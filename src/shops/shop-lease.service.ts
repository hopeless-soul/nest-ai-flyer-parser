import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { describeError } from '../common/errors';
import { ShopState } from './entities/shop-state.entity';
import type { ShopKey } from './shop.config.type';

/** Lease length; a crashed process frees the shop after this */
const LEASE_MS = 15 * 60_000;
/** How often a running pipeline extends its lease */
const RENEW_EVERY_MS = 5 * 60_000;

/** Another run (worker or API) holds the shop's lease */
export class LeaseBusyError extends Error {
  /**
   * @param shop - Shop that is busy
   * @param lockedUntil - When the current lease expires, if known
   */
  constructor(
    readonly shop: ShopKey,
    readonly lockedUntil: Date | null,
  ) {
    super(
      `[${shop}] another run holds the lease${lockedUntil ? ` until ${lockedUntil.toISOString()}` : ''}`,
    );
    this.name = 'LeaseBusyError';
  }
}

/** A held lease; renewed in the background until released */
export interface ShopLease {
  readonly shop: ShopKey;
  /** Stop renewing and free the shop */
  release(): Promise<void>;
}

/**
 * One pipeline run per shop at a time, across processes: `ShopState.lockedUntil` is a lease taken with
 * an atomic UPDATE. The exact `lockedUntil` value works as the owner token for renew and release.
 */
@Injectable()
export class ShopLeaseService {
  private readonly logger = new Logger(ShopLeaseService.name);

  /** @param states - ShopState repository */
  constructor(
    @InjectRepository(ShopState)
    private readonly states: Repository<ShopState>,
  ) {}

  /**
   * Take the shop's lease
   * @throws LeaseBusyError if another run holds an unexpired lease
   */
  async acquire(shop: ShopKey): Promise<ShopLease> {
    let until = new Date(Date.now() + LEASE_MS);
    const taken = await this.states
      .createQueryBuilder()
      .update(ShopState)
      .set({ lockedUntil: until })
      .where('shop = :shop', { shop })
      .andWhere('("lockedUntil" IS NULL OR "lockedUntil" < now())')
      .execute();
    if (!taken.affected) {
      const state = await this.states.findOneBy({ shop });
      throw new LeaseBusyError(shop, state?.lockedUntil ?? null);
    }

    /** Extend the lease by another LEASE_MS while we still own it */
    const renew = async (): Promise<void> => {
      const next = new Date(Date.now() + LEASE_MS);
      if (await this.move(shop, until, next)) until = next;
      else this.logger.warn(`[${shop}] lease was lost before renewal`);
    };
    const timer = setInterval(() => {
      renew().catch((error) =>
        this.logger.warn(
          `[${shop}] lease renewal failed: ${describeError(error)}`,
        ),
      );
    }, RENEW_EVERY_MS);
    timer.unref();

    return {
      shop,
      release: async () => {
        clearInterval(timer);
        await this.move(shop, until, null);
      },
    };
  }

  /**
   * Set `lockedUntil` to `next` (null frees the shop), only if it still equals `current`
   * @returns false if someone else holds the lease now
   */
  private async move(
    shop: ShopKey,
    current: Date,
    next: Date | null,
  ): Promise<boolean> {
    const result = await this.states
      .createQueryBuilder()
      .update(ShopState)
      .set({ lockedUntil: next })
      .where('shop = :shop AND "lockedUntil" = :current', { shop, current })
      .execute();
    return !!result.affected;
  }
}
