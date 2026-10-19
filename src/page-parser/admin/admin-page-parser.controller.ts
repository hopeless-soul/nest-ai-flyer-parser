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
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { zodSchema } from '../../common/openapi/zod-schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { API_KEY_SECURITY } from '../../openapi';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import { ShopKeys } from '../../shops/shop.config.type';
import { AdminPageParserService } from './admin-page-parser.service';
import { AdminFlyerDetailDto, AdminFlyerDto } from './dto/admin-flyer.dto';
import { AdminOfferDto } from './dto/admin-offer.dto';
import { AdminPageDetailDto, AdminPageDto } from './dto/admin-page.dto';
import {
  listFlyersQuerySchema,
  offerInputSchema,
  offerPatchSchema,
  type OfferInput,
  type OfferPatch,
} from './offer.schema';

/** Admin routes (API key) over parser results: flyers, pages, offers */
@ApiTags('admin: flyers')
@ApiBearerAuth()
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key' })
@Controller('admin')
@UseGuards(ApiKeyGuard)
@UseFilters(PipelineExceptionFilter)
export class AdminPageParserController {
  /** @param admin - Admin queries and edits */
  constructor(private readonly admin: AdminPageParserService) {}

  /** Flyers, newest first; `?shop=` filters */
  @Get('flyers')
  @ApiQuery({ name: 'shop', enum: ShopKeys, required: false })
  async listFlyers(
    @Query(new ZodValidationPipe(listFlyersQuerySchema))
    query: z.infer<typeof listFlyersQuerySchema>,
  ): Promise<AdminFlyerDto[]> {
    const flyers = await this.admin.listFlyers(query.shop);
    return flyers.map((flyer) => AdminFlyerDto.from(flyer));
  }

  /** A flyer with its pages */
  @Get('flyers/:id')
  @ApiNotFoundResponse({ description: 'Flyer not found' })
  async getFlyer(@Param('id') id: string): Promise<AdminFlyerDetailDto> {
    return AdminFlyerDetailDto.fromDetail(await this.admin.getFlyer(id));
  }

  /** A page with its offers and a presigned image URL */
  @Get('pages/:pageId')
  @ApiNotFoundResponse({ description: 'Page not found' })
  async getPage(@Param('pageId') pageId: string): Promise<AdminPageDetailDto> {
    const page = await this.admin.getPage(pageId);
    return AdminPageDetailDto.fromDetail(page, page.imageUrl);
  }

  /** Re-parse one page: 202 · 409 shop busy · 410 image expired */
  @Post('pages/:pageId/reparse')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: AdminPageDto })
  @ApiNotFoundResponse({ description: 'Page not found' })
  @ApiConflictResponse({ description: 'Shop busy' })
  @ApiGoneResponse({ description: 'Page image expired in R2' })
  async reparsePage(@Param('pageId') pageId: string): Promise<AdminPageDto> {
    return AdminPageDto.from(await this.admin.reparsePage(pageId));
  }

  /** Add an offer by hand */
  @Post('pages/:pageId/offers')
  @ApiBody({ schema: zodSchema(offerInputSchema) })
  @ApiCreatedResponse({ type: AdminOfferDto })
  @ApiNotFoundResponse({ description: 'Page not found' })
  async addOffer(
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(offerInputSchema)) body: OfferInput,
  ): Promise<AdminOfferDto> {
    return AdminOfferDto.from(await this.admin.addOffer(pageId, body));
  }

  /** Edit an offer */
  @Patch('offers/:id')
  @ApiBody({ schema: zodSchema(offerPatchSchema) })
  @ApiNotFoundResponse({ description: 'Offer not found' })
  async updateOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(offerPatchSchema)) body: OfferPatch,
  ): Promise<AdminOfferDto> {
    return AdminOfferDto.from(await this.admin.updateOffer(id, body));
  }

  /** Delete an offer */
  @Delete('offers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'Offer not found' })
  deleteOffer(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.admin.deleteOffer(id);
  }
}
