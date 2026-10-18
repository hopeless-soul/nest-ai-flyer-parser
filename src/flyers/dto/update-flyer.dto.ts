import { PartialType } from '@nestjs/mapped-types';
import { CreateFlyerDto } from './create-flyer.dto';

export class UpdateFlyerDto extends PartialType(CreateFlyerDto) {}
