import {
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/** Prefix of every flyer object (page images, later offer crops); the lifecycle rule targets it */
export const FLYER_OBJECT_PREFIX = 'flyers/';

/** Id of the lifecycle rule that expires flyer objects */
const FLYER_LIFECYCLE_RULE_ID = 'flyer-objects-ttl';

/** Lifetime of presigned GET URLs, in seconds */
const PRESIGN_TTL_SECONDS = 60 * 60;

/** Timeout of a whole R2 request (until the response is received), in ms */
const R2_REQUEST_TIMEOUT_MS = 60_000;

/** Timeout of opening the connection to R2, in ms */
const R2_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * true only for the "object does not exist" errors (GetObject: NoSuchKey, HeadObject: NotFound).
 * Note: A 404 with another name (e.g. NoSuchBucket from a misconfigured R2_BUCKET) is not a missing object and must throw.
 */
function isNotFound(error: unknown): boolean {
  const { name } = (error ?? {}) as { name?: string };
  return name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * Cloudflare R2 client (private bucket) through R2's S3-compatible endpoint.
 * Note: The S3 SDK is an implementation detail; nothing here talks to AWS.
 */
@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttlDays: number;

  /** Builds the S3 client for `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` */
  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('R2_BUCKET', { infer: true });
    this.ttlDays = config.get('R2_PAGE_TTL_DAYS', { infer: true });
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.get('R2_ACCOUNT_ID', { infer: true })}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get('R2_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('R2_SECRET_ACCESS_KEY', { infer: true }),
      },
      // Note: R2 does not support the SDK's default CRC32 request checksums (aws-sdk-js-v3 >= 3.729)
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: {
        requestTimeout: R2_REQUEST_TIMEOUT_MS,
        connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      },
    });
  }

  /** Upload (or overwrite) an object */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Read a whole object into memory
   * @returns The bytes, or null if the object does not exist (e.g. expired by the lifecycle rule)
   */
  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** true if the object exists; a HEAD request, no download */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Short-lived GET URL for the frontend or admin (the bucket stays private) */
  presign(key: string, expiresIn = PRESIGN_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  /**
   * Apply the lifecycle rule: objects under `flyers/` expire after R2_PAGE_TTL_DAYS days.
   * Note: Idempotent. PutBucketLifecycleConfiguration replaces all rules of the bucket,
   *       so the bucket must be dedicated to this service. The token needs bucket-config permission.
   */
  async ensureLifecycle(): Promise<void> {
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: FLYER_LIFECYCLE_RULE_ID,
              Status: 'Enabled',
              Filter: { Prefix: FLYER_OBJECT_PREFIX },
              Expiration: { Days: this.ttlDays },
            },
          ],
        },
      }),
    );
    this.logger.log(
      `Lifecycle rule applied: ${FLYER_OBJECT_PREFIX}* expires after ${this.ttlDays} days`,
    );
  }
}
