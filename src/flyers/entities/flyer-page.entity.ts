import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { Flyer } from './flyer.entity';
import { FlyerOffer } from './flyer-offer.entity';
import { PageStatus } from '../enums/page.enums';

@Entity()
@Unique(['flyerId', 'pageNumber'])
export class FlyerPage {
  // e.g.: kaufland_2026-10-14_2026-10-20_page_07
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Index()
  @Column({ type: 'varchar' })
  flyerId!: string;

  @ManyToOne(() => Flyer, (flyer) => flyer.pages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'flyerId' })
  flyer!: Relation<Flyer>;

  @Column({ type: 'varchar', length: 8, default: PageStatus.Pending })
  status!: PageStatus;

  /**
   * Meta
   */
  @Column({ type: 'int' })
  pageNumber!: number;

  // e.g.: flyers/<shopKey>/<flyerId>/pages/<pageId>.<hash8>.webp
  @Column({ type: 'text' })
  imageKey!: string;

  // e.g.: webp sha256
  @Column({ type: 'char', length: 64 })
  imageHash!: string;

  @Column({ type: 'int', nullable: true })
  width!: number | null;

  @Column({ type: 'int', nullable: true })
  height!: number | null;

  /**
   * AI Parser
   */
  @Column({ type: 'int', nullable: true })
  parserVersion!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  model!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  parsedAt!: Date | null;

  /**
   * Offers
   */
  @OneToMany(() => FlyerOffer, (offer) => offer.page)
  offers!: Relation<FlyerOffer[]>;
}
