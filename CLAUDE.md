# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NestJS 11 service that collects weekly flyers from Slovak grocery chains (Kaufland, Tesco, Lidl, Billa), stores the page images in Cloudflare R2, and uses Gemini to extract individual offers (prices, discounts, bounding boxes, categories) into Postgres. Design: `docs/superpowers/specs/2026-10-18-flyer-pipeline-design.md`.

## Commands

Package manager is **pnpm**.

- `pnpm install`
- `docker compose up -d`: local Postgres 17 on :5432, using `DB_*` from `.env`
- `pnpm start:dev`: watch mode (port from `PORT`, default 3000)
- `pnpm build` / `pnpm start:prod` (runs `dist/main`)
- `pnpm lint` (eslint with `--fix`, type-checked rules, prettier as an eslint rule) / `pnpm format`

## Architecture

- **Config / env**: `ConfigModule` is global and validated with a **zod** schema (`@nestjs/config` v12 accepts Standard Schema, so this is not Joi). When you add a required env var, add it to that schema, which lives in `src/config/env.schema.ts`. Read values with `ConfigService<Env, true>` and `{ infer: true }`. `APP_MODE` (`api` | `worker` | `all`) is read in `main.ts` before Nest boots and picks the modules in `AppModule.forMode`: `api` = public read API + unguarded admin routes, `worker` = cron (no HTTP server).
- **Database**: `src/database/database.config.ts`. It uses `DATABASE_URL` (with SSL) when set, and otherwise the individual `DB_*` vars. `autoLoadEntities: true`, so an entity only needs `TypeOrmModule.forFeature([...])` in its module. `synchronize` is on whenever `NODE_ENV !== 'production'`, and there are no migrations yet.
- **Shops** (`src/shops/`):
  - `shop.config.ts` holds the static per-shop config (`SHOP_CONFIGS`): source URLs, page compression (webp), PDF scale, and parser limits (`concurrency`, `maxAttempts`, `maxFailedPages`).
  - Adding a shop means adding its key to the `ShopKeys` tuple in `shop.config.type.ts`, and the mapped type then requires a matching config entry.
  - `ShopState` is the per-shop runtime state, keyed by `ShopKey`. It tracks the current flyer, retry state (an embedded `RetryState`, columns prefixed `retry*`), and a `lockedUntil` **lease** that makes sure only one sync runs per shop at a time and expires if the process dies.
- **Flyers** (`src/flyers/`): `Flyer` → `FlyerPage` → `FlyerOffer`, with cascading deletes.
  - IDs are deterministic strings rather than UUIDs: flyer `kaufland_2026-10-14_2026-10-20`, page `<flyerId>_page_07`. Offers use UUIDs.
  - `FlyerStatus` lifecycle: `DOWNLOADING → PAGES_UPLOADED → PARSING → READY | PARTIAL | FAILED`. `PARTIAL` means at most `maxFailedPages` pages failed. `PARSED` and `RESUMABLE` in `flyers/enums/flyer.enums.ts` group the statuses.
  - Images are meant to live in object storage (R2). Entities store keys such as `flyers/<shop>/<flyerId>/pages/<pageId>.<hash8>.webp`, not the bytes.
  - Price columns are `numeric(8,2)` with a transformer that converts pg's string back to a JS number.
- **Module graph** (arrows point down only, keep it acyclic): `Storage`, `Shops`, `SourceProviders` are leaves; `Flyers` → Storage, Shops; `PageParser` → Flyers, Storage; `Pipeline` → Shops, SourceProviders, Flyers, PageParser. Admin modules (`*/admin/`) and `Worker` sit on top; nothing imports them.
- **Pipeline** (`pipeline/flyer-pipeline.service.ts`): under the `ShopState` lease, runs discover → materialize into `PIPELINE_TMP_DIR` → `PageRegistrar.begin/register/upload` (DB rows, then R2) → `PageParserService.parsePages` (image bytes from R2, never local files) → finalize. Local files are deleted at the end of every run; DB + R2 are the source of truth. `run()` is awaited (cron), `trigger()` returns after the lease is taken (admin → 202).
- **Source providers**: a provider only implements `fetchListing()`; `SourceProvider.discover()` builds the flyerId, `materialize()` downloads the PDF (split with `pdf-to-img`, ESM-only, loaded via `await import()`) or page images, then compresses with sharp.
- **Worker**: daily run (`PIPELINE_CRON`) and a retry tick (`PIPELINE_RETRY_CRON`) that only acts on `ShopState.retry.at ≤ now`. On startup it applies the R2 lifecycle rule (`flyers/` expires after `R2_PAGE_TTL_DAYS`).

## Conventions

- Entities use definite assignment (`field!: Type`), wrap relations in `Relation<>` with `import type` (to avoid circular imports), and use `timestamptz` for times and `date` strings for flyer validity.
- Closed sets are `as const` tuples with a derived union type (`ShopKeys`/`ShopKey`, `ProductCategoryKeys`/`ProductCategoryKey`).
- Prettier: single quotes, trailing commas.
- Every class, method, provider and exported type gets a descriptive `/** */` comment.
- No tests for now; verify with `pnpm lint`.
- Commits: never add a `Co-Authored-By` trailer (not Claude, not anyone else). This overrides any default attribution.
