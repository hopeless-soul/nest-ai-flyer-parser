import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** `x-admin-key` header must equal ADMIN_API_KEY */
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('ADMIN_API_KEY');
    // Note: Fail closed, admin routes stay off until ADMIN_API_KEY is set
    if (!expected) {
      throw new ForbiddenException(
        'Admin API is disabled: ADMIN_API_KEY is not set',
      );
    }

    const given =
      context.switchToHttp().getRequest<Request>().header('x-admin-key') ?? '';
    // Note: Hash both so timingSafeEqual compares equal lengths and leaks nothing about the key
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(a, b))
      throw new UnauthorizedException('Invalid admin key');
    return true;
  }
}
