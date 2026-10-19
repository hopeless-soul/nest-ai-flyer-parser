import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  /**
   * @param pages - FlyerPage repository
   * @param offers - FlyerOffer repository
   * @param shopState - Current flyer per shop
   * @param r2 - Presigned page image URLs
   */
  constructor(
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    @InjectRepository(FlyerOffer)
    private readonly offers: Repository<FlyerOffer>,
    private readonly shopState: ShopStateService,
    private readonly r2: R2Service,
  ) {}

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

  /** Pages of a flyer with presigned image URLs (null when the image is not in R2) */
  async pagesOf(flyerId: string): Promise<PageDto[]> {
    const pages = await this.pages.find({
      where: { flyerId },
      order: { pageNumber: 'ASC' },
    });
    if (!pages.length)
      throw new NotFoundException(`Flyer ${flyerId} not found`);

    return Promise.all(
      pages.map(async (page) => ({
        id: page.id,
        pageNumber: page.pageNumber,
        status: page.status,
        width: page.width,
        height: page.height,
        imageUrl: page.imageKey ? await this.r2.presign(page.imageKey) : null,
      })),
    );
  }
}
