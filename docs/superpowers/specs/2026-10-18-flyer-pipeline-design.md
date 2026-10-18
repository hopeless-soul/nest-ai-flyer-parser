# Flyer pipeline design

Date: 2026-10-18
Status: approved in brainstorming, pending spec review

## Goal

Port the flyer processing code (download → split/compress → AI parse) from the read-only Node app
`C:\Users\hk\Documents\Development\node\ai flyer parser` into this NestJS service, using Postgres and Cloudflare R2 instead of
local JSON caches and lock files.

**Rule:** DB rows and R2 objects are the single source of truth. Local PDFs and page images are temporary
files of one run. They are never trusted, never resumed from, and always deleted at the end of the run.

## Callers

- **Worker** (`APP_MODE=worker|all`): a cron runs **once a day** (`PIPELINE_CRON`). For each enabled shop it
  loads a flyer when the shop has none or the current one is overdue. Otherwise it skips the shop.
  Retries are the exception: a separate retry tick (`PIPELINE_RETRY_CRON`) acts only on shops whose
  `retry.at` is due.
- **API** (`APP_MODE=api|all`): serves offers to the frontend. Unguarded admin routes trigger load, refresh
  and re-parse for a given shop. The admin run executes **in the API process**: the route returns 202 and
  the run continues in the background, or the route returns 409 if the shop lease is held.

Both callers go through one `FlyerPipelineService`.

## Modules

Feature modules. Dependency arrows only point down, so there are no cycles. Admin modules and the worker
are leaves: nothing imports them.

```
src/
├─ storage/          StorageModule                          (leaf)
│  └─ r2.service.ts          put, get → Buffer, presign, ensureLifecycle
├─ shops/            ShopsModule                            (leaf: owns ShopState)
│  ├─ shop-lease.service.ts  acquire / renew / release lockedUntil (atomic UPDATE … RETURNING)
│  ├─ shop-state.service.ts  seed rows for all ShopKeys, markSuccess / markError / retry bookkeeping
│  └─ admin/  ShopsAdminModule → admin-shops.controller.ts
├─ flyers/           FlyersModule → Storage
│  ├─ page-registrar.service.ts   register(d, files) → Flyer + FlyerPage rows; upload(flyerId, files) → R2 + link
│  └─ flyers.controller.ts        public read API (replaces CRUD scaffold + DTOs)
├─ source-providers/ SourceProvidersModule                  (leaf: no DB)
│  ├─ source-providers.service.ts   resolve(shop), resolveMany, getConfig, parseOverrides
│  ├─ source-provider.ts            abstract base: discover(), materialize(d, tmpDir)
│  ├─ source-provider.types.ts / source-provider.errors.ts / source-providers.tokens.ts
│  ├─ http.service.ts               getText, getJson, getTextLargeHeaders (Lidl CSP header), downloadToFile
│  ├─ page-materializer.service.ts  splitPdf(), compress(), compressFiles()
│  ├─ providers/ index.ts (SOURCE_PROVIDER_CLASSES) + kaufland|tesco|lidl|billa.source-provider.ts
│  └─ admin/  SourceProvidersAdminModule → admin-source-providers.controller.ts
├─ page-parser/      PageParserModule → Flyers, Storage
│  ├─ page-parser.service.ts        parsePages(flyerId, filter): R2 → Gemini → normalize → save
│  ├─ gemini.client.ts / page-prompt.ts / normalize.ts / retry.ts / page-parser.errors.ts   (ported)
│  └─ admin/  PageParserAdminModule → admin-page-parser.controller.ts   (→ Pipeline, PageParser)
├─ pipeline/         PipelineModule → Shops, SourceProviders, Flyers, PageParser
│  ├─ flyer-pipeline.service.ts     load / refresh / reparse / reparsePage
│  ├─ pipeline.errors.ts
│  └─ pipeline.exception-filter.ts  used by the admin controllers
├─ worker/           WorkerModule → Pipeline, Shops, ScheduleModule
│  └─ pipeline.cron.ts
└─ common/zod-validation.pipe.ts
```

