import { DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppMode } from './app-mode';
import { CoreModule } from './core/core.module';
import { FlyersModule } from './flyers/flyers.module';
import { ShopsModule } from './shops/shops.module';

/** Feature modules of the HTTP API (`api`, `all`); completed in Task 12 */
const API_MODULES: Type[] = [ShopsModule, FlyersModule];

/** Feature modules of the background worker (`worker`, `all`); completed in Task 12 */
const WORKER_MODULES: Type[] = [ShopsModule, FlyersModule];

/** Root module; `forMode` picks the feature modules for the process role */
@Module({})
export class AppModule {
  /** Build the root module for `mode`; a module needed by both roles is imported once */
  static forMode(mode: AppMode): DynamicModule {
    const modules = new Set<Type>([
      ...(mode === 'worker' ? [] : API_MODULES),
      ...(mode === 'api' ? [] : WORKER_MODULES),
    ]);
    return { module: AppModule, imports: [CoreModule, ...modules] };
  }
}
