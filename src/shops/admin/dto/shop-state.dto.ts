import { ApiProperty } from '@nestjs/swagger';
import { FlyerSummaryDto } from '../../../flyers/dto/shop.dto';
import type { ShopState } from '../../entities/shop-state.entity';
import { RetryReason } from '../../enums/shop.enums';
import { ShopKeys, type ShopKey } from '../../shop.config.type';

/** Scheduled retry of a shop */
export class RetryStateDto {
  @ApiProperty({ enum: RetryReason, enumName: 'RetryReason', nullable: true })
  reason!: RetryReason | null;
  attempts!: number;
  /** When the retry tick picks the shop up; null = no retry scheduled */
  at!: Date | null;
}

/** Runtime state of a shop: current flyer, lease and retry */
export class ShopStateDto {
  @ApiProperty({ enum: ShopKeys })
  shop!: ShopKey;
  /** A READY or PARTIAL flyer is shown to the frontend */
  isAvailable!: boolean;
  /** Waiting for the site to publish a newer flyer */
  awaitingNewFlyer!: boolean;
  @ApiProperty({ type: FlyerSummaryDto, nullable: true })
  currentFlyer!: FlyerSummaryDto | null;
  retry!: RetryStateDto;
  /** A sync holds the shop until then; null or past = free */
  lockedUntil!: Date | null;
  lastAttemptAt!: Date | null;
  lastSuccessAt!: Date | null;
  lastError!: string | null;
  updatedAt!: Date;

  /** Map a shop state entity (currentFlyer loaded) */
  static from(state: ShopState): ShopStateDto {
    return {
      shop: state.shop,
      isAvailable: state.isAvailiable,
      awaitingNewFlyer: state.awaitingNewFlyer,
      currentFlyer: FlyerSummaryDto.from(state.currentFlyer),
      retry: {
        reason: state.retry.reason,
        attempts: state.retry.attempts,
        at: state.retry.at,
      },
      lockedUntil: state.lockedUntil,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    };
  }
}
