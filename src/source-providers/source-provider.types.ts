import type { ShopKey } from '../shops/shop.config.type';

/** Where the flyer pages come from: one PDF to split, or ready page images */
export type PageSource =
  { kind: 'pdf'; url: string } | { kind: 'images'; urls: string[] };

/** What a provider scraped from the shop site. Dates are `YYYY-MM-DD` in the shop's time zone */
export interface SourceListing {
  validFrom: string;
  /** null when the site prints no end date; discover() fills it from defaultFlyerDuration */
  validTo: string | null;
  sourceUrl: string;
  pages: PageSource;
  meta?: Record<string, unknown>;
}

/** A listing checked and completed by SourceProvider.discover(); nothing is downloaded yet */
export interface DiscoveredFlyer {
  shop: ShopKey;
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  flyerId: string;
  validFrom: string;
  validTo: string;
  /** true when validTo came from defaultFlyerDuration instead of the site */
  validToEstimated: boolean;
  sourceUrl: string;
  pages: PageSource;
  meta: Record<string, unknown>;
}

/** Outcome of discovering one shop in a batch; a failure never hides the other shops */
export type DiscoverResult =
  | { shop: ShopKey; ok: true; flyer: DiscoveredFlyer }
  | { shop: ShopKey; ok: false; error: string };

/** A compressed page image in the run's temp folder */
export interface LocalPage {
  /** 1-based */
  pageNumber: number;
  /** Absolute path; the extension is the image format */
  path: string;
  width: number;
  height: number;
}
