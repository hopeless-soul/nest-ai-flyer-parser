import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation, ValueTransformer } from 'typeorm';
import { FlyerPage } from './flyer-page.entity';
import type { ShopKey } from '../../shops/shop.config.type';
import { ProductCategoryKey } from '../types/product-category.type';

// pg returns numeric as string; prices are small, so a JS number is safe
const decimal: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
const price = {
  type: 'numeric',
  precision: 8,
  scale: 2,
  nullable: true,
  transformer: decimal,
} as const;

@Entity()
@Index(['shop', 'validTo'])
export class FlyerOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // @Index()
  @Column({ type: 'varchar', length: 112 })
  pageId!: string;

  @ManyToOne(() => FlyerPage, (page) => page.offers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pageId' })
  page!: Relation<FlyerPage>;

  // @Index()
  @Column({ type: 'varchar', length: 96 })
  flyerId!: string;

  @Column({ type: 'varchar', length: 32 })
  shop!: ShopKey;

  // Order on the page, as the model returned it
  @Column({ type: 'int' })
  position!: number;

  /**
   * Content
   */
  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', array: true, nullable: true })
  category!: ProductCategoryKey[] | null;

  // e.g.: [[x1, y1], [x2, y2]]
  @Column({ type: 'jsonb' })
  boundaryBox!: [[number, number], [number, number]];

  @Column(price) basePrice!: number | null;
  @Column(price) discountedPrice!: number | null;
  @Column(price) loyaltyPrice!: number | null;

  @Column({ type: 'number', nullable: true })
  discount!: number | null;

  @Column({ type: 'number', nullable: true })
  loyaltyDiscount!: number | null;

  // e.g.: flyers/<storeName>/<flyerId>/offers/<offerId>.<hash8>.webp
  @Column({ type: 'text', nullable: true })
  cropKey!: string | null;

  @Column({ type: 'date' })
  validFrom!: string;

  @Column({ type: 'date' })
  validTo!: string;
}
