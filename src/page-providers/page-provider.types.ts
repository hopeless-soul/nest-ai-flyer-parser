import type { ShopKey } from '../shops/shop.config.type';

/** Where the flyer pages come from: one PDF to split, or ready page images */
export type PageSource =
  { kind: 'pdf'; url: string } | { kind: 'images'; urls: string[] };

/** What a provider found on the shop site. Dates are `YYYY-MM-DD` in the shop's time zone */
export interface SourceListing {
  validFrom: string;
  // null when the site prints no end date; resolve() fills it from defaultFlyerDuration
  validTo: string | null;
  sourceUrl: string;
  pages: PageSource;
  meta?: Record<string, unknown>;
}

/** A listing checked and completed by PageProvider.resolve() */
export interface ResolvedFlyer {
  shop: ShopKey;
  // kaufland_2026-10-14_2026-10-20
  flyerId: string;
  validFrom: string;
  validTo: string;
  // true when validTo came from defaultFlyerDuration instead of the site
  validToEstimated: boolean;
  sourceUrl: string;
  pages: PageSource;
  meta: Record<string, unknown>;
}

export type ResolveResult =
  | { shop: ShopKey; ok: true; flyer: ResolvedFlyer }
  | { shop: ShopKey; ok: false; error: string };
