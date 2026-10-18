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
