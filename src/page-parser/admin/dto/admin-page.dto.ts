import { ApiProperty } from '@nestjs/swagger';
import type { FlyerPage } from '../../../flyers/entities/flyer-page.entity';
import { PageStatus } from '../../../flyers/enums/page.enums';
import { AdminOfferDto } from './admin-offer.dto';

/** A flyer page with its parse state */
export class AdminPageDto {
  /** e.g. kaufland_2026-10-14_2026-10-20_page_07 */
  id!: string;
  flyerId!: string;
  @ApiProperty({ enum: PageStatus, enumName: 'PageStatus' })
  status!: PageStatus;
  /** 1-based */
  pageNumber!: number;
  /** R2 key, e.g. flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.webp */
  imageKey!: string | null;
  imageHash!: string | null;
  /** Pixels */
  width!: number | null;
  /** Pixels */
  height!: number | null;
  /** PARSER_VERSION that produced the offers */
  parserVersion!: number | null;
  /** Gemini model that produced the offers */
  model!: string | null;
  /** Parse attempts in the last run */
  attempts!: number;
  lastError!: string | null;
  parsedAt!: Date | null;

  /** Map a page entity to its admin shape */
  static from(page: FlyerPage): AdminPageDto {
    return {
      id: page.id,
      flyerId: page.flyerId,
      status: page.status,
      pageNumber: page.pageNumber,
      imageKey: page.imageKey,
      imageHash: page.imageHash,
      width: page.width,
      height: page.height,
      parserVersion: page.parserVersion,
      model: page.model,
      attempts: page.attempts,
      lastError: page.lastError,
      parsedAt: page.parsedAt,
    };
  }
}

/** A page with its offers and a presigned image URL */
export class AdminPageDetailDto extends AdminPageDto {
  /** Presigned URL, valid 1 hour; null when the image is not in R2 */
  imageUrl!: string | null;
  /** In page order */
  offers!: AdminOfferDto[];

  /** Map a page entity (offers loaded) and its image URL */
  static fromDetail(
    page: FlyerPage,
    imageUrl: string | null,
  ): AdminPageDetailDto {
    return {
      ...AdminPageDto.from(page),
      imageUrl,
      offers: page.offers.map((offer) => AdminOfferDto.from(offer)),
    };
  }
}
