// Deterministic money primitives. All amounts are bounded safe integers in minor units
// (bani for RON). No floating point arithmetic is used for stored or compared amounts.

export type Currency = "RON" | "EUR";

export interface Money {
  minor: number;
  currency: Currency;
}

export const MAX_MINOR = 1_000_000_000_00; // 1 billion major units: comfortably inside safe integers.

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertMinor(value: unknown, label = "amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer in minor units`);
  }
  if (Math.abs(value) > MAX_MINOR) throw new MoneyError(`${label} exceeds the supported bound`);
  return value;
}

export function money(minor: number, currency: Currency = "RON"): Money {
  return { minor: assertMinor(minor), currency };
}

export function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Mixed currency ${a.currency}/${b.currency} without a supplied conversion`);
  }
}

export function add(...items: Money[]): Money {
  if (items.length === 0) return money(0);
  const currency = items[0].currency;
  let total = 0;
  for (const item of items) {
    sameCurrency(items[0], item);
    total = assertMinor(total + item.minor);
  }
  return { minor: total, currency };
}

export function sumMinor(values: number[]): number {
  let total = 0;
  for (const v of values) total = assertMinor(total + assertMinor(v));
  return total;
}

/**
 * Divide an integer by a positive integer and round half away from zero.
 * Used for proration and per-unit splits; the rounding rule is part of each calculation's trace.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  assertMinor(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new MoneyError("denominator must be a positive integer");
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const q = Math.floor(abs / denominator);
  const r = abs - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

export function ceilDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new MoneyError("denominator must be positive");
  if (numerator <= 0) return 0;
  return Math.ceil(numerator / denominator);
}

const groupFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const MINUS = "−";

/** `110,000.00 RON`; negative values use a true minus sign. */
export function formatMoney(minor: number, currency: string = "RON", opts: { sign?: boolean; whole?: boolean } = {}): string {
  const abs = Math.abs(minor) / 100;
  const body = opts.whole && minor % 100 === 0 ? wholeFormatter.format(abs) : groupFormatter.format(abs);
  const prefix = minor < 0 ? MINUS : opts.sign && minor > 0 ? "+" : "";
  return `${prefix}${body} ${currency}`;
}

/** Short summary format (`153 RON`) used where precision is unnecessary and the value is whole. */
export function formatShort(minor: number, currency: string = "RON"): string {
  return formatMoney(minor, currency, { whole: true });
}

/** Parse a user-entered major-unit amount in English format, e.g. "1,234.56". Rejects ambiguous locale forms. */
export function parseMajorToMinor(input: string): number {
  const trimmed = input.trim().replace(/\s+/g, "").replace(/RON$/i, "");
  if (!/^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new MoneyError(`Amount "${input}" is not in the expected 1,234.56 format`);
  }
  const negative = trimmed.startsWith("-");
  const digits = trimmed.replace(/[-,]/g, "");
  const [whole, frac = ""] = digits.split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return assertMinor(negative ? -minor : minor);
}
