import {
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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { zodSchema } from '../../common/openapi/zod-schema';
import { ParseShopKeyPipe } from '../../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { API_KEY_SECURITY } from '../../openapi';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';
import { SourceProviderExceptionFilter } from '../source-provider.exception-filter';
import {
  overridesSchemaOf,
  SourceProvidersService,
} from '../source-providers.service';
import {
  DiscoverDto,
  DiscoverResultDto,
  DiscoveredFlyerDto,
  SourceProviderDto,
} from './dto/source-provider.dto';

/** Body of POST /admin/source-providers/discover */
const discoverManyBodySchema = z
  .object({ shops: z.array(z.enum(ShopKeys)).min(1).optional() })
  .strict();

/** A missing body (Express 5 leaves `req.body` undefined) is treated as `{}`, meaning all enabled shops */
const discoverManySchema = z.preprocess(
  (body) => body ?? {},
  discoverManyBodySchema,
);

/** Admin routes (API key): source configs and dry-run discovery; nothing is downloaded or stored */
@ApiTags('admin: source providers')
@ApiBearerAuth()
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key' })
@Controller('admin/source-providers')
@UseGuards(ApiKeyGuard)
@UseFilters(SourceProviderExceptionFilter)
export class AdminSourceProvidersController {
  /** @param sources - Source providers entry point */
  constructor(private readonly sources: SourceProvidersService) {}

  /** Every shop with its effective config */
  @Get()
  list(): SourceProviderDto[] {
    const enabled = new Set(this.sources.enabledShops());
    return this.sources.shops().map((shop) => ({
      shop,
      enabled: enabled.has(shop),
      config: this.sources.getConfig(shop),
    }));
  }

  /** One shop with its effective config */
  @Get(':shop')
  @ApiParam({ name: 'shop', enum: ShopKeys })
  get(@Param('shop', ParseShopKeyPipe) shop: ShopKey): SourceProviderDto {
    return {
      shop,
      enabled: this.sources.enabledShops().includes(shop),
      config: this.sources.getConfig(shop),
    };
  }

  /** Dry run for one shop, optionally with one-off overrides in the body */
  @Post(':shop/discover')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'shop', enum: ShopKeys })
  @ApiBody({
    required: false,
    schema: {
      oneOf: ShopKeys.map((shop) => zodSchema(overridesSchemaOf(shop))),
    },
  })
  @ApiOkResponse({ type: DiscoverDto })
  @ApiBadRequestResponse({ description: 'Invalid overrides' })
  async discover(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Body() body: unknown,
  ): Promise<DiscoverDto> {
    const overrides = this.sources.parseOverrides(shop, body);
    return {
      config: this.sources.getConfig(shop, overrides),
      flyer: DiscoveredFlyerDto.from(
        await this.sources.discover(shop, overrides),
      ),
    };
  }

  /** Dry run for several shops (default: the enabled ones) */
  @Post('discover')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ required: false, schema: zodSchema(discoverManyBodySchema) })
  @ApiOkResponse({ type: DiscoverResultDto, isArray: true })
  async discoverMany(
    @Body(new ZodValidationPipe(discoverManySchema))
    body: z.infer<typeof discoverManySchema>,
  ): Promise<DiscoverResultDto[]> {
    const results = await this.sources.discoverMany(body.shops);
    return results.map((result) => DiscoverResultDto.from(result));
  }
}
