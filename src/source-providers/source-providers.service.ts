import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { isValidTimeZone } from '../common/dates';
import { describeError } from '../common/errors';
import { SOURCE_OPTIONS_SCHEMAS } from '../shops/shop.config.schema';
import { ShopKeys } from '../shops/shop.config.type';
import type {
  ShopConfig,
  ShopConfigOverrides,
  ShopConfigs,
  ShopKey,
} from '../shops/shop.config.type';
import type { SourceProvider } from './source-provider';
import {
  InvalidOverridesError,
  type OverrideIssue,
} from './source-provider.errors';
import type {
  DiscoverResult,
  DiscoveredFlyer,
  LocalPage,
} from './source-provider.types';
import {
  SHOP_CONFIGS_TOKEN,
  SOURCE_PROVIDERS,
} from './source-providers.tokens';

/**
 * Entry point to the source providers, for the pipeline and the admin API.
 * Note: Admin overrides apply to one call only and are never stored.
 */
@Injectable()
export class SourceProvidersService implements OnModuleInit {
  private readonly logger = new Logger(SourceProvidersService.name);
  private readonly providers = new Map<ShopKey, SourceProvider>();

  /**
   * @param providers - Every provider instance (SOURCE_PROVIDERS)
   * @param configs - Static shop configs (SHOP_CONFIGS_TOKEN)
   */
  constructor(
    @Inject(SOURCE_PROVIDERS) providers: SourceProvider[],
    @Inject(SHOP_CONFIGS_TOKEN) private readonly configs: ShopConfigs,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.shop)) {
        throw new Error(
          `Two source providers registered for "${provider.shop}"`,
        );
      }
      this.providers.set(provider.shop, provider);
    }
  }

  /** Fail at boot, not at 06:00: every shop needs a provider and a valid source config */
  onModuleInit(): void {
    for (const shop of ShopKeys) {
      if (!this.providers.has(shop))
        throw new Error(`No source provider registered for "${shop}"`);

      const config = this.configs[shop];
      const result = SOURCE_OPTIONS_SCHEMAS[shop].safeParse(config.source);
      if (!result.success) {
        throw new Error(
          `Invalid SHOP_CONFIGS.${shop}.source:\n${z.prettifyError(result.error)}`,
        );
      }
      if (!isValidTimeZone(config.timezone)) {
        throw new Error(
          `Invalid SHOP_CONFIGS.${shop}.timezone "${config.timezone}"`,
        );
      }
    }
  }

  /** Every shop key */
  shops(): ShopKey[] {
    return [...ShopKeys];
  }

  /** Shops the cron runs */
  enabledShops(): ShopKey[] {
    return ShopKeys.filter((shop) => this.configs[shop].enabled);
  }

  /** SHOP_CONFIGS entry with validated overrides applied on top */
  getConfig<K extends ShopKey>(
    shop: K,
    overrides: ShopConfigOverrides<K> = {},
  ): ShopConfig<K> {
    const base = this.configs[shop] as ShopConfig<K>;
    return {
      ...base,
      timezone: overrides.timezone ?? base.timezone,
      defaultFlyerDuration:
        overrides.defaultFlyerDuration ?? base.defaultFlyerDuration,
      source: { ...base.source, ...overrides.source },
    };
  }

  /**
   * Validate raw overrides (an admin request body)
   * @throws InvalidOverridesError on unknown keys, wrong types or a URL on another host
   */
  parseOverrides<K extends ShopKey>(
    shop: K,
    raw: unknown,
  ): ShopConfigOverrides<K> {
    const sourceSchema = SOURCE_OPTIONS_SCHEMAS[shop] as z.ZodObject;
    const schema = z
      .object({
        source: sourceSchema.partial().strict().optional(),
        defaultFlyerDuration: z.number().int().min(1).max(31).optional(),
        timezone: z
          .string()
          .refine(isValidTimeZone, 'unknown IANA time zone')
          .optional(),
      })
      .strict();

    const result = schema.safeParse(raw ?? {});
    if (!result.success) {
      throw new InvalidOverridesError(
        shop,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      );
    }

    const overrides = result.data as ShopConfigOverrides<K>;
    this.assertSameHosts(shop, overrides);
    return overrides;
  }

  /** Find the shop's current flyer: one page fetch (Lidl: one more per flyer slug), no downloads */
  async discover<K extends ShopKey>(
    shop: K,
    overrides?: ShopConfigOverrides<K>,
  ): Promise<DiscoveredFlyer> {
    const started = Date.now();
    const flyer = await this.providerFor(shop).discover(
      this.getConfig(shop, overrides),
    );
    this.logger.log(
      `[${shop}] discovered ${flyer.flyerId} (${flyer.pages.kind}) in ${Date.now() - started} ms`,
    );
    return flyer;
  }

  /** Discover shops one after another; a failing shop never hides the others */
  async discoverMany(
    shops: ShopKey[] = this.enabledShops(),
  ): Promise<DiscoverResult[]> {
    const results: DiscoverResult[] = [];
    for (const shop of shops) {
      try {
        results.push({ shop, ok: true, flyer: await this.discover(shop) });
      } catch (error) {
        this.logger.warn(`[${shop}] discover failed: ${describeError(error)}`);
        results.push({ shop, ok: false, error: describeError(error) });
      }
    }
    return results;
  }

  /** Download `flyer` into `dir` and return its compressed page images */
  async materialize(flyer: DiscoveredFlyer, dir: string): Promise<LocalPage[]> {
    const started = Date.now();
    const pages = await this.providerFor(flyer.shop).materialize(
      flyer,
      this.getConfig(flyer.shop),
      dir,
    );
    this.logger.log(
      `[${flyer.shop}] materialized ${pages.length} pages of ${flyer.flyerId} in ${Date.now() - started} ms`,
    );
    return pages;
  }

  /** Provider of `shop`; every shop has one (checked in onModuleInit) */
  private providerFor<K extends ShopKey>(shop: K): SourceProvider<K> {
    const provider = this.providers.get(shop);
    if (!provider) throw new Error(`No source provider for "${shop}"`);
    return provider as SourceProvider<K>;
  }

  /**
   * Overrides may change paths and query strings, but never point the server at another host,
   * so the admin API can't be used to make the server fetch arbitrary URLs (SSRF)
   */
  private assertSameHosts<K extends ShopKey>(
    shop: K,
    overrides: ShopConfigOverrides<K>,
  ): void {
    const hostOf = (value: unknown) =>
      typeof value === 'string' && value.startsWith('https://')
        ? new URL(value).hostname
        : null;

    const allowed = new Set(
      Object.values(this.configs[shop].source)
        .map(hostOf)
        .filter((host): host is string => host !== null),
    );
    const issues: OverrideIssue[] = Object.entries(
      overrides.source ?? {},
    ).flatMap(([key, value]) => {
      const host = hostOf(value);
      return host && !allowed.has(host)
        ? [
            {
              path: `source.${key}`,
              message: `host ${host} is not allowed (allowed: ${[...allowed].join(', ')})`,
            },
          ]
        : [];
    });
    if (issues.length) throw new InvalidOverridesError(shop, issues);
  }
}
