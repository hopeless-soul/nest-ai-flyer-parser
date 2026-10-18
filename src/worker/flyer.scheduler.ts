import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

const TZ = 'Europe/Bratislava';

/** Only triggers; the work itself will live in FlyerSyncService */
@Injectable()
export class FlyerScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(FlyerScheduler.name);

  // constructor(private readonly sync: FlyerSyncService) {}

  @Cron('0 6 * * *', { name: 'daily-flyer-check', timeZone: TZ, waitForCompletion: true })
  async daily() {
    this.logger.log('Daily flyer check');
    // await this.sync.syncAll('daily')
  }

  // waitForCompletion: a slow run is never started twice in parallel
  @Cron('* * * * *', { name: 'flyer-retries', timeZone: TZ, waitForCompletion: true })
  async retries() {
    this.logger.debug('Retry poll');
    // await this.sync.runDueRetries()
  }

  onApplicationBootstrap() {
    this.logger.log('Worker started, resuming unfinished flyers');
    // void this.sync.resumeUnfinished()
  }
}
