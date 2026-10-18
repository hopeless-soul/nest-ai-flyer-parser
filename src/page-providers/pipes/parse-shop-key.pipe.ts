import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';

@Injectable()
export class ParseShopKeyPipe implements PipeTransform<string, ShopKey> {
  transform(value: string): ShopKey {
    if (!(ShopKeys as readonly string[]).includes(value)) {
      throw new BadRequestException(
        `Unknown shop "${value}"; expected one of ${ShopKeys.join(', ')}`,
      );
    }
    return value as ShopKey;
  }
}
