# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NestJS 11 service that collects weekly flyers from Slovak grocery chains (Kaufland, Tesco, Lidl, Billa), stores the page images in Cloudflare R2, and uses Gemini to extract individual offers (prices, discounts, bounding boxes, categories) into Postgres.

## Commands

Package manager is **pnpm**.

- `pnpm install`
- `docker compose up -d`: local Postgres 17 on :5432, using `DB_*` from `.env`
- `pnpm start:dev`: watch mode (port from `PORT`, default 3000)
- `pnpm build` / `pnpm start:prod` (runs `dist/main`)
- `pnpm lint` (eslint with `--fix`, type-checked rules, prettier as an eslint rule) / `pnpm format`
- `pnpm openapi`: build, then write `openapi.json` (preview mode: no DB/R2/Gemini, but env must validate). Swagger UI at `/docs` (JSON `/docs-json`) whenever `NODE_ENV !== 'production'`

## Architecture

- **Config / env**: `ConfigModule` is global and validated with a **zod** schema (`@nestjs/config` v12 accepts Standard Schema, so this is not Joi). When you add a required env var, add it to that schema, which lives in `src/config/env.schema.ts`. Read values with `ConfigService<Env, true>` and `{ infer: true }`. `APP_MODE` (`api` | `worker` | `all`) is read in `main.ts` before Nest boots and picks the modules in `AppModule.forMode`: `api` = public read API (`FlyersController`: `GET /shops`, `/shops/:shop/offers`, `/flyers/:id/pages`, `/pages/:id/image`) + `GET /health` (`HealthModule`: `SELECT 1`, 503 when the DB is down; never throttled) + `/admin/*` routes behind `ApiKeyGuard` (`common/guards/`: `Authorization: Bearer <key>` or `X-API-Key`, checked against the SHA-256 digests in `ADMIN_API_KEY_HASHES`; unset = every admin request is rejected). The API also registers `ThrottlerModule` with a global `ThrottlerGuard`: per client IP, `THROTTLE_LIMIT` requests per `THROTTLE_TTL` ms (options in `src/config/throttler.config.ts`; in-memory, per process; `main.ts` sets Express `trust proxy` to 1 for Railway's edge). `GET /pages/:id/image` has its own `IMAGE_THROTTLE` (600/min, per route) and is `Cache-Control: public, max-age=3000`. `worker` = cron (no HTTP server).
- **Database**: `src/database/database.config.ts`. It uses `DATABASE_URL` (with SSL) when set, and otherwise the individual `DB_*` vars. `autoLoadEntities: true`, so an entity only needs `TypeOrmModule.forFeature([...])` in its module. `synchronize` follows `DB_SYNCHRONIZE` (default false; on in dev, in production only for the first deploy against an empty DB), and there are no migrations yet.
- **Shops** (`src/shops/`):
  - `shop.config.ts` holds the static per-shop config (`SHOP_CONFIGS`): `enabled`, `timezone` (flyer dates and overdue checks), `defaultFlyerDuration` (used when the site prints no end date), source URLs, page compression (webp), PDF scale, and parser limits (`concurrency`, `maxAttempts`, `maxFailedPages`).
  - `shop.config.schema.ts` holds the zod schemas for each shop's source options (`SOURCE_OPTIONS_SCHEMAS`). They are the single source of truth for the `SourceOptionsMap` types and for validating admin overrides.
  - Adding a shop takes four steps: add its key to the `ShopKeys` tuple in `shop.config.type.ts`, add its `SOURCE_OPTIONS_SCHEMAS` schema, add its `SHOP_CONFIGS` entry (the mapped types require the last two), and register its provider class in `source-providers/providers/index.ts`.
  - `ShopState` is the per-shop runtime state, keyed by `ShopKey`. It tracks the current flyer, retry state (an embedded `RetryState`, columns prefixed `retry*`), and a `lockedUntil` **lease** that makes sure only one sync runs per shop at a time and expires if the process dies.
- **Flyers** (`src/flyers/`): `Flyer` → `FlyerPage` → `FlyerOffer`, with cascading deletes.
  - IDs are deterministic strings rather than UUIDs: flyer `kaufland_2026-10-14_2026-10-20`, page `<flyerId>_page_07`. Offers use UUIDs.
  - `FlyerStatus` lifecycle: `DOWNLOADING → PAGES_UPLOADED → PARSING → READY | PARTIAL | FAILED`. `PARTIAL` means at most `maxFailedPages` pages failed. `PARSED` and `RESUMABLE` in `flyers/enums/flyer.enums.ts` group the statuses.
  - Images are meant to live in object storage (R2). Entities store keys such as `flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.webp`, not the bytes.
  - The bucket is private. Public DTOs (`PageDto`, `OfferDto`) return stable `imageUrl`s (`${API_PUBLIC_URL}/pages/:id/image`) built by `FlyersService.stableImageUrl`, never presigned URLs. That endpoint 302s to a fresh 1-hour presigned R2 URL, because the frontend caches responses for the whole flyer (~7 days) and presigning caps at 7 days. Only admin routes return presigned URLs directly. `R2_PAGE_TTL_DAYS` must outlive that cache.
  - Price columns are `numeric(8,2)` with a transformer that converts pg's string back to a JS number.
- **Module graph** (arrows point down only, keep it acyclic): `Storage`, `Shops`, `SourceProviders` are leaves; `Flyers` → Storage, Shops; `PageParser` → Flyers, Storage; `Pipeline` → Shops, SourceProviders, Flyers, PageParser. Admin modules (`*/admin/`) and `Worker` sit on top; nothing imports them.
- **Pipeline** (`pipeline/flyer-pipeline.service.ts`): under the `ShopState` lease, runs discover → materialize into `PIPELINE_TMP_DIR` → `PageRegistrar.begin/register/upload` (DB rows, then R2) → `PageParserService.parsePages` (image bytes from R2, never local files) → finalize. Local files are deleted at the end of every run; DB + R2 are the source of truth. `run()` is awaited (cron), `trigger()` returns after the lease is taken (admin → 202).
- **Source providers**: a provider only implements `fetchListing()`; `SourceProvider.discover()` builds the flyerId, `materialize()` downloads the PDF (split with `pdf-to-img`, ESM-only, loaded via `await import()`) or page images, then compresses with sharp.
- **Page parser**: bump `PARSER_VERSION` in `page-parser/page-prompt.ts` whenever the prompt or the offer shape changes. Pages parsed by an older version are then parsed again.
- **Worker** (`worker/pipeline.cron.ts`, cron times in Europe/Bratislava): the daily run (`PIPELINE_CRON`) loads only enabled shops that have no current flyer, an overdue one, or an unfinished run. The retry tick (`PIPELINE_RETRY_CRON`) only acts on `ShopState.retry.at ≤ now`. Backoff lives in `ShopStateService.scheduleRetry`: `FETCH_FAILED`/`PAGES_FAILED` wait 30m · 2^(n-1), capped at 12h, and stop at `maxAttempts`; `AWAITING_NEW_FLYER` retries hourly forever. On startup the worker applies the R2 lifecycle rule (`flyers/` expires after `R2_PAGE_TTL_DAYS`).
- **Deploy**: Railway, configured by `railway.json` (build `pnpm build`, start `pnpm start:prod`, healthcheck `GET /health`). It runs as one service with `APP_MODE=all`, `DB_*` come from the Railway Postgres reference vars (private network, no SSL), and `CORS_ORIGINS` lists the Vercel frontend origins. The frontend is on Vercel.

## Conventions

- Entities use definite assignment (`field!: Type`), wrap relations in `Relation<>` with `import type` (to avoid circular imports), and use `timestamptz` for times and `date` strings for flyer validity.
- Closed sets are `as const` tuples with a derived union type (`ShopKeys`/`ShopKey`, `ProductCategoryKeys`/`ProductCategoryKey`).
- API responses are DTO classes in `*/dto/*.dto.ts`; controllers map entities with `XDto.from(entity)` and annotate the return type (`Promise<XDto[]>`). The `@nestjs/swagger` CLI plugin (`nest-cli.json`, `.dto.ts` only, `introspectComments`) documents them from types and `/** */` comments; add `@ApiProperty` only where it can't infer (`ShopKey`/category enums, tuples, free-form objects). Request bodies stay zod: document them with `@ApiBody({ schema: zodSchema(schema) })` (`common/openapi/`).
- Prettier: single quotes, trailing commas.
- Every class, method, provider and exported type gets a descriptive `/** */` comment.
- No tests for now; verify with `pnpm lint`. The jest scripts, `test/jest-e2e.json` and `README.md` are leftover Nest starter boilerplate, so don't trust them.
- Commits: never add a `Co-Authored-By` trailer (not Claude, not anyone else). This overrides any default attribution.
