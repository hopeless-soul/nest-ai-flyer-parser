import { OmitType } from '@nestjs/swagger';
import type { FlyerOffer } from '../../../flyers/entities/flyer-offer.entity';
import { OfferDto } from '../../../flyers/dto/offer.dto';

/** An offer as admins see it: the public fields plus storage keys (no image link) */
export class AdminOfferDto extends OmitType(OfferDto, ['imageUrl'] as const) {
  /** R2 key of the cropped offer image, e.g. flyers/<shop>/<flyerId>/offers/<offerId>.<hash8>.webp */
  cropKey!: string | null;

  /** Map an offer entity to its admin shape */
  static from(offer: FlyerOffer): AdminOfferDto {
    return { ...OfferDto.fieldsOf(offer), cropKey: offer.cropKey };
  }
}
