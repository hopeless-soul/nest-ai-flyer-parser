import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopsModule } from '../shops/shops.module';
import { StorageModule } from '../storage/storage.module';
import { FlyerOffer } from './entities/flyer-offer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import { Flyer } from './entities/flyer.entity';
import { FlyersController } from './flyers.controller';
import { FlyersService } from './flyers.service';
import { PageRegistrar } from './page-registrar.service';

/** Flyer, page and offer data: repositories, the page registrar and the public read API */
@Module({
  imports: [
    TypeOrmModule.forFeature([Flyer, FlyerPage, FlyerOffer]),
    ShopsModule,
    StorageModule,
  ],
  controllers: [FlyersController],
  providers: [FlyersService, PageRegistrar],
  exports: [TypeOrmModule, PageRegistrar],
})
export class FlyersModule {}
