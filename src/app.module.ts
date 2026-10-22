import { DynamicModule, Module, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { AppMode } from './app-mode';
import { throttlerConfig } from './config/throttler.config';
import { CoreModule } from './core/core.module';
import { FlyersModule } from './flyers/flyers.module';
import { PageParserAdminModule } from './page-parser/admin/page-parser-admin.module';
import { ShopsAdminModule } from './shops/admin/shops-admin.module';
import { SourceProvidersAdminModule } from './source-providers/admin/source-providers-admin.module';
import { WorkerModule } from './worker/worker.module';

/** Feature modules of the HTTP API (`api`, `all`): public read API + API-key-guarded admin routes */
const API_MODULES: (Type | DynamicModule)[] = [
  ThrottlerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: throttlerConfig,
  }),
  FlyersModule,
  ShopsAdminModule,
  SourceProvidersAdminModule,
  PageParserAdminModule,
];

/** Feature modules of the background worker (`worker`, `all`) */
const WORKER_MODULES: Type[] = [WorkerModule];

/** Root module; `forMode` picks the feature modules for the process role */
@Module({})
export class AppModule {
  /** Build the root module for `mode`; a module needed by both roles is imported once */
  static forMode(mode: AppMode): DynamicModule {
    const api = mode !== 'worker';
    const modules = new Set<Type | DynamicModule>([
      ...(api ? API_MODULES : []),
      ...(mode === 'api' ? [] : WORKER_MODULES),
    ]);
    return {
      module: AppModule,
      imports: [CoreModule, ...modules],
      // Note: the guard needs ThrottlerModule, which only the API imports
      providers: api ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : [],
    };
  }
}
