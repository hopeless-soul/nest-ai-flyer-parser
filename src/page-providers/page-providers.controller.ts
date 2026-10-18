import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { ShopKeys, type ShopKey } from '../shops/shop.config.type';
import { PageProviderExceptionFilter } from './page-provider.exception-filter';
import { PageProvidersService } from './page-providers.service';
import { ParseShopKeyPipe } from './pipes/parse-shop-key.pipe';

const resolveManySchema = z
  .object({ shops: z.array(z.enum(ShopKeys)).min(1).optional() })
  .strict();

/** Dry runs: what the worker would download, nothing is downloaded or stored */
@Controller('admin/page-providers')
@UseGuards(AdminApiKeyGuard)
@UseFilters(PageProviderExceptionFilter)
export class PageProvidersController {
  constructor(private readonly pageProviders: PageProvidersService) {}

  /** Every shop with its effective config */
  @Get()
  list() {
    const enabled = new Set(this.pageProviders.enabledShops());
    return this.pageProviders.shops().map((shop) => ({
      shop,
      enabled: enabled.has(shop),
      config: this.pageProviders.getConfig(shop),
    }));
  }

  /** One shop, optionally with one-off overrides in the body */
  @Post(':shop/resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Body() body: unknown,
  ) {
    const overrides = this.pageProviders.parseOverrides(shop, body);
    return {
      config: this.pageProviders.getConfig(shop, overrides),
      flyer: await this.pageProviders.resolve(shop, overrides),
    };
  }

  /** Several shops (default: enabled ones), each with its stored config */
  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  resolveMany(@Body() body: unknown) {
    const parsed = resolveManySchema.safeParse(body ?? {});
    if (!parsed.success)
      throw new BadRequestException(z.prettifyError(parsed.error));
    return this.pageProviders.resolveMany(parsed.data.shops);
  }
}
