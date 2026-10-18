import { Module } from '@nestjs/common';
import { SHOP_CONFIGS } from '../shops/shop.config';
import {
  DEFAULT_FLYER_HTTP_OPTIONS,
  FlyerHttpService,
} from './http/flyer-http.service';
import type { PageProvider } from './page-provider';
import { PageProvidersService } from './page-providers.service';
import {
  FLYER_HTTP_OPTIONS,
  PAGE_PROVIDERS,
  SHOP_CONFIGS_TOKEN,
} from './page-providers.tokens';
import { PAGE_PROVIDER_CLASSES } from './providers';

/**
 * Finds each shop's current flyer. No controllers and no database, so the worker can import it
 * without the admin routes; the API imports PageProvidersAdminModule instead.
 */
@Module({
  providers: [
    { provide: FLYER_HTTP_OPTIONS, useValue: DEFAULT_FLYER_HTTP_OPTIONS },
    FlyerHttpService,
    { provide: SHOP_CONFIGS_TOKEN, useValue: SHOP_CONFIGS },
    ...PAGE_PROVIDER_CLASSES,
    {
      provide: PAGE_PROVIDERS,
      useFactory: (...providers: PageProvider[]) => providers,
      inject: PAGE_PROVIDER_CLASSES,
    },
    PageProvidersService,
  ],
  // Note: FlyerHttpService is exported for the pipeline (PDF and page image downloads)
  exports: [PageProvidersService, FlyerHttpService],
})
export class PageProvidersModule {}
