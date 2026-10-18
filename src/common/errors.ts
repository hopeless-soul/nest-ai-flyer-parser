/** Short error text for logs and API responses */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
