/** Short error text for logs, ShopState.lastError and API responses */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
