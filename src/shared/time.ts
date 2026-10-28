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

export function inWindow(iso: string, startInclusive: string, endExclusive: string): boolean {
  const t = toMs(iso);
  return t >= toMs(startInclusive) && t < toMs(endExclusive);
}

export function relativeDays(fromIso: string, toIso: string): number {
  return Math.round((toMs(toIso) - toMs(fromIso)) / 86_400_000);
}
