import { z } from 'zod';
import { ProductCategoryKeys } from '../../flyers/types/product-category.type';
import { ShopKeys } from '../../shops/shop.config.type';

/** 0–1 fraction of the page width/height */
const coordinate = z.number().min(0).max(1);
/** [x, y] */
const point = z.tuple([coordinate, coordinate]);
/** EUR, fits numeric(8,2); omitted means null */
const price = z.number().nonnegative().max(999_999.99).nullable().optional();
/** Percent; omitted means null */
const percent = z.number().int().min(0).max(100).nullable().optional();

/** Body of POST /admin/pages/:pageId/offers */
export const offerInputSchema = z
  .object({
    title: z.string().trim().min(1),
    category: z.array(z.enum(ProductCategoryKeys)).nullable().optional(),
    boundaryBox: z.tuple([point, point]),
    basePrice: price,
    discountedPrice: price,
    discount: percent,
    loyaltyPrice: price,
    loyaltyDiscount: percent,
  })
  .strict();

/** Parsed offer input */
export type OfferInput = z.infer<typeof offerInputSchema>;

/** Body of PATCH /admin/offers/:id; only the given fields change */
export const offerPatchSchema = offerInputSchema.partial();

/** Parsed offer patch */
export type OfferPatch = z.infer<typeof offerPatchSchema>;

/** Query of GET /admin/flyers */
export const listFlyersQuerySchema = z.object({
  shop: z.enum(ShopKeys).optional(),
});
