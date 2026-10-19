import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { APP_MODES } from '../app-mode';

/**
 * Environment variables, validated by ConfigModule at boot.
 * Note: ConfigService returns the parsed values (coerced numbers, defaults applied).
 */
export const envSchema = z.object({
  APP_MODE: z.enum(APP_MODES).default('all'),
  NODE_ENV: z
    .enum(['development', 'production', 'worker'])
    .default('development'),
  PORT: z.coerce.number().default(3000),

  // Database: DATABASE_URL wins over the DB_* parts when set
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().nonempty(),
  DB_USERNAME: z.string().nonempty(),
  DB_PASSWORD: z.string().nonempty(),

  // Admin API: comma-separated SHA-256 hex digests of accepted keys; unset = admin routes reject all
  ADMIN_API_KEY_HASHES: z
    .string()
    .regex(/^[0-9a-f]{64}(,[0-9a-f]{64})*$/)
    .optional(),

  // Cloudflare R2 (S3-compatible endpoint), private bucket
  R2_ACCOUNT_ID: z.string().nonempty(),
  R2_ACCESS_KEY_ID: z.string().nonempty(),
  R2_SECRET_ACCESS_KEY: z.string().nonempty(),
  R2_BUCKET: z.string().nonempty(),
  R2_PAGE_TTL_DAYS: z.coerce.number().int().positive().default(10),

  // AI page parser
  GEMINI_API_KEY: z.string().nonempty(),
  GEMINI_MODEL: z.string().nonempty().default('gemini-3.5-flash-lite'),

  // Worker schedules (Europe/Bratislava) and the temp folder for downloads
  PIPELINE_CRON: z.string().nonempty().default('0 6 * * *'),
  PIPELINE_RETRY_CRON: z.string().nonempty().default('*/15 * * * *'),
  PIPELINE_TMP_DIR: z
    .string()
    .nonempty()
    .default(join(tmpdir(), 'flyer-parser')),
});

/** Parsed env; use as `ConfigService<Env, true>` and read with `{ infer: true }` */
export type Env = z.infer<typeof envSchema>;
