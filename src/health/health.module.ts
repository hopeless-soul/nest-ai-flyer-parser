import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Health endpoint of the HTTP API */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
