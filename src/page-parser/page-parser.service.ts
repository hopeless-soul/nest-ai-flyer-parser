import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { mapLimit } from '../common/concurrency';
import { FlyerOffer } from '../flyers/entities/flyer-offer.entity';
import { FlyerPage } from '../flyers/entities/flyer-page.entity';
import { Flyer } from '../flyers/entities/flyer.entity';
import { PageStatus } from '../flyers/enums/page.enums';
import { FlyerNotFoundError } from '../flyers/flyers.errors';
import { R2Service } from '../storage/r2.service';
import { GeminiClient, mimeTypeOfKey } from './gemini.client';
import { normalizePage, type NormalizedOffer } from './normalize';
import { FatalParseError, ImagesExpiredError } from './page-parser.errors';
import { PARSER_VERSION } from './page-prompt';
import { describeAttemptError, withRetry } from './retry';

/** Options of `PageParserService.parsePages` */
export interface ParsePagesOptions {
  /** Limit the run to these pages */
  pageIds?: string[];
  /** Parse even pages already PARSED by the current parser version */
  force?: boolean;
  /** Pages parsed in parallel */
  concurrency: number;
  /** Attempts per page */
  maxAttempts: number;
}

/** Outcome of `parsePages` */
export interface ParseSummary {
  /** Pages parsed in this run */
  parsed: number;
  /** Pages already up to date */
  skipped: number;
  /** Pages that failed after all attempts */
  failed: string[];
}

/**
 * AI-parses flyer pages: R2 image → Gemini → normalize → offers in the DB.
 * Note: Never reads local files; the page image always comes from R2.
 */
@Injectable()
export class PageParserService {
  private readonly logger = new Logger(PageParserService.name);

  /**
   * @param pages - FlyerPage repository
   * @param dataSource - For the per-page offer transaction
   * @param r2 - Page images
   * @param gemini - Model client
   */
  constructor(
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    private readonly dataSource: DataSource,
    private readonly r2: R2Service,
    private readonly gemini: GeminiClient,
  ) {}

  /**
   * Check that the pages exist and their images are still in R2 (checks the first page)
   * @throws FlyerNotFoundError | ImagesExpiredError
   */
  async assertImagesAvailable(
    flyerId: string,
    pageIds?: string[],
  ): Promise<void> {
    const pages = await this.selectPages(flyerId, pageIds);
    if (!pages.length) {
      throw new FlyerNotFoundError(
        `No pages for ${pageIds?.join(', ') ?? flyerId}`,
      );
    }
    const first = pages[0];
    if (!first.imageKey || !(await this.r2.exists(first.imageKey))) {
      throw new ImagesExpiredError(first.id);
    }
  }

  /**
   * Parse the flyer's pages that need it: UPLOADED, FAILED, or parsed by an older PARSER_VERSION
   * (all selected pages with `force`). Each page's offers are replaced in one transaction.
   * @throws FatalParseError | ImagesExpiredError - stops the run; pages not reached keep their status
   */
  async parsePages(
    flyer: Flyer,
    options: ParsePagesOptions,
  ): Promise<ParseSummary> {
    const selected = await this.selectPages(flyer.id, options.pageIds);
    const pending = selected.filter(
      (page) => options.force || this.needsParse(page),
    );
    const summary: ParseSummary = {
      parsed: 0,
      skipped: selected.length - pending.length,
      failed: [],
    };
    const run: { fatal: Error | null } = { fatal: null };

    await mapLimit(pending, options.concurrency, async (page) => {
      if (run.fatal) return;
      try {
        const count = await this.parsePage(flyer, page, options.maxAttempts);
        summary.parsed++;
        this.logger.log(`${page.id}: ${count} offers`);
      } catch (error) {
        if (
          error instanceof FatalParseError ||
          error instanceof ImagesExpiredError
        ) {
          run.fatal ??= error;
          return;
        }
        summary.failed.push(page.id);
        this.logger.warn(`${page.id}: failed (${describeAttemptError(error)})`);
      }
    });

    if (run.fatal) throw run.fatal;
    summary.failed.sort();
    return summary;
  }

  /** Pages of `flyerId` (optionally only `pageIds`) in page order */
  private selectPages(
    flyerId: string,
    pageIds?: string[],
  ): Promise<FlyerPage[]> {
    return this.pages.find({
      where: pageIds ? { flyerId, id: In(pageIds) } : { flyerId },
      order: { pageNumber: 'ASC' },
    });
  }

  /** true if the page has no up-to-date parse result */
  private needsParse(page: FlyerPage): boolean {
    return (
      page.status === PageStatus.Uploaded ||
      page.status === PageStatus.Failed ||
      (page.status === PageStatus.Parsed &&
        (page.parserVersion ?? 0) < PARSER_VERSION)
    );
  }

  /**
   * Parse one page with retries and save its offers
   * @returns Number of saved offers
   */
  private async parsePage(
    flyer: Flyer,
    page: FlyerPage,
    maxAttempts: number,
  ): Promise<number> {
    if (!page.imageKey) throw new ImagesExpiredError(page.id);
    const image = await this.r2.get(page.imageKey);
    if (!image) throw new ImagesExpiredError(page.id);
    const mimeType = mimeTypeOfKey(page.imageKey);

    let attempts = 0;
    try {
      const { offers, model } = await withRetry(
        async (attempt) => {
          attempts = attempt;
          const { text, model } = await this.gemini.extractPage(
            image,
            mimeType,
          );
          const offers = normalizePage(text, (reason) =>
            this.logger.warn(`${page.id}: dropped offer (${reason})`),
          );
          return { offers, model };
        },
        {
          maxAttempts,
          onRetry: (error, attempt, delayMs) =>
            this.logger.warn(
              `${page.id}: attempt ${attempt} failed (${describeAttemptError(error)}), retrying in ${Math.round(delayMs / 1000)}s`,
            ),
        },
      );
      await this.saveOffers(flyer, page, offers, model, attempts);
      return offers.length;
    } catch (error) {
      if (!(error instanceof FatalParseError)) {
        await this.pages.update(page.id, {
          status: PageStatus.Failed,
          attempts: page.attempts + attempts,
          lastError: describeAttemptError(error),
        });
      }
      throw error;
    }
  }

  /** Replace the page's offers and mark it PARSED, in one transaction */
  private async saveOffers(
    flyer: Flyer,
    page: FlyerPage,
    offers: NormalizedOffer[],
    model: string,
    attempts: number,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.delete(FlyerOffer, { pageId: page.id });
      if (offers.length) {
        await em.insert(
          FlyerOffer,
          offers.map((offer, position) => ({
            ...offer,
            position,
            pageId: page.id,
            flyerId: flyer.id,
            shop: flyer.shop,
            validFrom: flyer.validFrom,
            validTo: flyer.validTo,
            cropKey: null,
          })),
        );
      }
      await em.update(FlyerPage, page.id, {
        status: PageStatus.Parsed,
        parserVersion: PARSER_VERSION,
        model,
        parsedAt: new Date(),
        attempts: page.attempts + attempts,
        lastError: null,
      });
    });
  }
}
