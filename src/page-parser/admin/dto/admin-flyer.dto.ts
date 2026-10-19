import { ApiProperty } from '@nestjs/swagger';
import type { Flyer } from '../../../flyers/entities/flyer.entity';
import { FlyerStatus } from '../../../flyers/enums/flyer.enums';
import { ShopKeys, type ShopKey } from '../../../shops/shop.config.type';
import { AdminPageDto } from './admin-page.dto';

/** A flyer with its pipeline status */
export class AdminFlyerDto {
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  id!: string;
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** YYYY-MM-DD */
  validFrom!: string;
  /** YYYY-MM-DD */
  validTo!: string;
  @ApiProperty({ enum: FlyerStatus, enumName: 'FlyerStatus' })
  status!: FlyerStatus;
  pageCount!: number;
  /** Source details kept from discovery (source URL, provider meta) */
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  context!: Record<string, unknown> | null;
  createdAt!: Date;
  updatedAt!: Date;

  /** Map a flyer entity to its admin shape */
  static from(flyer: Flyer): AdminFlyerDto {
    return {
      id: flyer.id,
      shop: flyer.shop,
      validFrom: flyer.validFrom,
      validTo: flyer.validTo,
      status: flyer.status,
      pageCount: flyer.pageCount,
      context: flyer.context,
      createdAt: flyer.createdAt,
      updatedAt: flyer.updatedAt,
    };
  }
}

/** A flyer with its pages */
export class AdminFlyerDetailDto extends AdminFlyerDto {
  /** In page order */
  pages!: AdminPageDto[];

  /** Map a flyer entity (pages loaded) */
  static fromDetail(flyer: Flyer): AdminFlyerDetailDto {
    return {
      ...AdminFlyerDto.from(flyer),
      pages: flyer.pages.map((page) => AdminPageDto.from(page)),
    };
  }
}
