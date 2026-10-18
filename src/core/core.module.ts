import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';

/** Loaded in every mode: validated global config and the database connection */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envSchema,
    }),
    DatabaseModule,
  ],
})
export class CoreModule {}
