import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FlyerScheduler } from './flyer.scheduler';

/** Cron + pipeline, no HTTP. Later: SyncModule (→ PipelineModule, SourcesModule) */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [FlyerScheduler],
})
export class WorkerModule {}
