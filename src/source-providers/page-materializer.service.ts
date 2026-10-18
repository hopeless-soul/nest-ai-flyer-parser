import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import sharp from 'sharp';
import type {
  CompressImageOptions,
  PageImageOptions,
} from '../shops/shop.config.type';
import type { LocalPage } from './source-provider.types';

/** Cached result of `pdfjsWasmUrl()` */
let wasmUrl: string | null = null;

/**
 * Folder with the pdf.js wasm decoders (OpenJPEG for JPX images, ...), passed as `wasmUrl`
 * Note: Without it JPX images fail with "OpenJPEG failed to initialize" and render blank.
 *       Resolved through pdf-to-img, since pdfjs-dist is not a direct dependency.
 *       pdf.js needs forward slashes and a trailing `/`.
 */
function pdfjsWasmUrl(): string {
  wasmUrl ??=
    dirname(
      createRequire(require.resolve('pdf-to-img')).resolve(
        'pdfjs-dist/package.json',
      ),
    )
      .split(sep)
      .join('/') + '/wasm/';
  return wasmUrl;
}

/** A compressed image and its size */
export interface CompressedImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Turns a flyer source into compressed page images on local disk: PDF → split, then compress */
@Injectable()
export class PageMaterializer {
  /**
   * Render every PDF page and write it compressed as `<outDir>/<nnn>.<format>`
   * Note: pdf-to-img is ESM-only, so it is loaded with a dynamic import
   * @returns The pages in order
   */
  async splitPdf(
    pdfPath: string,
    outDir: string,
    options: PageImageOptions,
  ): Promise<LocalPage[]> {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(pdfPath, {
      scale: options.pdfScale,
      docInitParams: { wasmUrl: pdfjsWasmUrl() },
    });
    await mkdir(outDir, { recursive: true });

    const pages: LocalPage[] = [];
    try {
      for await (const image of doc) {
        pages.push(
          await this.writePage(
            image,
            outDir,
            pages.length + 1,
            options.compress,
          ),
        );
      }
    } finally {
      await doc.destroy();
    }
    return pages;
  }

  /**
   * Compress already downloaded page images (e.g. Lidl's pre-rendered JPEGs), keeping their order
   * @returns The pages in order
   */
  async compressFiles(
    files: string[],
    outDir: string,
    compress: CompressImageOptions,
  ): Promise<LocalPage[]> {
    await mkdir(outDir, { recursive: true });
    const pages: LocalPage[] = [];
    for (const file of files) {
      pages.push(
        await this.writePage(
          await readFile(file),
          outDir,
          pages.length + 1,
          compress,
        ),
      );
    }
    return pages;
  }

  /** Resize (never upscale) and re-encode an image buffer */
  async compress(
    input: Buffer,
    { format, quality, maxWidth }: CompressImageOptions,
  ): Promise<CompressedImage> {
    let image = sharp(input);
    if (maxWidth)
      image = image.resize({ width: maxWidth, withoutEnlargement: true });

    switch (format) {
      case 'jpg':
        image = image.jpeg({ quality, mozjpeg: true });
        break;
      case 'webp':
        image = image.webp({ quality });
        break;
      case 'png':
        image = image.png({ compressionLevel: 9, palette: true, quality });
        break;
    }

    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  /** Compress one page and write it as `<outDir>/<nnn>.<format>` */
  private async writePage(
    image: Buffer,
    outDir: string,
    pageNumber: number,
    compress: CompressImageOptions,
  ): Promise<LocalPage> {
    const { data, width, height } = await this.compress(image, compress);
    const path = join(
      outDir,
      `${String(pageNumber).padStart(3, '0')}.${compress.format}`,
    );
    await writeFile(path, data);
    return { pageNumber, path, width, height };
  }
}
