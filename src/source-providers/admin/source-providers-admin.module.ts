import { Module } from '@nestjs/common';
import { SourceProvidersModule } from '../source-providers.module';
import { AdminSourceProvidersController } from './admin-source-providers.controller';

/** Admin routes of the source providers; API only */
@Module({
  imports: [SourceProvidersModule],
  controllers: [AdminSourceProvidersController],
})
export class SourceProvidersAdminModule {}
