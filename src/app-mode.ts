export const APP_MODES = ['api', 'worker', 'all'] as const;
export type AppMode = (typeof APP_MODES)[number];

/**
 * `api`    - HTTP server for the frontend, no cron, no pipeline
 * `worker` - cron + flyer pipeline, no HTTP server
 * `all`    - both in one process, for local development only
 */
export function resolveAppMode(value = process.env.APP_MODE): AppMode {
  const mode = (value ?? 'api').trim().toLowerCase();
  if (!APP_MODES.includes(mode as AppMode)) {
    throw new Error(`APP_MODE must be one of ${APP_MODES.join(', ')}; got "${value}"`);
  }
  return mode as AppMode;
}
