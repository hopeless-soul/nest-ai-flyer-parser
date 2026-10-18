import { Module } from '@nestjs/common';
import { FlyersModule } from '../flyers/flyers.module';
import { PageParserModule } from '../page-parser/page-parser.module';
import { ShopsModule } from '../shops/shops.module';
import { SourceProvidersModule } from '../source-providers/source-providers.module';
import { FlyerPipelineService } from './flyer-pipeline.service';

/** Flyer pipeline orchestration; used by the worker cron and the admin routes */
@Module({
  imports: [ShopsModule, SourceProvidersModule, FlyersModule, PageParserModule],
  providers: [FlyerPipelineService],
  exports: [FlyerPipelineService],
})
export class PipelineModule {}
