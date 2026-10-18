import { DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from './app-mode';
import { CoreModule } from './core/core.module';
import { ApiModule } from './api/api.module';
import { WorkerModule } from './worker/worker.module';

@Module({})
export class AppModule {
  static forMode(mode: AppMode): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule,
        ...(mode === 'api' || mode === 'all' ? [ApiModule] : []),
        ...(mode === 'worker' || mode === 'all' ? [WorkerModule] : []),
      ],
    };
  }
}
