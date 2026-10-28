import { formatMoney } from "../shared/money";

// Display formatting. English formatting, Europe/Bucharest time, tabular numerals are applied in CSS.

const TZ = "Europe/Bucharest";
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ });
const dayTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

export const money = (minor: number | null | undefined, opts: { sign?: boolean; whole?: boolean } = {}) => (minor == null ? "—" : formatMoney(minor, "RON", opts));
export const short = (minor: number | null | undefined) => (minor == null ? "—" : formatMoney(minor, "RON", { whole: true }));

export function splitMoney(minor: number) {
  const s = formatMoney(minor, "RON");
  const i = s.lastIndexOf(" ");
  return { amount: s.slice(0, i), ccy: s.slice(i + 1) };
}

const valid = (iso: string | null | undefined) => Boolean(iso) && !Number.isNaN(Date.parse(String(iso)));
export const date = (iso: string | null | undefined) => (valid(iso) ? dateFmt.format(new Date(iso!)) : "—");
export const day = (iso: string | null | undefined) => (valid(iso) ? dayFmt.format(new Date(iso!)) : "—");
export const dayTime = (iso: string | null | undefined) => (valid(iso) ? dayTimeFmt.format(new Date(iso!)) : "—");
export const time = (iso: string | null | undefined) => (valid(iso) ? timeFmt.format(new Date(iso!)) : "—");

export function initials(name: string | null | undefined) {
  const parts = String(name ?? "?").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

/** Plain-English names for evidence levels; the raw code stays available in the developer view. */
export const EVIDENCE_LABEL: Record<string, string> = {
  DETERMINISTIC_CALCULATION: "Calculated by NextMove",
  BANK_RECORD: "Bank record",
  BANK_LEDGER_POSTING: "Bank ledger posting",
  SIMULATED_MERCHANT_API: "Simulated provider API",
  SIMULATED_MERCHANT_BROWSER: "Simulated provider website",
  SIMULATED_MERCHANT_EVENT: "Simulated provider event",
  LIVE_MODEL: "Live model",
  LIVE_MODEL_VISION: "Live model reading your image",
  SIMULATED_PLANNER: "Simulated planner (labelled)",
  MANUAL_INPUT: "You entered",
  PREPARED_NOT_SENT: "Prepared, not sent",
  FICTIONAL_CATALOG: "Fictional catalog",
  CUSTOMER_APPROVAL: "Your approval",
};

export const evidenceLabel = (code: string | null | undefined) => (code ? EVIDENCE_LABEL[code] ?? code.replace(/_/g, " ").toLowerCase() : "");

export const ROUTE_LABEL: Record<string, string> = {
  PARTNER_API: "Partner API",
  ISOLATED_BROWSER: "Provider website, isolated browser",
  BANK_INTERNAL: "NextMove bank",
  LOCAL_PREPARATION: "Prepared in NextMove (not sent)",
};

/** Place a real (wall-clock) timestamp on the demo clock shown everywhere else in the app. */
export function onDemoClock(iso: string | null | undefined, offsetMs: number): string | null {
  if (!valid(iso)) return null;
  return new Date(Date.parse(iso!) + offsetMs).toISOString();
}
