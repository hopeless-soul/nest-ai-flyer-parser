import {
  Controller,
  Get,
  Header,
  type HttpRedirectResponse,
  Param,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiFoundResponse,
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
    // Note: offers exist only on parsed pages, whose image is always in R2
    return offers.map((offer) =>
      OfferDto.from(offer, this.flyers.stableImageUrl(offer.pageId)),
    );
  }

  /** Pages of a flyer with stable image URLs (safe to store) */
  @Get('flyers/:id/pages')
  @ApiNotFoundResponse({ description: 'Flyer not found' })
  pages(@Param('id') id: string): Promise<PageDto[]> {
    return this.flyers.pagesOf(id);
  }

  /** Page image: 302 to a fresh presigned R2 URL (valid 1 hour) */
  @Get('pages/:id/image')
  @Redirect()
  // Note: shorter than the 1-hour presign so a cached redirect never points at an expired URL
  @Header('Cache-Control', 'private, max-age=3000')
  @ApiFoundResponse({ description: 'Redirect to the image in R2' })
  @ApiNotFoundResponse({ description: 'Page or its image not found' })
  async pageImage(@Param('id') id: string): Promise<HttpRedirectResponse> {
    return { url: await this.flyers.pageImageUrl(id), statusCode: 302 };
  }
}
