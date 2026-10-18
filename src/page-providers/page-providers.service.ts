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
import type { PageProvider } from './page-provider';
import {
  ShopConfigOverrideError,
  type OverrideIssue,
} from './page-provider.errors';
import type { ResolveResult, ResolvedFlyer } from './page-provider.types';
import { PAGE_PROVIDERS, SHOP_CONFIGS_TOKEN } from './page-providers.tokens';

/**
 * Entry point to the page providers, for the worker (scheduled runs) and the admin API (dry runs).
 * Consumes SHOP_CONFIGS; admin overrides apply to one call only and are never stored here.
 */
@Injectable()
export class PageProvidersService implements OnModuleInit {
  private readonly logger = new Logger(PageProvidersService.name);
  private readonly providers = new Map<ShopKey, PageProvider>();

  constructor(
    @Inject(PAGE_PROVIDERS) providers: PageProvider[],
    @Inject(SHOP_CONFIGS_TOKEN) private readonly configs: ShopConfigs,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.shop)) {
        throw new Error(`Two page providers registered for "${provider.shop}"`);
      }
      this.providers.set(provider.shop, provider);
    }
  }

  /** Fail at boot, not at 06:00: every shop needs a provider and a valid source config */
  onModuleInit(): void {
    for (const shop of ShopKeys) {
      if (!this.providers.has(shop))
        throw new Error(`No page provider registered for "${shop}"`);

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

  shops(): ShopKey[] {
    return [...ShopKeys];
  }

  /** Shops the scheduler runs */
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
   * Validate raw overrides (an admin request body, or JSON stored with a refresh request)
   * @throws ShopConfigOverrideError on unknown keys, wrong types or a URL on another host
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
      throw new ShopConfigOverrideError(
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
  async resolve<K extends ShopKey>(
    shop: K,
    overrides?: ShopConfigOverrides<K>,
  ): Promise<ResolvedFlyer> {
    const provider = this.providers.get(shop) as PageProvider<K>;
    const started = Date.now();
    const flyer = await provider.resolve(this.getConfig(shop, overrides));
    this.logger.log(
      `[${shop}] resolved ${flyer.flyerId} (${flyer.pages.kind}) in ${Date.now() - started} ms`,
    );
    return flyer;
  }

  /** Resolve shops one after another; a failing shop never hides the others */
  async resolveMany(
    shops: ShopKey[] = this.enabledShops(),
  ): Promise<ResolveResult[]> {
    const results: ResolveResult[] = [];
    for (const shop of shops) {
      try {
        results.push({ shop, ok: true, flyer: await this.resolve(shop) });
      } catch (error) {
        this.logger.warn(`[${shop}] resolve failed: ${describeError(error)}`);
        results.push({ shop, ok: false, error: describeError(error) });
      }
    }
    return results;
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
    if (issues.length) throw new ShopConfigOverrideError(shop, issues);
  }
}
