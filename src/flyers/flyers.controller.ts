import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { FlyersService } from './flyers.service';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';

@Controller('flyers')
export class FlyersController {
  constructor(private readonly flyersService: FlyersService) {}

  @Post()
  create(@Body() createFlyerDto: CreateFlyerDto) {
    return this.flyersService.create(createFlyerDto);
  }

  @Get()
  findAll() {
    return this.flyersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.flyersService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateFlyerDto: UpdateFlyerDto) {
    return this.flyersService.update(+id, updateFlyerDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.flyersService.remove(+id);
  }
}
