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

export function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

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

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
