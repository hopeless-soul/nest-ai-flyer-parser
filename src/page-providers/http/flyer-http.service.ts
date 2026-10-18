import { Inject, Injectable, Logger } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeError } from '../../common/errors';
import { FLYER_HTTP_OPTIONS } from '../page-providers.tokens';

export interface FlyerHttpOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  downloadTimeoutMs: number;
  // Extra attempts on network errors, timeouts, 429 and 5xx
  retries: number;
  retryDelayMs: number;
  maxDownloadBytes: number;
}

export const DEFAULT_FLYER_HTTP_OPTIONS: FlyerHttpOptions = {
  // Note: tesco.sk sits behind Akamai, which answers 403 to requests without browser-like headers
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'sk-SK,sk;q=0.9,en;q=0.8',
  },
  timeoutMs: 20_000,
  downloadTimeoutMs: 180_000,
  retries: 2,
  retryDelayMs: 1_000,
  maxDownloadBytes: 300 * 1024 * 1024,
};

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  // Raise Node's 16 KB response header limit; lidl.sk sends a ~21 KB CSP header
  maxHeaderSize?: number;
}

export class HttpRequestError extends Error {
  constructor(
    readonly url: string,
    // null when no response arrived (DNS, connection, timeout)
    readonly status: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpRequestError';
  }

  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/** HTTP client for shop sites: browser headers, timeouts, retries, streamed downloads */
@Injectable()
export class FlyerHttpService {
  private readonly logger = new Logger(FlyerHttpService.name);

  constructor(
    @Inject(FLYER_HTTP_OPTIONS) private readonly options: FlyerHttpOptions,
  ) {}

  getText(url: string, options: RequestOptions = {}): Promise<string> {
    return this.withRetry(async () => {
      if (options.maxHeaderSize)
        return this.getTextWithLargeHeaders(url, options);
      const res = await this.fetchOk(
        url,
        options,
        options.timeoutMs ?? this.options.timeoutMs,
      );
      return res.text();
    });
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.getText(url, {
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
    });
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new HttpRequestError(url, 200, `Invalid JSON from ${url}`, {
        cause: error,
      });
    }
  }

  /**
   * Stream a file to disk through `<filePath>.part`, so an interrupted download never looks complete
   * Note: Used by the pipeline for PDFs and page images; never buffers the whole file in memory
   */
  downloadToFile(
    url: string,
    filePath: string,
    options: RequestOptions = {},
  ): Promise<{ bytes: number; contentType: string | null }> {
    return this.withRetry(async () => {
      const res = await this.fetchOk(
        url,
        options,
        options.timeoutMs ?? this.options.downloadTimeoutMs,
      );
      const max = this.options.maxDownloadBytes;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > max) {
        await res.body?.cancel();
        throw new HttpRequestError(
          url,
          res.status,
          `File too large: ${declared} bytes (max ${max})`,
        );
      }
      if (!res.body)
        throw new HttpRequestError(
          url,
          res.status,
          `Empty response body from ${url}`,
        );

      await mkdir(dirname(filePath), { recursive: true });
      const partPath = `${filePath}.part`;
      let bytes = 0;
      try {
        await pipeline(
          Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              bytes += chunk.length;
              if (bytes > max) {
                throw new HttpRequestError(
                  url,
                  res.status,
                  `File too large: over ${max} bytes`,
                );
              }
              yield chunk;
            }
          },
          createWriteStream(partPath),
        );
        await rename(partPath, filePath);
      } catch (error) {
        await rm(partPath, { force: true });
        throw error;
      }
      return { bytes, contentType: res.headers.get('content-type') };
    });
  }

  private async fetchOk(
    url: string,
    options: RequestOptions,
    timeoutMs: number,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { ...this.options.headers, ...options.headers },
        redirect: 'follow',
        // Note: Covers reading the body too, so a stalled download also times out
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HttpRequestError(
        url,
        null,
        `GET ${url} failed: ${describeError(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpRequestError(
        url,
        res.status,
        `GET ${url} answered HTTP ${res.status}`,
      );
    }
    return res;
  }

  /** `https.get`, because fetch has no per-request `maxHeaderSize` */
  private getTextWithLargeHeaders(
    url: string,
    options: RequestOptions,
    redirects = 0,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpsGet(
        url,
        {
          headers: { ...this.options.headers, ...options.headers },
          maxHeaderSize: options.maxHeaderSize,
          timeout: options.timeoutMs ?? this.options.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location && redirects < 3) {
            res.resume();
            const next = new URL(location, url).toString();
            resolve(this.getTextWithLargeHeaders(next, options, redirects + 1));
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(
              new HttpRequestError(
                url,
                status,
                `GET ${url} answered HTTP ${status}`,
              ),
            );
            return;
          }
          res.setEncoding('utf8');
          let body = '';
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve(body));
          res.on('error', (error) =>
            reject(
              new HttpRequestError(
                url,
                null,
                `GET ${url} failed: ${error.message}`,
                { cause: error },
              ),
            ),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (error) =>
        reject(
          new HttpRequestError(
            url,
            null,
            `GET ${url} failed: ${error.message}`,
            { cause: error },
          ),
        ),
      );
    });
  }

  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        // Note: Mid-stream resets and other non-HTTP errors are worth one more try
        const retryable =
          error instanceof HttpRequestError ? error.retryable : true;
        if (!retryable || n >= this.options.retries) throw error;

        const delayMs = this.options.retryDelayMs * 2 ** n;
        this.logger.warn(
          `${describeError(error)}; retry ${n + 1}/${this.options.retries} in ${delayMs} ms`,
        );
        await sleep(delayMs);
      }
    }
  }
}
