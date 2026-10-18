import type { SourceOptionsMap } from './shop.config.schema';

/** Every supported shop; a new shop also needs a SHOP_CONFIGS entry, a source schema and a provider */
export const ShopKeys = ['kaufland', 'tesco', 'lidl', 'billa'] as const;

/** One of `ShopKeys` */
export type ShopKey = (typeof ShopKeys)[number];

/** How a page image is compressed before it is uploaded */
export interface CompressImageOptions {
  format: 'jpg' | 'png' | 'webp';
  /** 1-100 */
  quality?: number;
  /** Downscales width if the image is wider (keeps aspect ratio, never upscales) */
  maxWidth?: number;
}

/** How flyer pages are turned into images */
export interface PageImageOptions {
  compress: CompressImageOptions;
  /** pdf.js render scale, `1` is 72 DPI */
  pdfScale: number;
}

/** AI parser limits of a shop */
export interface ParserOptions {
  /** Pages parsed in parallel */
  concurrency: number;
  /** Attempts per page within a run; also caps shop-level retries */
  maxAttempts: number;
  /** Up to this many failed pages the flyer is PARTIAL instead of FAILED */
  maxFailedPages: number;
}

/** Static config of one shop */
export interface ShopConfig<K extends ShopKey = ShopKey> {
  key: K;
  name: string;
  /** Only affects scheduled runs; an admin can still run a disabled shop */
  enabled: boolean;
  /** IANA time zone; decides what "today" is (current flyer, overdue check) */
  timezone: string;
  /** Days added to validFrom when the site prints no end date */
  defaultFlyerDuration: number;
  source: SourceOptionsMap[K];
  pages: PageImageOptions;
  parser: ParserOptions;
}

/** Config of every shop, keyed by ShopKey */
export type ShopConfigs = { readonly [K in ShopKey]: ShopConfig<K> };

/** What an admin may override for one discover call */
export interface ShopConfigOverrides<K extends ShopKey = ShopKey> {
  source?: Partial<SourceOptionsMap[K]>;
  defaultFlyerDuration?: number;
  timezone?: string;
}
