import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { ShopsModule } from '../shops/shops.module';

/** Loaded in every mode: config, database connection, entities */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DatabaseModule,
    ShopsModule,
  ],
})
export class CoreModule {}
