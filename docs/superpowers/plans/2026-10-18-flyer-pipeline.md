# Flyer Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download each shop's weekly flyer, store its pages in R2 and Postgres, and extract offers with Gemini. The run is triggered by a daily cron (worker) or by admin routes (API).

**Architecture:** Feature modules with a one-way dependency graph:
`Storage`, `Shops` and `SourceProviders` are leaves. `Flyers` → `Storage`, `Shops`. `PageParser` → `Flyers`, `Storage`. `Pipeline` → `Shops`, `SourceProviders`, `Flyers`, `PageParser`. The admin modules and `Worker` are leaves on top.

`FlyerPipelineService` owns the stages: discover → materialize to a temp dir → register rows → upload to R2 → parse from R2 → finalize. Local files are temporary. DB rows and R2 objects are the source of truth.

**Tech Stack:** NestJS 11, TypeORM (Postgres), zod 4, `@aws-sdk/client-s3` (against R2), `@google/genai`, `pdf-to-img`, `sharp`, `@nestjs/schedule` + `cron`.

**Spec:** `docs/superpowers/specs/2026-10-18-flyer-pipeline-design.md`

## Global Constraints

- **No tests.** Do not write or run unit or e2e tests. The only verification step is `pnpm lint` (eslint with type-checked rules, prettier, `--fix`). It must finish with **0 errors**. Warnings are allowed.
- **JSDoc everywhere.** Every class, method, injectable provider, exported function, exported type or interface and exported const gets a descriptive `/** */` comment.
- **No co-authors.** Commit messages must not contain any `Co-Authored-By` trailer.
- **Source repo is read-only.** `C:\Users\hk\Documents\Development\node\ai flyer parser` is never modified. Port its code by copying.
- **Style.** Follow `CLAUDE.md`: single quotes, trailing commas, definite assignment in entities (`field!: Type`), `Relation<>` with `import type`, `as const` tuples, `timestamptz` for times, `date` strings for flyer validity.
- **Admin routes have no guard.**
- **Module system.** The project compiles to CommonJS (`module: nodenext`, no `"type": "module"`). `pdf-to-img` is ESM-only, so it is loaded with `await import('pdf-to-img')`. `sharp` and `@google/genai` ship CommonJS builds.
- **Typed config.** Read config through `ConfigService<Env, true>` with `{ infer: true }`. `Env` comes from `src/config/env.schema.ts`.

---

## File Structure

```
src/
├─ main.ts                                   bootstrap per APP_MODE (worker = no HTTP)
├─ app-mode.ts                               APP_MODES, resolveAppMode()
├─ app.module.ts                             AppModule.forMode(mode)
├─ config/env.schema.ts                      zod env schema + Env type
├─ core/core.module.ts                       ConfigModule + DatabaseModule (every mode)
├─ common/
│  ├─ concurrency.ts                         mapLimit()
│  ├─ dates.ts                               isoDate, isIsoDate, addDaysIso, isoDateIn, isValidTimeZone, isOverdue
│  ├─ errors.ts                              describeError()
│  ├─ html.ts                                decodeHtmlEntities()
│  └─ pipes/ parse-shop-key.pipe.ts, zod-validation.pipe.ts
├─ storage/ storage.module.ts, r2.service.ts
├─ shops/
│  ├─ shops.module.ts                        ShopState repo + ShopStateService + ShopLeaseService
│  ├─ shop-state.service.ts, shop-lease.service.ts
│  ├─ shop.config.ts, shop.config.type.ts, shop.config.schema.ts
│  └─ admin/ shops-admin.module.ts, admin-shops.controller.ts
├─ source-providers/
│  ├─ source-providers.module.ts, source-providers.service.ts, source-providers.tokens.ts
│  ├─ source-provider.ts, source-provider.types.ts, source-provider.errors.ts, source-provider.exception-filter.ts
│  ├─ http.service.ts, page-materializer.service.ts
│  ├─ providers/ index.ts, kaufland|tesco|lidl|billa.source-provider.ts
│  └─ admin/ source-providers-admin.module.ts, admin-source-providers.controller.ts
├─ flyers/
│  ├─ flyers.module.ts, flyers.controller.ts, flyers.service.ts (public read API)
│  ├─ page-registrar.service.ts, flyer-keys.ts, flyers.errors.ts
│  └─ entities/, enums/, types/              (existing; schema fixes)
├─ page-parser/
│  ├─ page-parser.module.ts, page-parser.service.ts
│  ├─ gemini.client.ts, page-prompt.ts, normalize.ts, retry.ts, page-parser.errors.ts
│  └─ admin/ page-parser-admin.module.ts, admin-page-parser.controller.ts, admin-page-parser.service.ts, offer.schema.ts
├─ pipeline/ pipeline.module.ts, flyer-pipeline.service.ts, pipeline.exception-filter.ts
└─ worker/ worker.module.ts, pipeline.cron.ts
```

Deleted: `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`, `src/flyers/dto/*`.

---

### Task 1: Dependencies, env schema and APP_MODE bootstrap

**Files:**
- Modify: `package.json` (via pnpm)
- Create: `src/app-mode.ts`, `src/config/env.schema.ts`, `src/core/core.module.ts`, `.env.example`
- Modify: `src/app.module.ts`, `src/main.ts`
- Delete: `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`

**Interfaces:**
- Produces: `APP_MODES`, `AppMode`, `resolveAppMode()`; `envSchema`, `Env`; `CoreModule`; `AppModule.forMode(mode: AppMode): DynamicModule`

- [ ] **Step 1: Install dependencies**

Run (Git Bash):
```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @google/genai pdf-to-img sharp @nestjs/schedule
pnpm add "cron@$(node -p "require('./node_modules/@nestjs/schedule/package.json').dependencies.cron")"
```
Expected: both commands succeed. `cron` is pinned to the exact range `@nestjs/schedule` uses, so `SchedulerRegistry.addCronJob` accepts our `CronJob`.

- [ ] **Step 2: Create `src/app-mode.ts`**

```ts
/** Process roles selected by the `APP_MODE` env var */
export const APP_MODES = ['api', 'worker', 'all'] as const;

/** One of `APP_MODES` */
export type AppMode = (typeof APP_MODES)[number];

/**
 * Read `APP_MODE` before Nest boots, because it decides which modules are loaded
 * `api`    - HTTP: public offers API + admin routes (admin-triggered runs execute in this process)
 * `worker` - daily cron + retry tick + flyer pipeline, no HTTP server
 * `all`    - both in one process
 */
export function resolveAppMode(value = process.env.APP_MODE): AppMode {
  const mode = (value ?? 'all').trim().toLowerCase();
  if (!(APP_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `APP_MODE must be one of ${APP_MODES.join(', ')}; got "${value}"`,
    );
  }
  return mode as AppMode;
}
```

- [ ] **Step 3: Create `src/config/env.schema.ts`**

```ts
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
```

- [ ] **Step 4: Create `src/core/core.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';

/** Loaded in every mode: validated global config and the database connection */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envSchema,
    }),
    DatabaseModule,
  ],
})
export class CoreModule {}
```

- [ ] **Step 5: Replace `src/app.module.ts`**

```ts
import { DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppMode } from './app-mode';
import { CoreModule } from './core/core.module';
import { FlyersModule } from './flyers/flyers.module';
import { ShopsModule } from './shops/shops.module';

/** Feature modules of the HTTP API (`api`, `all`); completed in Task 12 */
const API_MODULES: Type[] = [ShopsModule, FlyersModule];

/** Feature modules of the background worker (`worker`, `all`); completed in Task 12 */
const WORKER_MODULES: Type[] = [ShopsModule, FlyersModule];

/** Root module; `forMode` picks the feature modules for the process role */
@Module({})
export class AppModule {
  /** Build the root module for `mode`; a module needed by both roles is imported once */
  static forMode(mode: AppMode): DynamicModule {
    const modules = new Set<Type>([
      ...(mode === 'worker' ? [] : API_MODULES),
      ...(mode === 'api' ? [] : WORKER_MODULES),
    ]);
    return { module: AppModule, imports: [CoreModule, ...modules] };
  }
}
```

- [ ] **Step 6: Replace `src/main.ts`**

```ts
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolveAppMode } from './app-mode';
import { AppModule } from './app.module';

// Note: APP_MODE is needed before ConfigModule reads .env; real env vars still win
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file (production, CI)
}

/** Start the process in the role selected by APP_MODE */
async function bootstrap(): Promise<void> {
  const mode = resolveAppMode();
  const logger = new Logger('Bootstrap');

  if (mode === 'worker') {
    // Note: No HTTP server; the cron jobs keep the process alive
    const app = await NestFactory.createApplicationContext(
      AppModule.forMode(mode),
    );
    app.enableShutdownHooks();
    logger.log('Worker running');
    return;
  }

  const app = await NestFactory.create(AppModule.forMode(mode));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
  logger.log(
    `${mode === 'all' ? 'API + worker' : 'API'} listening on ${await app.getUrl()}`,
  );
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(error);
  process.exit(1);
});
```

- [ ] **Step 7: Create `.env.example`**

```dotenv
APP_MODE=all
NODE_ENV=development
PORT=3000

# Database + Docker
DB_HOST=localhost
DB_PORT=5432
DB_NAME=flyers
DB_USERNAME=flyers
DB_PASSWORD=flyers
# DATABASE_URL=postgres://user:pass@host:5432/db

# Cloudflare R2 (token needs object read/write + bucket lifecycle config)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PAGE_TTL_DAYS=10

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite

# Worker
PIPELINE_CRON=0 6 * * *
PIPELINE_RETRY_CRON=*/15 * * * *
# PIPELINE_TMP_DIR=
```

- [ ] **Step 8: Delete the Hello-World scaffold**

```bash
git rm src/app.controller.ts src/app.service.ts src/app.controller.spec.ts test/app.e2e-spec.ts
```

- [ ] **Step 9: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: env schema, APP_MODE bootstrap and pipeline dependencies"
```

---

### Task 2: Shared utilities, shop config schemas and entity fixes

**Files:**
- Create: `src/common/concurrency.ts`, `src/common/dates.ts`, `src/common/errors.ts`, `src/common/html.ts`, `src/common/pipes/parse-shop-key.pipe.ts`, `src/common/pipes/zod-validation.pipe.ts`, `src/shops/shop.config.schema.ts`
- Modify: `src/shops/shop.config.type.ts`, `src/shops/shop.config.ts`, `src/shops/shops.module.ts`, `src/flyers/enums/page.enums.ts`, `src/flyers/entities/flyer-page.entity.ts`, `src/flyers/entities/flyer-offer.entity.ts`

**Interfaces:**
- Produces:
  - `mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`
  - `isoDate`, `isIsoDate`, `addDaysIso`, `isoDateIn(timeZone, date?)`, `isValidTimeZone`, `isOverdue(validTo, timeZone, now?)`
  - `describeError(error: unknown): string`, `decodeHtmlEntities(value)`
  - `ParseShopKeyPipe`, `ZodValidationPipe`
  - `SOURCE_OPTIONS_SCHEMAS`, `SourceOptionsMap`
  - `ShopKeys`, `ShopKey`, `CompressImageOptions` (format required), `PageImageOptions`, `ParserOptions`, `ShopConfig<K>`, `ShopConfigs`, `ShopConfigOverrides<K>`
  - `PageStatus` = `PENDING | UPLOADED | PARSED | FAILED`

- [ ] **Step 1: Create `src/common/concurrency.ts`**

```ts
/**
 * Run `fn` over `items` with at most `limit` calls in flight
 * Note: Results keep the input order; the first rejection rejects the whole call
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  /** Takes the next item until none are left */
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  return results;
}
```

- [ ] **Step 2: Create `src/common/dates.ts`**

```ts
/** `YYYY-MM-DD` */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` from parts; throws on impossible dates such as 2026-02-30 */
export function isoDate(
  year: number | string,
  month: number | string,
  day: number | string,
): string {
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new RangeError(`Invalid date: ${year}-${month}-${day}`);
  }
  return date.toISOString().slice(0, 10);
}

/** true for a real `YYYY-MM-DD` date string */
export function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** `iso` plus `days` calendar days, as `YYYY-MM-DD` */
export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Calendar day of `date` in `timeZone`, as `YYYY-MM-DD` */
export function isoDateIn(timeZone: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** true if `timeZone` is a known IANA time zone */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** true once today (in `timeZone`) is past `validTo`; a flyer is valid through its last day */
export function isOverdue(
  validTo: string,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  return isoDateIn(timeZone, now) > validTo;
}
```

- [ ] **Step 3: Create `src/common/errors.ts` and `src/common/html.ts`**

`src/common/errors.ts`:
```ts
/** Short error text for logs, ShopState.lastError and API responses */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

`src/common/html.ts`:
```ts
/** HTML entities that show up in attribute values scraped from shop pages */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

/** Decode the entities found in HTML attribute values, e.g. `&amp;` in a URL */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(amp|quot|#39|#x27|lt|gt);/g,
    (match) => ENTITIES[match] ?? match,
  );
}
```

- [ ] **Step 4: Create the pipes**

`src/common/pipes/parse-shop-key.pipe.ts`:
```ts
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';

/** Route param → ShopKey; 400 for an unknown shop */
@Injectable()
export class ParseShopKeyPipe implements PipeTransform<string, ShopKey> {
  /** Validate `value` against `ShopKeys` */
  transform(value: string): ShopKey {
    if (!(ShopKeys as readonly string[]).includes(value)) {
      throw new BadRequestException(
        `Unknown shop "${value}"; expected one of ${ShopKeys.join(', ')}`,
      );
    }
    return value as ShopKey;
  }
}
```

`src/common/pipes/zod-validation.pipe.ts`:
```ts
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/**
 * Validate a body, query or param with a zod schema; 400 with readable issues on failure
 * Usage: `@Body(new ZodValidationPipe(schema)) body: z.infer<typeof schema>`
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  /** @param schema - Schema the incoming value must match */
  constructor(private readonly schema: T) {}

  /** Parse `value`; returns the schema output (defaults applied, unknown keys handled by the schema) */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(z.prettifyError(result.error));
    }
    return result.data;
  }
}
```

- [ ] **Step 5: Create `src/shops/shop.config.schema.ts`**

```ts
import { z } from 'zod';
import type { ShopKey } from './shop.config.type';

/** Only https URLs are accepted for shop sources */
const httpsUrl = z.url({ protocol: /^https$/ });

/**
 * Source options per shop: what its source provider needs to find the current flyer.
 * Note: Single source of truth for the types (SourceOptionsMap) and for validating admin overrides.
 */
