import {
  Body,
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
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';
import { SourceProviderExceptionFilter } from '../source-provider.exception-filter';
import { SourceProvidersService } from '../source-providers.service';

/** Body of POST /admin/source-providers/discover */
const discoverManySchema = z
  .object({ shops: z.array(z.enum(ShopKeys)).min(1).optional() })
  .strict();

/** Admin routes (unguarded): source configs and dry-run discovery; nothing is downloaded or stored */
@Controller('admin/source-providers')
@UseFilters(SourceProviderExceptionFilter)
export class AdminSourceProvidersController {
  /** @param sources - Source providers entry point */
  constructor(private readonly sources: SourceProvidersService) {}

  /** Every shop with its effective config */
  @Get()
  list() {
    const enabled = new Set(this.sources.enabledShops());
    return this.sources.shops().map((shop) => ({
      shop,
      enabled: enabled.has(shop),
      config: this.sources.getConfig(shop),
    }));
  }

  /** One shop with its effective config */
  @Get(':shop')
  get(@Param('shop', ParseShopKeyPipe) shop: ShopKey) {
    return {
      shop,
      enabled: this.sources.enabledShops().includes(shop),
      config: this.sources.getConfig(shop),
    };
  }

  /** Dry run for one shop, optionally with one-off overrides in the body */
  @Post(':shop/discover')
  @HttpCode(HttpStatus.OK)
  async discover(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Body() body: unknown,
  ) {
    const overrides = this.sources.parseOverrides(shop, body);
    return {
      config: this.sources.getConfig(shop, overrides),
      flyer: await this.sources.discover(shop, overrides),
    };
  }

  /** Dry run for several shops (default: the enabled ones) */
  @Post('discover')
  @HttpCode(HttpStatus.OK)
  discoverMany(
    @Body(new ZodValidationPipe(discoverManySchema))
    body: z.infer<typeof discoverManySchema>,
  ) {
    return this.sources.discoverMany(body.shops);
  }
}
