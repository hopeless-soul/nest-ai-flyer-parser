import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';

/** HTTP-only modules. Later: OffersModule, AdminModule */
@Module({
  imports: [HealthModule],
})
export class ApiModule {}
