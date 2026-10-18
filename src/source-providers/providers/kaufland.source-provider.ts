import { Injectable } from '@nestjs/common';
import { isoDate } from '../../common/dates';
import { decodeHtmlEntities } from '../../common/html';
import type { ShopConfig } from '../../shops/shop.config.type';
import { SourceProvider } from '../source-provider';
import type { SourceListing } from '../source-provider.types';

/** `DD.MM.YYYY – DD.MM.YYYY`, separated by an en dash or a hyphen */
const VALIDITY =
  /(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/;

/** Kaufland: flyer tiles on predajne.kaufland.sk, each with its validity and a static PDF URL */
@Injectable()
export class KauflandSourceProvider extends SourceProvider<'kaufland'> {
  readonly shop = 'kaufland' as const;

  /** Find the tile of `flyerSubcategory` and read its dates and PDF link */
  protected async fetchListing({
    source,
  }: ShopConfig<'kaufland'>): Promise<SourceListing> {
    const html = await this.http.getText(source.flyerUrl);

    // Note: Every tile starts with `data-t-name="FlyerTile"`, so a chunk ends where the next tile begins
    const tile = html
      .split('data-t-name="FlyerTile"')
      .slice(1)
      .find((chunk) =>
        chunk.includes(`data-subcategory="${source.flyerSubcategory}"`),
      );
    if (!tile)
      this.fail(
        `flyer tile "${source.flyerSubcategory}" not found on ${source.flyerUrl}`,
      );

    // Note: Falls back to `data-aa-detail` if the visible validity text is empty
    const text =
      tile.match(/m-flyer-tile__validity-date[^>]*>([^<]*)</)?.[1] ?? '';
    const detail = tile.match(/data-aa-detail="([^"]*)"/)?.[1] ?? '';
    const match = text.match(VALIDITY) ?? detail.match(VALIDITY);
    if (!match) this.fail('validity dates not found in the flyer tile');

    const pdfUrl = tile.match(/data-download-url="([^"]+\.pdf[^"]*)"/)?.[1];
    if (!pdfUrl) this.fail('PDF download URL not found in the flyer tile');

    const [, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
    return {
      validFrom: isoDate(fromYear, fromMonth, fromDay),
      validTo: isoDate(toYear, toMonth, toDay),
      sourceUrl: source.flyerUrl,
      pages: { kind: 'pdf', url: decodeHtmlEntities(pdfUrl) },
      meta: { flyerSubcategory: source.flyerSubcategory },
    };
  }
}
