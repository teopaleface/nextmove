import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cancellationDifficulty, DEFAULT_DIFFICULTY_POLICY, percentile, type CancellationRunObservation } from '../src/merchant-insights/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { NOW } from './fixtures.ts';

const key = (i: number) => `ck-${String(i).padStart(4, '0')}`;
const START = '2026-10-01T10:00:00+03:00';
const after = (seconds: number, from = START) => new Date(Date.parse(from) + seconds * 1000).toISOString();

function runs(merchantId: string, customers: number, o: Partial<CancellationRunObservation> & { seconds?: number } = {}): CancellationRunObservation[] {
  const { seconds = 120, ...rest } = o;
  return Array.from({ length: customers }, (_, i) => ({
    customerKey: key(i),
    merchantId,
    runId: `${merchantId}-run-${i}`,
    channel: 'BROWSER_ADAPTER' as const,
    flowRevision: 1,
    startedAt: START,
    finishedAt: after(seconds),
    outcome: 'CONFIRMED' as const,
    verified: true,
    steps: 3,
    retentionScreens: 0,
    humanContactRequired: false,
    ...rest,
  }));
}

const only = (records: ReturnType<typeof cancellationDifficulty>) => {
  assert.equal(records.length, 1);
  return records[0] as Extract<ReturnType<typeof cancellationDifficulty>[number], { status: 'MEASURED' }>;
};

describe('percentile', () => {
  it('uses nearest rank without interpolation', () => {
    assert.equal(percentile([5, 1, 3], 50), 3);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([7], 90), 7);
    assert.throws(() => percentile([], 50), DomainError);
    assert.throws(() => percentile([1], 0), DomainError);
  });
});

describe('cancellationDifficulty', () => {
  it('suppresses merchants below k distinct customers', () => {
    assert.deepEqual(cancellationDifficulty(runs('fitflow', 19), NOW), [{ merchantId: 'fitflow', status: 'INSUFFICIENT_DATA', flowRevision: 1 }]);
    assert.equal(only(cancellationDifficulty(runs('fitflow', 20), NOW)).status, 'MEASURED');
  });

  it('counts customers, not runs: one customer retrying many times cannot reach k', () => {
    const repeated = Array.from({ length: 40 }, (_, i) => ({ ...runs('fitflow', 1)[0]!, runId: `r${i}` }));
    assert.equal(cancellationDifficulty(repeated, NOW)[0]?.status, 'INSUFFICIENT_DATA');
  });

  it('uses each customer’s latest confirmed run so a heavy user cannot skew the medians', () => {
    const base = runs('fitflow', 20);
    const heavy = Array.from({ length: 50 }, (_, i) => ({ ...base[0]!, runId: `old-${i}`, startedAt: '2026-09-01T10:00:00+03:00', finishedAt: after(900, '2026-09-01T10:00:00+03:00'), steps: 30 }));
    const r = only(cancellationDifficulty([...base, ...heavy], NOW));
    assert.equal(r.medianSteps, 3);
    assert.equal(r.medianSeconds, 120);
  });

  it('measures only our own browser runs, not API or manual ones', () => {
    const r = cancellationDifficulty([...runs('fitflow', 20, { channel: 'PARTNER_API' }), ...runs('gymco', 20, { channel: 'MANUAL' })], NOW);
    assert.deepEqual(r, []);
  });

  it('times and steps come only from verified confirmations; failures lower the completion rate', () => {
    const confirmed = runs('fitflow', 20);
    const failed = runs('fitflow', 5, { outcome: 'FAILED', steps: 40 }).map((r, i) => ({ ...r, customerKey: `fail-${i}` }));
    const unverified = runs('fitflow', 5, { verified: false, steps: 40 }).map((r, i) => ({ ...r, customerKey: `weak-${i}` }));
    const r = only(cancellationDifficulty([...confirmed, ...failed, ...unverified], NOW));
    assert.equal(r.medianSteps, 3);
    assert.equal(r.customers, 20);
    assert.equal(r.completionBp, 6666);
  });

  it('only counts the merchant’s current flow revision', () => {
    const old = runs('fitflow', 30, { flowRevision: 1, retentionScreens: 4 });
    const fresh = runs('fitflow', 5, { flowRevision: 2 });
    assert.deepEqual(cancellationDifficulty([...old, ...fresh], NOW), [{ merchantId: 'fitflow', status: 'INSUFFICIENT_DATA', flowRevision: 2 }]);
  });

  it('grades flows by time, retention screens and demanded human contact', () => {
    assert.equal(only(cancellationDifficulty(runs('a', 20), NOW)).grade, 'EASY');
    assert.equal(only(cancellationDifficulty(runs('a', 20, { steps: 6, retentionScreens: 1 }), NOW)).grade, 'MODERATE');
    assert.equal(only(cancellationDifficulty(runs('a', 20, { retentionScreens: 3 }), NOW)).grade, 'HARD');
    assert.equal(only(cancellationDifficulty(runs('a', 20, { seconds: 600 }), NOW)).grade, 'HARD');
    const phone = runs('a', 20).map((r, i) => ({ ...r, humanContactRequired: i < 10 }));
    const p = only(cancellationDifficulty(phone, NOW));
    assert.deepEqual([p.humanContactBp, p.grade], [5000, 'HARD']);
  });

  it('reports p90 alongside the median', () => {
    const varied = runs('a', 20).map((r, i) => ({ ...r, steps: i + 1 }));
    const r = only(cancellationDifficulty(varied, NOW));
    assert.deepEqual([r.medianSteps, r.p90Steps], [10, 18]);
  });

  it('drops runs outside the window, from the future, inverted or abandoned for hours', () => {
    const r = cancellationDifficulty(
      [
        ...runs('old', 20, { startedAt: '2026-01-01T10:00:00+02:00', finishedAt: '2026-01-01T10:05:00+02:00' }),
        ...runs('future', 20, { startedAt: '2026-10-28T09:50:00+02:00', finishedAt: '2026-10-28T09:55:00+02:00' }),
        ...runs('inverted', 20, { seconds: -5 }),
        ...runs('abandoned', 20, { seconds: DEFAULT_DIFFICULTY_POLICY.maxRunSeconds + 1 }),
      ],
      NOW,
    );
    assert.deepEqual(r, []);
  });

  it('never outputs customer keys and keeps merchants separate and sorted', () => {
    const out = cancellationDifficulty([...runs('zeta', 20), ...runs('alpha', 20, { steps: 9 })], NOW);
    assert.deepEqual(out.map((r) => r.merchantId), ['alpha', 'zeta']);
    assert.ok(!JSON.stringify(out).includes('ck-'));
  });

  it('rejects k below 2 and invalid counts', () => {
    assert.throws(() => cancellationDifficulty([], NOW, { ...DEFAULT_DIFFICULTY_POLICY, minCustomers: 1 }), DomainError);
    assert.throws(() => cancellationDifficulty(runs('a', 1, { steps: -1 }), NOW), DomainError);
    assert.throws(() => cancellationDifficulty(runs('a', 1, { retentionScreens: 1.5 }), NOW), DomainError);
  });
});