export const SOURCE_OPTIONS_SCHEMAS = {
  kaufland: z.object({
    // Page with the flyer tiles; each tile has its validity and a static PDF URL
    flyerUrl: httpsUrl,
    // Tile to pick, `KDZ` = main weekly flyer
    flyerSubcategory: z.string().min(1),
  }),
  tesco: z.object({
    // Next.js page; __NEXT_DATA__ holds every leaflet with dates, PDF and page images
    flyerUrl: httpsUrl,
    // HM = hypermarket, SM = supermarket, CAT = catalogue
    flyerType: z.enum(['HM', 'SM', 'CAT']),
    // `pdf` renders leafletUrl, `images` downloads the pre-rendered pagePNG files
    pages: z.enum(['pdf', 'images']),
  }),
  lidl: z.object({
    // List page with the weekly flyer slugs
    flyerUrl: httpsUrl,
    // Leaflets API: dates, PDF and page images per slug
    apiUrl: httpsUrl,
    regionId: z.number().int().nonnegative(),
    // `image` ~708x1200 (~190 KB), `zoom` ~1415x2400 (~500 KB)
    imageVariant: z.enum(['image', 'zoom']),
    pages: z.enum(['images', 'pdf']),
  }),
  billa: z.object({
    // Page with "Akciová ponuka platí od … do …" and the Publitas PDF link
    flyerUrl: httpsUrl,
  }),
} satisfies Record<ShopKey, z.ZodObject>;

/** Source options type per shop, derived from `SOURCE_OPTIONS_SCHEMAS` */
export type SourceOptionsMap = {
  [K in ShopKey]: z.infer<(typeof SOURCE_OPTIONS_SCHEMAS)[K]>;
};
```

- [ ] **Step 6: Replace `src/shops/shop.config.type.ts`**

```ts
import type { SourceOptionsMap } from './shop.config.schema';

/** Every supported shop; a new shop also needs a SHOP_CONFIGS entry, a source schema and a provider */
export const ShopKeys = ['kaufland', 'tesco', 'lidl', 'billa'] as const;

/** One of `ShopKeys` */
export type ShopKey = (typeof ShopKeys)[number];

/** How a page image is compressed before it is uploaded */
export interface CompressImageOptions {
  format: 'jpg' | 'png' | 'webp';
  /** 1-100 */
  quality?: number;
  /** Downscales width if the image is wider (keeps aspect ratio, never upscales) */
  maxWidth?: number;
}

/** How flyer pages are turned into images */
export interface PageImageOptions {
  compress: CompressImageOptions;
  /** pdf.js render scale, `1` is 72 DPI */
  pdfScale: number;
}

/** AI parser limits of a shop */
export interface ParserOptions {
  /** Pages parsed in parallel */
  concurrency: number;
  /** Attempts per page within a run; also caps shop-level retries */
  maxAttempts: number;
  /** Up to this many failed pages the flyer is PARTIAL instead of FAILED */
  maxFailedPages: number;
}

/** Static config of one shop */
export interface ShopConfig<K extends ShopKey = ShopKey> {
  key: K;
  name: string;
  /** Only affects scheduled runs; an admin can still run a disabled shop */
  enabled: boolean;
  /** IANA time zone; decides what "today" is (current flyer, overdue check) */
  timezone: string;
  /** Days added to validFrom when the site prints no end date */
  defaultFlyerDuration: number;
  source: SourceOptionsMap[K];
  pages: PageImageOptions;
  parser: ParserOptions;
}

/** Config of every shop, keyed by ShopKey */
export type ShopConfigs = { readonly [K in ShopKey]: ShopConfig<K> };

/** What an admin may override for one discover call */
export interface ShopConfigOverrides<K extends ShopKey = ShopKey> {
  source?: Partial<SourceOptionsMap[K]>;
  defaultFlyerDuration?: number;
  timezone?: string;
}
```

- [ ] **Step 7: Replace `src/shops/shop.config.ts`**

```ts
import type { ShopConfigs } from './shop.config.type';

/** Page images: webp q60, max 800 px wide; PDFs rendered at 2x */
const PAGES = {
  compress: { format: 'webp', quality: 60, maxWidth: 800 },
  pdfScale: 2,
} as const;

/** AI parser limits shared by every shop */
const PARSER = {
  concurrency: 4,
  maxAttempts: 4,
  maxFailedPages: 3,
};

/** Defaults shared by every shop */
const base = {
  enabled: true,
  timezone: 'Europe/Bratislava',
  defaultFlyerDuration: 7,
  pages: PAGES,
  parser: PARSER,
};

/** Static per-shop config: sources, page compression and parser limits */
export const SHOP_CONFIGS: ShopConfigs = {
  kaufland: {
    ...base,
    key: 'kaufland',
    name: 'Kaufland',
    source: {
      flyerUrl: 'https://predajne.kaufland.sk/aktualna-ponuka/letak.html',
      flyerSubcategory: 'KDZ',
    },
  },
  tesco: {
    ...base,
    key: 'tesco',
    name: 'Tesco',
    source: {
      flyerUrl: 'https://www.tesco.sk/akciove-ponuky/letaky-a-katalogy',
      flyerType: 'HM',
      pages: 'pdf',
    },
  },
  lidl: {
    ...base,
    key: 'lidl',
    name: 'Lidl',
    source: {
      flyerUrl: 'https://www.lidl.sk/c/online-letak/s10008489',
      apiUrl: 'https://endpoints.leaflets.schwarz/v4/flyer',
      regionId: 0,
      imageVariant: 'image',
      pages: 'images',
    },
  },
  billa: {
    ...base,
    key: 'billa',
    name: 'Billa',
    source: {
      flyerUrl:
        'https://www.billa.sk/letaky-a-akcie%2Fletaky?tab=letaky-a-akcie/aktualny-letak',
    },
  },
};
```

- [ ] **Step 8: Replace `src/flyers/enums/page.enums.ts`**

```ts
/** Lifecycle of a flyer page: registered → in R2 → parsed or failed */
export enum PageStatus {
  // Row registered, image not in R2 yet
  Pending = 'PENDING',
  // Image uploaded to R2 and linked (imageKey/imageHash set)
  Uploaded = 'UPLOADED',
  // Offers extracted by the current or an older parser version
  Parsed = 'PARSED',
  // Parsing failed after all attempts; retried by the next run
  Failed = 'FAILED',
}
```

- [ ] **Step 9: Fix `src/flyers/entities/flyer-page.entity.ts`**

Replace the `status`, `imageKey` and `imageHash` columns:
```ts
  @Column({ type: 'varchar', length: 16, default: PageStatus.Pending })
  status!: PageStatus;
```
```ts
  // e.g.: flyers/<shopKey>/<flyerId>/pages/<pageId>.<hash8>.webp; null until uploaded
  @Column({ type: 'text', nullable: true })
  imageKey!: string | null;

  // e.g.: webp sha256; null until uploaded
  @Column({ type: 'char', length: 64, nullable: true })
  imageHash!: string | null;
```

- [ ] **Step 10: Fix `src/flyers/entities/flyer-offer.entity.ts`**

Replace the two discount columns (`'number'` is not a Postgres type):
```ts
  // Discount of `discountedPrice` in percent, e.g. 25
  @Column({ type: 'smallint', nullable: true })
  discount!: number | null;

  // Discount of `loyaltyPrice` in percent
  @Column({ type: 'smallint', nullable: true })
  loyaltyDiscount!: number | null;
```
Also change `import { ProductCategoryKey } from '../types/product-category.type';` to `import type { ProductCategoryKey } from '../types/product-category.type';`.

- [ ] **Step 11: Replace `src/shops/shops.module.ts`**

The `FlyersModule` import and re-export go away. `autoLoadEntities` resolves entity relations without a module import.
```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopState } from './entities/shop-state.entity';

/** Owns ShopState: per-shop runtime state, retry bookkeeping and the run lease */
@Module({
  imports: [TypeOrmModule.forFeature([ShopState])],
  exports: [TypeOrmModule],
})
export class ShopsModule {}
```

- [ ] **Step 12: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: shared utils, shop source schemas and entity schema fixes"
```

---

### Task 3: R2 storage module

**Files:**
- Create: `src/storage/r2.service.ts`, `src/storage/storage.module.ts`

**Interfaces:**
- Consumes: `Env`
- Produces:
  - `R2Service`: `put(key, body: Buffer, contentType): Promise<void>`, `get(key): Promise<Buffer | null>`, `exists(key): Promise<boolean>`, `presign(key, expiresIn?): Promise<string>`, `ensureLifecycle(): Promise<void>`
  - `FLYER_OBJECT_PREFIX = 'flyers/'`
  - `StorageModule` (exports `R2Service`)

- [ ] **Step 1: Create `src/storage/r2.service.ts`**

```ts
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

/** true for the S3 "object does not exist" errors (GetObject: NoSuchKey, HeadObject: NotFound) */
function isNotFound(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    $metadata?.httpStatusCode === 404
  );
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
```

- [ ] **Step 2: Create `src/storage/storage.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { R2Service } from './r2.service';

/** Object storage (Cloudflare R2) for page images */
@Module({
  providers: [R2Service],
  exports: [R2Service],
})
export class StorageModule {}
```

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(storage): R2 service with presign and lifecycle rule"
```

---

### Task 4: Shop state and lease services

**Files:**
- Create: `src/shops/shop-state.service.ts`, `src/shops/shop-lease.service.ts`
- Modify: `src/shops/shops.module.ts`

**Interfaces:**
- Consumes: `ShopState`, `RetryReason`, `ShopKeys`, `describeError`
- Produces:
  - `ShopStateService`: `list()`, `listAvailable()`, `get(shop)` (all load `currentFlyer`), `findDueRetries(now?)`, `markAttempt(shop)`, `setCurrentFlyer(shop, flyerId)`, `clearRetry(shop)`, `scheduleRetry(shop, reason, { maxAttempts?, error? }): Promise<Date | null>`, `recordError(shop, message)`
  - `ShopLeaseService.acquire(shop): Promise<ShopLease>`, `ShopLease { shop; release(): Promise<void> }`, `LeaseBusyError`

- [ ] **Step 1: Create `src/shops/shop-state.service.ts`**

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { ShopState } from './entities/shop-state.entity';
import { RetryReason } from './enums/shop.enums';
import { ShopKeys, type ShopKey } from './shop.config.type';

/** Minute in ms */
const MINUTE_MS = 60_000;
/** First backoff for FETCH_FAILED / PAGES_FAILED; doubles per attempt */
const BACKOFF_BASE_MS = 30 * MINUTE_MS;
/** Upper bound of a single backoff */
const BACKOFF_MAX_MS = 12 * 60 * MINUTE_MS;
/** Flat delay while the shop site still shows the overdue flyer */
const AWAITING_DELAY_MS = 60 * MINUTE_MS;

/** Options of `ShopStateService.scheduleRetry` */
export interface ScheduleRetryOptions {
  /** Stop scheduling (retry.at = null) once attempts reach this; ignored for AWAITING_NEW_FLYER */
  maxAttempts?: number;
  /** Stored in lastError */
  error?: string;
}

/** Reads and updates ShopState: current flyer, availability, retries, last error */
@Injectable()
export class ShopStateService implements OnModuleInit {
  /** @param states - ShopState repository */
  constructor(
    @InjectRepository(ShopState)
    private readonly states: Repository<ShopState>,
  ) {}

  /** Insert a row for every ShopKey that has none (flyers reference it through a foreign key) */
  async onModuleInit(): Promise<void> {
    await this.states
      .createQueryBuilder()
      .insert()
      .into(ShopState)
      .values(ShopKeys.map((shop) => ({ shop })))
      .orIgnore()
      .execute();
  }

  /** Every shop with its current flyer */
  list(): Promise<ShopState[]> {
    return this.states.find({
      relations: { currentFlyer: true },
      order: { shop: 'ASC' },
    });
  }

  /** Shops the frontend may show (a READY or PARTIAL flyer exists) */
  listAvailable(): Promise<ShopState[]> {
    return this.states.find({
      where: { isAvailiable: true },
      relations: { currentFlyer: true },
      order: { shop: 'ASC' },
    });
  }

  /** One shop with its current flyer */
  get(shop: ShopKey): Promise<ShopState> {
    return this.states.findOneOrFail({
      where: { shop },
      relations: { currentFlyer: true },
    });
  }

  /** Shops whose scheduled retry is due */
  findDueRetries(now: Date = new Date()): Promise<ShopState[]> {
    return this.states.find({
      where: { retry: { at: LessThanOrEqual(now) } },
      order: { shop: 'ASC' },
    });
  }

  /** Stamp the start of a run */
  async markAttempt(shop: ShopKey): Promise<void> {
    await this.states.update(shop, { lastAttemptAt: new Date() });
  }

  /** Make `flyerId` the flyer the frontend shows */
  async setCurrentFlyer(shop: ShopKey, flyerId: string): Promise<void> {
    await this.states.update(shop, {
      currentFlyerId: flyerId,
      isAvailiable: true,
      awaitingNewFlyer: false,
      lastSuccessAt: new Date(),
      lastError: null,
    });
  }

  /** Forget any scheduled retry */
  async clearRetry(shop: ShopKey): Promise<void> {
    await this.states.update(shop, {
      awaitingNewFlyer: false,
      retry: { reason: null, attempts: 0, at: null },
    });
  }

  /**
   * Schedule the next retry of `shop`
   * Note: Attempts count up while the reason stays the same. FETCH_FAILED / PAGES_FAILED back off
   *       30m · 2^(n-1) up to 12h and stop at `maxAttempts`; AWAITING_NEW_FLYER retries hourly forever.
   * @returns When the retry tick picks the shop up again, or null if retries are used up
   */
  async scheduleRetry(
    shop: ShopKey,
    reason: RetryReason,
    options: ScheduleRetryOptions = {},
  ): Promise<Date | null> {
    const { retry } = await this.get(shop);
    const attempts = retry.reason === reason ? retry.attempts + 1 : 1;
    const awaiting = reason === RetryReason.AwaitingNewFlyer;
    const exhausted =
      !awaiting &&
      options.maxAttempts !== undefined &&
      attempts >= options.maxAttempts;
    const delayMs = awaiting
      ? AWAITING_DELAY_MS
      : Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    const at = exhausted ? null : new Date(Date.now() + delayMs);

    await this.states.update(shop, {
      awaitingNewFlyer: awaiting,
      retry: { reason, attempts, at },
      ...(options.error !== undefined && { lastError: options.error }),
    });
    return at;
  }

  /** Store an error without scheduling a retry */
  async recordError(shop: ShopKey, message: string): Promise<void> {
    await this.states.update(shop, { lastError: message });
  }
}
```