`AppModule` reads `APP_MODE` once at bootstrap and imports the matching modules:
- `api`: `ShopsAdminModule`, `SourceProvidersAdminModule`, `PageParserAdminModule`, `FlyersModule`
- `worker`: `WorkerModule`
- `all`: both sets

`R2Service.ensureLifecycle()` runs on worker init.

`ShopsModule` drops its current import and re-export of `FlyersModule`. Entity-to-entity references work
without a module import because `autoLoadEntities` is on.

## Schema changes

| Entity | Change | Reason |
|---|---|---|
| `FlyerOffer` | `discount`, `loyaltyDiscount` → `smallint` | `'number'` is not a Postgres type |
| `FlyerPage` | `imageKey`, `imageHash` → nullable | The row is registered before the image is in R2 |
| `FlyerPage` | `PageStatus` = `PENDING → UPLOADED → PARSED \| FAILED`; column `varchar(16)` | Separates "registered" from "in R2" |
| `Flyer.context` | holds the provider's `discover()` context (pdf URL, Lidl slug, …) | Records where the flyer came from |
| `ShopConfig` type | add the `timezone` field (already in config values) | Needed for the overdue check |

`FlyerStatus` stays as it is: `DOWNLOADING → PAGES_UPLOADED → PARSING → READY | PARTIAL | FAILED`.
"Offer/Product" means `FlyerOffer`. There is no separate product entity.

## Source provider contract

```ts
abstract class SourceProvider {
  abstract readonly shop: ShopKey
  /** Cheap: reads the shop site/API, no file download */
  abstract discover(overrides?: SourceOption): Promise<DiscoveredFlyer>   // { flyerId, validFrom, validTo, context }
  /** Downloads the flyer and writes compressed page images to tmpDir, in page order */
  abstract materialize(flyer: DiscoveredFlyer, tmpDir: string): Promise<LocalPage[]>   // { pageNumber, path }
}
```

- Kaufland, Tesco and Billa: download the PDF, then `PageMaterializer.splitPdf` (pdf-to-img with the pdf.js
  wasm path fix, `pdfScale`), then compress (sharp, `shop.pages.compress`).
- Lidl: picks the flyer valid today from the leaflets API, downloads the pre-rendered page images, then
  `PageMaterializer.compressFiles`.
- `flyerId` = `<shop>_<validFrom>_<validTo>`. When the source has no `validTo`, the provider uses
  `validFrom + defaultFlyerDuration`.
- Providers never touch the DB or R2.

## Pipeline flow

`load(shop)`:

1. `lease.acquire(shop, 15m)`. If the lease is busy, admin gets 409 and the cron skips the shop. While
   running, the lease is renewed every 5 minutes.
2. `d = provider.discover()`.
3. Decide using the existing `Flyer(d.flyerId)`:
   - **`READY`, or `PARTIAL`/`FAILED` with shop retries used up (`retry.attempts ≥ parser.maxAttempts`):**
     if this is the current flyer and it is overdue, set the shop retry to `AWAITING_NEW_FLYER`. Then stop.
   - **Every page is `UPLOADED` or later (this covers `PARTIAL`/`FAILED` with retries left):** go to step 7.
     No local files are needed.
   - **Otherwise, or no flyer:** delete any partial rows (cascade) and continue.
4. Upsert the `Flyer` with status `DOWNLOADING`.
5. `files = provider.materialize(d, tmpDir)`, where tmpDir is `PIPELINE_TMP_DIR/<flyerId>-<runId>`.
6. Register and upload:
   - `registrar.register(flyer, files)`: in one transaction, create the `FlyerPage` rows with status
     `PENDING` and set `pageCount`.
   - `registrar.upload(flyerId, files)`: for each page, compute the sha256 and use the key
     `flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.webp`. Put the object, then set `imageKey`, `imageHash`,
     `width` and `height`, and mark the page `UPLOADED`. When every page is uploaded, the flyer becomes
     `PAGES_UPLOADED`.
   - `rm tmpDir` always runs (in a `finally`).
