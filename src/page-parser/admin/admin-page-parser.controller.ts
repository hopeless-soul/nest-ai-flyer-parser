import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import { AdminPageParserService } from './admin-page-parser.service';
import {
  listFlyersQuerySchema,
  offerInputSchema,
  offerPatchSchema,
  type OfferInput,
  type OfferPatch,
} from './offer.schema';

/** Admin routes (API key) over parser results: flyers, pages, offers */
@Controller('admin')
@UseGuards(ApiKeyGuard)
@UseFilters(PipelineExceptionFilter)
export class AdminPageParserController {
  /** @param admin - Admin queries and edits */
  constructor(private readonly admin: AdminPageParserService) {}

  /** Flyers, newest first; `?shop=` filters */
  @Get('flyers')
  listFlyers(
    @Query(new ZodValidationPipe(listFlyersQuerySchema))
    query: z.infer<typeof listFlyersQuerySchema>,
  ) {
    return this.admin.listFlyers(query.shop);
  }

  /** A flyer with its pages */
  @Get('flyers/:id')
  getFlyer(@Param('id') id: string) {
    return this.admin.getFlyer(id);
  }

  /** A page with its offers and a presigned image URL */
  @Get('pages/:pageId')
  getPage(@Param('pageId') pageId: string) {
    return this.admin.getPage(pageId);
  }

  /** Re-parse one page: 202 · 409 shop busy · 410 image expired */
  @Post('pages/:pageId/reparse')
  @HttpCode(HttpStatus.ACCEPTED)
  reparsePage(@Param('pageId') pageId: string) {
    return this.admin.reparsePage(pageId);
  }

  /** Add an offer by hand */
  @Post('pages/:pageId/offers')
  addOffer(
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(offerInputSchema)) body: OfferInput,
  ) {
    return this.admin.addOffer(pageId, body);
  }

  /** Edit an offer */
  @Patch('offers/:id')
  updateOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(offerPatchSchema)) body: OfferPatch,
  ) {
    return this.admin.updateOffer(id, body);
  }

  /** Delete an offer */
  @Delete('offers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteOffer(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteOffer(id);
  }
}