- [ ] **Step 2: Create `src/shops/shop-lease.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { describeError } from '../common/errors';
import { ShopState } from './entities/shop-state.entity';
import type { ShopKey } from './shop.config.type';

/** Lease length; a crashed process frees the shop after this */
const LEASE_MS = 15 * 60_000;
/** How often a running pipeline extends its lease */
const RENEW_EVERY_MS = 5 * 60_000;

/** Another run (worker or API) holds the shop's lease */
export class LeaseBusyError extends Error {
  /**
   * @param shop - Shop that is busy
   * @param lockedUntil - When the current lease expires, if known
   */
  constructor(
    readonly shop: ShopKey,
    readonly lockedUntil: Date | null,
  ) {
    super(
      `[${shop}] another run holds the lease${lockedUntil ? ` until ${lockedUntil.toISOString()}` : ''}`,
    );
    this.name = 'LeaseBusyError';
  }
}

/** A held lease; renewed in the background until released */
export interface ShopLease {
  readonly shop: ShopKey;
  /** Stop renewing and free the shop */
  release(): Promise<void>;
}

/**
 * One pipeline run per shop at a time, across processes: `ShopState.lockedUntil` is a lease taken with
 * an atomic UPDATE. The exact `lockedUntil` value works as the owner token for renew and release.
 */
@Injectable()
export class ShopLeaseService {
  private readonly logger = new Logger(ShopLeaseService.name);

  /** @param states - ShopState repository */
  constructor(
    @InjectRepository(ShopState)
    private readonly states: Repository<ShopState>,
  ) {}

  /**
   * Take the shop's lease
   * @throws LeaseBusyError if another run holds an unexpired lease
   */
  async acquire(shop: ShopKey): Promise<ShopLease> {
    let until = new Date(Date.now() + LEASE_MS);
    const taken = await this.states
      .createQueryBuilder()
      .update(ShopState)
      .set({ lockedUntil: until })
      .where('shop = :shop', { shop })
      .andWhere('("lockedUntil" IS NULL OR "lockedUntil" < now())')
      .execute();
    if (!taken.affected) {
      const state = await this.states.findOneBy({ shop });
      throw new LeaseBusyError(shop, state?.lockedUntil ?? null);
    }

    /** Extend the lease by another LEASE_MS while we still own it */
    const renew = async (): Promise<void> => {
      const next = new Date(Date.now() + LEASE_MS);
      if (await this.move(shop, until, next)) until = next;
      else this.logger.warn(`[${shop}] lease was lost before renewal`);
    };
    const timer = setInterval(() => {
      renew().catch((error) =>
        this.logger.warn(
          `[${shop}] lease renewal failed: ${describeError(error)}`,
        ),
      );
    }, RENEW_EVERY_MS);
    timer.unref();

    return {
      shop,
      release: async () => {
        clearInterval(timer);
        await this.move(shop, until, null);
      },
    };
  }

  /**
   * Set `lockedUntil` to `next` (null frees the shop), only if it still equals `current`
   * @returns false if someone else holds the lease now
   */
  private async move(
    shop: ShopKey,
    current: Date,
    next: Date | null,
  ): Promise<boolean> {
    const result = await this.states
      .createQueryBuilder()
      .update(ShopState)
      .set({ lockedUntil: next })
      .where('shop = :shop AND "lockedUntil" = :current', { shop, current })
      .execute();
    return !!result.affected;
  }
}
```

- [ ] **Step 3: Replace `src/shops/shops.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopState } from './entities/shop-state.entity';
import { ShopLeaseService } from './shop-lease.service';
import { ShopStateService } from './shop-state.service';

/** Owns ShopState: per-shop runtime state, retry bookkeeping and the run lease */
@Module({
  imports: [TypeOrmModule.forFeature([ShopState])],
  providers: [ShopStateService, ShopLeaseService],
  exports: [ShopStateService, ShopLeaseService],
})
export class ShopsModule {}
```

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shops): shop state service and DB lease"
```

---

### Task 5: Source providers (discover + materialize)

Ported from branch `feat/page-providers` (`src/page-providers/*`) with renames: `PageProvider` → `SourceProvider`, `resolve` → `discover`, `ResolvedFlyer` → `DiscoveredFlyer`, `PageProviderError` → `SourceUnavailableError`, `ShopConfigOverrideError` → `InvalidOverridesError`. Added: `materialize()` and `PageMaterializer`, ported from `ai flyer parser/src/utils/{pdf,image}.ts`.

**Files:**
- Create: `src/source-providers/source-providers.tokens.ts`, `source-provider.types.ts`, `source-provider.errors.ts`, `http.service.ts`, `page-materializer.service.ts`, `source-provider.ts`, `providers/kaufland.source-provider.ts`, `providers/tesco.source-provider.ts`, `providers/lidl.source-provider.ts`, `providers/billa.source-provider.ts`, `providers/index.ts`, `source-providers.service.ts`
- Replace: `src/source-providers/source-providers.module.ts` (currently empty)

**Interfaces:**
- Consumes: `ShopConfig`, `ShopConfigs`, `ShopConfigOverrides`, `SOURCE_OPTIONS_SCHEMAS`, `SHOP_CONFIGS`, `mapLimit`, the date helpers, `describeError`, `decodeHtmlEntities`
- Produces:
  - `PageSource = { kind: 'pdf'; url } | { kind: 'images'; urls }`
  - `DiscoveredFlyer { shop; flyerId; validFrom; validTo; validToEstimated; sourceUrl; pages: PageSource; meta }`
  - `LocalPage { pageNumber; path; width; height }`
  - `DiscoverResult`
  - `SourceUnavailableError`, `InvalidOverridesError`, `HttpRequestError`, `FlyerHttpService`
  - `PageMaterializer`: `splitPdf(pdfPath, outDir, options: PageImageOptions)`, `compressFiles(files, outDir, compress)`, `compress(input, options)`
  - `SourceProvidersService`: `shops()`, `enabledShops()`, `getConfig(shop, overrides?)`, `parseOverrides(shop, raw)`, `discover(shop, overrides?)`, `discoverMany(shops?)`, `materialize(flyer, dir)`
  - `SourceProvidersModule` (exports `SourceProvidersService`)

- [ ] **Step 1: Create `src/source-providers/source-providers.tokens.ts`**

```ts
/** Injection token of the static shop configs (swappable in tests) */
export const SHOP_CONFIGS_TOKEN = Symbol('SHOP_CONFIGS');
/** Injection token of the list of every SourceProvider instance */
export const SOURCE_PROVIDERS = Symbol('SOURCE_PROVIDERS');
/** Injection token of FlyerHttpService options */
export const FLYER_HTTP_OPTIONS = Symbol('FLYER_HTTP_OPTIONS');
```

- [ ] **Step 2: Create `src/source-providers/source-provider.types.ts`**

```ts
import type { ShopKey } from '../shops/shop.config.type';

/** Where the flyer pages come from: one PDF to split, or ready page images */
export type PageSource =
  | { kind: 'pdf'; url: string }
  | { kind: 'images'; urls: string[] };

/** What a provider scraped from the shop site. Dates are `YYYY-MM-DD` in the shop's time zone */
export interface SourceListing {
  validFrom: string;
  /** null when the site prints no end date; discover() fills it from defaultFlyerDuration */
  validTo: string | null;
  sourceUrl: string;
  pages: PageSource;
  meta?: Record<string, unknown>;
}

/** A listing checked and completed by SourceProvider.discover(); nothing is downloaded yet */
export interface DiscoveredFlyer {
  shop: ShopKey;
  /** e.g. kaufland_2026-10-14_2026-10-20 */
  flyerId: string;
  validFrom: string;
  validTo: string;
  /** true when validTo came from defaultFlyerDuration instead of the site */
  validToEstimated: boolean;
  sourceUrl: string;
  pages: PageSource;
  meta: Record<string, unknown>;
}

/** Outcome of discovering one shop in a batch; a failure never hides the other shops */
export type DiscoverResult =
  | { shop: ShopKey; ok: true; flyer: DiscoveredFlyer }
  | { shop: ShopKey; ok: false; error: string };

/** A compressed page image in the run's temp folder */
export interface LocalPage {
  /** 1-based */
  pageNumber: number;
  /** Absolute path; the extension is the image format */
  path: string;
  width: number;
  height: number;
}
```

- [ ] **Step 3: Create `src/source-providers/source-provider.errors.ts`**

```ts
import type { ShopKey } from '../shops/shop.config.type';

/** The shop site answered, but not with what the provider expects (layout changed, no flyer, broken PDF) */
export class SourceUnavailableError extends Error {
  /**
   * @param shop - Shop whose source failed
   * @param message - What was missing or wrong
   */
  constructor(
    readonly shop: ShopKey,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${shop}] ${message}`, options);
    this.name = 'SourceUnavailableError';
  }
}

/** One invalid field of admin overrides */
export type OverrideIssue = { path: string; message: string };

/** Admin overrides failed validation; nothing was fetched */
export class InvalidOverridesError extends Error {
  /**
   * @param shop - Shop the overrides were for
   * @param issues - Every invalid field
   */
  constructor(
    readonly shop: ShopKey,
    readonly issues: OverrideIssue[],
  ) {
    super(
      `[${shop}] invalid overrides: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'InvalidOverridesError';
  }
}
```

- [ ] **Step 4: Create `src/source-providers/http.service.ts`**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeError } from '../common/errors';
import { FLYER_HTTP_OPTIONS } from './source-providers.tokens';

/** Defaults for every request to shop sites */
export interface FlyerHttpOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  downloadTimeoutMs: number;
  /** Extra attempts on network errors, timeouts, 429 and 5xx */
  retries: number;
  retryDelayMs: number;
  maxDownloadBytes: number;
}

/** Browser-like defaults; tesco.sk sits behind Akamai, which answers 403 to requests without them */
export const DEFAULT_FLYER_HTTP_OPTIONS: FlyerHttpOptions = {
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

/** Per-request options */
export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Raise Node's 16 KB response header limit; lidl.sk sends a ~21 KB CSP header */
  maxHeaderSize?: number;
}

/** A request to a shop site failed; `status` is null when no response arrived */
export class HttpRequestError extends Error {
  /**
   * @param url - Requested URL
   * @param status - HTTP status, or null for DNS/connection/timeout errors
   */
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpRequestError';
  }

  /** true for errors worth another attempt: no response, 429, 5xx */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/** HTTP client for shop sites: browser headers, timeouts, retries, streamed downloads */
@Injectable()
export class FlyerHttpService {
  private readonly logger = new Logger(FlyerHttpService.name);

  /** @param options - Defaults from FLYER_HTTP_OPTIONS */
  constructor(
    @Inject(FLYER_HTTP_OPTIONS) private readonly options: FlyerHttpOptions,
  ) {}

  /** GET a page as text */
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

  /** GET and parse JSON */
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
   * Note: Never buffers the whole file in memory
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

  /** fetch() that throws HttpRequestError on network errors and non-2xx answers */
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

  /** Retry `attempt` with exponential backoff on retryable errors */
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
```

- [ ] **Step 5: Create `src/source-providers/page-materializer.service.ts`**

```ts
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
```

- [ ] **Step 6: Create `src/source-providers/source-provider.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { mapLimit } from '../common/concurrency';
import { addDaysIso, isIsoDate } from '../common/dates';
import { describeError } from '../common/errors';
import type { ShopConfig, ShopKey } from '../shops/shop.config.type';
import { FlyerHttpService, HttpRequestError } from './http.service';
import { PageMaterializer } from './page-materializer.service';
import { SourceUnavailableError } from './source-provider.errors';
import type {
  DiscoveredFlyer,
  LocalPage,
  SourceListing,
} from './source-provider.types';

/** Parallel downloads for image-based sources */
const IMAGE_DOWNLOAD_CONCURRENCY = 6;

/**
 * One subclass per shop. A subclass only scrapes the listing (`fetchListing`); the base class checks it
 * (`discover`) and turns it into local page images (`materialize`). DB, R2 and AI belong to the pipeline.
 * Note: Providers are singletons. Keep run state in arguments, never in `this`.
 */
@Injectable()
export abstract class SourceProvider<K extends ShopKey = ShopKey> {
  /** Shop this provider serves */
  abstract readonly shop: K;

  /**
   * @param http - Client for shop sites
   * @param materializer - PDF split + image compression
   */
  constructor(
    protected readonly http: FlyerHttpService,
    protected readonly materializer: PageMaterializer,
  ) {}

  /** Scrape the shop site for the current flyer. Must not download the PDF or page images */
  protected abstract fetchListing(
    config: ShopConfig<K>,
  ): Promise<SourceListing>;

  /**
   * Find the current flyer: checks dates, fills validTo from defaultFlyerDuration, builds the flyerId
   * @throws SourceUnavailableError | HttpRequestError
   */
  async discover(config: ShopConfig<K>): Promise<DiscoveredFlyer> {
    if (config.key !== this.shop) {
      throw new Error(
        `${this.constructor.name} got the config of "${config.key}"`,
      );
    }

    let listing: SourceListing;
    try {
      listing = await this.fetchListing(config);
    } catch (error) {
      this.rethrowAsSourceError(error, 'unexpected page content');
    }

    const { validFrom: from, validTo: to } = listing;
    if (!isIsoDate(from)) this.fail(`invalid validFrom "${String(from)}"`);
    if (to !== null && !isIsoDate(to)) {
      this.fail(`invalid validTo "${String(to)}"`);
    }
    const validTo =
      listing.validTo ??
      addDaysIso(listing.validFrom, config.defaultFlyerDuration);
    if (validTo < listing.validFrom)
      this.fail(`validTo ${validTo} is before validFrom ${listing.validFrom}`);
    if (listing.pages.kind === 'images' && listing.pages.urls.length === 0)
      this.fail('no page images');

    return {
      shop: this.shop,
      flyerId: `${this.shop}_${listing.validFrom}_${validTo}`,
      validFrom: listing.validFrom,
      validTo,
      validToEstimated: listing.validTo === null,
      sourceUrl: listing.sourceUrl,
      pages: listing.pages,
      meta: listing.meta ?? {},
    };
  }

  /**
   * Download the flyer into `dir` and write compressed page images to `<dir>/pages`
   * Note: The caller owns `dir` and deletes it; these files are never a source of truth
   * @throws SourceUnavailableError | HttpRequestError
   */
  async materialize(
    flyer: DiscoveredFlyer,
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    let pages: LocalPage[];
    try {
      pages =
        flyer.pages.kind === 'pdf'
          ? await this.materializePdf(flyer.pages.url, config, dir)
          : await this.materializeImages(flyer.pages.urls, config, dir);
    } catch (error) {
      this.rethrowAsSourceError(error, 'could not materialize the flyer');
    }
    if (!pages.length) this.fail(`${flyer.flyerId} has no pages`);
    return pages;
  }

  /**
   * The flyer valid on `today`; otherwise the latest one that already started (it may be expired,
   * the pipeline then sees the same flyerId and waits). Flyers starting in the future are never picked.
   */
  protected pickCurrent<T extends { validFrom: string; validTo: string }>(
    items: T[],
    today: string,
  ): T | null {
    const started = items
      .filter((item) => item.validFrom <= today)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return started.find((item) => today <= item.validTo) ?? started[0] ?? null;
  }

  /** Throw a SourceUnavailableError for this shop */
  protected fail(message: string, cause?: unknown): never {
    throw new SourceUnavailableError(
      this.shop,
      message,
      cause === undefined ? undefined : { cause },
    );
  }

  /** Download the PDF and split it */
  private async materializePdf(
    url: string,
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    const pdfPath = join(dir, 'flyer.pdf');
    await this.http.downloadToFile(url, pdfPath);
    return this.materializer.splitPdf(pdfPath, join(dir, 'pages'), config.pages);
  }

  /** Download the page images and compress them */
  private async materializeImages(
    urls: string[],
    config: ShopConfig<K>,
    dir: string,
  ): Promise<LocalPage[]> {
    const files = await mapLimit(
      urls,
      IMAGE_DOWNLOAD_CONCURRENCY,
      async (url, index) => {
        const path = join(dir, 'raw', String(index + 1).padStart(3, '0'));
        await this.http.downloadToFile(url, path);
        return path;
      },
    );
    return this.materializer.compressFiles(
      files,
      join(dir, 'pages'),
      config.pages.compress,
    );
  }

  /** Keep known errors; wrap anything else (bad JSON, broken PDF, ...) as a source problem */
  private rethrowAsSourceError(error: unknown, context: string): never {
    if (
      error instanceof SourceUnavailableError ||
      error instanceof HttpRequestError
    )
      throw error;
    this.fail(`${context}: ${describeError(error)}`, error);
  }
}
```

