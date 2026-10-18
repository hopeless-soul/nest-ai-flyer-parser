import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ShopsModule } from '../shops/shops.module';
import { SourceProvidersModule } from '../source-providers/source-providers.module';
import { StorageModule } from '../storage/storage.module';
import { PipelineCron } from './pipeline.cron';

/** Background worker: daily run + retry tick over the flyer pipeline; no HTTP */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    PipelineModule,
    ShopsModule,
    SourceProvidersModule,
    StorageModule,
  ],
  providers: [PipelineCron],
})
export class WorkerModule {}
