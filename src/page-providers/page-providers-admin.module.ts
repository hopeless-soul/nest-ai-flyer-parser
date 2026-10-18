import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { PageProvidersController } from './page-providers.controller';
import { PageProvidersModule } from './page-providers.module';

/** Admin routes for dry runs with overrides; API mode only */
@Module({
  imports: [PageProvidersModule],
  controllers: [PageProvidersController],
  providers: [AdminApiKeyGuard],
})
export class PageProvidersAdminModule {}
