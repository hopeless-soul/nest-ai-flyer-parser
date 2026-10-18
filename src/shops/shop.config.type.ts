import type { SourceOptionsMap } from './shop.config.schema';

export const ShopKeys = ['kaufland', 'tesco', 'lidl', 'billa'] as const;

export type ShopKey = (typeof ShopKeys)[number];

export interface ShopConfig<K extends ShopKey = ShopKey> {
  key: K;
  name: string;
  // Only affects scheduled runs; an admin can still resolve a disabled shop
  enabled: boolean;
  // IANA time zone of the shop, decides what "today" is when picking the current flyer
  timezone: string;
  // Days added to validFrom when the site prints no end date
  defaultFlyerDuration: number;
  source: SourceOptionsMap[K];
  pages: { compress: CompressImageOptions; pdfScale: number };
  parser: { concurrency: number; maxAttempts: number; maxFailedPages: number };
}

export type ShopConfigs = { readonly [K in ShopKey]: ShopConfig<K> };

/** What an admin may override for one run: testing, or downloading a specific flyer */
export interface ShopConfigOverrides<K extends ShopKey = ShopKey> {
  source?: Partial<SourceOptionsMap[K]>;
  defaultFlyerDuration?: number;
  timezone?: string;
}

// TODO: Move to utils types
export interface CompressImageOptions {
  format?: 'jpg' | 'png' | 'webp';
  quality?: number; // 1-100
  maxWidth?: number; // Downscales width if the image is wider (keeps aspect ratio, never upscales)
}
