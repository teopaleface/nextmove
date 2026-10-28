import { invariant } from '../shared/errors.ts';
import { assertInstant, toMillis, type Instant } from '../shared/time.ts';

/**
 * How hard a merchant makes cancelling, measured from the bank's own browser-adapter runs
 * rather than from surveys or reviews: pages walked, retention screens shown, time taken and
 * how often a human contact was demanded. Same k-anonymity rule as the track record.
 *
 * Partner-API cancellations are excluded because they bypass the merchant's flow. When the
 * merchant changes its flow (a new adapter flow revision), older runs stop counting.
 */
export interface CancellationRunObservation {
  /** Pseudonymous, per-analysis key; never an account or customer ID. */
  readonly customerKey: string;
  readonly merchantId: string;
  readonly runId: string;
  readonly channel: 'BROWSER_ADAPTER' | 'PARTNER_API' | 'MANUAL';
  readonly flowRevision: number;
  readonly startedAt: Instant;
  readonly finishedAt: Instant;
  readonly outcome: 'CONFIRMED' | 'FAILED' | 'NEEDS_CUSTOMER';
  /** A confirmed run counts only when the ending was read back independently. */
  readonly verified: boolean;
  readonly steps: number;
  readonly retentionScreens: number;
  /** The flow demanded a phone call, chat or letter. */
  readonly humanContactRequired: boolean;
}

export interface DifficultyPolicy {
  readonly minCustomers: number;
  readonly windowDays: number;
  /** Runs longer than this are treated as abandoned sessions, not as the flow's length. */
  readonly maxRunSeconds: number;
  readonly hard: { readonly medianSeconds: number; readonly medianRetentionScreens: number; readonly humanContactBp: number };
  readonly easy: { readonly medianSteps: number; readonly medianRetentionScreens: number; readonly humanContactBp: number };
}

export const DEFAULT_DIFFICULTY_POLICY: DifficultyPolicy = {
  minCustomers: 20,
  windowDays: 180,
  maxRunSeconds: 3_600,
  hard: { medianSeconds: 600, medianRetentionScreens: 3, humanContactBp: 5_000 },
  easy: { medianSteps: 3, medianRetentionScreens: 0, humanContactBp: 1_000 },
};

export type DifficultyRecord =
  | { readonly merchantId: string; readonly status: 'INSUFFICIENT_DATA'; readonly flowRevision: number }
  | {
      readonly merchantId: string;
      readonly status: 'MEASURED';
      readonly flowRevision: number;
      readonly customers: number;
      readonly grade: 'EASY' | 'MODERATE' | 'HARD';
      readonly medianSteps: number;
      readonly p90Steps: number;
      readonly medianRetentionScreens: number;
      readonly medianSeconds: number;
      readonly humanContactBp: number;
      /** Customers whose cancellation we confirmed, out of all customers we attempted for. */
      readonly completionBp: number;
    };

/** Nearest-rank percentile over integers; deterministic and never interpolated. */
export function percentile(values: readonly number[], pct: number): number {
  invariant(values.length > 0, 'EMPTY', 'percentile of no values');
  invariant(pct > 0 && pct <= 100, 'INVALID_PERCENTILE', 'pct must be in (0, 100]');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((pct / 100) * sorted.length) - 1] as number;
}

const bp = (part: number, whole: number): number => Math.floor((part * 10_000) / whole);

export function cancellationDifficulty(runs: readonly CancellationRunObservation[], now: Instant, policy: DifficultyPolicy = DEFAULT_DIFFICULTY_POLICY): DifficultyRecord[] {
  assertInstant(now, 'now');
  invariant(Number.isSafeInteger(policy.minCustomers) && policy.minCustomers >= 2, 'INVALID_K', 'minCustomers must be at least 2');
  const nowMs = toMillis(now);
  const oldest = nowMs - policy.windowDays * 86_400_000;

  const usable = runs.filter((r) => {
    assertInstant(r.startedAt, 'startedAt');
    assertInstant(r.finishedAt, 'finishedAt');
    invariant(Number.isSafeInteger(r.steps) && r.steps >= 0 && Number.isSafeInteger(r.retentionScreens) && r.retentionScreens >= 0, 'INVALID_COUNT', `run ${r.runId} has invalid counts`);
    const start = toMillis(r.startedAt);
    const seconds = (toMillis(r.finishedAt) - start) / 1000;
    return r.channel === 'BROWSER_ADAPTER' && start >= oldest && toMillis(r.finishedAt) <= nowMs && seconds >= 0 && seconds <= policy.maxRunSeconds;
  });

  const byMerchant = new Map<string, CancellationRunObservation[]>();
  for (const r of usable) byMerchant.set(r.merchantId, [...(byMerchant.get(r.merchantId) ?? []), r]);

  return [...byMerchant.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([merchantId, all]): DifficultyRecord => {
      const flowRevision = Math.max(...all.map((r) => r.flowRevision));
      const current = all.filter((r) => r.flowRevision === flowRevision);
      const attempted = new Set(current.map((r) => r.customerKey));
      // One run per customer (their latest verified confirmation), so a heavy user cannot skew the medians.
      const latest = new Map<string, CancellationRunObservation>();
      for (const r of current) {
        if (r.outcome !== 'CONFIRMED' || !r.verified) continue;
        const prev = latest.get(r.customerKey);
        if (prev === undefined || toMillis(r.startedAt) > toMillis(prev.startedAt) || (r.startedAt === prev.startedAt && r.runId > prev.runId)) latest.set(r.customerKey, r);
      }
      const measured = [...latest.values()];
      if (measured.length < policy.minCustomers) return { merchantId, status: 'INSUFFICIENT_DATA', flowRevision };

      const steps = measured.map((r) => r.steps);
      const screens = measured.map((r) => r.retentionScreens);
      const seconds = measured.map((r) => Math.round((toMillis(r.finishedAt) - toMillis(r.startedAt)) / 1000));
      const humanContactBp = bp(measured.filter((r) => r.humanContactRequired).length, measured.length);
      const medianSteps = percentile(steps, 50);
      const medianRetentionScreens = percentile(screens, 50);
      const medianSeconds = percentile(seconds, 50);
      const grade =
        medianSeconds >= policy.hard.medianSeconds || medianRetentionScreens >= policy.hard.medianRetentionScreens || humanContactBp >= policy.hard.humanContactBp ? 'HARD'
        : medianSteps <= policy.easy.medianSteps && medianRetentionScreens <= policy.easy.medianRetentionScreens && humanContactBp < policy.easy.humanContactBp ? 'EASY'
        : 'MODERATE';
      return {
        merchantId,
        status: 'MEASURED',
        flowRevision,
        customers: measured.length,
        grade,
        medianSteps,
        p90Steps: percentile(steps, 90),
        medianRetentionScreens,
        medianSeconds,
        humanContactBp,
        completionBp: bp(measured.length, attempted.size),
      };
    });
}