- [ ] **Step 7: Create the four providers**

`src/source-providers/providers/kaufland.source-provider.ts`:
```ts
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
```

`src/source-providers/providers/tesco.source-provider.ts`:
```ts
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
```

`src/source-providers/providers/lidl.source-provider.ts`:
```ts
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
```

`src/source-providers/providers/billa.source-provider.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { isoDate } from '../../common/dates';
import { decodeHtmlEntities } from '../../common/html';
import type { ShopConfig } from '../../shops/shop.config.type';
import { SourceProvider } from '../source-provider';
import type { SourceListing } from '../source-provider.types';

/** e.g. "Akciová ponuka platí od 14. 10. do 20. 10. 2026"; only the end date carries a year */
const VALIDITY =
  /Akciová ponuka platí od (\d{1,2})\.\s*(\d{1,2})\.\s*do (\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/;
/** Publitas PDF link on the flyer page */
const PDF_LINK = /href="(https:\/\/view\.publitas\.com\/[^"]+\.pdf[^"]*)"/;

/** Billa: validity sentence and Publitas PDF link on billa.sk */
@Injectable()
export class BillaSourceProvider extends SourceProvider<'billa'> {
  readonly shop = 'billa' as const;

  /** Read the validity sentence and the PDF link */
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
```

`src/source-providers/providers/index.ts`:
```ts
import { BillaSourceProvider } from './billa.source-provider';
import { KauflandSourceProvider } from './kaufland.source-provider';
import { LidlSourceProvider } from './lidl.source-provider';
import { TescoSourceProvider } from './tesco.source-provider';

/** Every provider class; a new shop: add its class here, its key to ShopKeys and its SHOP_CONFIGS entry */
export const SOURCE_PROVIDER_CLASSES = [
  KauflandSourceProvider,
  TescoSourceProvider,
  LidlSourceProvider,
  BillaSourceProvider,
];
```

- [ ] **Step 8: Create `src/source-providers/source-providers.service.ts`**

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { isValidTimeZone } from '../common/dates';
import { describeError } from '../common/errors';
import { SOURCE_OPTIONS_SCHEMAS } from '../shops/shop.config.schema';
import { ShopKeys } from '../shops/shop.config.type';
import type {
  ShopConfig,
  ShopConfigOverrides,
  ShopConfigs,
  ShopKey,
} from '../shops/shop.config.type';
import type { SourceProvider } from './source-provider';
import {
  InvalidOverridesError,
  type OverrideIssue,
} from './source-provider.errors';
import type {
  DiscoverResult,
  DiscoveredFlyer,
  LocalPage,
} from './source-provider.types';
import { SHOP_CONFIGS_TOKEN, SOURCE_PROVIDERS } from './source-providers.tokens';

/**
 * Entry point to the source providers, for the pipeline and the admin API.
 * Note: Admin overrides apply to one call only and are never stored.
 */
@Injectable()
export class SourceProvidersService implements OnModuleInit {
  private readonly logger = new Logger(SourceProvidersService.name);
  private readonly providers = new Map<ShopKey, SourceProvider>();

  /**
   * @param providers - Every provider instance (SOURCE_PROVIDERS)
   * @param configs - Static shop configs (SHOP_CONFIGS_TOKEN)
   */
  constructor(
    @Inject(SOURCE_PROVIDERS) providers: SourceProvider[],
    @Inject(SHOP_CONFIGS_TOKEN) private readonly configs: ShopConfigs,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.shop)) {
        throw new Error(
          `Two source providers registered for "${provider.shop}"`,
        );
      }
      this.providers.set(provider.shop, provider);
    }
  }

  /** Fail at boot, not at 06:00: every shop needs a provider and a valid source config */
  onModuleInit(): void {
    for (const shop of ShopKeys) {
      if (!this.providers.has(shop))
        throw new Error(`No source provider registered for "${shop}"`);

      const config = this.configs[shop];
      const result = SOURCE_OPTIONS_SCHEMAS[shop].safeParse(config.source);
      if (!result.success) {
        throw new Error(
          `Invalid SHOP_CONFIGS.${shop}.source:\n${z.prettifyError(result.error)}`,
        );
      }
      if (!isValidTimeZone(config.timezone)) {
        throw new Error(
          `Invalid SHOP_CONFIGS.${shop}.timezone "${config.timezone}"`,
        );
      }
    }
  }

  /** Every shop key */
  shops(): ShopKey[] {
    return [...ShopKeys];
  }

  /** Shops the cron runs */
  enabledShops(): ShopKey[] {
    return ShopKeys.filter((shop) => this.configs[shop].enabled);
  }

  /** SHOP_CONFIGS entry with validated overrides applied on top */
  getConfig<K extends ShopKey>(
    shop: K,
    overrides: ShopConfigOverrides<K> = {},
  ): ShopConfig<K> {
    const base = this.configs[shop] as ShopConfig<K>;
    return {
      ...base,
      timezone: overrides.timezone ?? base.timezone,
      defaultFlyerDuration:
        overrides.defaultFlyerDuration ?? base.defaultFlyerDuration,
      source: { ...base.source, ...overrides.source },
    };
  }

  /**
   * Validate raw overrides (an admin request body)
   * @throws InvalidOverridesError on unknown keys, wrong types or a URL on another host
   */
  parseOverrides<K extends ShopKey>(
    shop: K,
    raw: unknown,
  ): ShopConfigOverrides<K> {
    const sourceSchema = SOURCE_OPTIONS_SCHEMAS[shop] as z.ZodObject;
    const schema = z
      .object({
        source: sourceSchema.partial().strict().optional(),
        defaultFlyerDuration: z.number().int().min(1).max(31).optional(),
        timezone: z
          .string()
          .refine(isValidTimeZone, 'unknown IANA time zone')
          .optional(),
      })
      .strict();

    const result = schema.safeParse(raw ?? {});
    if (!result.success) {
      throw new InvalidOverridesError(
        shop,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      );
    }

    const overrides = result.data as ShopConfigOverrides<K>;
    this.assertSameHosts(shop, overrides);
    return overrides;
  }

  /** Find the shop's current flyer: one page fetch (Lidl: one more per flyer slug), no downloads */
  async discover<K extends ShopKey>(
    shop: K,
    overrides?: ShopConfigOverrides<K>,
  ): Promise<DiscoveredFlyer> {
    const started = Date.now();
    const flyer = await this.providerFor(shop).discover(
      this.getConfig(shop, overrides),
    );
    this.logger.log(
      `[${shop}] discovered ${flyer.flyerId} (${flyer.pages.kind}) in ${Date.now() - started} ms`,
    );
    return flyer;
  }

  /** Discover shops one after another; a failing shop never hides the others */
  async discoverMany(
    shops: ShopKey[] = this.enabledShops(),
  ): Promise<DiscoverResult[]> {
    const results: DiscoverResult[] = [];
    for (const shop of shops) {
      try {
        results.push({ shop, ok: true, flyer: await this.discover(shop) });
      } catch (error) {
        this.logger.warn(`[${shop}] discover failed: ${describeError(error)}`);
        results.push({ shop, ok: false, error: describeError(error) });
      }
    }
    return results;
  }

  /** Download `flyer` into `dir` and return its compressed page images */
  async materialize(
    flyer: DiscoveredFlyer,
    dir: string,
  ): Promise<LocalPage[]> {
    const started = Date.now();
    const pages = await this.providerFor(flyer.shop).materialize(
      flyer,
      this.getConfig(flyer.shop),
      dir,
    );
    this.logger.log(
      `[${flyer.shop}] materialized ${pages.length} pages of ${flyer.flyerId} in ${Date.now() - started} ms`,
    );
    return pages;
  }

  /** Provider of `shop`; every shop has one (checked in onModuleInit) */
  private providerFor<K extends ShopKey>(shop: K): SourceProvider<K> {
    const provider = this.providers.get(shop);
    if (!provider) throw new Error(`No source provider for "${shop}"`);
    return provider as SourceProvider<K>;
  }

  /**
   * Overrides may change paths and query strings, but never point the server at another host,
   * so the admin API can't be used to make the server fetch arbitrary URLs (SSRF)
   */
  private assertSameHosts<K extends ShopKey>(
    shop: K,
    overrides: ShopConfigOverrides<K>,
  ): void {
    const hostOf = (value: unknown) =>
      typeof value === 'string' && value.startsWith('https://')
        ? new URL(value).hostname
        : null;

    const allowed = new Set(
      Object.values(this.configs[shop].source)
        .map(hostOf)
        .filter((host): host is string => host !== null),
    );
    const issues: OverrideIssue[] = Object.entries(
      overrides.source ?? {},
    ).flatMap(([key, value]) => {
      const host = hostOf(value);
      return host && !allowed.has(host)
        ? [
            {
              path: `source.${key}`,
              message: `host ${host} is not allowed (allowed: ${[...allowed].join(', ')})`,
            },
          ]
        : [];
    });
    if (issues.length) throw new InvalidOverridesError(shop, issues);
  }
}
```

- [ ] **Step 9: Replace `src/source-providers/source-providers.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { SHOP_CONFIGS } from '../shops/shop.config';
import { DEFAULT_FLYER_HTTP_OPTIONS, FlyerHttpService } from './http.service';
import { PageMaterializer } from './page-materializer.service';
import { SOURCE_PROVIDER_CLASSES } from './providers';
import type { SourceProvider } from './source-provider';
import { SourceProvidersService } from './source-providers.service';
import {
  FLYER_HTTP_OPTIONS,
  SHOP_CONFIGS_TOKEN,
  SOURCE_PROVIDERS,
} from './source-providers.tokens';

/**
 * Finds each shop's current flyer and turns it into local page images.
 * No controllers and no database; the API imports SourceProvidersAdminModule for the admin routes.
 */
@Module({
  providers: [
    { provide: FLYER_HTTP_OPTIONS, useValue: DEFAULT_FLYER_HTTP_OPTIONS },
    FlyerHttpService,
    PageMaterializer,
    { provide: SHOP_CONFIGS_TOKEN, useValue: SHOP_CONFIGS },
    ...SOURCE_PROVIDER_CLASSES,
    {
      provide: SOURCE_PROVIDERS,
      useFactory: (...providers: SourceProvider[]) => providers,
      inject: SOURCE_PROVIDER_CLASSES,
    },
    SourceProvidersService,
  ],
  exports: [SourceProvidersService],
})
export class SourceProvidersModule {}
```

- [ ] **Step 10: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(source-providers): shop providers, HTTP client and page materializer"
```

---

### Task 6: Source providers admin module

**Files:**
- Create: `src/source-providers/source-provider.exception-filter.ts`, `src/source-providers/admin/admin-source-providers.controller.ts`, `src/source-providers/admin/source-providers-admin.module.ts`

**Interfaces:**
- Consumes: `SourceProvidersService`, `InvalidOverridesError`, `SourceUnavailableError`, `HttpRequestError`, `ParseShopKeyPipe`, `ZodValidationPipe`
- Produces: `SourceProvidersAdminModule`, `SourceProviderExceptionFilter`

- [ ] **Step 1: Create `src/source-providers/source-provider.exception-filter.ts`**

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { HttpRequestError } from './http.service';
import {
  InvalidOverridesError,
  SourceUnavailableError,
} from './source-provider.errors';

/** Source errors → HTTP: bad overrides are the caller's fault (400), a failing shop site is upstream (502) */
@Catch(InvalidOverridesError, SourceUnavailableError, HttpRequestError)
export class SourceProviderExceptionFilter implements ExceptionFilter {
  /** Write the JSON error response */
  catch(
    error: InvalidOverridesError | SourceUnavailableError | HttpRequestError,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof InvalidOverridesError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Invalid overrides',
        shop: error.shop,
        issues: error.issues,
      });
      return;
    }

    res.status(HttpStatus.BAD_GATEWAY).json(
      error instanceof HttpRequestError
        ? {
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Shop site request failed',
            message: error.message,
            url: error.url,
            upstreamStatus: error.status,
          }
        : {
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Unexpected shop page',
            shop: error.shop,
            message: error.message,
          },
    );
  }
}
```

- [ ] **Step 2: Create `src/source-providers/admin/admin-source-providers.controller.ts`**

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ShopKeys, type ShopKey } from '../../shops/shop.config.type';
import { SourceProviderExceptionFilter } from '../source-provider.exception-filter';
import { SourceProvidersService } from '../source-providers.service';

/** Body of POST /admin/source-providers/discover */
const discoverManySchema = z
  .object({ shops: z.array(z.enum(ShopKeys)).min(1).optional() })
  .strict();

/** Admin routes (unguarded): source configs and dry-run discovery; nothing is downloaded or stored */
@Controller('admin/source-providers')
@UseFilters(SourceProviderExceptionFilter)
export class AdminSourceProvidersController {
  /** @param sources - Source providers entry point */
  constructor(private readonly sources: SourceProvidersService) {}

  /** Every shop with its effective config */
  @Get()
  list() {
    const enabled = new Set(this.sources.enabledShops());
    return this.sources.shops().map((shop) => ({
      shop,
      enabled: enabled.has(shop),
      config: this.sources.getConfig(shop),
    }));
  }

  /** One shop with its effective config */
  @Get(':shop')
  get(@Param('shop', ParseShopKeyPipe) shop: ShopKey) {
    return {
      shop,
      enabled: this.sources.enabledShops().includes(shop),
      config: this.sources.getConfig(shop),
    };
  }

  /** Dry run for one shop, optionally with one-off overrides in the body */
  @Post(':shop/discover')
  @HttpCode(HttpStatus.OK)
  async discover(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Body() body: unknown,
  ) {
    const overrides = this.sources.parseOverrides(shop, body);
    return {
      config: this.sources.getConfig(shop, overrides),
      flyer: await this.sources.discover(shop, overrides),
    };
  }

  /** Dry run for several shops (default: the enabled ones) */
  @Post('discover')
  @HttpCode(HttpStatus.OK)
  discoverMany(
    @Body(new ZodValidationPipe(discoverManySchema))
    body: z.infer<typeof discoverManySchema>,
  ) {
    return this.sources.discoverMany(body.shops);
  }
}
```

