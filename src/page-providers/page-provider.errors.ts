import type { ShopKey } from '../shops/shop.config.type';

/** The shop site answered, but not with what the provider expects (layout changed, no flyer) */
export class PageProviderError extends Error {
  constructor(
    readonly shop: ShopKey,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${shop}] ${message}`, options);
    this.name = 'PageProviderError';
  }
}

export type OverrideIssue = { path: string; message: string };

/** Admin overrides failed validation; nothing was fetched */
export class ShopConfigOverrideError extends Error {
  constructor(
    readonly shop: ShopKey,
    readonly issues: OverrideIssue[],
  ) {
    super(
      `[${shop}] invalid overrides: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'ShopConfigOverrideError';
  }
}
