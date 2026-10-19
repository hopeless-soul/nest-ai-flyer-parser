import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env.schema';
import { SHOP_CONFIGS } from '../shops/shop.config';
import type { ShopKey } from '../shops/shop.config.type';
import { ShopStateService } from '../shops/shop-state.service';
import { R2Service } from '../storage/r2.service';
import { FlyerOffer } from './entities/flyer-offer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import type { PageDto } from './dto/page.dto';
import { FlyerSummaryDto, type ShopDto } from './dto/shop.dto';
import type { ProductCategoryKey } from './types/product-category.type';

/** Read-only queries for the public API */
@Injectable()
export class FlyersService {
  /** Public base URL of this API, without a trailing slash */
  private readonly publicUrl: string;

  /**
   * @param pages - FlyerPage repository
   * @param offers - FlyerOffer repository
   * @param shopState - Current flyer per shop
   * @param r2 - Presigned page image URLs
   * @param config - API_PUBLIC_URL for stable image links
   */
  constructor(
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    @InjectRepository(FlyerOffer)
    private readonly offers: Repository<FlyerOffer>,
    private readonly shopState: ShopStateService,
    private readonly r2: R2Service,
    config: ConfigService<Env, true>,
  ) {
    this.publicUrl = config.get('API_PUBLIC_URL', { infer: true });
  }

  /** Shops with a READY or PARTIAL current flyer */
  async availableShops(): Promise<ShopDto[]> {
    const states = await this.shopState.listAvailable();
    return states.map((state) => ({
      shop: state.shop,
      name: SHOP_CONFIGS[state.shop].name,
      flyer: FlyerSummaryDto.from(state.currentFlyer),
    }));
  }

  /** Offers of the shop's current flyer in page order, optionally of one category */
  async currentOffers(
    shop: ShopKey,
    category?: ProductCategoryKey,
  ): Promise<FlyerOffer[]> {
    const state = await this.shopState.get(shop);
    if (!state.isAvailiable || !state.currentFlyerId) {
      throw new NotFoundException(`${shop} has no current flyer`);
    }

    const query = this.offers
      .createQueryBuilder('offer')
      .innerJoin('offer.page', 'page')
      .where('offer.flyerId = :flyerId', { flyerId: state.currentFlyerId })
      .orderBy('page.pageNumber', 'ASC')
      .addOrderBy('offer.position', 'ASC');
    if (category) {
      query.andWhere(':category = ANY(offer.category)', { category });
    }
    return query.getMany();
  }

  /** Pages of a flyer with stable image URLs (null when the image is not in R2) */
  async pagesOf(flyerId: string): Promise<PageDto[]> {
    const pages = await this.pages.find({
      where: { flyerId },
      order: { pageNumber: 'ASC' },
    });
    if (!pages.length)
      throw new NotFoundException(`Flyer ${flyerId} not found`);

    return pages.map((page) => ({
      id: page.id,
      pageNumber: page.pageNumber,
      status: page.status,
      width: page.width,
      height: page.height,
      imageUrl: page.imageKey ? this.stableImageUrl(page.id) : null,
    }));
  }

  /** Stable URL of a page image (`GET /pages/:id/image`); never expires, safe for the frontend to store */
  stableImageUrl(pageId: string): string {
    return `${this.publicUrl}/pages/${encodeURIComponent(pageId)}/image`;
  }

  /** Fresh presigned R2 URL of a page image; 404 when the page or its image is missing */
  async pageImageUrl(pageId: string): Promise<string> {
    const page = await this.pages.findOne({
      where: { id: pageId },
      select: { id: true, imageKey: true },
    });
    if (!page?.imageKey)
      throw new NotFoundException(`Image of page ${pageId} not found`);
    return this.r2.presign(page.imageKey);
  }
}