- [ ] **Step 3: Create `src/source-providers/admin/source-providers-admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { SourceProvidersModule } from '../source-providers.module';
import { AdminSourceProvidersController } from './admin-source-providers.controller';

/** Admin routes of the source providers; API only */
@Module({
  imports: [SourceProvidersModule],
  controllers: [AdminSourceProvidersController],
})
export class SourceProvidersAdminModule {}
```

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(source-providers): admin routes for configs and dry-run discovery"
```

---

### Task 7: Flyers module: page registrar and public read API

**Files:**
- Create: `src/flyers/flyer-keys.ts`, `src/flyers/flyers.errors.ts`, `src/flyers/page-registrar.service.ts`
- Replace: `src/flyers/flyers.service.ts`, `src/flyers/flyers.controller.ts`, `src/flyers/flyers.module.ts`
- Delete: `src/flyers/dto/create-flyer.dto.ts`, `src/flyers/dto/update-flyer.dto.ts`

**Interfaces:**
- Consumes: `R2Service`, `FLYER_OBJECT_PREFIX`, `ShopStateService`, `DiscoveredFlyer`, `LocalPage`, `mapLimit`, `ParseShopKeyPipe`, `ZodValidationPipe`, `SHOP_CONFIGS`
- Produces:
  - `pageIdOf(flyerId, pageNumber)`, `pageImageKey(shop, flyerId, pageId, imageHash, ext)`
  - `FlyerNotFoundError`
  - `PageRegistrar`: `begin(flyer: DiscoveredFlyer)`, `register(flyerId, files: LocalPage[])`, `upload(flyer: Pick<DiscoveredFlyer, 'flyerId' | 'shop'>, files)`
  - `FlyersModule` (exports `TypeOrmModule` and `PageRegistrar`)

- [ ] **Step 1: Create `src/flyers/flyer-keys.ts`**

```ts
import type { ShopKey } from '../shops/shop.config.type';
import { FLYER_OBJECT_PREFIX } from '../storage/r2.service';

/** Page id: `kaufland_2026-10-14_2026-10-20` + 7 → `kaufland_2026-10-14_2026-10-20_page_07` */
export function pageIdOf(flyerId: string, pageNumber: number): string {
  return `${flyerId}_page_${String(pageNumber).padStart(2, '0')}`;
}

/**
 * R2 key of a page image: `flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.<ext>`
 * Note: The hash part makes a changed image a new key, so caches never serve a stale page
 */
export function pageImageKey(
  shop: ShopKey,
  flyerId: string,
  pageId: string,
  imageHash: string,
  ext: string,
): string {
  return `${FLYER_OBJECT_PREFIX}${shop}/${flyerId}/pages/${pageId}.${imageHash.slice(0, 8)}.${ext}`;
}
```

- [ ] **Step 2: Create `src/flyers/flyers.errors.ts`**

```ts
/** A flyer or page a pipeline run needs does not exist (or the shop has no current flyer) */
export class FlyerNotFoundError extends Error {
  /** @param message - What was missing */
  constructor(message: string) {
    super(message);
    this.name = 'FlyerNotFoundError';
  }
}
```

- [ ] **Step 3: Create `src/flyers/page-registrar.service.ts`**

```ts
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
```

- [ ] **Step 4: Replace `src/flyers/flyers.service.ts`**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SHOP_CONFIGS } from '../shops/shop.config';
import type { ShopKey } from '../shops/shop.config.type';
import { ShopStateService } from '../shops/shop-state.service';
import { R2Service } from '../storage/r2.service';
import { FlyerOffer } from './entities/flyer-offer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import type { ProductCategoryKey } from './types/product-category.type';

/** A shop the frontend can show, with its current flyer */
export interface AvailableShop {
  shop: ShopKey;
  name: string;
  flyer: { id: string; validFrom: string; validTo: string } | null;
}

/** A page for the frontend, with a short-lived image URL */
export interface PageView {
  id: string;
  pageNumber: number;
  status: string;
  width: number | null;
  height: number | null;
  imageUrl: string | null;
}

/** Read-only queries for the public API */
@Injectable()
export class FlyersService {
  /**
   * @param pages - FlyerPage repository
   * @param offers - FlyerOffer repository
   * @param shopState - Current flyer per shop
   * @param r2 - Presigned page image URLs
   */
  constructor(
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    @InjectRepository(FlyerOffer)
    private readonly offers: Repository<FlyerOffer>,
    private readonly shopState: ShopStateService,
    private readonly r2: R2Service,
  ) {}

  /** Shops with a READY or PARTIAL current flyer */
  async availableShops(): Promise<AvailableShop[]> {
    const states = await this.shopState.listAvailable();
    return states.map((state) => ({
      shop: state.shop,
      name: SHOP_CONFIGS[state.shop].name,
      flyer: state.currentFlyer
        ? {
            id: state.currentFlyer.id,
            validFrom: state.currentFlyer.validFrom,
            validTo: state.currentFlyer.validTo,
          }
        : null,
    }));
  }

  /** Offers of the shop's current flyer in page order, optionally of one category */
  async currentOffers(
    shop: ShopKey,
    category?: ProductCategoryKey,
  ): Promise<FlyerOffer[]> {
    const state = await this.shopState.get(shop);
    if (!state.isAvailiable || !state.currentFlyerId) {
      throw new NotFoundException(`${shop} has no current flyer`);
    }

    const query = this.offers
      .createQueryBuilder('offer')
      .where('offer.flyerId = :flyerId', { flyerId: state.currentFlyerId })
      .orderBy('offer.pageId', 'ASC')
      .addOrderBy('offer.position', 'ASC');
    if (category) {
      query.andWhere(':category = ANY(offer.category)', { category });
    }
    return query.getMany();
  }

  /** Pages of a flyer with presigned image URLs (null when the image is not in R2) */
  async pagesOf(flyerId: string): Promise<PageView[]> {
    const pages = await this.pages.find({
      where: { flyerId },
      order: { pageNumber: 'ASC' },
    });
    if (!pages.length) throw new NotFoundException(`Flyer ${flyerId} not found`);

    return Promise.all(
      pages.map(async (page) => ({
        id: page.id,
        pageNumber: page.pageNumber,
        status: page.status,
        width: page.width,
        height: page.height,
        imageUrl: page.imageKey ? await this.r2.presign(page.imageKey) : null,
      })),
    );
  }
}
```

- [ ] **Step 5: Replace `src/flyers/flyers.controller.ts`**

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { ShopKey } from '../shops/shop.config.type';
import { FlyersService } from './flyers.service';
import { ProductCategoryKeys } from './types/product-category.type';

/** Query of GET /shops/:shop/offers */
const offersQuerySchema = z.object({
  category: z.enum(ProductCategoryKeys).optional(),
});

/** Public read API for the frontend */
@Controller()
export class FlyersController {
  /** @param flyers - Read queries */
  constructor(private readonly flyers: FlyersService) {}

  /** Shops with a current flyer */
  @Get('shops')
  shops() {
    return this.flyers.availableShops();
  }

  /** Offers of the shop's current flyer; `?category=` filters */
  @Get('shops/:shop/offers')
  offers(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Query(new ZodValidationPipe(offersQuerySchema))
    query: z.infer<typeof offersQuerySchema>,
  ) {
    return this.flyers.currentOffers(shop, query.category);
  }

  /** Pages of a flyer with presigned image URLs (valid 1 hour) */
  @Get('flyers/:id/pages')
  pages(@Param('id') id: string) {
    return this.flyers.pagesOf(id);
  }
}
```

- [ ] **Step 6: Replace `src/flyers/flyers.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopsModule } from '../shops/shops.module';
import { StorageModule } from '../storage/storage.module';
import { FlyerOffer } from './entities/flyer-offer.entity';
import { FlyerPage } from './entities/flyer-page.entity';
import { Flyer } from './entities/flyer.entity';
import { FlyersController } from './flyers.controller';
import { FlyersService } from './flyers.service';
import { PageRegistrar } from './page-registrar.service';

/** Flyer, page and offer data: repositories, the page registrar and the public read API */
@Module({
  imports: [
    TypeOrmModule.forFeature([Flyer, FlyerPage, FlyerOffer]),
    ShopsModule,
    StorageModule,
  ],
  controllers: [FlyersController],
  providers: [FlyersService, PageRegistrar],
  exports: [TypeOrmModule, PageRegistrar],
})
export class FlyersModule {}
```

- [ ] **Step 7: Delete the CRUD DTO scaffolds**

```bash
git rm src/flyers/dto/create-flyer.dto.ts src/flyers/dto/update-flyer.dto.ts
```

- [ ] **Step 8: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(flyers): page registrar and public read API"
```

---

### Task 8: Page parser (Gemini, ported)

Ported from `ai flyer parser/src/parser/{errors,gemini,normalize,retry,schema}.ts`.

**Files:**
- Create: `src/page-parser/page-parser.errors.ts`, `retry.ts`, `page-prompt.ts`, `normalize.ts`, `gemini.client.ts`, `page-parser.service.ts`, `page-parser.module.ts`

**Interfaces:**
- Consumes: `Flyer`, `FlyerPage`, `FlyerOffer`, `PageStatus`, `R2Service`, `FlyerNotFoundError`, `mapLimit`, `Env`
- Produces:
  - `InvalidResponseError`, `FatalParseError`, `ImagesExpiredError(pageId)`
  - `withRetry`, `classifyError`, `describeAttemptError`
  - `PARSER_VERSION = 3`
  - `NormalizedOffer`, `normalizePage(text, onDrop)`
  - `GeminiClient.extractPage(image: Buffer, mimeType: string): Promise<PageExtraction>`, `mimeTypeOfKey(key)`
  - `PageParserService`: `assertImagesAvailable(flyerId, pageIds?)`, `parsePages(flyer: Flyer, options: ParsePagesOptions): Promise<ParseSummary>`
  - `PageParserModule` (exports `PageParserService`)

- [ ] **Step 1: Create `src/page-parser/page-parser.errors.ts`**

```ts
/**
 * The model answered, but not with the expected JSON shape
 * Note: Retryable, the next attempt usually returns valid JSON
 */
export class InvalidResponseError extends Error {
  override name = 'InvalidResponseError';
}

/**
 * An error every other page would hit too (bad API key, invalid request, ...)
 * Note: Stops the whole parse run instead of failing page by page
 */
export class FatalParseError extends Error {
  override name = 'FatalParseError';
}

/** A page image is gone from R2 (expired by the lifecycle rule) or was never uploaded */
export class ImagesExpiredError extends Error {
  override name = 'ImagesExpiredError';

  /** @param pageId - Page whose image is missing */
  constructor(readonly pageId: string) {
    super(
      `Image of ${pageId} is not in R2 (expired or never uploaded); use refresh to download the flyer again`,
    );
  }
}
```

- [ ] **Step 2: Create `src/page-parser/retry.ts`**

```ts
import { FatalParseError } from './page-parser.errors';

/** Options of `withRetry` */
export interface RetryOptions {
  /** Total attempts, including the first one */
  maxAttempts: number;
  /** Delay before the 2nd attempt; doubles for every next one. Defaults to `2000` */
  baseDelayMs?: number;
  /** Upper bound of a single delay. Defaults to `60000` */
  maxDelayMs?: number;
  /** Replaceable for tests */
  sleep?: (ms: number) => Promise<void>;
  /** Called before every retry */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Every page would fail the same way, so these statuses stop the whole run */
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

/** setTimeout as a promise */
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** HTTP status of an API error (`ApiError` from `@google/genai` has `status`) */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Retry delay the API asks for, e.g. `"retryDelay": "23s"` in a 429 error body
 * @returns The delay in ms, or null if the error does not contain one
 */
function requestedDelayMs(error: unknown): number | null {
  const match = (error as Error | null)?.message?.match(
    /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/,
  );
  return match ? Number(match[1]) * 1000 : null;
}

/** Short error text for logs; API errors carry the whole JSON response in `message` */
export function describeAttemptError(error: unknown): string {
  const status = statusOf(error);
  return status !== null
    ? `HTTP ${status}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * Decide what to do with a failed attempt
 * `fatal` - stop the run; `retry` - try again; `fail` - give up on this call only
 */
export function classifyError(error: unknown): 'fatal' | 'retry' | 'fail' {
  if (error instanceof FatalParseError) return 'fatal';

  const status = statusOf(error);
  // Note: No status means network error, timeout or invalid response
  if (status === null) return 'retry';
  if (FATAL_STATUSES.has(status)) return 'fatal';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

/**
 * Run `fn`, retrying with exponential backoff and jitter
 * @throws FatalParseError for errors that would fail every call; otherwise the last error
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    maxAttempts,
    baseDelayMs = 2000,
    maxDelayMs = 60_000,
    sleep = defaultSleep,
    onRetry,
  }: RetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const kind = classifyError(error);

      if (kind === 'fatal') {
        throw error instanceof FatalParseError
          ? error
          : new FatalParseError(describeAttemptError(error), { cause: error });
      }
      if (kind === 'fail' || attempt >= maxAttempts) throw error;

      const backoff =
        baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
      const delayMs = Math.min(
        maxDelayMs,
        Math.max(backoff, requestedDelayMs(error) ?? 0),
      );
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
```

- [ ] **Step 3: Create `src/page-parser/page-prompt.ts`**

```ts
import { ProductCategoryKeys } from '../flyers/types/product-category.type';

/**
 * Bump when the prompt or the offer shape changes, so pages parsed by an older version are parsed again
 */
export const PARSER_VERSION = 3;

/**
 * Output token cap of one page answer
 * Note: A page answer is ~85 tokens per offer; the cap only stops a looping answer (the model default is 65k)
 */
export const PARSER_MAX_OUTPUT_TOKENS = 8192;

/**
 * Instructions sent with every page image
 * Note: Flyers are Slovak, prices are EUR with a decimal comma
 * Note: Every output token costs ~8x an input token, so titles leave out unit prices and notes
 */
export const PAGE_PROMPT = `Supermarket flyer page from Slovakia, prices in EUR. List its discounted product offers.

Rules:
- If the page has no product offers (cover, adverts, recipes, articles, store info), return {"products": []} immediately.
- Include an offer only if it shows a promotional price and a discount: a printed percent (e.g. "-25 %") or a regular price ("bežná cena", often struck through).
- Skip multi-buy deals ("1 + 1", "2 + 2", "3 za 2", "Kúpte 2 zaplaťte 1", "druhý kus zadarmo") and offers without a discount.
- A label printed under or next to a price belongs to that price. A price labeled with a loyalty card or app is a loyalty price, never a price for everyone: "Clubcard cena", "S Clubcard", "Cena s kupónom v aplikácii Clubcard", "XTRA", "K-Card", "Lidl Plus", "BILLA Bonus", "S kupónom", "s aplikáciou". "Cena pre všetkých" is for everyone.

Fields:
- title: product name as printed, with brand, variant and pack size, in the original language. Leave out prices, unit prices ("1 kg = 4,30") and notes like "viac druhov" or "voľný predaj".
- category: the allowed categories that fit; "other" if none does.
- box_2d: [ymin, xmin, ymax, xmax] of the whole offer (image, name and prices), 0-1000.
- basePrice: regular price before the discount.
- discountedPrice: promotional price for everyone.
- discountPercent: printed percent for discountedPrice ("-25 %" -> 25).
- loyaltyPrice: lowest loyalty price.
- loyaltyDiscountPercent: printed percent for loyaltyPrice.
Use null for anything not printed. Prices use a decimal point: "1,99" -> 1.99.`;

/**
 * Sent as `systemInstruction`
 * Note: Without it the model pretty-prints the JSON, a third of its output tokens were whitespace.
 *       The same line inside the prompt was ignored half the time.
 */
export const PAGE_SYSTEM_INSTRUCTION =
  'Respond with minified JSON on a single line: no indentation, no line breaks, no spaces between tokens.';

/** Structured output schema, sent as `responseJsonSchema` */
export const PAGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: {
            type: 'array',
            items: { type: 'string', enum: [...ProductCategoryKeys] },
          },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
          },
          basePrice: { type: ['number', 'null'] },
          discountedPrice: { type: ['number', 'null'] },
          discountPercent: { type: ['integer', 'null'] },
          loyaltyPrice: { type: ['number', 'null'] },
          loyaltyDiscountPercent: { type: ['integer', 'null'] },
        },
        required: [
          'title',
          'category',
          'box_2d',
          'basePrice',
          'discountedPrice',
          'discountPercent',
          'loyaltyPrice',
          'loyaltyDiscountPercent',
        ],
      },
    },
  },
  required: ['products'],
};
```

- [ ] **Step 4: Create `src/page-parser/normalize.ts`**

```ts
import {
  ProductCategoryKeys,
  type ProductCategoryKey,
} from '../flyers/types/product-category.type';
import { InvalidResponseError } from './page-parser.errors';

