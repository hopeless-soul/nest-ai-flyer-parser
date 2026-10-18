import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopState } from './entities/shop-state.entity';
import { ShopLeaseService } from './shop-lease.service';
import { ShopStateService } from './shop-state.service';

/** Owns ShopState: per-shop runtime state, retry bookkeeping and the run lease */
@Module({
  imports: [TypeOrmModule.forFeature([ShopState])],
  providers: [ShopStateService, ShopLeaseService],
  exports: [ShopStateService, ShopLeaseService],
})
export class ShopsModule {}
