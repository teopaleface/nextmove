import { DomainError, invariant } from './errors.ts';

/** Integer minor units (bani for RON), bounded well inside the safe-integer range. */
export const MAX_ABS_MINOR = 1_000_000_000_000_000;

export type Currency = string;

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export function assertCurrency(currency: string): void {
  invariant(/^[A-Z]{3}$/.test(currency), 'INVALID_CURRENCY', `currency must be an ISO 4217 code, got "${currency}"`);
}

export function assertMinor(amountMinor: number, field = 'amountMinor'): void {
  invariant(Number.isSafeInteger(amountMinor), 'INVALID_AMOUNT', `${field} must be an integer number of minor units, got ${amountMinor}`);
  invariant(Math.abs(amountMinor) <= MAX_ABS_MINOR, 'AMOUNT_OUT_OF_RANGE', `${field} exceeds ${MAX_ABS_MINOR}`);
}

export function assertNonNegativeMinor(amountMinor: number, field = 'amountMinor'): void {
  assertMinor(amountMinor, field);
  invariant(amountMinor >= 0, 'NEGATIVE_AMOUNT', `${field} must not be negative, got ${amountMinor}`);
}

export function money(amountMinor: number, currency: Currency): Money {
  assertMinor(amountMinor);
  assertCurrency(currency);
  return { amountMinor, currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError('CURRENCY_MISMATCH', `cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((total, item) => add(total, item), money(0, currency));
}

export function minMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return a.amountMinor <= b.amountMinor ? a : b;
}

/** Share of an amount in basis points, rounded down so the bank never moves more than the rule allows. */
export function basisPointsOf(amountMinor: number, basisPoints: number): number {
  assertNonNegativeMinor(amountMinor);
  invariant(Number.isInteger(basisPoints) && basisPoints >= 0 && basisPoints <= 10_000, 'INVALID_BASIS_POINTS', `basis points must be 0..10000, got ${basisPoints}`);
  return Number((BigInt(amountMinor) * BigInt(basisPoints)) / 10_000n);
}