/** Place of an offer on the page as 0–1 fractions: top-left and bottom-right corners */
export type BoundaryBox = [[number, number], [number, number]];

/** One offer validated from the model answer, before it gets its page/flyer columns */
export interface NormalizedOffer {
  title: string;
  /** null means the category is not known */
  category: ProductCategoryKey[] | null;
  boundaryBox: BoundaryBox;
  /** Prices in EUR; null if not printed */
  basePrice: number | null;
  discountedPrice: number | null;
  /** Percent, e.g. 25 */
  discount: number | null;
  loyaltyPrice: number | null;
  loyaltyDiscount: number | null;
}

/** Round to `digits` decimals */
const round = (value: number, digits: number): number =>
  Number(value.toFixed(digits));
/** Clamp to [min, max] */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
/** true for a finite number */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A non-negative price rounded to cents, otherwise null */
function toPrice(value: unknown): number | null {
  return isFiniteNumber(value) && value >= 0 ? round(value, 2) : null;
}

/**
 * Convert Gemini `box_2d` ([ymin, xmin, ymax, xmax], 0–1000) to 0–1 corners
 * @returns null if the box is malformed or has no area
 */
function toBoundaryBox(value: unknown): BoundaryBox | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(isFiniteNumber)
  )
    return null;

  const [a, b, c, d] = (value as number[]).map(
    (n) => clamp(n, 0, 1000) / 1000,
  );
  const [y1, y2] = a <= c ? [a, c] : [c, a];
  const [x1, x2] = b <= d ? [b, d] : [d, b];
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

  return [
    [round(x1, 4), round(y1, 4)],
    [round(x2, 4), round(y2, 4)],
  ];
}

/** Known category keys only, without duplicates; null if none remain */
function toCategories(value: unknown): ProductCategoryKey[] | null {
  if (!Array.isArray(value)) return null;
  const known = (value as unknown[]).filter((key): key is ProductCategoryKey =>
    (ProductCategoryKeys as readonly unknown[]).includes(key),
  );
  return known.length ? [...new Set(known)] : null;
}

/**
 * Printed discount if valid, otherwise computed from both prices
 * Note: Always null without the promotional price; a discount never stands without its price
 */
function toDiscount(
  value: unknown,
  basePrice: number | null,
  promoPrice: number | null,
): number | null {
  if (promoPrice === null) return null;
  if (isFiniteNumber(value) && value > 0 && value < 100)
    return Math.round(value);
  if (basePrice && promoPrice < basePrice) {
    return Math.round((1 - promoPrice / basePrice) * 100);
  }
  return null;
}

/**
 * Validate the model answer of one page and convert it to offers
 * Note: Invalid offers and offers without any discount are dropped (reported via `onDrop`)
 * @throws InvalidResponseError if the answer is not JSON with a `products` array
 */
export function normalizePage(
  text: string | undefined,
  onDrop: (reason: string) => void,
): NormalizedOffer[] {
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    throw new InvalidResponseError('Response is not valid JSON');
  }

  const items = (data as { products?: unknown } | null)?.products;
  if (!Array.isArray(items)) {
    throw new InvalidResponseError('Response has no "products" array');
  }

  const offers: NormalizedOffer[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const title =
      typeof item?.title === 'string'
        ? item.title.replace(/\s+/g, ' ').trim()
        : '';
    const boundaryBox = toBoundaryBox(item?.box_2d);

    if (!title || !boundaryBox) {
      onDrop(!title ? 'no title' : `invalid box: ${title}`);
      continue;
    }

    const basePrice = toPrice(item.basePrice);
    const discountedPrice = toPrice(item.discountedPrice);
    const loyaltyPrice = toPrice(item.loyaltyPrice);
    const discount = toDiscount(item.discountPercent, basePrice, discountedPrice);
    const loyaltyDiscount = toDiscount(
      item.loyaltyDiscountPercent,
      basePrice,
      loyaltyPrice,
    );

    // Note: The prompt asks for discounted offers only, but the model still returns some regular-price offers
    if (discount === null && loyaltyDiscount === null) {
      onDrop(`no discount: ${title}`);
      continue;
    }

    offers.push({
      title,
      category: toCategories(item.category),
      boundaryBox,
      basePrice,
      discountedPrice,
      discount,
      loyaltyPrice,
      loyaltyDiscount,
    });
  }
  return offers;
}
```

- [ ] **Step 5: Create `src/page-parser/gemini.client.ts`**

```ts
import {
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { FatalParseError, InvalidResponseError } from './page-parser.errors';
import {
  PAGE_PROMPT,
  PAGE_RESPONSE_SCHEMA,
  PAGE_SYSTEM_INSTRUCTION,
  PARSER_MAX_OUTPUT_TOKENS,
} from './page-prompt';

/** Raw model answer of one page */
export interface PageExtraction {
  /** JSON text; validated by `normalizePage` */
  text: string | undefined;
  /** Model id that produced it */
  model: string;
}

/** Image mime types by file extension */
const MIME_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Mime type of an image from its R2 key's extension
 * @throws FatalParseError for an unsupported format
 */
export function mimeTypeOfKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType)
    throw new FatalParseError(`Unsupported page image format: ${key}`);
  return mimeType;
}

/**
 * Thinking off, temperature per model family
 * Note: Gemini 2.5 turns thinking off with a zero budget; 3.x has no "off", `MINIMAL` is its lowest level
 * Note: Gemini 3 keeps its default temperature (1.0); Google warns that lower values may cause looping
 */
export function modelConfigFor(
  model: string,
): Pick<GenerateContentConfig, 'thinkingConfig' | 'temperature'> {
  return /^gemini-2\.5-/.test(model)
    ? { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 }
    : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } };
}

/**
 * Answer text of a response
 * @throws InvalidResponseError if the answer was cut off at the output token cap
 */
export function answerText(
  response: Pick<GenerateContentResponse, 'candidates' | 'text'>,
): string | undefined {
  if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
    throw new InvalidResponseError(
      `Response cut off at ${PARSER_MAX_OUTPUT_TOKENS} output tokens`,
    );
  }
  return response.text;
}

/** Gemini client for page extraction (GEMINI_API_KEY, GEMINI_MODEL) */
@Injectable()
export class GeminiClient {
  private readonly client: GoogleGenAI;
  /** Model id used for every request */
  readonly model: string;

  /** @param config - Reads GEMINI_API_KEY and GEMINI_MODEL */
  constructor(config: ConfigService<Env, true>) {
    this.client = new GoogleGenAI({
      apiKey: config.get('GEMINI_API_KEY', { infer: true }),
    });
    this.model = config.get('GEMINI_MODEL', { infer: true });
  }

  /** Ask the model for the offers on one page image (sent inline; the bytes come from R2) */
  async extractPage(image: Buffer, mimeType: string): Promise<PageExtraction> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image.toString('base64') } },
            { text: PAGE_PROMPT },
          ],
        },
      ],
      config: {
        ...modelConfigFor(this.model),
        systemInstruction: PAGE_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: PAGE_RESPONSE_SCHEMA,
        maxOutputTokens: PARSER_MAX_OUTPUT_TOKENS,
      },
    });
    return { text: answerText(response), model: this.model };
  }
}
```

- [ ] **Step 6: Create `src/page-parser/page-parser.service.ts`**

```ts
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
import {
  FatalParseError,
  ImagesExpiredError,
} from './page-parser.errors';
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
        this.logger.warn(
          `${page.id}: failed (${describeAttemptError(error)})`,
        );
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
```

- [ ] **Step 7: Create `src/page-parser/page-parser.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FlyersModule } from '../flyers/flyers.module';
import { StorageModule } from '../storage/storage.module';
import { GeminiClient } from './gemini.client';
import { PageParserService } from './page-parser.service';

/** AI page parsing; no routes (PageParserAdminModule adds them for the API) */
@Module({
  imports: [FlyersModule, StorageModule],
  providers: [GeminiClient, PageParserService],
  exports: [PageParserService],
})
export class PageParserModule {}
```

- [ ] **Step 8: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(page-parser): Gemini page parser reading images from R2"
```

---

### Task 9: Pipeline orchestration

**Files:**
- Create: `src/pipeline/flyer-pipeline.service.ts`, `src/pipeline/pipeline.exception-filter.ts`, `src/pipeline/pipeline.module.ts`

**Interfaces:**
- Consumes: `ShopLeaseService`, `ShopLease`, `LeaseBusyError`, `ShopStateService`, `SourceProvidersService`, `PageRegistrar`, `PageParserService`, `FatalParseError`, `ImagesExpiredError`, `FlyerNotFoundError`, `isOverdue`, `describeError`, `RetryReason`, `FlyerStatus`, `PARSED`, `PageStatus`, `Env`
- Produces:
  - `PipelineAction = 'load' | 'refresh' | 'reparse'`
  - `PipelineRequest { shop; action; flyerId?; pageIds? }`
  - `FlyerPipelineService`: `run(request)` (awaited, used by the cron), `trigger(request)` (lease + prechecks awaited, work runs in the background, used by admin), `hasUnfinishedFlyer(shop)`
  - `PipelineExceptionFilter` (409 / 410 / 404)
  - `PipelineModule` (exports `FlyerPipelineService`)

