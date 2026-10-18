import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopState } from './entities/shop-state.entity';
import { Flyer } from './entities/flyer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import { FlyerOffer } from './entities/flyer-offer.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([ShopState, Flyer, FlyerPage, FlyerOffer]),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class ShopsModule {}
