import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { isOverdue } from '../common/dates';
import { describeError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { FlyerPipelineService } from '../pipeline/flyer-pipeline.service';
import { LeaseBusyError } from '../shops/shop-lease.service';
import type { ShopKey } from '../shops/shop.config.type';
import { ShopStateService } from '../shops/shop-state.service';
import { SourceProvidersService } from '../source-providers/source-providers.service';
import { R2Service } from '../storage/r2.service';

/** Time zone of both schedules */
const CRON_TIME_ZONE = 'Europe/Bratislava';

/**
 * Worker schedules
 * - Daily run (PIPELINE_CRON): load shops with no flyer, an overdue flyer, or an unfinished run
 * - Retry tick (PIPELINE_RETRY_CRON): load only shops whose retry.at is due
 * Note: Jobs are registered at runtime because their times come from config
 */
@Injectable()
export class PipelineCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PipelineCron.name);

  /**
   * @param scheduler - Registers the cron jobs
   * @param config - Cron expressions
   * @param pipeline - Runs
   * @param shopState - Current flyer and due retries
   * @param sources - Enabled shops and their configs
   * @param r2 - Lifecycle rule on startup
   */
  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
    private readonly pipeline: FlyerPipelineService,
    private readonly shopState: ShopStateService,
    private readonly sources: SourceProvidersService,
    private readonly r2: R2Service,
  ) {}

  /** Apply the R2 lifecycle rule and start both schedules */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.r2.ensureLifecycle();
    } catch (error) {
      this.logger.error(
        `R2 lifecycle rule not applied: ${describeError(error)}`,
      );
    }
    this.schedule(
      'pipeline-daily',
      this.config.get('PIPELINE_CRON', { infer: true }),
      () => this.daily(),
    );
    this.schedule(
      'pipeline-retries',
      this.config.get('PIPELINE_RETRY_CRON', { infer: true }),
      () => this.retries(),
    );
  }

  /** Daily run: each enabled shop, one after another */
  async daily(): Promise<void> {
    for (const shop of this.sources.enabledShops()) {
      try {
        const state = await this.shopState.get(shop);
        const { timezone } = this.sources.getConfig(shop);
        const due =
          !state.currentFlyer ||
          isOverdue(state.currentFlyer.validTo, timezone) ||
          (await this.pipeline.hasUnfinishedFlyer(shop));
        if (!due) {
          this.logger.log(
            `[${shop}] ${state.currentFlyerId} is still valid; skipped`,
          );
          continue;
        }
        await this.load(shop);
      } catch (error) {
        this.logger.error(
          `[${shop}] daily check failed: ${describeError(error)}`,
        );
      }
    }
  }

  /** Retry tick: one query; nothing to do unless a retry is due */
  async retries(): Promise<void> {
    const enabled = new Set(this.sources.enabledShops());
    const due = await this.shopState.findDueRetries();
    for (const state of due) {
      if (!enabled.has(state.shop)) continue;
      this.logger.log(
        `[${state.shop}] retry due (${state.retry.reason}, attempt ${state.retry.attempts})`,
      );
      await this.load(state.shop);
    }
  }

  /** Run `load` and wait; a busy shop is skipped until the next tick */
  private async load(shop: ShopKey): Promise<void> {
    try {
      await this.pipeline.run({ shop, action: 'load' });
    } catch (error) {
      if (error instanceof LeaseBusyError) {
        this.logger.log(`[${shop}] busy; skipped`);
        return;
      }
      this.logger.error(`[${shop}] load failed: ${describeError(error)}`);
    }
  }

  /** Register and start a job; `waitForCompletion` never overlaps two runs of the same job */
  private schedule(
    name: string,
    cronTime: string,
    onTick: () => Promise<void>,
  ): void {
    const job = CronJob.from({
      cronTime,
      onTick,
      timeZone: CRON_TIME_ZONE,
      waitForCompletion: true,
    });
    this.scheduler.addCronJob(name, job);
    job.start();
    this.logger.log(`${name} scheduled: "${cronTime}" (${CRON_TIME_ZONE})`);
  }
}
