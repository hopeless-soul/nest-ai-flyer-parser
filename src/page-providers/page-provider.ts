import { Injectable } from '@nestjs/common';
import { addDaysIso, isIsoDate } from '../common/dates';
import { describeError } from '../common/errors';
import type { ShopConfig, ShopKey } from '../shops/shop.config.type';
import { FlyerHttpService, HttpRequestError } from './http/flyer-http.service';
import { PageProviderError } from './page-provider.errors';
import type { ResolvedFlyer, SourceListing } from './page-provider.types';

/**
 * One subclass per shop. A provider only finds the current flyer and says where its pages are;
 * downloading, splitting, R2, the database and AI belong to the pipeline.
 * Note: Providers are singletons. Keep run state in arguments, never in `this`.
 */
@Injectable()
export abstract class PageProvider<K extends ShopKey = ShopKey> {
  abstract readonly shop: K;

  constructor(protected readonly http: FlyerHttpService) {}

  /** Scrape the shop site for the current flyer. Must not download the PDF or page images. */
  protected abstract fetchListing(
    config: ShopConfig<K>,
  ): Promise<SourceListing>;

  /** Shared for every shop: checks, validTo fallback, flyerId */
  async resolve(config: ShopConfig<K>): Promise<ResolvedFlyer> {
    if (config.key !== this.shop) {
      throw new Error(
        `${this.constructor.name} got the config of "${config.key}"`,
      );
    }

    let listing: SourceListing;
    try {
      listing = await this.fetchListing(config);
    } catch (error) {
      if (
        error instanceof PageProviderError ||
        error instanceof HttpRequestError
      )
        throw error;
      // Note: A parse crash (bad JSON, impossible date) means the page changed, not a bug elsewhere
      this.fail(`unexpected page content: ${describeError(error)}`, error);
    }

    const { validFrom: from, validTo: to } = listing;
    if (!isIsoDate(from)) this.fail(`invalid validFrom "${String(from)}"`);
    if (to !== null && !isIsoDate(to)) {
      this.fail(`invalid validTo "${String(to)}"`);
    }
    const validTo =
      listing.validTo ??
      addDaysIso(listing.validFrom, config.defaultFlyerDuration);
    if (validTo < listing.validFrom)
      this.fail(`validTo ${validTo} is before validFrom ${listing.validFrom}`);
    if (listing.pages.kind === 'images' && listing.pages.urls.length === 0)
      this.fail('no page images');

    return {
      shop: this.shop,
      flyerId: `${this.shop}_${listing.validFrom}_${validTo}`,
      validFrom: listing.validFrom,
      validTo,
      validToEstimated: listing.validTo === null,
      sourceUrl: listing.sourceUrl,
      pages: listing.pages,
      meta: listing.meta ?? {},
    };
  }

  /**
   * The flyer valid on `today`; otherwise the latest one that already started (it may be expired,
   * the sync then sees the same flyerId and waits). Flyers starting in the future are never picked.
   */
  protected pickCurrent<T extends { validFrom: string; validTo: string }>(
    items: T[],
    today: string,
  ): T | null {
    const started = items
      .filter((item) => item.validFrom <= today)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return started.find((item) => today <= item.validTo) ?? started[0] ?? null;
  }

  protected fail(message: string, cause?: unknown): never {
    throw new PageProviderError(
      this.shop,
      message,
      cause === undefined ? undefined : { cause },
    );
  }
}
