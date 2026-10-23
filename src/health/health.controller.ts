import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { HealthDto } from './dto/health.dto';

/** Health of the API process; Railway's deploy healthcheck, so never rate limited */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  /** @param dataSource - Used for the database ping */
  constructor(private readonly dataSource: DataSource) {}

  /** 200 when the process serves requests and Postgres answers; 503 otherwise */
  @Get()
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ description: 'Database unreachable' })
  async check(): Promise<HealthDto> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
      });
    }
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      database: 'up',
    };
  }
}
