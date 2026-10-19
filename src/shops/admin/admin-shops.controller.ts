import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ParseShopKeyPipe } from '../../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  FlyerPipelineService,
  type PipelineAction,
} from '../../pipeline/flyer-pipeline.service';
import { API_KEY_SECURITY } from '../../openapi';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import { ShopKeys, type ShopKey } from '../shop.config.type';
import { ShopStateService } from '../shop-state.service';
import { ShopStateDto } from './dto/shop-state.dto';

/** Actions an admin can trigger per shop */
const actionSchema = z.enum(['load', 'refresh', 'reparse']);

/** Admin routes (API key): shop state and pipeline triggers */
@ApiTags('admin: shops')
@ApiBearerAuth()
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key' })
@Controller('admin/shops')
@UseGuards(ApiKeyGuard)
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
  async list(): Promise<ShopStateDto[]> {
    const states = await this.shopState.list();
    return states.map((state) => ShopStateDto.from(state));
  }

  /** One shop's state */
  @Get(':shop')
  @ApiParam({ name: 'shop', enum: ShopKeys })
  async get(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
  ): Promise<ShopStateDto> {
    return ShopStateDto.from(await this.shopState.get(shop));
  }

  /**
   * Start load / refresh / reparse in the background
   * 202 with the shop state · 409 shop busy · 410 images expired (reparse) · 404 no current flyer (reparse)
   */
  @Post(':shop/:action')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: 'shop', enum: ShopKeys })
  @ApiParam({ name: 'action', enum: actionSchema.options })
  @ApiAcceptedResponse({ type: ShopStateDto })
  @ApiNotFoundResponse({ description: 'No current flyer (reparse)' })
  @ApiConflictResponse({ description: 'Shop busy' })
  @ApiGoneResponse({ description: 'Page images expired in R2 (reparse)' })
  async trigger(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Param('action', new ZodValidationPipe(actionSchema))
    action: PipelineAction,
  ): Promise<ShopStateDto> {
    await this.pipeline.trigger({ shop, action });
    return ShopStateDto.from(await this.shopState.get(shop));
  }
}
