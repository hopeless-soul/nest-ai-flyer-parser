import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';

/** Route param → ShopKey; 400 for an unknown shop */
@Injectable()
export class ParseShopKeyPipe implements PipeTransform<string, ShopKey> {
  /** Validate `value` against `ShopKeys` */
  transform(value: string): ShopKey {
    if (!(ShopKeys as readonly string[]).includes(value)) {
      throw new BadRequestException(
        `Unknown shop "${value}"; expected one of ${ShopKeys.join(', ')}`,
      );
    }
    return value as ShopKey;
  }
}
