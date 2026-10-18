import type { ShopKey } from '../shops/shop.config.type';

/** The shop site answered, but not with what the provider expects (layout changed, no flyer, broken PDF) */
export class SourceUnavailableError extends Error {
  /**
   * @param shop - Shop whose source failed
   * @param message - What was missing or wrong
   */
  constructor(
    readonly shop: ShopKey,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${shop}] ${message}`, options);
    this.name = 'SourceUnavailableError';
  }
}

/** One invalid field of admin overrides */
export type OverrideIssue = { path: string; message: string };

/** Admin overrides failed validation; nothing was fetched */
export class InvalidOverridesError extends Error {
  /**
   * @param shop - Shop the overrides were for
   * @param issues - Every invalid field
   */
  constructor(
    readonly shop: ShopKey,
    readonly issues: OverrideIssue[],
  ) {
    super(
      `[${shop}] invalid overrides: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'InvalidOverridesError';
  }
}
