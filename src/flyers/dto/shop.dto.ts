import { ApiProperty } from '@nestjs/swagger';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';
import type { Flyer } from '../entities/flyer.entity';

/** A flyer's id and validity */
export class FlyerSummaryDto {
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  id!: string;
  /** YYYY-MM-DD */
  validFrom!: string;
  /** YYYY-MM-DD */
  validTo!: string;

  /** Map a flyer entity (null-safe) to its summary */
  static from(flyer: Flyer | null): FlyerSummaryDto | null {
    return flyer
      ? { id: flyer.id, validFrom: flyer.validFrom, validTo: flyer.validTo }
      : null;
  }
}

/** A shop the frontend can show, with its current flyer */
export class ShopDto {
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** Display name */
  name!: string;
  @ApiProperty({ type: FlyerSummaryDto, nullable: true })
  flyer!: FlyerSummaryDto | null;
}
