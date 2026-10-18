import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { mapLimit } from '../common/concurrency';
import { addDaysIso, isIsoDate } from '../common/dates';
import { describeError } from '../common/errors';
import type { ShopConfig, ShopKey } from '../shops/shop.config.type';
import { FlyerHttpService, HttpRequestError } from './http.service';
import { PageMaterializer } from './page-materializer.service';
import { SourceUnavailableError } from './source-provider.errors';
import type {
  DiscoveredFlyer,
  LocalPage,
  SourceListing,
} from './source-provider.types';

/** Parallel downloads for image-based sources */
const IMAGE_DOWNLOAD_CONCURRENCY = 6;

/**
 * One subclass per shop. A subclass only scrapes the listing (`fetchListing`); the base class checks it
 * (`discover`) and turns it into local page images (`materialize`). DB, R2 and AI belong to the pipeline.
 * Note: Providers are singletons. Keep run state in arguments, never in `this`.
 */
@Injectable()
export abstract class SourceProvider<K extends ShopKey = ShopKey> {
  /** Shop this provider serves */
  abstract readonly shop: K;

  /**
   * @param http - Client for shop sites
   * @param materializer - PDF split + image compression
   */
  constructor(
    protected readonly http: FlyerHttpService,
    protected readonly materializer: PageMaterializer,
  ) {}

  /** Scrape the shop site for the current flyer. Must not download the PDF or page images */
  protected abstract fetchListing(
    config: ShopConfig<K>,
  ): Promise<SourceListing>;

  /**
   * Find the current flyer: checks dates, fills validTo from defaultFlyerDuration, builds the flyerId
   * @throws SourceUnavailableError | HttpRequestError
   */
  async discover(config: ShopConfig<K>): Promise<DiscoveredFlyer> {
    if (config.key !== this.shop) {
      throw new Error(
        `${this.constructor.name} got the config of "${config.key}"`,
      );
    }

    let listing: SourceListing;
    try {
      listing = await this.fetchListing(config);
    } catch (error) {
      this.rethrowAsSourceError(error, 'unexpected page content');
    }

    const { validFrom: from, validTo: to } = listing;
    if (!isIsoDate(from)) this.fail(`invalid validFrom "${String(from)}"`);
    if (to !== null && !isIsoDate(to)) {
      this.fail(`invalid validTo "${String(to)}"`);
    }
    const validTo =
      listing.validTo ??
      addDaysIso(listing.validFrom, config.defaultFlyerDuration);
    if (validTo < listing.validFrom)
      this.fail(`validTo ${validTo} is before validFrom ${listing.validFrom}`);
    if (listing.pages.kind === 'images' && listing.pages.urls.length === 0)
      this.fail('no page images');

    return {
      shop: this.shop,
      flyerId: `${this.shop}_${listing.validFrom}_${validTo}`,
      validFrom: listing.validFrom,
      validTo,
      validToEstimated: listing.validTo === null,
      sourceUrl: listing.sourceUrl,
      pages: listing.pages,
      meta: listing.meta ?? {},
    };
  }

  /**
   * Download the flyer into `dir` and write compressed page images to `<dir>/pages`
   * Note: The caller owns `dir` and deletes it; these files are never a source of truth
   * @throws SourceUnavailableError | HttpRequestError
   */
  async materialize(
    flyer: DiscoveredFlyer,
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    let pages: LocalPage[];
    try {
      pages =
        flyer.pages.kind === 'pdf'
          ? await this.materializePdf(flyer.pages.url, config, dir)
          : await this.materializeImages(flyer.pages.urls, config, dir);
    } catch (error) {
      this.rethrowAsSourceError(error, 'could not materialize the flyer');
    }
    if (!pages.length) this.fail(`${flyer.flyerId} has no pages`);
    return pages;
  }

  /**
   * The flyer valid on `today`; otherwise the latest one that already started (it may be expired,
   * the pipeline then sees the same flyerId and waits). Flyers starting in the future are never picked.
   */
  protected pickCurrent<T extends { validFrom: string; validTo: string }>(
    items: T[],
    today: string,
  ): T | null {
    const started = items
      .filter((item) => item.validFrom <= today)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return started.find((item) => today <= item.validTo) ?? started[0] ?? null;
  }

  /** Throw a SourceUnavailableError for this shop */
  protected fail(message: string, cause?: unknown): never {
    throw new SourceUnavailableError(
      this.shop,
      message,
      cause === undefined ? undefined : { cause },
    );
  }

  /** Download the PDF and split it */
  private async materializePdf(
    url: string,
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    const pdfPath = join(dir, 'flyer.pdf');
    await this.http.downloadToFile(url, pdfPath);
    return this.materializer.splitPdf(
      pdfPath,
      join(dir, 'pages'),
      config.pages,
    );
  }

  /** Download the page images and compress them */
  private async materializeImages(
    urls: string[],
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    const files = await mapLimit(
      urls,
      IMAGE_DOWNLOAD_CONCURRENCY,
      async (url, index) => {
        const path = join(dir, 'raw', String(index + 1).padStart(3, '0'));
        await this.http.downloadToFile(url, path);
        return path;
      },
    );
    return this.materializer.compressFiles(
      files,
      join(dir, 'pages'),
      config.pages.compress,
    );
  }

  /** Keep known errors; wrap anything else (bad JSON, broken PDF, ...) as a source problem */
  private rethrowAsSourceError(error: unknown, context: string): never {
    if (
      error instanceof SourceUnavailableError ||
      error instanceof HttpRequestError
    )
      throw error;
    this.fail(`${context}: ${describeError(error)}`, error);
  }
}