- [ ] **Step 1: Create `src/pipeline/flyer-pipeline.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import { isOverdue } from '../common/dates';
import { describeError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { FlyerPage } from '../flyers/entities/flyer-page.entity';
import { Flyer } from '../flyers/entities/flyer.entity';
import { FlyerStatus, PARSED } from '../flyers/enums/flyer.enums';
import { PageStatus } from '../flyers/enums/page.enums';
import { FlyerNotFoundError } from '../flyers/flyers.errors';
import { PageRegistrar } from '../flyers/page-registrar.service';
import { FatalParseError } from '../page-parser/page-parser.errors';
import { PageParserService } from '../page-parser/page-parser.service';
import { RetryReason } from '../shops/enums/shop.enums';
import type { ShopConfig, ShopKey } from '../shops/shop.config.type';
import { ShopLeaseService, type ShopLease } from '../shops/shop-lease.service';
import { ShopStateService } from '../shops/shop-state.service';
import type { DiscoveredFlyer } from '../source-providers/source-provider.types';
import { SourceProvidersService } from '../source-providers/source-providers.service';

/**
 * What a run does
 * `load`    - discover; skip a known finished flyer, resume an uploaded one, otherwise download + parse
 * `refresh` - discover and download + parse again, even if the flyer is known
 * `reparse` - parse an existing flyer again from its R2 images (all selected pages)
 */
export type PipelineAction = 'load' | 'refresh' | 'reparse';

/** One run request */
export interface PipelineRequest {
  shop: ShopKey;
  action: PipelineAction;
  /** reparse only: flyer to re-parse; defaults to the shop's current flyer */
  flyerId?: string;
  /** reparse only: limit to these pages */
  pageIds?: string[];
}

/** Flyer statuses of a run that stopped before the end */
const UNFINISHED = [
  FlyerStatus.Downloading,
  FlyerStatus.PagesUploaded,
  FlyerStatus.Parsing,
];

/** Page statuses that do not count as parsed when finalizing */
const NOT_PARSED = [PageStatus.Pending, PageStatus.Uploaded, PageStatus.Failed];

/**
 * Orchestrates a flyer run under the shop lease:
 * discover → materialize (temp dir) → register rows → upload to R2 → parse from R2 → finalize.
 * Note: Local files live only inside one run; a resumed run re-downloads unless every page is in R2.
 */
@Injectable()
export class FlyerPipelineService {
  private readonly logger = new Logger(FlyerPipelineService.name);
  private readonly tmpRoot: string;

  /**
   * @param lease - One run per shop
   * @param shopState - Current flyer and retries
   * @param sources - Discover + materialize
   * @param registrar - Flyer/page rows and R2 upload
   * @param parser - AI parsing
   * @param flyers - Flyer repository
   * @param pages - FlyerPage repository
   * @param config - PIPELINE_TMP_DIR
   */
  constructor(
    private readonly lease: ShopLeaseService,
    private readonly shopState: ShopStateService,
    private readonly sources: SourceProvidersService,
    private readonly registrar: PageRegistrar,
    private readonly parser: PageParserService,
    @InjectRepository(Flyer) private readonly flyers: Repository<Flyer>,
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    config: ConfigService<Env, true>,
  ) {
    this.tmpRoot = config.get('PIPELINE_TMP_DIR', { infer: true });
  }

  /**
   * Run and wait for the end (cron). Failures are recorded on ShopState, not thrown.
   * @throws LeaseBusyError | FlyerNotFoundError | ImagesExpiredError - before any work starts
   */
  async run(request: PipelineRequest): Promise<void> {
    const prepared = await this.prepare(request);
    await this.execute(prepared.request, prepared.lease);
  }

  /**
   * Take the lease, run the prechecks and continue in the background (admin → 202)
   * @throws LeaseBusyError | FlyerNotFoundError | ImagesExpiredError - before any work starts
   */
  async trigger(request: PipelineRequest): Promise<void> {
    const prepared = await this.prepare(request);
    void this.execute(prepared.request, prepared.lease);
  }

  /** true if the shop has a flyer whose run stopped midway (crash, fatal parse error) */
  hasUnfinishedFlyer(shop: ShopKey): Promise<boolean> {
    return this.flyers.exists({ where: { shop, status: In(UNFINISHED) } });
  }

  /** Lease + reparse prechecks; frees the lease again if a precheck fails */
  private async prepare(
    request: PipelineRequest,
  ): Promise<{ lease: ShopLease; request: PipelineRequest }> {
    const lease = await this.lease.acquire(request.shop);
    try {
      if (request.action !== 'reparse') return { lease, request };

      const flyerId =
        request.flyerId ??
        (await this.shopState.get(request.shop)).currentFlyerId;
      if (!flyerId) {
        throw new FlyerNotFoundError(
          `${request.shop} has no current flyer to re-parse`,
        );
      }
      await this.parser.assertImagesAvailable(flyerId, request.pageIds);
      return { lease, request: { ...request, flyerId } };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  /** Do the work, record failures on ShopState, always release the lease; never throws */
  private async execute(
    request: PipelineRequest,
    lease: ShopLease,
  ): Promise<void> {
    const { shop, action } = request;
    const config = this.sources.getConfig(shop);
    const started = Date.now();
    try {
      await this.shopState.markAttempt(shop);
      if (action === 'reparse') {
        await this.reparse(request, config);
      } else {
        await this.load(config, action === 'refresh');
      }
      this.logger.log(
        `[${shop}] ${action} finished in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (error) {
      await this.recordFailure(config, action, error);
    } finally {
      await lease.release();
    }
  }

  /** `load` and `refresh` */
  private async load(config: ShopConfig, force: boolean): Promise<void> {
    const discovered = await this.sources.discover(config.key);
    if (!force) {
      const existing = await this.flyers.findOne({
        where: { id: discovered.flyerId },
        relations: { pages: true },
      });
      if (existing && (await this.skipOrResume(config, existing))) return;
    }

    const flyer = await this.download(discovered, config);
    await this.parse(flyer, config, {});
  }

  /** `reparse`: the selected pages of an existing flyer, from R2 */
  private async reparse(
    request: PipelineRequest,
    config: ShopConfig,
  ): Promise<void> {
    if (!request.flyerId) throw new FlyerNotFoundError('No flyer to re-parse');
    const flyer = await this.flyers.findOneBy({ id: request.flyerId });
    if (!flyer) throw new FlyerNotFoundError(`Flyer ${request.flyerId} not found`);
    await this.parse(flyer, config, { force: true, pageIds: request.pageIds });
  }

  /**
   * Decide what to do with a flyer that already exists
   * - READY, or PARTIAL/FAILED with page retries used up → done (overdue current flyer → wait for a new one)
   * - every page in R2 → resume at parsing
   * - otherwise → false (the caller downloads it again)
   * @returns true when the run is done
   */
  private async skipOrResume(
    config: ShopConfig,
    flyer: Flyer,
  ): Promise<boolean> {
    const shop = config.key;
    const state = await this.shopState.get(shop);
    const exhausted =
      state.retry.reason === RetryReason.PagesFailed &&
      state.retry.attempts >= config.parser.maxAttempts;
    const finished =
      flyer.status === FlyerStatus.Ready ||
      ((flyer.status === FlyerStatus.Partial ||
        flyer.status === FlyerStatus.Failed) &&
        exhausted);

    if (finished) {
      if (PARSED.includes(flyer.status) && state.currentFlyerId !== flyer.id) {
        await this.shopState.setCurrentFlyer(shop, flyer.id);
      }
      if (isOverdue(flyer.validTo, config.timezone)) {
        await this.shopState.scheduleRetry(shop, RetryReason.AwaitingNewFlyer);
        this.logger.log(
          `[${shop}] ${flyer.id} is overdue and still the newest flyer; waiting for a new one`,
        );
      } else if (flyer.status === FlyerStatus.Ready) {
        await this.shopState.clearRetry(shop);
        this.logger.log(`[${shop}] ${flyer.id} is up to date`);
      }
      return true;
    }

    const uploaded =
      flyer.pageCount > 0 &&
      flyer.pages.length === flyer.pageCount &&
      flyer.pages.every((page) => page.status !== PageStatus.Pending);
    if (!uploaded) return false;

    this.logger.log(`[${shop}] resuming ${flyer.id} at parsing`);
    await this.parse(flyer, config, {});
    return true;
  }

  /** Stages 1-3: materialize into a temp dir, register rows, upload to R2; the temp dir is always deleted */
  private async download(
    discovered: DiscoveredFlyer,
    config: ShopConfig,
  ): Promise<Flyer> {
    const dir = join(
      this.tmpRoot,
      `${discovered.flyerId}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await this.registrar.begin(discovered);
      const files = await this.sources.materialize(discovered, dir);
      await this.registrar.register(discovered.flyerId, files);
      await this.registrar.upload(discovered, files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Note: Cleared only once every page is in R2, so download failures keep counting attempts
    await this.shopState.clearRetry(config.key);
    return this.flyers.findOneByOrFail({ id: discovered.flyerId });
  }

  /** Stage 4: parse pages, then finalize the flyer status */
  private async parse(
    flyer: Flyer,
    config: ShopConfig,
    options: { force?: boolean; pageIds?: string[] },
  ): Promise<void> {
    await this.flyers.update(flyer.id, { status: FlyerStatus.Parsing });
    const summary = await this.parser.parsePages(flyer, {
      ...options,
      concurrency: config.parser.concurrency,
      maxAttempts: config.parser.maxAttempts,
    });
    this.logger.log(
      `[${config.key}] ${flyer.id}: ${summary.parsed} parsed, ${summary.skipped} skipped, ${summary.failed.length} failed`,
    );
    await this.finalize(flyer, config);
  }

  /**
   * READY (0 unparsed pages) · PARTIAL (≤ maxFailedPages) · FAILED (more)
   * READY/PARTIAL becomes the shop's current flyer unless the current one is newer; PARTIAL/FAILED schedule a page retry.
   */
  private async finalize(flyer: Flyer, config: ShopConfig): Promise<void> {
    const shop = config.key;
    const unparsed = await this.pages.count({
      where: { flyerId: flyer.id, status: In(NOT_PARSED) },
    });
    const status =
      unparsed === 0
        ? FlyerStatus.Ready
        : unparsed <= config.parser.maxFailedPages
          ? FlyerStatus.Partial
          : FlyerStatus.Failed;
    await this.flyers.update(flyer.id, { status });

    if (status !== FlyerStatus.Failed) {
      const { currentFlyer } = await this.shopState.get(shop);
      if (!currentFlyer || currentFlyer.validFrom <= flyer.validFrom) {
        await this.shopState.setCurrentFlyer(shop, flyer.id);
      }
    }
    if (status === FlyerStatus.Ready) {
      await this.shopState.clearRetry(shop);
    } else {
      await this.shopState.scheduleRetry(shop, RetryReason.PagesFailed, {
        maxAttempts: config.parser.maxAttempts,
        error: `${unparsed} pages of ${flyer.id} are not parsed`,
      });
    }
    this.logger.log(`[${shop}] ${flyer.id} is ${status}`);
  }

  /**
   * Log and store a failure
   * load/refresh: FatalParseError → PAGES_FAILED retry, anything else → FETCH_FAILED retry.
   * reparse (admin): lastError only.
   */
  private async recordFailure(
    config: ShopConfig,
    action: PipelineAction,
    error: unknown,
  ): Promise<void> {
    const message = describeError(error);
    this.logger.error(
      `[${config.key}] ${action} failed: ${message}`,
      error instanceof Error ? error.stack : undefined,
    );
    try {
      if (action === 'reparse') {
        await this.shopState.recordError(config.key, message);
        return;
      }
      const reason =
        error instanceof FatalParseError
          ? RetryReason.PagesFailed
          : RetryReason.FetchFailed;
      const at = await this.shopState.scheduleRetry(config.key, reason, {
        maxAttempts: config.parser.maxAttempts,
        error: message,
      });
      this.logger.warn(
        `[${config.key}] ${reason}: ${at ? `retry at ${at.toISOString()}` : 'retries used up'}`,
      );
    } catch (stateError) {
      this.logger.error(
        `[${config.key}] could not record the failure: ${describeError(stateError)}`,
      );
    }
  }
}
```

- [ ] **Step 2: Create `src/pipeline/pipeline.exception-filter.ts`**

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { FlyerNotFoundError } from '../flyers/flyers.errors';
import { ImagesExpiredError } from '../page-parser/page-parser.errors';
import { LeaseBusyError } from '../shops/shop-lease.service';

/** Pipeline trigger errors → HTTP: busy shop 409, expired images 410, missing flyer/page 404 */
@Catch(LeaseBusyError, ImagesExpiredError, FlyerNotFoundError)
export class PipelineExceptionFilter implements ExceptionFilter {
  /** Write the JSON error response */
  catch(
    error: LeaseBusyError | ImagesExpiredError | FlyerNotFoundError,
    host: ArgumentsHost,
  ): void {
    const status =
      error instanceof LeaseBusyError
        ? HttpStatus.CONFLICT
        : error instanceof ImagesExpiredError
          ? HttpStatus.GONE
          : HttpStatus.NOT_FOUND;
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, error: error.name, message: error.message });
  }
}
```

- [ ] **Step 3: Create `src/pipeline/pipeline.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FlyersModule } from '../flyers/flyers.module';
import { PageParserModule } from '../page-parser/page-parser.module';
import { ShopsModule } from '../shops/shops.module';
import { SourceProvidersModule } from '../source-providers/source-providers.module';
import { FlyerPipelineService } from './flyer-pipeline.service';

/** Flyer pipeline orchestration; used by the worker cron and the admin routes */
@Module({
  imports: [ShopsModule, SourceProvidersModule, FlyersModule, PageParserModule],
  providers: [FlyerPipelineService],
  exports: [FlyerPipelineService],
})
export class PipelineModule {}
```

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pipeline): flyer pipeline orchestration under the shop lease"
```

---

### Task 10: Shops admin module (trigger routes)

**Files:**
- Create: `src/shops/admin/admin-shops.controller.ts`, `src/shops/admin/shops-admin.module.ts`

**Interfaces:**
- Consumes: `ShopStateService`, `FlyerPipelineService`, `PipelineExceptionFilter`, `ParseShopKeyPipe`, `ZodValidationPipe`
- Produces: `ShopsAdminModule`

- [ ] **Step 1: Create `src/shops/admin/admin-shops.controller.ts`**

```ts
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import { ParseShopKeyPipe } from '../../common/pipes/parse-shop-key.pipe';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  FlyerPipelineService,
  type PipelineAction,
} from '../../pipeline/flyer-pipeline.service';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import type { ShopKey } from '../shop.config.type';
import { ShopStateService } from '../shop-state.service';

/** Actions an admin can trigger per shop */
const actionSchema = z.enum(['load', 'refresh', 'reparse']);

/** Admin routes (unguarded): shop state and pipeline triggers */
@Controller('admin/shops')
@UseFilters(PipelineExceptionFilter)
export class AdminShopsController {
  /**
   * @param shopState - Shop state reads
   * @param pipeline - Run triggers
   */
  constructor(
    private readonly shopState: ShopStateService,
    private readonly pipeline: FlyerPipelineService,
  ) {}

  /** Every shop: current flyer, lease, retry, lastError */
  @Get()
  list() {
    return this.shopState.list();
  }

  /** One shop's state */
  @Get(':shop')
  get(@Param('shop', ParseShopKeyPipe) shop: ShopKey) {
    return this.shopState.get(shop);
  }

  /**
   * Start load / refresh / reparse in the background
   * 202 with the shop state · 409 shop busy · 410 images expired (reparse) · 404 no current flyer (reparse)
   */
  @Post(':shop/:action')
  @HttpCode(HttpStatus.ACCEPTED)
  async trigger(
    @Param('shop', ParseShopKeyPipe) shop: ShopKey,
    @Param('action', new ZodValidationPipe(actionSchema))
    action: PipelineAction,
  ) {
    await this.pipeline.trigger({ shop, action });
    return this.shopState.get(shop);
  }
}
```

- [ ] **Step 2: Create `src/shops/admin/shops-admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { ShopsModule } from '../shops.module';
import { AdminShopsController } from './admin-shops.controller';

/** Admin routes for shops and pipeline triggers; API only */
@Module({
  imports: [ShopsModule, PipelineModule],
  controllers: [AdminShopsController],
})
export class ShopsAdminModule {}
```

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(shops): admin routes to inspect shops and trigger pipeline runs"
```

---

### Task 11: Page parser admin module (flyers, pages, offers CRUD)

**Files:**
- Create: `src/page-parser/admin/offer.schema.ts`, `src/page-parser/admin/admin-page-parser.service.ts`, `src/page-parser/admin/admin-page-parser.controller.ts`, `src/page-parser/admin/page-parser-admin.module.ts`

**Interfaces:**
- Consumes: `Flyer`, `FlyerPage`, `FlyerOffer`, `R2Service`, `FlyerPipelineService`, `PipelineExceptionFilter`, `ZodValidationPipe`, `ProductCategoryKeys`, `ShopKeys`
- Produces: `PageParserAdminModule`

- [ ] **Step 1: Create `src/page-parser/admin/offer.schema.ts`**

```ts
import { z } from 'zod';
import { ProductCategoryKeys } from '../../flyers/types/product-category.type';

/** 0–1 fraction of the page width/height */
const coordinate = z.number().min(0).max(1);
/** [x, y] */
const point = z.tuple([coordinate, coordinate]);
/** EUR, fits numeric(8,2); omitted means null */
const price = z.number().nonnegative().max(999_999.99).nullable().optional();
/** Percent; omitted means null */
const percent = z.number().int().min(0).max(100).nullable().optional();

/** Body of POST /admin/pages/:pageId/offers */
export const offerInputSchema = z
  .object({
    title: z.string().trim().min(1),
    category: z.array(z.enum(ProductCategoryKeys)).nullable().optional(),
    boundaryBox: z.tuple([point, point]),
    basePrice: price,
    discountedPrice: price,
    discount: percent,
    loyaltyPrice: price,
    loyaltyDiscount: percent,
  })
  .strict();

/** Parsed offer input */
export type OfferInput = z.infer<typeof offerInputSchema>;

/** Body of PATCH /admin/offers/:id; only the given fields change */
export const offerPatchSchema = offerInputSchema.partial();

/** Parsed offer patch */
export type OfferPatch = z.infer<typeof offerPatchSchema>;

