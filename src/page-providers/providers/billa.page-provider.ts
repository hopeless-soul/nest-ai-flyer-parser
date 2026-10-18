import { Injectable } from '@nestjs/common';
import { isoDate } from '../../common/dates';
import { decodeHtmlEntities } from '../../common/html';
import type { ShopConfig } from '../../shops/shop.config.type';
import { PageProvider } from '../page-provider';
import type { SourceListing } from '../page-provider.types';

// Note: e.g. "Akciová ponuka platí od 14. 10. do 20. 10. 2026"; only the end date carries a year
const VALIDITY =
  /Akciová ponuka platí od (\d{1,2})\.\s*(\d{1,2})\.\s*do (\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/;
const PDF_LINK = /href="(https:\/\/view\.publitas\.com\/[^"]+\.pdf[^"]*)"/;

@Injectable()
export class BillaPageProvider extends PageProvider<'billa'> {
  readonly shop = 'billa' as const;

  protected async fetchListing({
    source,
  }: ShopConfig<'billa'>): Promise<SourceListing> {
    const html = await this.http.getText(source.flyerUrl);

    const match = html.match(VALIDITY);
    if (!match)
      this.fail('validity text "Akciová ponuka platí od … do …" not found');

    const pdfUrl = html.match(PDF_LINK)?.[1];
    if (!pdfUrl) this.fail('Publitas PDF link not found');

    const [, fromDay, fromMonth, toDay, toMonth, year] = match;
    // Note: A flyer across New Year (28. 12. - 3. 1. 2027) starts in the previous year
    const fromYear =
      Number(fromMonth) > Number(toMonth) ? Number(year) - 1 : Number(year);

    return {
      validFrom: isoDate(fromYear, fromMonth, fromDay),
      validTo: isoDate(year, toMonth, toDay),
      sourceUrl: source.flyerUrl,
      pages: { kind: 'pdf', url: decodeHtmlEntities(pdfUrl) },
    };
  }
}
