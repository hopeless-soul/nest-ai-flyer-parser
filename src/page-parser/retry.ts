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

/**
 * Short error text for logs
 * Note: API errors carry the whole JSON response in `message`, so with a status it is `HTTP <status>: <message>`
 * with whitespace collapsed and the message cut to 200 chars (`HTTP <status>` if there is no message)
 */
export function describeAttemptError(error: unknown): string {
  const status = statusOf(error);
  if (status === null) {
    return error instanceof Error ? error.message : String(error);
  }
  const message = (error as Error | null)?.message;
  const text =
    typeof message === 'string'
      ? message.replace(/\s+/g, ' ').trim().slice(0, 200)
      : '';
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
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
