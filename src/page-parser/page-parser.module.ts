import { Module } from '@nestjs/common';
import { FlyersModule } from '../flyers/flyers.module';
import { StorageModule } from '../storage/storage.module';
import { GeminiClient } from './gemini.client';
import { PageParserService } from './page-parser.service';

/** AI page parsing; no routes (PageParserAdminModule adds them for the API) */
@Module({
  imports: [FlyersModule, StorageModule],
  providers: [GeminiClient, PageParserService],
  exports: [PageParserService],
})
export class PageParserModule {}