7. Set the flyer to `PARSING`, then run `parser.parsePages(flyerId)` on pages that are `UPLOADED`, `FAILED`,
   or have `parserVersion < PARSER_VERSION`. Pages run with `parser.concurrency` workers. For each page:
   - Get the object from R2 into memory (the parser never sees local files).
   - Call Gemini with inline data, then `normalizePage`.
   - In one transaction: delete the page's offers, insert the new ones, and set `PARSED`, `parserVersion`,
     `model` and `parsedAt`.
   - On failure: increment `attempts`, store `lastError`, and set `FAILED`.
8. Finalize the flyer:
   - 0 failed pages → `READY`
   - at most `maxFailedPages` failed → `PARTIAL`
   - more failed → `FAILED`

   For `READY` or `PARTIAL`, `ShopState` gets `currentFlyerId`, `isAvailiable = true`, `lastSuccessAt`, and
   its retry is reset.
9. `lease.release` always runs (in a `finally`).

Other entry points:
- **`refresh(shop)`:** discover, delete the existing flyer with that id, then run steps 4–9.
- **`reparse(shop)`:** steps 7–8 on the current flyer, with every page treated as pending.
- **`reparsePage(pageId)`:** steps 7–8 for that page only, under the shop lease.

If R2 objects are missing (expired after 10 days), these throw `ImagesExpiredError`. There is no automatic
refresh in that case.

**Cron** (`worker/pipeline.cron.ts`, two jobs, both in timezone `Europe/Bratislava`, both skip shops whose
lease is busy):

- **Daily run** (`PIPELINE_CRON`, default `0 6 * * *`), for each enabled shop:
  1. No current flyer, or today is past `validTo` in the shop timezone → `load`.
  2. The current flyer is `RESUMABLE` (a run died mid-way) → `load` (it resumes).
  3. Otherwise → skip.
- **Retry tick** (`PIPELINE_RETRY_CRON`, default `*/15 * * * *`): runs one query for shops where
  `retry.at ≤ now` and calls `load` for each of them. Covers `FETCH_FAILED`, `PAGES_FAILED` (a
  `PARTIAL`/`FAILED` flyer with retries left resumes at step 7) and `AWAITING_NEW_FLYER`. With no due
  retries, the tick does nothing beyond that query. The retry time lives in the DB (`retry.at`), so a
  restart loses nothing.

## R2

