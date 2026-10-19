import type { FlyerOffer } from '../../../flyers/entities/flyer-offer.entity';
import { OfferDto } from '../../../flyers/dto/offer.dto';

/** An offer as admins see it: the public shape plus storage keys */
export class AdminOfferDto extends OfferDto {
  /** R2 key of the cropped offer image, e.g. flyers/<shop>/<flyerId>/offers/<offerId>.<hash8>.webp */
  cropKey!: string | null;

  /** Map an offer entity to its admin shape */
  static override from(offer: FlyerOffer): AdminOfferDto {
    return { ...OfferDto.from(offer), cropKey: offer.cropKey };
  }
}
