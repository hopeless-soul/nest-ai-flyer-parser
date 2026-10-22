import { ConfigService } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Env } from './env.schema';

/** Per-client-IP rate limit for the API: `THROTTLE_LIMIT` requests per `THROTTLE_TTL` ms */
export const throttlerConfig = (
  config: ConfigService<Env, true>,
): ThrottlerModuleOptions => ({
  throttlers: [
    {
      ttl: config.get('THROTTLE_TTL', { infer: true }),
      limit: config.get('THROTTLE_LIMIT', { infer: true }),
    },
  ],
});
