import { ApiProperty } from '@nestjs/swagger';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';
import type { FlyerOffer } from '../entities/flyer-offer.entity';
import {
  ProductCategoryKeys,
  type ProductCategoryKey,
} from '../types/product-category.type';

/** OpenAPI schema of a `[[x1, y1], [x2, y2]]` box in 0–1 page fractions */
export const BOUNDARY_BOX_SCHEMA = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: { type: 'number', minimum: 0, maximum: 1 },
  },
  example: [
    [0.1, 0.2],
    [0.4, 0.5],
  ],
} as const;

/** One offer of a flyer page */
export class OfferDto {
  /** UUID */
  id!: string;
  /** e.g. kaufland_2026-10-14_2026-10-20_page_07 */
  pageId!: string;
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  flyerId!: string;
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** Order of the offer on its page, 0-based */
  position!: number;
  title!: string;
  @ApiProperty({
    enum: ProductCategoryKeys,
    isArray: true,
    nullable: true,
    type: String,
  })
  category!: ProductCategoryKey[] | null;
  /** `[[x1, y1], [x2, y2]]` as fractions of the page width/height */
  @ApiProperty(BOUNDARY_BOX_SCHEMA)
  boundaryBox!: [[number, number], [number, number]];
  /** EUR */
  basePrice!: number | null;
  /** EUR */
  discountedPrice!: number | null;
  /** Discount of `discountedPrice` in percent */
  discount!: number | null;
  /** EUR, with the shop's loyalty card */
  loyaltyPrice!: number | null;
  /** Discount of `loyaltyPrice` in percent */
  loyaltyDiscount!: number | null;
  /** YYYY-MM-DD */
  validFrom!: string;
  /** YYYY-MM-DD */
  validTo!: string;

  /** Map an offer entity to its public shape */
  static from(offer: FlyerOffer): OfferDto {
    return {
      id: offer.id,
      pageId: offer.pageId,
      flyerId: offer.flyerId,
      shop: offer.shop,
      position: offer.position,
      title: offer.title,
      category: offer.category,
      boundaryBox: offer.boundaryBox,
      basePrice: offer.basePrice,
      discountedPrice: offer.discountedPrice,
      discount: offer.discount,
      loyaltyPrice: offer.loyaltyPrice,
      loyaltyDiscount: offer.loyaltyDiscount,
      validFrom: offer.validFrom,
      validTo: offer.validTo,
    };
  }
}
