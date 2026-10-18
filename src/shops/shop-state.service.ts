import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { ShopState } from './entities/shop-state.entity';
import { RetryReason } from './enums/shop.enums';
import { ShopKeys, type ShopKey } from './shop.config.type';

/** Minute in ms */
const MINUTE_MS = 60_000;
/** First backoff for FETCH_FAILED / PAGES_FAILED; doubles per attempt */
const BACKOFF_BASE_MS = 30 * MINUTE_MS;
/** Upper bound of a single backoff */
const BACKOFF_MAX_MS = 12 * 60 * MINUTE_MS;
/** Flat delay while the shop site still shows the overdue flyer */
const AWAITING_DELAY_MS = 60 * MINUTE_MS;

/** Options of `ShopStateService.scheduleRetry` */
export interface ScheduleRetryOptions {
  /** Stop scheduling (retry.at = null) once attempts reach this; ignored for AWAITING_NEW_FLYER */
  maxAttempts?: number;
  /** Stored in lastError */
  error?: string;
}

/** Reads and updates ShopState: current flyer, availability, retries, last error */
@Injectable()
export class ShopStateService implements OnModuleInit {
  /** @param states - ShopState repository */
  constructor(
    @InjectRepository(ShopState)
    private readonly states: Repository<ShopState>,
  ) {}

  /** Insert a row for every ShopKey that has none (flyers reference it through a foreign key) */
  async onModuleInit(): Promise<void> {
    await this.states
      .createQueryBuilder()
      .insert()
      .into(ShopState)
      .values(ShopKeys.map((shop) => ({ shop })))
      .orIgnore()
      .execute();
  }

  /** Every shop with its current flyer */
  list(): Promise<ShopState[]> {
    return this.states.find({
      relations: { currentFlyer: true },
      order: { shop: 'ASC' },
    });
  }

  /** Shops the frontend may show (a READY or PARTIAL flyer exists) */
  listAvailable(): Promise<ShopState[]> {
    return this.states.find({
      where: { isAvailiable: true },
      relations: { currentFlyer: true },
      order: { shop: 'ASC' },
    });
  }

  /** One shop with its current flyer */
  get(shop: ShopKey): Promise<ShopState> {
    return this.states.findOneOrFail({
      where: { shop },
      relations: { currentFlyer: true },
    });
  }

  /** Shops whose scheduled retry is due */
  findDueRetries(now: Date = new Date()): Promise<ShopState[]> {
    return this.states.find({
      where: { retry: { at: LessThanOrEqual(now) } },
      order: { shop: 'ASC' },
    });
  }

  /** Stamp the start of a run */
  async markAttempt(shop: ShopKey): Promise<void> {
    await this.states.update(shop, { lastAttemptAt: new Date() });
  }

  /** Make `flyerId` the flyer the frontend shows */
  async setCurrentFlyer(shop: ShopKey, flyerId: string): Promise<void> {
    await this.states.update(shop, {
      currentFlyerId: flyerId,
      isAvailiable: true,
      awaitingNewFlyer: false,
      lastSuccessAt: new Date(),
      lastError: null,
    });
  }

  /** Forget any scheduled retry */
  async clearRetry(shop: ShopKey): Promise<void> {
    await this.states.update(shop, {
      awaitingNewFlyer: false,
      retry: { reason: null, attempts: 0, at: null },
    });
  }

  /**
   * Schedule the next retry of `shop`
   * Note: Attempts count up while the reason stays the same. FETCH_FAILED / PAGES_FAILED back off
   *       30m · 2^(n-1) up to 12h and stop at `maxAttempts`; AWAITING_NEW_FLYER retries hourly forever.
   * @returns When the retry tick picks the shop up again, or null if retries are used up
   */
  async scheduleRetry(
    shop: ShopKey,
    reason: RetryReason,
    options: ScheduleRetryOptions = {},
  ): Promise<Date | null> {
    const { retry } = await this.get(shop);
    const attempts = retry.reason === reason ? retry.attempts + 1 : 1;
    const awaiting = reason === RetryReason.AwaitingNewFlyer;
    const exhausted =
      !awaiting &&
      options.maxAttempts !== undefined &&
      attempts >= options.maxAttempts;
    const delayMs = awaiting
      ? AWAITING_DELAY_MS
      : Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    const at = exhausted ? null : new Date(Date.now() + delayMs);

    await this.states.update(shop, {
      awaitingNewFlyer: awaiting,
      retry: { reason, attempts, at },
      ...(options.error !== undefined && { lastError: options.error }),
    });
    return at;
  }

  /** Store an error without scheduling a retry */
  async recordError(shop: ShopKey, message: string): Promise<void> {
    await this.states.update(shop, { lastError: message });
  }
}
