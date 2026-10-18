import { Injectable } from '@nestjs/common';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';

@Injectable()
export class FlyersService {
  create(createFlyerDto: CreateFlyerDto) {
    return 'This action adds a new flyer';
  }

  findAll() {
    return `This action returns all flyers`;
  }

  findOne(id: number) {
    return `This action returns a #${id} flyer`;
  }

  update(id: number, updateFlyerDto: UpdateFlyerDto) {
    return `This action updates a #${id} flyer`;
  }

  remove(id: number) {
    return `This action removes a #${id} flyer`;
  }
}
