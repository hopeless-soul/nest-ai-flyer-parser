import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ShopConfig } from '../../../shops/shop.config.type';
import { ShopKeys, type ShopKey } from '../../../shops/shop.config.type';
import type {
  DiscoverResult,
  DiscoveredFlyer,
  PageSource,
} from '../../source-provider.types';

/** OpenAPI schema of the effective shop config; its `source` differs per shop, so it stays free-form */
const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'Effective ShopConfig (static config with overrides applied)',
} as const;

/** A shop's source config and whether scheduled runs include it */
export class SourceProviderDto {
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** Included in scheduled runs */
  enabled!: boolean;
  @ApiProperty(CONFIG_SCHEMA)
  config!: ShopConfig;
}

/** A flyer found on the shop site; nothing is downloaded yet */
export class DiscoveredFlyerDto {
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  flyerId!: string;
  /** YYYY-MM-DD */
  validFrom!: string;
  /** YYYY-MM-DD */
  validTo!: string;
  /** validTo came from defaultFlyerDuration instead of the site */
  validToEstimated!: boolean;
  sourceUrl!: string;
  /** One PDF to split, or ready page images */
  @ApiProperty({
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'url'],
        properties: {
          kind: { type: 'string', enum: ['pdf'] },
          url: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'urls'],
        properties: {
          kind: { type: 'string', enum: ['images'] },
          urls: { type: 'array', items: { type: 'string' } },
        },
      },
    ],
  })
  pages!: PageSource;
  /** Provider-specific details */
  @ApiProperty({ type: 'object', additionalProperties: true })
  meta!: Record<string, unknown>;

  /** Copy a discovered flyer */
  static from(flyer: DiscoveredFlyer): DiscoveredFlyerDto {
    return {
      shop: flyer.shop,
      flyerId: flyer.flyerId,
      validFrom: flyer.validFrom,
      validTo: flyer.validTo,
      validToEstimated: flyer.validToEstimated,
      sourceUrl: flyer.sourceUrl,
      pages: flyer.pages,
      meta: flyer.meta,
    };
  }
}

/** Dry-run discovery of one shop */
export class DiscoverDto {
  @ApiProperty(CONFIG_SCHEMA)
  config!: ShopConfig;
  flyer!: DiscoveredFlyerDto;
}

/** Outcome of one shop in a batch discovery: `flyer` when ok, `error` otherwise */
export class DiscoverResultDto {
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  ok!: boolean;
  @ApiPropertyOptional({ type: DiscoveredFlyerDto })
  flyer?: DiscoveredFlyerDto;
  @ApiPropertyOptional()
  error?: string;

  /** Map a batch result */
  static from(result: DiscoverResult): DiscoverResultDto {
    return result.ok
      ? {
          shop: result.shop,
          ok: true,
          flyer: DiscoveredFlyerDto.from(result.flyer),
        }
      : { shop: result.shop, ok: false, error: result.error };
  }
}
