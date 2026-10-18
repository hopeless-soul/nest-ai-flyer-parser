import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { mapLimit } from '../common/concurrency';
import type {
  DiscoveredFlyer,
  LocalPage,
} from '../source-providers/source-provider.types';
import { R2Service } from '../storage/r2.service';
import { FlyerPage } from './entities/flyer-page.entity';
import { Flyer } from './entities/flyer.entity';
import { FlyerStatus } from './enums/flyer.enums';
import { PageStatus } from './enums/page.enums';
import { pageIdOf, pageImageKey } from './flyer-keys';

/** Content types of the formats PageMaterializer writes */
const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  png: 'image/png',
};

/** Parallel R2 uploads per flyer */
const UPLOAD_CONCURRENCY = 4;

/**
 * Saves pipeline progress: the Flyer row, its FlyerPage rows (stage 2) and their R2 images (stage 3).
 * Note: Reads local files only to upload them; afterwards DB + R2 are the source of truth.
 */
@Injectable()
export class PageRegistrar {
  /**
   * @param dataSource - For transactions
   * @param flyers - Flyer repository
   * @param pages - FlyerPage repository
   * @param r2 - Page image storage
   */
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Flyer) private readonly flyers: Repository<Flyer>,
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    private readonly r2: R2Service,
  ) {}

  /**
   * Create the Flyer row (or reset an earlier attempt) in DOWNLOADING and drop its old pages
   * Note: Old offers go with the pages (cascade); the row itself stays, so ShopState.currentFlyerId survives a refresh
   */
  async begin(flyer: DiscoveredFlyer): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.delete(FlyerPage, { flyerId: flyer.flyerId });
      await em.upsert(
        Flyer,
        {
          id: flyer.flyerId,
          shop: flyer.shop,
          validFrom: flyer.validFrom,
          validTo: flyer.validTo,
          status: FlyerStatus.Downloading,
          pageCount: 0,
          context: {
            sourceUrl: flyer.sourceUrl,
            pages: flyer.pages,
            meta: flyer.meta,
            validToEstimated: flyer.validToEstimated,
          },
        },
        ['id'],
      );
    });
  }

  /** Stage 2: one PENDING row per local page (no image link yet) and the flyer's pageCount */
  async register(flyerId: string, files: LocalPage[]): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.insert(
        FlyerPage,
        files.map((file) => ({
          id: pageIdOf(flyerId, file.pageNumber),
          flyerId,
          pageNumber: file.pageNumber,
          status: PageStatus.Pending,
          imageKey: null,
          imageHash: null,
          width: file.width,
          height: file.height,
        })),
      );
      await em.update(Flyer, flyerId, { pageCount: files.length });
    });
  }

  /**
   * Stage 3: hash, upload and link every page image; then the flyer is PAGES_UPLOADED
   * Note: A page is UPLOADED only after its object exists in R2
   */
  async upload(
    flyer: Pick<DiscoveredFlyer, 'flyerId' | 'shop'>,
    files: LocalPage[],
  ): Promise<void> {
    await mapLimit(files, UPLOAD_CONCURRENCY, async (file) => {
      const data = await readFile(file.path);
      const imageHash = createHash('sha256').update(data).digest('hex');
      const ext = extname(file.path).slice(1);
      const pageId = pageIdOf(flyer.flyerId, file.pageNumber);
      const imageKey = pageImageKey(
        flyer.shop,
        flyer.flyerId,
        pageId,
        imageHash,
        ext,
      );

      await this.r2.put(
        imageKey,
        data,
        CONTENT_TYPES[ext] ?? 'application/octet-stream',
      );
      await this.pages.update(pageId, {
        imageKey,
        imageHash,
        status: PageStatus.Uploaded,
      });
    });
    await this.flyers.update(flyer.flyerId, {
      status: FlyerStatus.PagesUploaded,
    });
  }
}
