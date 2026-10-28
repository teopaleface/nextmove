// Date helpers. Instants are ISO-8601 strings with an explicit offset; display uses Europe/Bucharest.

export const TIMEZONE = "Europe/Bucharest";

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid instant: ${iso}`);
  return ms;
}

/** Render an instant as an ISO string in Europe/Bucharest local time with its offset, e.g. 2026-10-30T09:00:00+02:00. */
export function toLocalIso(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const localAsUtc = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"), +get("second"));
  const offsetMin = Math.round((localAsUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${off}`;
}

const dayMonth = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "short", year: "numeric" });
const hourMinute = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "long" });

/** `30 Oct` */
export function formatDay(iso: string | number): string {
  return dayMonth.format(new Date(typeof iso === "number" ? iso : toMs(iso)));
}
/** `30 Oct 2026` */
export function formatDate(iso: string | number): string {
  return dayMonthYear.format(new Date(typeof iso === "number" ? iso : toMs(iso)));
}
/** `09:00` */
export function formatTime(iso: string | number): string {
  return hourMinute.format(new Date(typeof iso === "number" ? iso : toMs(iso)));
}
/** `30 Oct, 09:00` */
export function formatDayTime(iso: string | number): string {
  return `${formatDay(iso)}, ${formatTime(iso)}`;
}
/** `26 October` */
export function formatLongDay(iso: string | number): string {
  return longDay.format(new Date(typeof iso === "number" ? iso : toMs(iso)));
}

export function addDaysMs(ms: number, days: number): number {
  return ms + days * 86_400_000;
}

/** Calendar date (YYYY-MM-DD) of an instant in Europe/Bucharest. */
export function localDate(ms: number): string {
  return toLocalIso(ms).slice(0, 10);
}

/* Calendar arithmetic on Europe/Bucharest wall-clock time. Adding UTC months or days to an instant drifts:
   31 Jan + 1 month overflows into March, and a local time keeps its UTC hour across a DST change. These work
   on the local Y-M-D, clamp to the month's last day and keep the local time of day. */

function localFields(ms: number) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(toLocalIso(ms))!;
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +m[6] };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Epoch ms of a Europe/Bucharest wall-clock time. A time skipped by the spring DST change lands an hour later. */
export function fromLocal(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = (ms: number) => {
    const f = localFields(ms);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
  };
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

/** The same local time `months` calendar months later, clamped to the target month's last day (31 Jan + 1 → 28/29 Feb). */
export function addLocalMonths(ms: number, months: number): number {
  const f = localFields(ms);
  const index = f.year * 12 + (f.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return fromLocal(year, month, Math.min(f.day, daysInMonth(year, month)), f.hour, f.minute, f.second);
}

/** The same local time on another day of the same local month, clamped to the month's last day. */
export function withLocalDay(ms: number, day: number): number {
  const f = localFields(ms);
  return fromLocal(f.year, f.month, Math.min(Math.max(1, day), daysInMonth(f.year, f.month)), f.hour, f.minute, f.second);
}

/** Signed number of calendar days between two instants' local dates (Europe/Bucharest). */
export function localDaysBetween(fromMs: number, toMs_: number): number {
  const a = localFields(fromMs);
  const b = localFields(toMs_);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function inWindow(iso: string, startInclusive: string, endExclusive: string): boolean {
  const t = toMs(iso);
  return t >= toMs(startInclusive) && t < toMs(endExclusive);
}

export function relativeDays(fromIso: string, toIso: string): number {
  return Math.round((toMs(toIso) - toMs(fromIso)) / 86_400_000);
}
