import { Module } from '@nestjs/common';
import { FlyersModule } from '../../flyers/flyers.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminPageParserController } from './admin-page-parser.controller';
import { AdminPageParserService } from './admin-page-parser.service';

/** Admin routes over parser results; API only */
@Module({
  imports: [FlyersModule, StorageModule, PipelineModule],
  controllers: [AdminPageParserController],
  providers: [AdminPageParserService],
})
export class PageParserAdminModule {}