- Private bucket accessed through R2's S3-compatible endpoint with `@aws-sdk/client-s3`
  (`region: 'auto'`, endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`). The S3 client is an
  internal detail of `R2Service`.
- `ensureLifecycle()` runs on worker init. It applies an idempotent `PutBucketLifecycleConfiguration`: rule
  `flyer-pages-10d`, prefix `flyers/`, expire after `R2_PAGE_TTL_DAYS` (10). The R2 token needs
  bucket-config permission.
- The frontend and admin get page images as presigned GET URLs that are valid for 1 hour.

## AI parsing (ported)

Taken from `src/parser/*` in the source repo, with these changes:
- Images come from R2 buffers instead of local files.
- The `@google/genai` client comes from `ConfigService` (`GEMINI_API_KEY`, `GEMINI_MODEL`).
- File locking and JSON caching are removed.

Kept unchanged:
- `PAGE_PROMPT`, `PAGE_SYSTEM_INSTRUCTION`, `PAGE_RESPONSE_SCHEMA`
- `modelConfigFor`, `answerText` (MAX_TOKENS check), `PARSER_MAX_OUTPUT_TOKENS = 8192`
- `normalizePage`: `box_2d` 0–1000 → 0–1 corners, prices, categories, discount fallback, offers without a
  discount dropped
- `withRetry` / `classifyError`: exponential backoff with jitter, honouring Gemini's `retryDelay`; statuses
  400/401/403/404 are fatal
- `PARSER_VERSION = 3`

`FlyerOffer.position` is the item's index in the model answer. Offers also copy `flyerId`, `shop`,
`validFrom` and `validTo` from the flyer.

## Errors and retries

| Error | Source | Admin HTTP | Cron effect |
|---|---|---|---|
| `SourceUnavailableError` | provider discover/materialize | 502 | `retry.reason = FETCH_FAILED`, backoff |
| `InvalidOverridesError` | admin discover body | 400 | n/a |
| `LeaseBusyError` | `ShopLeaseService.acquire` | 409 | skip the tick |
| `ImagesExpiredError` | reparse with missing R2 objects | 410 | n/a |
| `InvalidResponseError` | normalize | n/a | page-level retry |
| `FatalParseError` | Gemini (bad key, 4xx) | n/a | stop parsing; the flyer stays `PARSING` (resumable); `retry.reason = PAGES_FAILED`, backoff |

- `PipelineExceptionFilter` maps these errors in the admin modules.
- Errors that happen in a background run after the 202 response are logged and written to
  `ShopState.lastError`.
- **Page level:** `withRetry`, up to `parser.maxAttempts`.
- **Shop level:** `ShopState.retry` holds `{ reason, attempts, at }`. Backoff is `30m · 2^attempts`, capped
  at 12h. A success resets it. `AWAITING_NEW_FLYER` uses a flat 1h with no cap.

## HTTP API

Validation uses zod schemas through `ZodValidationPipe`. Admin routes have no guard.

```
# ShopsAdminModule
GET    /admin/shops                          state, current flyer status, lease, retry, lastError
GET    /admin/shops/:shop
POST   /admin/shops/:shop/load               202 | 409
POST   /admin/shops/:shop/refresh            202 | 409
POST   /admin/shops/:shop/reparse            202 | 409 | 410

# SourceProvidersAdminModule
GET    /admin/source-providers
GET    /admin/source-providers/:shop
POST   /admin/source-providers/:shop/discover   optional overrides → DiscoveredFlyer (no writes) | 400 | 502

# PageParserAdminModule
GET    /admin/flyers?shop=
GET    /admin/flyers/:id                     pages with status, attempts, lastError, parserVersion, model
GET    /admin/pages/:pageId                  page + offers + presigned imageUrl
POST   /admin/pages/:pageId/reparse          202 | 409 | 410
POST   /admin/pages/:pageId/offers           manual offer add
PATCH  /admin/offers/:id
DELETE /admin/offers/:id

# FlyersModule (public)
GET    /shops                                available shops with current flyer dates
GET    /shops/:shop/offers?category=         offers of the current flyer
GET    /flyers/:id/pages                     pages with presigned imageUrl
```

## Configuration

New env vars, added to the zod schema in `app.module.ts`:

```
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   required
R2_PAGE_TTL_DAYS=10
GEMINI_API_KEY                                                     required
GEMINI_MODEL=gemini-3.5-flash-lite
PIPELINE_CRON="0 6 * * *"            daily run
PIPELINE_RETRY_CRON="*/15 * * * *"   retry tick (acts only on due retry.at)
PIPELINE_TMP_DIR=<os.tmpdir()>/flyer-parser
```

New dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@google/genai`, `pdf-to-img`,
`sharp`, `@nestjs/schedule`.

## Implementation conventions

- Every class, method, provider and exported type gets a descriptive `/** */` comment.
- Follow `CLAUDE.md`: definite assignment, `Relation<>` with `import type`, `as const` tuples, single
  quotes, trailing commas.
- Fix the broken `PageProvidersModule` import in `app.module.ts`.
- No tests for now. Verification is `pnpm lint` only.

## Out of scope

Auth on admin routes, offer image crops (`cropKey`), DB migrations (`synchronize` stays on in dev),
queues, and tests.
