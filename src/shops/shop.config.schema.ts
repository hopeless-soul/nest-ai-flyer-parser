import { z } from 'zod';
import type { ShopKey } from './shop.config.type';

/** Only https URLs are accepted for shop sources */
const httpsUrl = z.url({ protocol: /^https$/ });

/**
 * Source options per shop: what its source provider needs to find the current flyer.
 * Note: Single source of truth for the types (SourceOptionsMap) and for validating admin overrides.
 */
export const SOURCE_OPTIONS_SCHEMAS = {
  kaufland: z.object({
    // Page with the flyer tiles; each tile has its validity and a static PDF URL
    flyerUrl: httpsUrl,
    // Tile to pick, `KDZ` = main weekly flyer
    flyerSubcategory: z.string().min(1),
  }),
  tesco: z.object({
    // Next.js page; __NEXT_DATA__ holds every leaflet with dates, PDF and page images
    flyerUrl: httpsUrl,
    // HM = hypermarket, SM = supermarket, CAT = catalogue
    flyerType: z.enum(['HM', 'SM', 'CAT']),
    // `pdf` renders leafletUrl, `images` downloads the pre-rendered pagePNG files
    pages: z.enum(['pdf', 'images']),
  }),
  lidl: z.object({
    // List page with the weekly flyer slugs
    flyerUrl: httpsUrl,
    // Leaflets API: dates, PDF and page images per slug
    apiUrl: httpsUrl,
    regionId: z.number().int().nonnegative(),
    // `image` ~708x1200 (~190 KB), `zoom` ~1415x2400 (~500 KB)
    imageVariant: z.enum(['image', 'zoom']),
    pages: z.enum(['images', 'pdf']),
  }),
  billa: z.object({
    // Page with "Akciová ponuka platí od … do …" and the Publitas PDF link
    flyerUrl: httpsUrl,
  }),
} satisfies Record<ShopKey, z.ZodObject>;

/** Source options type per shop, derived from `SOURCE_OPTIONS_SCHEMAS` */
export type SourceOptionsMap = {
  [K in ShopKey]: z.infer<(typeof SOURCE_OPTIONS_SCHEMAS)[K]>;
};
