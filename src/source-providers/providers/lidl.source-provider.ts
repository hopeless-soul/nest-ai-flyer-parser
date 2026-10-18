import { Injectable, Logger } from '@nestjs/common';
import { addDaysIso, isIsoDate, isoDateIn } from '../../common/dates';
import { describeError } from '../../common/errors';
import type { ShopConfig } from '../../shops/shop.config.type';
import { SourceProvider } from '../source-provider';
import type { SourceListing } from '../source-provider.types';

/** Leaflets API response; only the fields we use */
type LidlFlyerApiResponse = {
  success: boolean;
  flyer?: {
    pdfUrl?: string;
    offerStartDate?: string; // YYYY-MM-DD
    offerEndDate?: string | null;
    pages?: { number: number; image?: string; zoom?: string }[];
  };
};

/** One flyer slug with its API data */
type LidlCandidate = {
  slug: string;
  pdfUrl: string;
  pageImageUrls: string[];
  validFrom: string;
  validTo: string;
  validToPrinted: boolean;
};

/** Weekly flyers only; magazines and store-opening flyers have other slugs */
const FLYER_SLUG =
  /\/l\/sk\/letak\/(online-letak-platny-od-\d{2}-\d{2}-\d{4})\/ar\/0/g;

/** lidl.sk sends a ~21 KB Content-Security-Policy header, over Node's default 16 KB limit */
const LIST_PAGE_MAX_HEADER_SIZE = 64 * 1024;

/** Lidl: flyer slugs from the list page, dates and pages from the public leaflets API */
@Injectable()
export class LidlSourceProvider extends SourceProvider<'lidl'> {
  readonly shop = 'lidl' as const;
  private readonly logger = new Logger(LidlSourceProvider.name);

  /** Collect the weekly slugs, query the API for each and pick the current flyer */
  protected async fetchListing(
    config: ShopConfig<'lidl'>,
  ): Promise<SourceListing> {
    const { source, timezone } = config;
    const html = await this.http.getText(source.flyerUrl, {
      maxHeaderSize: LIST_PAGE_MAX_HEADER_SIZE,
    });

    const slugs = [
      ...new Set(Array.from(html.matchAll(FLYER_SLUG), (match) => match[1])),
    ];
    if (!slugs.length) this.fail('no weekly flyer links on the list page');

    // Note: One API call per slug, one after another; the list page usually has 2-3 slugs
    const candidates: LidlCandidate[] = [];
    for (const slug of slugs) {
      const candidate = await this.fetchCandidate(config, slug);
      if (candidate) candidates.push(candidate);
    }

    const flyer = this.pickCurrent(candidates, isoDateIn(timezone));
    if (!flyer) this.fail(`no usable flyer among ${slugs.join(', ')}`);

    return {
      validFrom: flyer.validFrom,
      validTo: flyer.validToPrinted ? flyer.validTo : null,
      sourceUrl: source.flyerUrl,
      pages:
        source.pages === 'pdf'
          ? { kind: 'pdf', url: flyer.pdfUrl }
          : { kind: 'images', urls: flyer.pageImageUrls },
      meta: { slug: flyer.slug, slugs, imageVariant: source.imageVariant },
    };
  }

  /** Dates, PDF and page images of one slug; `null` (and a warning) if the API has no usable data */
  private async fetchCandidate(
    { source, defaultFlyerDuration }: ShopConfig<'lidl'>,
    slug: string,
  ): Promise<LidlCandidate | null> {
    const url = `${source.apiUrl}?flyer_identifier=${encodeURIComponent(slug)}&region_id=${source.regionId}`;

    let data: LidlFlyerApiResponse;
    try {
      data = await this.http.getJson<LidlFlyerApiResponse>(url);
    } catch (error) {
      this.logger.warn(
        `Skipping ${slug}: API request failed (${describeError(error)})`,
      );
      return null;
    }

    const flyer = data.flyer;
    const validFrom = flyer?.offerStartDate?.slice(0, 10);
    if (!data.success || !flyer?.pdfUrl || !isIsoDate(validFrom)) {
      this.logger.warn(`Skipping ${slug}: API has no PDF or start date`);
      return null;
    }

    const printedTo = flyer.offerEndDate?.slice(0, 10);
    const validToPrinted = isIsoDate(printedTo);
    const pageImageUrls = [...(flyer.pages ?? [])]
      .sort((a, b) => a.number - b.number)
      .map((page) => page[source.imageVariant])
      .filter((imageUrl): imageUrl is string => !!imageUrl);
    if (source.pages === 'images' && !pageImageUrls.length) {
      this.logger.warn(`Skipping ${slug}: API has no page images`);
      return null;
    }

    return {
      slug,
      pdfUrl: flyer.pdfUrl,
      pageImageUrls,
      validFrom,
      validTo: validToPrinted
        ? printedTo
        : addDaysIso(validFrom, defaultFlyerDuration),
      validToPrinted,
    };
  }
}
