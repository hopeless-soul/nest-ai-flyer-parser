import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import { isOverdue } from '../common/dates';
import { describeError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { FlyerPage } from '../flyers/entities/flyer-page.entity';
import { Flyer } from '../flyers/entities/flyer.entity';
import { FlyerStatus, PARSED } from '../flyers/enums/flyer.enums';
import { PageStatus } from '../flyers/enums/page.enums';
import { FlyerNotFoundError } from '../flyers/flyers.errors';
import { PageRegistrar } from '../flyers/page-registrar.service';
import { FatalParseError } from '../page-parser/page-parser.errors';
import { PageParserService } from '../page-parser/page-parser.service';
import { RetryReason } from '../shops/enums/shop.enums';
import type { ShopConfig, ShopKey } from '../shops/shop.config.type';
import { ShopLeaseService, type ShopLease } from '../shops/shop-lease.service';
import { ShopStateService } from '../shops/shop-state.service';
import type { DiscoveredFlyer } from '../source-providers/source-provider.types';
import { SourceProvidersService } from '../source-providers/source-providers.service';

/**
 * What a run does
 * `load`    - discover; skip a known finished flyer, resume an uploaded one, otherwise download + parse
 * `refresh` - discover and download + parse again, even if the flyer is known
 * `reparse` - parse an existing flyer again from its R2 images (all selected pages)
 */
export type PipelineAction = 'load' | 'refresh' | 'reparse';

/** One run request */
export interface PipelineRequest {
  shop: ShopKey;
  action: PipelineAction;
  /** reparse only: flyer to re-parse; defaults to the shop's current flyer */
  flyerId?: string;
  /** reparse only: limit to these pages */
  pageIds?: string[];
}

/** Flyer statuses of a run that stopped before the end */
const UNFINISHED = [
  FlyerStatus.Downloading,
  FlyerStatus.PagesUploaded,
  FlyerStatus.Parsing,
];

/** Page statuses that do not count as parsed when finalizing */
const NOT_PARSED = [PageStatus.Pending, PageStatus.Uploaded, PageStatus.Failed];

/**
 * Orchestrates a flyer run under the shop lease:
 * discover → materialize (temp dir) → register rows → upload to R2 → parse from R2 → finalize.
 * Note: Local files live only inside one run; a resumed run re-downloads unless every page is in R2.
 */
@Injectable()
export class FlyerPipelineService {
  private readonly logger = new Logger(FlyerPipelineService.name);
  private readonly tmpRoot: string;

  /**
   * @param lease - One run per shop
   * @param shopState - Current flyer and retries
   * @param sources - Discover + materialize
   * @param registrar - Flyer/page rows and R2 upload
   * @param parser - AI parsing
   * @param flyers - Flyer repository
   * @param pages - FlyerPage repository
   * @param config - PIPELINE_TMP_DIR
   */
  constructor(
    private readonly lease: ShopLeaseService,
    private readonly shopState: ShopStateService,
    private readonly sources: SourceProvidersService,
    private readonly registrar: PageRegistrar,
    private readonly parser: PageParserService,
    @InjectRepository(Flyer) private readonly flyers: Repository<Flyer>,
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    config: ConfigService<Env, true>,
  ) {
    this.tmpRoot = config.get('PIPELINE_TMP_DIR', { infer: true });
  }

  /**
   * Run and wait for the end (cron). Failures are recorded on ShopState, not thrown.
   * @throws LeaseBusyError | FlyerNotFoundError | ImagesExpiredError - before any work starts
   */
  async run(request: PipelineRequest): Promise<void> {
    const prepared = await this.prepare(request);
    await this.execute(prepared.request, prepared.lease);
  }

  /**
   * Take the lease, run the prechecks and continue in the background (admin → 202)
   * @throws LeaseBusyError | FlyerNotFoundError | ImagesExpiredError - before any work starts
   */
  async trigger(request: PipelineRequest): Promise<void> {
    const prepared = await this.prepare(request);
    void this.execute(prepared.request, prepared.lease).catch((error) =>
      this.logger.error(
        `[${request.shop}] background run crashed: ${describeError(error)}`,
      ),
    );
  }

  /** true if the shop has a flyer whose run stopped midway (crash, fatal parse error) */
  hasUnfinishedFlyer(shop: ShopKey): Promise<boolean> {
    return this.flyers.exists({ where: { shop, status: In(UNFINISHED) } });
  }

  /**
   * Lease + reparse prechecks; frees the lease again if a precheck fails
   * Note: An explicit `flyerId` must exist and belong to `request.shop`, so a flyer is never parsed under another shop's lease.
   * @throws The original precheck error, even when releasing the lease fails too
   */
  private async prepare(
    request: PipelineRequest,
  ): Promise<{ lease: ShopLease; request: PipelineRequest }> {
    const lease = await this.lease.acquire(request.shop);
    try {
      if (request.action !== 'reparse') return { lease, request };

      if (request.flyerId) {
        const flyer = await this.flyers.findOneBy({ id: request.flyerId });
        if (!flyer || flyer.shop !== request.shop) {
          throw new FlyerNotFoundError(
            `Flyer ${request.flyerId} not found for ${request.shop}`,
          );
        }
      }
      const flyerId =
        request.flyerId ??
        (await this.shopState.get(request.shop)).currentFlyerId;
      if (!flyerId) {
        throw new FlyerNotFoundError(
          `${request.shop} has no current flyer to re-parse`,
        );
      }
      await this.parser.assertImagesAvailable(flyerId, request.pageIds);
      return { lease, request: { ...request, flyerId } };
    } catch (error) {
      try {
        await lease.release();
      } catch (releaseError) {
        this.logger.error(
          `[${request.shop}] could not release the lease after a failed precheck: ${describeError(releaseError)}`,
        );
      }
      throw error;
    }
  }

  /** Do the work, record failures on ShopState, always release the lease (a failing release is only logged); never throws */
  private async execute(
    request: PipelineRequest,
    lease: ShopLease,
  ): Promise<void> {
    const { shop, action } = request;
    const started = Date.now();
    try {
      const config = this.sources.getConfig(shop);
      await this.shopState.markAttempt(shop);
      if (action === 'reparse') {
        await this.reparse(request, config);
      } else {
        await this.load(config, action === 'refresh');
      }
      this.logger.log(
        `[${shop}] ${action} finished in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (error) {
      await this.recordFailure(shop, action, error);
    } finally {
      try {
        await lease.release();
      } catch (releaseError) {
        this.logger.error(
          `[${shop}] could not release the lease: ${describeError(releaseError)}`,
        );
      }
    }
  }

  /** `load` and `refresh` */
  private async load(config: ShopConfig, force: boolean): Promise<void> {
    const discovered = await this.sources.discover(config.key);
    if (!force) {
      const existing = await this.flyers.findOne({
        where: { id: discovered.flyerId },
        relations: { pages: true },
      });
      if (existing && (await this.skipOrResume(config, existing))) return;
    }

    const flyer = await this.download(discovered, config);
    await this.parse(flyer, config, {});
  }

  /** `reparse`: the selected pages of an existing flyer, from R2 */
  private async reparse(
    request: PipelineRequest,
    config: ShopConfig,
  ): Promise<void> {
    if (!request.flyerId) throw new FlyerNotFoundError('No flyer to re-parse');
    const flyer = await this.flyers.findOneBy({ id: request.flyerId });
    if (!flyer)
      throw new FlyerNotFoundError(`Flyer ${request.flyerId} not found`);
    await this.parse(flyer, config, { force: true, pageIds: request.pageIds });
  }

  /**
   * Decide what to do with a flyer that already exists
   * - READY, or PARTIAL/FAILED that counts as finished → done (overdue current flyer → wait for a new one)
   *   PARTIAL/FAILED is finished when its page retries are used up, or when the shop is already
   *   AWAITING_NEW_FLYER for it (it was found finished and overdue before), so it is never re-parsed again
   * - every page in R2 → resume at parsing
   * - otherwise → false (the caller downloads it again)
   * @returns true when the run is done
   */
  private async skipOrResume(
    config: ShopConfig,
    flyer: Flyer,
  ): Promise<boolean> {
    const shop = config.key;
    const state = await this.shopState.get(shop);
    const exhausted =
      (state.retry.reason === RetryReason.PagesFailed &&
        state.retry.attempts >= config.parser.maxAttempts) ||
      (state.retry.reason === RetryReason.AwaitingNewFlyer &&
        state.currentFlyerId === flyer.id);
    const finished =
      flyer.status === FlyerStatus.Ready ||
      ((flyer.status === FlyerStatus.Partial ||
        flyer.status === FlyerStatus.Failed) &&
        exhausted);

    if (finished) {
      let isCurrent = state.currentFlyerId === flyer.id;
      if (!isCurrent && PARSED.includes(flyer.status)) {
        await this.shopState.setCurrentFlyer(shop, flyer.id);
        isCurrent = true;
      }
      if (isCurrent && isOverdue(flyer.validTo, config.timezone)) {
        await this.shopState.scheduleRetry(shop, RetryReason.AwaitingNewFlyer);
        this.logger.log(
          `[${shop}] ${flyer.id} is overdue and still the newest flyer; waiting for a new one`,
        );
      } else if (flyer.status === FlyerStatus.Ready) {
        await this.shopState.clearRetry(shop);
        this.logger.log(`[${shop}] ${flyer.id} is up to date`);
      }
      return true;
    }

    const uploaded =
      flyer.pageCount > 0 &&
      flyer.pages.length === flyer.pageCount &&
      flyer.pages.every((page) => page.status !== PageStatus.Pending);
    if (!uploaded) return false;

    this.logger.log(`[${shop}] resuming ${flyer.id} at parsing`);
    await this.parse(flyer, config, {});
    return true;
  }

  /** Stages 1-3: materialize into a temp dir, register rows, upload to R2; the temp dir is always deleted */
  private async download(
    discovered: DiscoveredFlyer,
    config: ShopConfig,
  ): Promise<Flyer> {
    const dir = join(
      this.tmpRoot,
      `${discovered.flyerId}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await this.registrar.begin(discovered);
      const files = await this.sources.materialize(discovered, dir);
      await this.registrar.register(discovered.flyerId, files);
      await this.registrar.upload(discovered, files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Note: Cleared only once every page is in R2, so download failures keep counting attempts
    await this.shopState.clearRetry(config.key);
    return this.flyers.findOneByOrFail({ id: discovered.flyerId });
  }

  /** Stage 4: parse pages, then finalize the flyer status */
  private async parse(
    flyer: Flyer,
    config: ShopConfig,
    options: { force?: boolean; pageIds?: string[] },
  ): Promise<void> {
    await this.flyers.update(flyer.id, { status: FlyerStatus.Parsing });
    const summary = await this.parser.parsePages(flyer, {
      ...options,
      concurrency: config.parser.concurrency,
      maxAttempts: config.parser.maxAttempts,
    });
    this.logger.log(
      `[${config.key}] ${flyer.id}: ${summary.parsed} parsed, ${summary.skipped} skipped, ${summary.failed.length} failed`,
    );
    await this.finalize(flyer, config);
  }

  /**
   * READY (0 unparsed pages) · PARTIAL (≤ maxFailedPages) · FAILED (more)
   * READY/PARTIAL becomes the shop's current flyer unless the current one is newer; PARTIAL/FAILED schedule a page retry.
   */
  private async finalize(flyer: Flyer, config: ShopConfig): Promise<void> {
    const shop = config.key;
    const unparsed = await this.pages.count({
      where: { flyerId: flyer.id, status: In(NOT_PARSED) },
    });
    const status =
      unparsed === 0
        ? FlyerStatus.Ready
        : unparsed <= config.parser.maxFailedPages
          ? FlyerStatus.Partial
          : FlyerStatus.Failed;
    await this.flyers.update(flyer.id, { status });

    if (status !== FlyerStatus.Failed) {
      const { currentFlyer } = await this.shopState.get(shop);
      if (!currentFlyer || currentFlyer.validFrom <= flyer.validFrom) {
        await this.shopState.setCurrentFlyer(shop, flyer.id);
      }
    }
    if (status === FlyerStatus.Ready) {
      await this.shopState.clearRetry(shop);
    } else {
      await this.shopState.scheduleRetry(shop, RetryReason.PagesFailed, {
        maxAttempts: config.parser.maxAttempts,
        error: `${unparsed} pages of ${flyer.id} are not parsed`,
      });
    }
    this.logger.log(`[${shop}] ${flyer.id} is ${status}`);
  }

  /**
   * Log and store a failure
   * load/refresh: FatalParseError → PAGES_FAILED retry, anything else → FETCH_FAILED retry.
   * reparse (admin): lastError only.
   */
  private async recordFailure(
    shop: ShopKey,
    action: PipelineAction,
    error: unknown,
  ): Promise<void> {
    const message = describeError(error);
    this.logger.error(
      `[${shop}] ${action} failed: ${message}`,
      error instanceof Error ? error.stack : undefined,
    );
    try {
      if (action === 'reparse') {
        await this.shopState.recordError(shop, message);
        return;
      }
      const config = this.sources.getConfig(shop);
      const reason =
        error instanceof FatalParseError
          ? RetryReason.PagesFailed
          : RetryReason.FetchFailed;
      const at = await this.shopState.scheduleRetry(shop, reason, {
        maxAttempts: config.parser.maxAttempts,
        error: message,
      });
      this.logger.warn(
        `[${shop}] ${reason}: ${at ? `retry at ${at.toISOString()}` : 'retries used up'}`,
      );
    } catch (stateError) {
      this.logger.error(
        `[${shop}] could not record the failure: ${describeError(stateError)}`,
      );
    }
  }
}
