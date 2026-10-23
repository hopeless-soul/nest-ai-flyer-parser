import { ConfigService } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Env } from './env.schema';

/**
 * Looser limit for `GET /pages/:id/image`: one flyer view loads 30-40 images, and offices share one IP.
 * Applied per route with `@Throttle({ default: IMAGE_THROTTLE })`, so it cannot come from env (decorators are static).
 */
export const IMAGE_THROTTLE = { limit: 600, ttl: 60_000 };

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
