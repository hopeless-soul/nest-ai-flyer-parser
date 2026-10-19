import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ShopKeys, type ShopKey } from '../shops/shop.config.type';
import { OfferDto } from './dto/offer.dto';
import type { PageDto } from './dto/page.dto';
import type { ShopDto } from './dto/shop.dto';
import { FlyersService } from './flyers.service';
import { ProductCategoryKeys } from './types/product-category.type';

/** Query of GET /shops/:shop/offers */
const offersQuerySchema = z.object({
  category: z.enum(ProductCategoryKeys).optional(),
});

/** Public read API for the frontend */
@ApiTags('public')
@Controller()
export class FlyersController {
  /** @param flyers - Read queries */
  constructor(private readonly flyers: FlyersService) {}

  /** Shops with a current flyer */
  @Get('shops')
  shops(): Promise<ShopDto[]> {
    return this.flyers.availableShops();
  }

  /** Offers of the shop's current flyer; `?category=` filters */
  @Get('shops/:shop/offers')
  @ApiParam({ name: 'shop', enum: ShopKeys })
  @ApiQuery({ name: 'category', enum: ProductCategoryKeys, required: false })
  @ApiNotFoundResponse({ description: 'The shop has no current flyer' })
  async offers(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Query(new ZodValidationPipe(offersQuerySchema))
    query: z.infer<typeof offersQuerySchema>,
  ): Promise<OfferDto[]> {
    const offers = await this.flyers.currentOffers(shop, query.category);
    return offers.map((offer) => OfferDto.from(offer));
  }

  /** Pages of a flyer with presigned image URLs (valid 1 hour) */
  @Get('flyers/:id/pages')
  @ApiNotFoundResponse({ description: 'Flyer not found' })
  pages(@Param('id') id: string): Promise<PageDto[]> {
    return this.flyers.pagesOf(id);
  }
}
