import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { ShopsModule } from './shops/shops.module';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

@Module({
  imports: [
    DatabaseModule,
    ShopsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: z.object({
        APP_MODE: z.enum(['api', 'worker', 'all']).default('all'),
        NODE_ENV: z.enum(['development', 'production', 'worker']).default('development'),
        PORT: z.coerce.number().default(5432),
        DB_NAME: z.string().nonempty(),
        DB_USERNAME: z.string().nonempty(),
        DB_PASSWORD: z.string().nonempty(),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
