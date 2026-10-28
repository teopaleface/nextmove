import { invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor } from '../shared/money.ts';
import { addDays, assertInstant, daysBetween, isAfter, localDate, toMillis, type Instant, type IsoDate } from '../shared/time.ts';

/**
 * Bank-wide, anonymised facts about merchants, built from the bank's own ledger:
 * how often a merchant keeps billing after a verified cancellation, and price changes
 * seen across many customers before an individual customer's next charge.
 * Inputs carry a pseudonymous customer key; outputs never do, and any group smaller than
 * `minCustomers` distinct customers is suppressed.
 */
export interface PostCancellationObservation {
  /** Pseudonymous, per-analysis key (e.g. a salted hash); never an account or customer ID. */
  readonly customerKey: string;
  readonly merchantId: string;
  readonly cancellationConfirmedAt: Instant;
  /** True only for cancellations the bank read back independently. */
  readonly verified: boolean;
  readonly billedAfterCancellation: boolean;
}

export interface TrackRecordPolicy {
  /** k-anonymity threshold: distinct customers needed before anything about a group is shown. */
  readonly minCustomers: number;
  readonly windowDays: number;
  /** A cancellation is only counted once its next billing date has surely passed. */
  readonly maturityDays: number;
  /** Flag when the Wilson lower bound of the billed-after rate reaches this, in basis points. */
  readonly flagLowerBoundBp: number;
  /** z for the confidence interval; 1.96 ≈ 95%. */
  readonly z: number;
}

export const DEFAULT_TRACK_RECORD_POLICY: TrackRecordPolicy = { minCustomers: 20, windowDays: 180, maturityDays: 35, flagLowerBoundBp: 200, z: 1.96 };

export type TrackRecord =
  | { readonly merchantId: string; readonly status: 'INSUFFICIENT_DATA' }
  | {
      readonly merchantId: string;
      readonly status: 'OK' | 'FLAGGED';
      readonly customers: number;
      readonly billedAfterCustomers: number;
      readonly rateBp: number;
      readonly lowerBoundBp: number;
    };

/** Wilson score interval lower bound, in basis points rounded down. */
export function wilsonLowerBoundBp(successes: number, trials: number, z: number): number {
  invariant(Number.isSafeInteger(trials) && trials > 0, 'INVALID_TRIALS', 'trials must be a positive integer');
  invariant(Number.isSafeInteger(successes) && successes >= 0 && successes <= trials, 'INVALID_SUCCESSES', 'successes must be 0..trials');
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const bound = (centre - margin) / (1 + z2 / trials);
  return Math.max(0, Math.floor(bound * 10_000 + 1e-9));
}

export function merchantTrackRecords(observations: readonly PostCancellationObservation[], now: Instant, policy: TrackRecordPolicy = DEFAULT_TRACK_RECORD_POLICY): TrackRecord[] {
  assertInstant(now, 'now');
  invariant(Number.isSafeInteger(policy.minCustomers) && policy.minCustomers >= 2, 'INVALID_K', 'minCustomers must be at least 2');
  const nowMs = toMillis(now);
  const oldest = nowMs - policy.windowDays * 86_400_000;
  const newest = nowMs - policy.maturityDays * 86_400_000;

  // merchant -> customer -> billed after any of their cancellations
  const byMerchant = new Map<string, Map<string, boolean>>();
  for (const o of observations) {
    assertInstant(o.cancellationConfirmedAt, 'cancellationConfirmedAt');
    if (!o.verified) continue;
    const at = toMillis(o.cancellationConfirmedAt);
    if (at < oldest || at > newest) continue;
    const customers = byMerchant.get(o.merchantId) ?? new Map<string, boolean>();
    customers.set(o.customerKey, (customers.get(o.customerKey) ?? false) || o.billedAfterCancellation);
    byMerchant.set(o.merchantId, customers);
  }

  return [...byMerchant.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([merchantId, customers]): TrackRecord => {
      const n = customers.size;
      if (n < policy.minCustomers) return { merchantId, status: 'INSUFFICIENT_DATA' };
      const billed = [...customers.values()].filter(Boolean).length;
      const lowerBoundBp = wilsonLowerBoundBp(billed, n, policy.z);
      return {
        merchantId,
        status: lowerBoundBp >= policy.flagLowerBoundBp ? 'FLAGGED' : 'OK',
        customers: n,
        billedAfterCustomers: billed,
        rateBp: Math.floor((billed * 10_000) / n),
        lowerBoundBp,
      };
    });
}

export interface ChargeObservation {
  readonly customerKey: string;
  readonly merchantId: string;
  /** Merchant plan or descriptor key, so two plans at one merchant are not mixed up. */
  readonly planKey: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly chargedAt: Instant;
  readonly recurring: boolean;
}

export interface PriceRadarPolicy {
  readonly minCustomers: number;
  /** Only consecutive charges this close count as one plan renewing (drops one-offs and annual noise). */
  readonly maxGapDays: number;
  readonly lookbackDays: number;
}

export const DEFAULT_PRICE_RADAR_POLICY: PriceRadarPolicy = { minCustomers: 20, maxGapDays: 45, lookbackDays: 90 };

