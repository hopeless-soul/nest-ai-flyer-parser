import { Module } from '@nestjs/common';
import { SHOP_CONFIGS } from '../shops/shop.config';
import { DEFAULT_FLYER_HTTP_OPTIONS, FlyerHttpService } from './http.service';
import { PageMaterializer } from './page-materializer.service';
import { SOURCE_PROVIDER_CLASSES } from './providers';
import type { SourceProvider } from './source-provider';
import { SourceProvidersService } from './source-providers.service';
import {
  FLYER_HTTP_OPTIONS,
  SHOP_CONFIGS_TOKEN,
  SOURCE_PROVIDERS,
} from './source-providers.tokens';

/**
 * Finds each shop's current flyer and turns it into local page images.
 * No controllers and no database; the API imports SourceProvidersAdminModule for the admin routes.
 */
@Module({
  providers: [
    { provide: FLYER_HTTP_OPTIONS, useValue: DEFAULT_FLYER_HTTP_OPTIONS },
    FlyerHttpService,
    PageMaterializer,
    { provide: SHOP_CONFIGS_TOKEN, useValue: SHOP_CONFIGS },
    ...SOURCE_PROVIDER_CLASSES,
    {
      provide: SOURCE_PROVIDERS,
      useFactory: (...providers: SourceProvider[]) => providers,
      inject: SOURCE_PROVIDER_CLASSES,
    },
    SourceProvidersService,
  ],
  exports: [SourceProvidersService],
})
export class SourceProvidersModule {}
