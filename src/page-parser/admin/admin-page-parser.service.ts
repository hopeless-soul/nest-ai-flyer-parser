import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FlyerOffer } from '../../flyers/entities/flyer-offer.entity';
import { FlyerPage } from '../../flyers/entities/flyer-page.entity';
import { Flyer } from '../../flyers/entities/flyer.entity';
import { FlyerPipelineService } from '../../pipeline/flyer-pipeline.service';
import type { ShopKey } from '../../shops/shop.config.type';
import { R2Service } from '../../storage/r2.service';
import type { OfferInput, OfferPatch } from './offer.schema';

/** Admin queries and edits for parsed flyers, pages and offers */
@Injectable()
export class AdminPageParserService {
  /**
   * @param flyers - Flyer repository
   * @param pages - FlyerPage repository
   * @param offers - FlyerOffer repository
   * @param r2 - Presigned page image URLs
   * @param pipeline - Page reparse trigger (under the shop lease)
   */
  constructor(
    @InjectRepository(Flyer) private readonly flyers: Repository<Flyer>,
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    @InjectRepository(FlyerOffer)
    private readonly offers: Repository<FlyerOffer>,
    private readonly r2: R2Service,
    private readonly pipeline: FlyerPipelineService,
  ) {}

  /** Flyers, newest first, optionally of one shop */
  listFlyers(shop?: ShopKey): Promise<Flyer[]> {
    return this.flyers.find({
      where: shop ? { shop } : {},
      order: { validFrom: 'DESC' },
    });
  }

  /** A flyer with its pages (status, attempts, lastError, parserVersion, model) */
  async getFlyer(id: string): Promise<Flyer> {
    const flyer = await this.flyers.findOne({
      where: { id },
      relations: { pages: true },
      order: { pages: { pageNumber: 'ASC' } },
    });
    if (!flyer) throw new NotFoundException(`Flyer ${id} not found`);
    return flyer;
  }

  /** A page with its offers and a presigned image URL */
  async getPage(pageId: string) {
    const page = await this.pages.findOne({
      where: { id: pageId },
      relations: { offers: true },
      order: { offers: { position: 'ASC' } },
    });
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);
    return {
      ...page,
      imageUrl: page.imageKey ? await this.r2.presign(page.imageKey) : null,
    };
  }

  /** Re-parse one page in the background (shop lease, prechecks first) */
  async reparsePage(pageId: string): Promise<FlyerPage> {
    const page = await this.findPageWithFlyer(pageId);
    await this.pipeline.trigger({
      shop: page.flyer.shop,
      action: 'reparse',
      flyerId: page.flyerId,
      pageIds: [page.id],
    });
    return page;
  }

  /** Add an offer by hand at the end of the page */
  async addOffer(pageId: string, input: OfferInput): Promise<FlyerOffer> {
    const page = await this.findPageWithFlyer(pageId);
    const last = await this.offers.maximum('position', { pageId });
    return this.offers.save(
      this.offers.create({
        title: input.title,
        category: input.category ?? null,
        boundaryBox: input.boundaryBox,
        basePrice: input.basePrice ?? null,
        discountedPrice: input.discountedPrice ?? null,
        discount: input.discount ?? null,
        loyaltyPrice: input.loyaltyPrice ?? null,
        loyaltyDiscount: input.loyaltyDiscount ?? null,
        position: (last ?? -1) + 1,
        pageId: page.id,
        flyerId: page.flyerId,
        shop: page.flyer.shop,
        validFrom: page.flyer.validFrom,
        validTo: page.flyer.validTo,
        cropKey: null,
      }),
    );
  }

  /** Change the given fields of an offer */
  async updateOffer(id: string, patch: OfferPatch): Promise<FlyerOffer> {
    const offer = await this.offers.findOneBy({ id });
    if (!offer) throw new NotFoundException(`Offer ${id} not found`);
    Object.assign(offer, patch);
    return this.offers.save(offer);
  }

  /** Delete an offer */
  async deleteOffer(id: string): Promise<void> {
    const result = await this.offers.delete(id);
    if (!result.affected) throw new NotFoundException(`Offer ${id} not found`);
  }

  /** A page with its flyer; 404 if missing */
  private async findPageWithFlyer(pageId: string): Promise<FlyerPage> {
    const page = await this.pages.findOne({
      where: { id: pageId },
      relations: { flyer: true },
    });
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);
    return page;
  }
}