/** Query of GET /admin/flyers */
export const listFlyersQuerySchema = z.object({
  shop: z.enum(ShopKeys).optional(),
});
```

Add this import at the top of the file: `import { ShopKeys } from '../../shops/shop.config.type';`

- [ ] **Step 2: Create `src/page-parser/admin/admin-page-parser.service.ts`**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FlyerOffer } from '../../flyers/entities/flyer-offer.entity';
import { FlyerPage } from '../../flyers/entities/flyer-page.entity';
import { Flyer } from '../../flyers/entities/flyer.entity';
import { FlyerPipelineService } from '../../pipeline/flyer-pipeline.service';
import type { ShopKey } from '../../shops/shop.config.type';
import { R2Service } from '../../storage/r2.service';
import type { OfferInput, OfferPatch } from './offer.schema';

/** Admin queries and edits for parsed flyers, pages and offers */
@Injectable()
export class AdminPageParserService {
  /**
   * @param flyers - Flyer repository
   * @param pages - FlyerPage repository
   * @param offers - FlyerOffer repository
   * @param r2 - Presigned page image URLs
   * @param pipeline - Page reparse trigger (under the shop lease)
   */
  constructor(
    @InjectRepository(Flyer) private readonly flyers: Repository<Flyer>,
    @InjectRepository(FlyerPage) private readonly pages: Repository<FlyerPage>,
    @InjectRepository(FlyerOffer)
    private readonly offers: Repository<FlyerOffer>,
    private readonly r2: R2Service,
    private readonly pipeline: FlyerPipelineService,
  ) {}

  /** Flyers, newest first, optionally of one shop */
  listFlyers(shop?: ShopKey): Promise<Flyer[]> {
    return this.flyers.find({
      where: shop ? { shop } : {},
      order: { validFrom: 'DESC' },
    });
  }

  /** A flyer with its pages (status, attempts, lastError, parserVersion, model) */
  async getFlyer(id: string): Promise<Flyer> {
    const flyer = await this.flyers.findOne({
      where: { id },
      relations: { pages: true },
      order: { pages: { pageNumber: 'ASC' } },
    });
    if (!flyer) throw new NotFoundException(`Flyer ${id} not found`);
    return flyer;
  }

  /** A page with its offers and a presigned image URL */
  async getPage(pageId: string) {
    const page = await this.pages.findOne({
      where: { id: pageId },
      relations: { offers: true },
      order: { offers: { position: 'ASC' } },
    });
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);
    return {
      ...page,
      imageUrl: page.imageKey ? await this.r2.presign(page.imageKey) : null,
    };
  }

  /** Re-parse one page in the background (shop lease, prechecks first) */
  async reparsePage(pageId: string): Promise<FlyerPage> {
    const page = await this.findPageWithFlyer(pageId);
    await this.pipeline.trigger({
      shop: page.flyer.shop,
      action: 'reparse',
      flyerId: page.flyerId,
      pageIds: [page.id],
    });
    return page;
  }

  /** Add an offer by hand at the end of the page */
  async addOffer(pageId: string, input: OfferInput): Promise<FlyerOffer> {
    const page = await this.findPageWithFlyer(pageId);
    const last = await this.offers.maximum('position', { pageId });
    return this.offers.save(
      this.offers.create({
        title: input.title,
        category: input.category ?? null,
        boundaryBox: input.boundaryBox,
        basePrice: input.basePrice ?? null,
        discountedPrice: input.discountedPrice ?? null,
        discount: input.discount ?? null,
        loyaltyPrice: input.loyaltyPrice ?? null,
        loyaltyDiscount: input.loyaltyDiscount ?? null,
        position: (last ?? -1) + 1,
        pageId: page.id,
        flyerId: page.flyerId,
        shop: page.flyer.shop,
        validFrom: page.flyer.validFrom,
        validTo: page.flyer.validTo,
        cropKey: null,
      }),
    );
  }

  /** Change the given fields of an offer */
  async updateOffer(id: string, patch: OfferPatch): Promise<FlyerOffer> {
    const offer = await this.offers.findOneBy({ id });
    if (!offer) throw new NotFoundException(`Offer ${id} not found`);
    Object.assign(offer, patch);
    return this.offers.save(offer);
  }

  /** Delete an offer */
  async deleteOffer(id: string): Promise<void> {
    const result = await this.offers.delete(id);
    if (!result.affected) throw new NotFoundException(`Offer ${id} not found`);
  }

  /** A page with its flyer; 404 if missing */
  private async findPageWithFlyer(pageId: string): Promise<FlyerPage> {
    const page = await this.pages.findOne({
      where: { id: pageId },
      relations: { flyer: true },
    });
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);
    return page;
  }
}
```

- [ ] **Step 3: Create `src/page-parser/admin/admin-page-parser.controller.ts`**

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PipelineExceptionFilter } from '../../pipeline/pipeline.exception-filter';
import { AdminPageParserService } from './admin-page-parser.service';
import {
  listFlyersQuerySchema,
  offerInputSchema,
  offerPatchSchema,
  type OfferInput,
  type OfferPatch,
} from './offer.schema';

/** Admin routes (unguarded) over parser results: flyers, pages, offers */
@Controller('admin')
@UseFilters(PipelineExceptionFilter)
export class AdminPageParserController {
  /** @param admin - Admin queries and edits */
  constructor(private readonly admin: AdminPageParserService) {}

  /** Flyers, newest first; `?shop=` filters */
  @Get('flyers')
  listFlyers(
    @Query(new ZodValidationPipe(listFlyersQuerySchema))
    query: z.infer<typeof listFlyersQuerySchema>,
  ) {
    return this.admin.listFlyers(query.shop);
  }

  /** A flyer with its pages */
  @Get('flyers/:id')
  getFlyer(@Param('id') id: string) {
    return this.admin.getFlyer(id);
  }

  /** A page with its offers and a presigned image URL */
  @Get('pages/:pageId')
  getPage(@Param('pageId') pageId: string) {
    return this.admin.getPage(pageId);
  }

  /** Re-parse one page: 202 · 409 shop busy · 410 image expired */
  @Post('pages/:pageId/reparse')
  @HttpCode(HttpStatus.ACCEPTED)
  reparsePage(@Param('pageId') pageId: string) {
    return this.admin.reparsePage(pageId);
  }

  /** Add an offer by hand */
  @Post('pages/:pageId/offers')
  addOffer(
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(offerInputSchema)) body: OfferInput,
  ) {
    return this.admin.addOffer(pageId, body);
  }

  /** Edit an offer */
  @Patch('offers/:id')
  updateOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(offerPatchSchema)) body: OfferPatch,
  ) {
    return this.admin.updateOffer(id, body);
  }

  /** Delete an offer */
  @Delete('offers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteOffer(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteOffer(id);
  }
}
```

- [ ] **Step 4: Create `src/page-parser/admin/page-parser-admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FlyersModule } from '../../flyers/flyers.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminPageParserController } from './admin-page-parser.controller';
import { AdminPageParserService } from './admin-page-parser.service';

/** Admin routes over parser results; API only */
@Module({
  imports: [FlyersModule, StorageModule, PipelineModule],
  controllers: [AdminPageParserController],
  providers: [AdminPageParserService],
})
export class PageParserAdminModule {}
```

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(page-parser): admin routes for flyers, pages and offers"
```

---

### Task 12: Worker cron, final wiring and docs

**Files:**
- Create: `src/worker/pipeline.cron.ts`, `src/worker/worker.module.ts`
- Modify: `src/app.module.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `FlyerPipelineService`, `ShopStateService`, `SourceProvidersService`, `R2Service`, `LeaseBusyError`, `isOverdue`, `describeError`, `Env`
- Produces: `WorkerModule`; final `AppModule`

- [ ] **Step 1: Create `src/worker/pipeline.cron.ts`**

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { isOverdue } from '../common/dates';
import { describeError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { FlyerPipelineService } from '../pipeline/flyer-pipeline.service';
import { LeaseBusyError } from '../shops/shop-lease.service';
import type { ShopKey } from '../shops/shop.config.type';
import { ShopStateService } from '../shops/shop-state.service';
import { SourceProvidersService } from '../source-providers/source-providers.service';
import { R2Service } from '../storage/r2.service';

/** Time zone of both schedules */
const CRON_TIME_ZONE = 'Europe/Bratislava';

/**
 * Worker schedules
 * - Daily run (PIPELINE_CRON): load shops with no flyer, an overdue flyer, or an unfinished run
 * - Retry tick (PIPELINE_RETRY_CRON): load only shops whose retry.at is due
 * Note: Jobs are registered at runtime because their times come from config
 */
@Injectable()
export class PipelineCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PipelineCron.name);

  /**
   * @param scheduler - Registers the cron jobs
   * @param config - Cron expressions
   * @param pipeline - Runs
   * @param shopState - Current flyer and due retries
   * @param sources - Enabled shops and their configs
   * @param r2 - Lifecycle rule on startup
   */
  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
    private readonly pipeline: FlyerPipelineService,
    private readonly shopState: ShopStateService,
    private readonly sources: SourceProvidersService,
    private readonly r2: R2Service,
  ) {}

  /** Apply the R2 lifecycle rule and start both schedules */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.r2.ensureLifecycle();
    } catch (error) {
      this.logger.error(
        `R2 lifecycle rule not applied: ${describeError(error)}`,
      );
    }
    this.schedule(
      'pipeline-daily',
      this.config.get('PIPELINE_CRON', { infer: true }),
      () => this.daily(),
    );
    this.schedule(
      'pipeline-retries',
      this.config.get('PIPELINE_RETRY_CRON', { infer: true }),
      () => this.retries(),
    );
  }

  /** Daily run: each enabled shop, one after another */
  async daily(): Promise<void> {
    for (const shop of this.sources.enabledShops()) {
      try {
        const state = await this.shopState.get(shop);
        const { timezone } = this.sources.getConfig(shop);
        const due =
          !state.currentFlyer ||
          isOverdue(state.currentFlyer.validTo, timezone) ||
          (await this.pipeline.hasUnfinishedFlyer(shop));
        if (!due) {
          this.logger.log(
            `[${shop}] ${state.currentFlyerId} is still valid; skipped`,
          );
          continue;
        }
        await this.load(shop);
      } catch (error) {
        this.logger.error(`[${shop}] daily check failed: ${describeError(error)}`);
      }
    }
  }

  /** Retry tick: one query; nothing to do unless a retry is due */
  async retries(): Promise<void> {
    const enabled = new Set(this.sources.enabledShops());
    const due = await this.shopState.findDueRetries();
    for (const state of due) {
      if (!enabled.has(state.shop)) continue;
      this.logger.log(
        `[${state.shop}] retry due (${state.retry.reason}, attempt ${state.retry.attempts})`,
      );
      await this.load(state.shop);
    }
  }

  /** Run `load` and wait; a busy shop is skipped until the next tick */
  private async load(shop: ShopKey): Promise<void> {
    try {
      await this.pipeline.run({ shop, action: 'load' });
    } catch (error) {
      if (error instanceof LeaseBusyError) {
        this.logger.log(`[${shop}] busy; skipped`);
        return;
      }
      this.logger.error(`[${shop}] load failed: ${describeError(error)}`);
    }
  }

  /** Register and start a job; `waitForCompletion` never overlaps two runs of the same job */
  private schedule(
    name: string,
    cronTime: string,
    onTick: () => Promise<void>,
  ): void {
    const job = CronJob.from({
      cronTime,
      onTick,
      timeZone: CRON_TIME_ZONE,
      waitForCompletion: true,
    });
    this.scheduler.addCronJob(name, job);
    job.start();
    this.logger.log(`${name} scheduled: "${cronTime}" (${CRON_TIME_ZONE})`);
  }
}
```

- [ ] **Step 2: Create `src/worker/worker.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ShopsModule } from '../shops/shops.module';
import { SourceProvidersModule } from '../source-providers/source-providers.module';
import { StorageModule } from '../storage/storage.module';
import { PipelineCron } from './pipeline.cron';

/** Background worker: daily run + retry tick over the flyer pipeline; no HTTP */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    PipelineModule,
    ShopsModule,
    SourceProvidersModule,
    StorageModule,
  ],
  providers: [PipelineCron],
})
export class WorkerModule {}
```

- [ ] **Step 3: Replace `src/app.module.ts` with the final wiring**

```ts
import { DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppMode } from './app-mode';
import { CoreModule } from './core/core.module';
import { FlyersModule } from './flyers/flyers.module';
import { PageParserAdminModule } from './page-parser/admin/page-parser-admin.module';
import { ShopsAdminModule } from './shops/admin/shops-admin.module';
import { SourceProvidersAdminModule } from './source-providers/admin/source-providers-admin.module';
import { WorkerModule } from './worker/worker.module';

/** Feature modules of the HTTP API (`api`, `all`): public read API + unguarded admin routes */
const API_MODULES: Type[] = [
  FlyersModule,
  ShopsAdminModule,
  SourceProvidersAdminModule,
  PageParserAdminModule,
];

/** Feature modules of the background worker (`worker`, `all`) */
const WORKER_MODULES: Type[] = [WorkerModule];

/** Root module; `forMode` picks the feature modules for the process role */
@Module({})
export class AppModule {
  /** Build the root module for `mode`; a module needed by both roles is imported once */
  static forMode(mode: AppMode): DynamicModule {
    const modules = new Set<Type>([
      ...(mode === 'worker' ? [] : API_MODULES),
      ...(mode === 'api' ? [] : WORKER_MODULES),
    ]);
    return { module: AppModule, imports: [CoreModule, ...modules] };
  }
}
```

- [ ] **Step 4: Update `CLAUDE.md`**

Replace the `## Project` paragraph with:
```markdown
NestJS 11 service that collects weekly flyers from Slovak grocery chains (Kaufland, Tesco, Lidl, Billa), stores the page images in Cloudflare R2, and uses Gemini to extract individual offers (prices, discounts, bounding boxes, categories) into Postgres. Design: `docs/superpowers/specs/2026-10-18-flyer-pipeline-design.md`.
```

In `## Architecture`, replace the `APP_MODE` sentence of the **Config / env** bullet with:
```markdown
The schema lives in `src/config/env.schema.ts`; read values with `ConfigService<Env, true>` and `{ infer: true }`. `APP_MODE` (`api` | `worker` | `all`) is read in `main.ts` before Nest boots and picks the modules in `AppModule.forMode`: `api` = public read API + unguarded admin routes, `worker` = cron (no HTTP server).
```

Add these bullets at the end of `## Architecture`:
```markdown
- **Module graph** (arrows point down only, keep it acyclic): `Storage`, `Shops`, `SourceProviders` are leaves; `Flyers` → Storage, Shops; `PageParser` → Flyers, Storage; `Pipeline` → Shops, SourceProviders, Flyers, PageParser. Admin modules (`*/admin/`) and `Worker` sit on top; nothing imports them.
- **Pipeline** (`pipeline/flyer-pipeline.service.ts`): under the `ShopState` lease, runs discover → materialize into `PIPELINE_TMP_DIR` → `PageRegistrar.begin/register/upload` (DB rows, then R2) → `PageParserService.parsePages` (image bytes from R2, never local files) → finalize. Local files are deleted at the end of every run; DB + R2 are the source of truth. `run()` is awaited (cron), `trigger()` returns after the lease is taken (admin → 202).
- **Source providers**: a provider only implements `fetchListing()`; `SourceProvider.discover()` builds the flyerId, `materialize()` downloads the PDF (split with `pdf-to-img`, ESM-only, loaded via `await import()`) or page images, then compresses with sharp.
- **Worker**: daily run (`PIPELINE_CRON`) and a retry tick (`PIPELINE_RETRY_CRON`) that only acts on `ShopState.retry.at ≤ now`. On startup it applies the R2 lifecycle rule (`flyers/` expires after `R2_PAGE_TTL_DAYS`).
```

In `## Conventions`, add:
```markdown
- Every class, method, provider and exported type gets a descriptive `/** */` comment.
- No tests for now; verify with `pnpm lint`.
```

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): daily pipeline cron and retry tick; wire API and worker modes"
```