export interface PriceChangeCluster {
  readonly merchantId: string;
  readonly planKey: string;
  readonly currency: string;
  readonly oldMinor: number;
  readonly newMinor: number;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly changeBp: number;
  readonly customers: number;
  /** Calendar day only, so the output cannot be joined back to a single charge. */
  readonly firstSeenOn: IsoDate;
}

export function detectPriceChanges(charges: readonly ChargeObservation[], now: Instant, policy: PriceRadarPolicy = DEFAULT_PRICE_RADAR_POLICY): PriceChangeCluster[] {
  assertInstant(now, 'now');
  invariant(Number.isSafeInteger(policy.minCustomers) && policy.minCustomers >= 2, 'INVALID_K', 'minCustomers must be at least 2');
  const since = toMillis(now) - policy.lookbackDays * 86_400_000;

  const series = new Map<string, ChargeObservation[]>();
  for (const c of charges) {
    assertCurrency(c.currency);
    assertNonNegativeMinor(c.amountMinor, 'amountMinor');
    assertInstant(c.chargedAt, 'chargedAt');
    if (!c.recurring || c.amountMinor === 0 || isAfter(c.chargedAt, now)) continue;
    const key = JSON.stringify([c.customerKey, c.merchantId, c.planKey, c.currency]);
    series.set(key, [...(series.get(key) ?? []), c]);
  }

  const clusters = new Map<string, { sample: Omit<PriceChangeCluster, 'customers' | 'firstSeenOn'>; customers: Set<string>; firstSeenOn: IsoDate }>();
  for (const list of series.values()) {
    list.sort((a, b) => toMillis(a.chargedAt) - toMillis(b.chargedAt));
    // Each customer contributes at most once per (old, new) change.
    const seen = new Set<string>();
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as ChargeObservation;
      const curr = list[i] as ChargeObservation;
      if (prev.amountMinor === curr.amountMinor) continue;
      if (toMillis(curr.chargedAt) < since) continue;
      if (daysBetween(localDate(prev.chargedAt), localDate(curr.chargedAt)) > policy.maxGapDays) continue;
      const key = JSON.stringify([curr.merchantId, curr.planKey, curr.currency, prev.amountMinor, curr.amountMinor]);
      if (seen.has(key)) continue;
      seen.add(key);
      const day = localDate(curr.chargedAt);
      const existing = clusters.get(key);
      if (existing === undefined) {
        clusters.set(key, {
          sample: {
            merchantId: curr.merchantId,
            planKey: curr.planKey,
            currency: curr.currency,
            oldMinor: prev.amountMinor,
            newMinor: curr.amountMinor,
            direction: curr.amountMinor > prev.amountMinor ? 'INCREASE' : 'DECREASE',
            changeBp: Math.trunc(((curr.amountMinor - prev.amountMinor) * 10_000) / prev.amountMinor),
          },
          customers: new Set([curr.customerKey]),
          firstSeenOn: day,
        });
      } else {
        existing.customers.add(curr.customerKey);
        if (day < existing.firstSeenOn) existing.firstSeenOn = day;
      }
    }
  }

  return [...clusters.values()]
    .filter((c) => c.customers.size >= policy.minCustomers)
    .map((c) => ({ ...c.sample, customers: c.customers.size, firstSeenOn: c.firstSeenOn }))
    .sort((a, b) => (a.merchantId + a.planKey < b.merchantId + b.planKey ? -1 : a.merchantId + a.planKey > b.merchantId + b.planKey ? 1 : a.oldMinor - b.oldMinor));
}

export interface CustomerSubscriptionView {
  readonly subscriptionId: string;
  readonly merchantId: string;
  readonly planKey: string;
  readonly currency: string;
  readonly currentMinor: number;
  readonly nextChargeAt: Instant;
}

export interface PriceAlert {
  readonly subscriptionId: string;
  readonly merchantId: string;
  readonly currentMinor: number;
  readonly expectedMinor: number;
  readonly increaseMinor: number;
  readonly nextChargeAt: Instant;
  readonly customersSeen: number;
}

/**
 * Warns a customer about an increase other customers already paid, before their own next charge.
 * Only increases from the customer's current price, only while there is still time to act.
 */
export function priceAlertsFor(subscriptions: readonly CustomerSubscriptionView[], clusters: readonly PriceChangeCluster[], now: Instant, leadDays = 14): PriceAlert[] {
  assertInstant(now, 'now');
  const horizon = addDays(localDate(now), leadDays);
  const alerts: PriceAlert[] = [];
  for (const s of subscriptions) {
    assertInstant(s.nextChargeAt, 'nextChargeAt');
    if (!isAfter(s.nextChargeAt, now)) continue;
    if (localDate(s.nextChargeAt) > horizon) continue;
    const match = clusters
      .filter((c) => c.direction === 'INCREASE' && c.merchantId === s.merchantId && c.planKey === s.planKey && c.currency === s.currency && c.oldMinor === s.currentMinor)
      .sort((a, b) => b.customers - a.customers)[0];
    if (match === undefined) continue;
    alerts.push({
      subscriptionId: s.subscriptionId,
      merchantId: s.merchantId,
      currentMinor: s.currentMinor,
      expectedMinor: match.newMinor,
      increaseMinor: match.newMinor - s.currentMinor,
      nextChargeAt: s.nextChargeAt,
      customersSeen: match.customers,
    });
  }
  return alerts;
}

export * from './difficulty.ts';
