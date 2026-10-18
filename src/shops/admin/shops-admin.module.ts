import { Module } from '@nestjs/common';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { ShopsModule } from '../shops.module';
import { AdminShopsController } from './admin-shops.controller';

/** Admin routes for shops and pipeline triggers; API only */
@Module({
  imports: [ShopsModule, PipelineModule],
  controllers: [AdminShopsController],
})
export class ShopsAdminModule {}
