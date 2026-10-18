import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopState } from './entities/shop-state.entity';

/** Owns ShopState: per-shop runtime state, retry bookkeeping and the run lease */
@Module({
  imports: [TypeOrmModule.forFeature([ShopState])],
  exports: [TypeOrmModule],
})
export class ShopsModule {}
