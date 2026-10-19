import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../../config/env.schema';

/**
 * Admin auth: the request carries a raw API key (`Authorization: Bearer <key>` or `X-API-Key: <key>`)
 * whose SHA-256 must match one of `ADMIN_API_KEY_HASHES`. Without configured hashes every request is
 * rejected (fail closed).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  /** Accepted key digests (32 bytes each), decoded once */
  private readonly hashes: Buffer[];

  /** @param config - Reads ADMIN_API_KEY_HASHES */
  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('ADMIN_API_KEY_HASHES', { infer: true });
    this.hashes = raw
      ? raw.split(',').map((hex) => Buffer.from(hex, 'hex'))
      : [];
    if (!this.hashes.length) {
      new Logger(ApiKeyGuard.name).warn(
        'Admin routes disabled: ADMIN_API_KEY_HASHES not set',
      );
    }
  }

  /** Allow the request only when its key hashes to an accepted digest */
  canActivate(context: ExecutionContext): boolean {
    const key = this.keyOf(context.switchToHttp().getRequest<Request>());
    if (key) {
      const digest = createHash('sha256').update(key).digest();
      if (this.hashes.some((hash) => timingSafeEqual(hash, digest))) {
        return true;
      }
    }
    throw new UnauthorizedException();
  }

  /** Raw key from `Authorization: Bearer` or `X-API-Key`, if present */
  private keyOf(request: Request): string | undefined {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
    return request.header('x-api-key') || undefined;
  }
}
