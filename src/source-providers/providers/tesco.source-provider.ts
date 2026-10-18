import { Injectable } from '@nestjs/common';
import { addDaysIso, isoDateIn } from '../../common/dates';
import type { ShopConfig } from '../../shops/shop.config.type';
import { SourceProvider } from '../source-provider';
import type { PageSource, SourceListing } from '../source-provider.types';

/** Shape of the `Leaflet:<id>` entries in the page's Apollo state; only the fields we use */
type TescoLeaflet = {
  __typename: 'Leaflet';
  type: string;
  leafletUrl: string;
  validFrom: string;
  validTo: string | null;
  pages?: { pagePNG?: string }[];
};

/** true for Apollo cache entries that are leaflets */
const isLeaflet = (value: unknown): value is TescoLeaflet =>
  (value as TescoLeaflet | null)?.__typename === 'Leaflet';

/** Tesco: Next.js page whose __NEXT_DATA__ Apollo cache holds every leaflet */
@Injectable()
export class TescoSourceProvider extends SourceProvider<'tesco'> {
  readonly shop = 'tesco' as const;

  /** Pick the current leaflet of `flyerType` from the Apollo cache */
  protected async fetchListing(
    config: ShopConfig<'tesco'>,
  ): Promise<SourceListing> {
    const { source, timezone } = config;
    const html = await this.http.getText(source.flyerUrl);

    const json = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
    )?.[1];
    if (!json) this.fail('__NEXT_DATA__ not found on the page');

    const data = JSON.parse(json) as {
      props?: { pageProps?: { __APOLLO_STATE__?: Record<string, unknown> } };
    };
    const leaflets = Object.values(
      data.props?.pageProps?.__APOLLO_STATE__ ?? {},
    )
      .filter(isLeaflet)
      .filter((leaflet) => leaflet.type === source.flyerType)
      .map((leaflet) => {
        // Note: Dates are timestamps; the calendar day in the shop's time zone is what counts
        const validFrom = isoDateIn(timezone, new Date(leaflet.validFrom));
        const validTo = leaflet.validTo
          ? isoDateIn(timezone, new Date(leaflet.validTo))
          : addDaysIso(validFrom, config.defaultFlyerDuration);
        return {
          leaflet,
          validFrom,
          validTo,
          validToPrinted: !!leaflet.validTo,
        };
      });
    if (!leaflets.length)
      this.fail(`no "${source.flyerType}" leaflet in the page data`);

    const current = this.pickCurrent(leaflets, isoDateIn(timezone));
    if (!current) this.fail(`no "${source.flyerType}" leaflet has started yet`);

    const pageUrls = (current.leaflet.pages ?? [])
      .map((page) => page.pagePNG)
      .filter((url): url is string => !!url);
    const pages: PageSource =
      source.pages === 'images'
        ? { kind: 'images', urls: pageUrls }
        : { kind: 'pdf', url: current.leaflet.leafletUrl };

    return {
      validFrom: current.validFrom,
      validTo: current.validToPrinted ? current.validTo : null,
      sourceUrl: source.flyerUrl,
      pages,
      meta: { flyerType: source.flyerType, leafletsOfType: leaflets.length },
    };
  }
}
