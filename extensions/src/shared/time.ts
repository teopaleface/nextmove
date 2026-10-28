import { invariant } from './errors.ts';

/** Calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;
/** Instant with an explicit offset, e.g. `2026-10-28T09:45:00+02:00`. */
export type Instant = string;

export const BANK_TIME_ZONE = 'Europe/Bucharest';
const DAY_MS = 86_400_000;

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function assertDate(value: IsoDate, field = 'date'): void {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), 'INVALID_DATE', `${field} must be YYYY-MM-DD, got "${value}"`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  invariant(m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m), 'INVALID_DATE', `${field} is not a calendar date: "${value}"`);
}

export function assertInstant(value: Instant, field = 'instant'): void {
  invariant(INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), 'INVALID_INSTANT', `${field} must be an ISO instant with offset, got "${value}"`);
}

export function toMillis(value: Instant): number {
  assertInstant(value);
  return Date.parse(value);
}

export function compareInstants(a: Instant, b: Instant): number {
  return Math.sign(toMillis(a) - toMillis(b));
}

export function isBefore(a: Instant, b: Instant): boolean {
  return toMillis(a) < toMillis(b);
}

export function isAfter(a: Instant, b: Instant): boolean {
  return toMillis(a) > toMillis(b);
}

export function addMinutes(value: Instant, minutes: number): Instant {
  return new Date(toMillis(value) + minutes * 60_000).toISOString();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateToUtcMillis(value: IsoDate): number {
  assertDate(value);
  return Date.parse(`${value}T00:00:00Z`);
}

function utcMillisToDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  invariant(Number.isInteger(days), 'INVALID_DAYS', `days must be an integer, got ${days}`);
  return utcMillisToDate(dateToUtcMillis(value) + days * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((dateToUtcMillis(to) - dateToUtcMillis(from)) / DAY_MS);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  assertDate(a);
  assertDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Calendar date of an instant in the bank's time zone (merchant billing days are local days). */
export function localDate(value: Instant, timeZone = BANK_TIME_ZONE): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(toMillis(value)));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthKey(value: IsoDate): string {
  assertDate(value);
  return value.slice(0, 7);
}

/**
 * Adds whole months keeping the anchor day, clamped to the month's last day:
 * anchor 31 gives Jan 31 → Feb 28/29 → Mar 31; an annual Feb 29 anchor lands on Feb 28 in other years.
 */
export function addMonthsClamped(value: IsoDate, months: number, anchorDay?: number): IsoDate {
  assertDate(value);
  invariant(Number.isInteger(months), 'INVALID_MONTHS', `months must be an integer, got ${months}`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const day = anchorDay ?? d;
  invariant(Number.isInteger(day) && day >= 1 && day <= 31, 'INVALID_ANCHOR_DAY', `anchor day must be 1..31, got ${day}`);
  const zeroBased = m - 1 + months;
  const year = y + Math.floor(zeroBased / 12);
  const month = (((zeroBased % 12) + 12) % 12) + 1;
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}
