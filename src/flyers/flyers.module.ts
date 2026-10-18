import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyersService } from './flyers.service';
import { FlyersController } from './flyers.controller';
import { Flyer } from './entities/flyer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import { FlyerOffer } from './entities/flyer-offer.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Flyer, FlyerPage, FlyerOffer])],
  controllers: [FlyersController],
  providers: [FlyersService],
  exports: [TypeOrmModule],
})
export class FlyersModule {}
