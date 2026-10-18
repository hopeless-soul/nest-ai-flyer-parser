import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyersModule } from '../flyers/flyers.module';
import { ShopState } from './entities/shop-state.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ShopState]), FlyersModule],
  controllers: [],
  providers: [],
  exports: [FlyersModule],
})
export class ShopsModule {}
