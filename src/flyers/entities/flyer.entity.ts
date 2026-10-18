import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { ShopKey } from '../../shops/shop.config.type';
import { ShopState } from '../../shops/entities/shop-state.entity';
import { FlyerPage } from './flyer-page.entity';
import { FlyerStatus } from '../enums/flyer.enums';


@Entity()
@Index(['shop', 'validTo'])
export class Flyer {
  // e.g.: kaufland_2026-10-14_2026-10-20
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  /**
   * Shop data
   */
  @Column({ type: 'varchar' })
  shop!: ShopKey;

  @ManyToOne(() => ShopState, (state) => state.flyers, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'shop' })
  shopState!: Relation<ShopState>;

  /**
   * Flyer
   */
  @Column({ type: 'date' })
  validFrom!: string;

  @Column({ type: 'date' })
  validTo!: string;

  @Column({ type: 'varchar', default: FlyerStatus.Downloading })
  status!: FlyerStatus;

  @Column({ type: 'int', default: 0 })
  pageCount!: number;

  /**
   * Pages
   */
  @OneToMany(() => FlyerPage, (page) => page.flyer)
  pages!: Relation<FlyerPage[]>

  /**
   * Context
   */
  // {shop}_flyer.json
  @Column({ type: 'jsonb', nullable: true })
  context!: Record<string, unknown> | null; 

  /**
   * Timestamps
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}
