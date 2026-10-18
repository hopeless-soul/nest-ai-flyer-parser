import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { ShopKey } from '../shops/shop.config.type';
import { FlyersService } from './flyers.service';
import { ProductCategoryKeys } from './types/product-category.type';

/** Query of GET /shops/:shop/offers */
const offersQuerySchema = z.object({
  category: z.enum(ProductCategoryKeys).optional(),
});

/** Public read API for the frontend */
@Controller()
export class FlyersController {
  /** @param flyers - Read queries */
  constructor(private readonly flyers: FlyersService) {}

  /** Shops with a current flyer */
  @Get('shops')
  shops() {
    return this.flyers.availableShops();
  }

  /** Offers of the shop's current flyer; `?category=` filters */
  @Get('shops/:shop/offers')
  offers(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Query(new ZodValidationPipe(offersQuerySchema))
    query: z.infer<typeof offersQuerySchema>,
  ) {
    return this.flyers.currentOffers(shop, query.category);
  }

  /** Pages of a flyer with presigned image URLs (valid 1 hour) */
  @Get('flyers/:id/pages')
  pages(@Param('id') id: string) {
    return this.flyers.pagesOf(id);
  }
}
