import { Column, Index } from "typeorm"
import { RetryReason } from "../enums/shop.enums"

export class RetryState {
  @Column({ type: 'varchar', nullable: true })
  reason!: RetryReason | null

  @Column({ type: 'int', default: 0 })
  attempts!: number

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  at!: Date | null
}