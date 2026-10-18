import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { Relation } from "typeorm";
import type{ ShopKey } from "../shop.config.type";
import { RetryState } from "./retry-state.embedded";
import { Flyer } from "../../flyers/entities/flyer.entity";

@Entity()
export class ShopState {
  @PrimaryColumn({ type: 'varchar' })
  shop!: ShopKey

  // Is availiable for frontend
  @Column({ type: 'boolean', default: false })
  isAvailiable!: boolean 

  /**
   * Flyer
   */
  @Column({ type: 'boolean', default: false })
  awaitingNewFlyer!: boolean

  @Column({ type: 'varchar', nullable: true })
  currentFlyerId!: string | null

  @ManyToOne(() => Flyer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'currentFlyerId' })
  currentFlyer!: Relation<Flyer> | null

  @OneToMany(() => Flyer, (flyer) => flyer.shopState)
  flyers!: Relation<Flyer[]>


  /**
   * Retry
   */
  @Column(() => RetryState, { prefix: 'retry' })
  retry!: RetryState

  /**
   * Timestamps
   */
  // Lease instead of parse.lock: one sync per shop at a time, expires if the process dies
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null

  @Column({ type: 'text', nullable: true })
  lastError!: string | null

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}