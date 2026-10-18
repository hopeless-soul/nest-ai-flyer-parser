import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  FlyerPipelineService,
  type PipelineAction,
} from '../../pipeline/flyer-pipeline.service';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import type { ShopKey } from '../shop.config.type';
import { ShopStateService } from '../shop-state.service';

/** Actions an admin can trigger per shop */
const actionSchema = z.enum(['load', 'refresh', 'reparse']);

/** Admin routes (unguarded): shop state and pipeline triggers */
@Controller('admin/shops')
@UseFilters(PipelineExceptionFilter)
export class AdminShopsController {
  /**
   * @param shopState - Shop state reads
   * @param pipeline - Run triggers
   */
  constructor(
    private readonly shopState: ShopStateService,
    private readonly pipeline: FlyerPipelineService,
  ) {}

  /** Every shop: current flyer, lease, retry, lastError */
  @Get()
  list() {
    return this.shopState.list();
  }

  /** One shop's state */
  @Get(':shop')
  get(@Param('shop', ParseShopKeyPipe) shop: ShopKey) {
    return this.shopState.get(shop);
  }

  /**
   * Start load / refresh / reparse in the background
   * 202 with the shop state · 409 shop busy · 410 images expired (reparse) · 404 no current flyer (reparse)
   */
  @Post(':shop/:action')
  @HttpCode(HttpStatus.ACCEPTED)
  async trigger(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Param('action', new ZodValidationPipe(actionSchema))
    action: PipelineAction,
  ) {
    await this.pipeline.trigger({ shop, action });
    return this.shopState.get(shop);
  }
}
