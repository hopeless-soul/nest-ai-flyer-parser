export type SourceOption = {
  flyerUrl?: string;
  apiUrl?: string;
};

export const ShopKeys = ['kaufland', 'tesco', 'lidl', 'billa'] as const;

export type ShopKey = (typeof ShopKeys)[number];

export interface ShopConfig<K extends ShopKey> {
  key: K;
  name: string;
  enabled: boolean;
  defaultFlyerDuration: number;
  source: SourceOption;
  pages: { compress: CompressImageOptions; pdfScale: number };
  parser: { concurrency: number; maxAttempts: number; maxFailedPages: number };
}

// TODO: Move to utils types
export interface CompressImageOptions {
  format?: 'jpg' | 'png' | 'webp';
  quality?: number; // 1-100
  maxWidth?: number; // Downscales width if the image is wider (keeps aspect ratio, never upscales)
}
