import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPriceChanges,
  merchantTrackRecords,
  priceAlertsFor,
  wilsonLowerBoundBp,
  type ChargeObservation,
  type CustomerSubscriptionView,
  type PostCancellationObservation,
} from '../src/merchant-insights/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { NOW } from './fixtures.ts';

/** Synthetic pseudonymous keys; real deployments would use a salted per-analysis hash. */
const key = (i: number) => `ck-${String(i).padStart(4, '0')}`;

function cancellations(merchantId: string, customers: number, billed: number, overrides: Partial<PostCancellationObservation> = {}): PostCancellationObservation[] {
  return Array.from({ length: customers }, (_, i) => ({
    customerKey: key(i),
    merchantId,
    cancellationConfirmedAt: '2026-08-01T10:00:00+03:00',
    verified: true,
    billedAfterCancellation: i < billed,
    ...overrides,
  }));
}

describe('wilsonLowerBoundBp', () => {
  it('matches reference values computed independently', () => {
    assert.equal(wilsonLowerBoundBp(0, 20, 1.96), 0);
    assert.equal(wilsonLowerBoundBp(1, 20, 1.96), 88);
    assert.equal(wilsonLowerBoundBp(3, 20, 1.96), 523);
    assert.equal(wilsonLowerBoundBp(5, 40, 1.96), 545);
    assert.equal(wilsonLowerBoundBp(20, 20, 1.96), 8388);
    assert.equal(wilsonLowerBoundBp(10, 100, 1.96), 552);
  });

  it('rejects impossible counts', () => {
    assert.throws(() => wilsonLowerBoundBp(1, 0, 1.96), (e: unknown) => e instanceof DomainError && e.code === 'INVALID_TRIALS');
    assert.throws(() => wilsonLowerBoundBp(3, 2, 1.96), (e: unknown) => e instanceof DomainError && e.code === 'INVALID_SUCCESSES');
    assert.throws(() => wilsonLowerBoundBp(-1, 2, 1.96), DomainError);
  });
});

describe('merchantTrackRecords', () => {
  it('flags a merchant whose billed-after rate is confidently above the threshold', () => {
    const [record] = merchantTrackRecords(cancellations('stickygym', 20, 3), NOW);
    assert.deepEqual(record, { merchantId: 'stickygym', status: 'FLAGGED', customers: 20, billedAfterCustomers: 3, rateBp: 1500, lowerBoundBp: 523 });
  });

  it('does not flag on one unlucky customer', () => {
    assert.equal(merchantTrackRecords(cancellations('goodstream', 20, 1), NOW)[0]?.status, 'OK');
  });

  it('flags at the exact threshold', () => {
    assert.equal(merchantTrackRecords(cancellations('m', 25, 2), NOW, { minCustomers: 20, windowDays: 180, maturityDays: 35, flagLowerBoundBp: 222, z: 1.96 })[0]?.status, 'FLAGGED');
    assert.equal(merchantTrackRecords(cancellations('m', 25, 2), NOW, { minCustomers: 20, windowDays: 180, maturityDays: 35, flagLowerBoundBp: 223, z: 1.96 })[0]?.status, 'OK');
  });

  it('suppresses every number for groups below k distinct customers', () => {
    const [record] = merchantTrackRecords(cancellations('tinyshop', 19, 19), NOW);
    assert.deepEqual(record, { merchantId: 'tinyshop', status: 'INSUFFICIENT_DATA' });
  });

  it('counts a customer once even with several cancellations, billed if any was', () => {
    const repeat: PostCancellationObservation[] = [
      ...cancellations('stickygym', 20, 0),
      { customerKey: key(0), merchantId: 'stickygym', cancellationConfirmedAt: '2026-07-01T10:00:00+03:00', verified: true, billedAfterCancellation: true },
      { customerKey: key(0), merchantId: 'stickygym', cancellationConfirmedAt: '2026-07-15T10:00:00+03:00', verified: true, billedAfterCancellation: true },
    ];
    const [record] = merchantTrackRecords(repeat, NOW);
    assert.equal(record?.status !== 'INSUFFICIENT_DATA' && record?.customers, 20);
    assert.equal(record?.status !== 'INSUFFICIENT_DATA' && record?.billedAfterCustomers, 1);
  });

  it('one customer cancelling many times cannot reach k alone', () => {
    const spam = Array.from({ length: 50 }, () => ({ customerKey: key(1), merchantId: 'm', cancellationConfirmedAt: '2026-08-01T10:00:00+03:00', verified: true, billedAfterCancellation: true }));
    assert.deepEqual(merchantTrackRecords(spam, NOW), [{ merchantId: 'm', status: 'INSUFFICIENT_DATA' }]);
  });

  it('ignores unverified cancellations', () => {
    const mixed = [...cancellations('m', 19, 0), { customerKey: 'ck-x', merchantId: 'm', cancellationConfirmedAt: '2026-08-01T10:00:00+03:00', verified: false, billedAfterCancellation: true }];
    assert.deepEqual(merchantTrackRecords(mixed, NOW), [{ merchantId: 'm', status: 'INSUFFICIENT_DATA' }]);
  });

  it('waits for cancellations to mature and drops ones outside the window', () => {
    assert.deepEqual(merchantTrackRecords(cancellations('m', 20, 5, { cancellationConfirmedAt: '2026-10-01T10:00:00+03:00' }), NOW), []);
    assert.deepEqual(merchantTrackRecords(cancellations('m', 20, 5, { cancellationConfirmedAt: '2026-04-01T10:00:00+03:00' }), NOW), []);
    assert.equal(merchantTrackRecords(cancellations('m', 20, 5, { cancellationConfirmedAt: '2026-09-23T09:45:00+03:00' }), NOW).length, 1);
  });

  it('never outputs customer keys', () => {
    const output = JSON.stringify(merchantTrackRecords([...cancellations('a', 25, 3), ...cancellations('b', 5, 5)], NOW));
    assert.ok(!output.includes('ck-'));
  });

  it('returns merchants in a stable order and refuses k below 2', () => {
    const records = merchantTrackRecords([...cancellations('zeta', 20, 0), ...cancellations('alpha', 20, 0)], NOW);
    assert.deepEqual(records.map((r) => r.merchantId), ['alpha', 'zeta']);
    assert.throws(() => merchantTrackRecords([], NOW, { minCustomers: 1, windowDays: 1, maturityDays: 0, flagLowerBoundBp: 1, z: 1.96 }), DomainError);
  });
});

function renewals(customers: number, overrides: Partial<ChargeObservation> = {}, prices: [number, number] = [4900, 5900], dates: [string, string] = ['2026-09-15T10:00:00+03:00', '2026-10-15T10:00:00+03:00']): ChargeObservation[] {
  return Array.from({ length: customers }, (_, i) => [
    { customerKey: key(i), merchantId: 'streamly', planKey: 'standard', currency: 'RON', amountMinor: prices[0], chargedAt: dates[0], recurring: true, ...overrides },
    { customerKey: key(i), merchantId: 'streamly', planKey: 'standard', currency: 'RON', amountMinor: prices[1], chargedAt: dates[1], recurring: true, ...overrides },
  ]).flat();
}

describe('detectPriceChanges', () => {
  it('finds a price increase seen by at least k customers', () => {
    assert.deepEqual(detectPriceChanges(renewals(20), NOW), [
      { merchantId: 'streamly', planKey: 'standard', currency: 'RON', oldMinor: 4900, newMinor: 5900, direction: 'INCREASE', changeBp: 2040, customers: 20, firstSeenOn: '2026-10-15' },
    ]);
  });

  it('suppresses changes seen by fewer than k customers', () => {
    assert.deepEqual(detectPriceChanges(renewals(19), NOW), []);
  });

  it('reports decreases with a negative change', () => {
    const [cluster] = detectPriceChanges(renewals(20, {}, [5900, 4900]), NOW);
    assert.equal(cluster?.direction, 'DECREASE');
    assert.equal(cluster?.changeBp, -1694);
  });

  it('keeps plans and currencies apart', () => {
    const mixed = [...renewals(10), ...renewals(10, { planKey: 'premium' })];
    assert.deepEqual(detectPriceChanges(mixed, NOW), []);
    const currencies = [...renewals(10), ...renewals(10, { currency: 'EUR' }).map((c) => ({ ...c, customerKey: `${c.customerKey}-eu` }))];
    assert.deepEqual(detectPriceChanges(currencies, NOW), []);
  });

  it('ignores one-off charges, refunds-as-zero and gaps too long to be a renewal', () => {
    assert.deepEqual(detectPriceChanges(renewals(20, { recurring: false }), NOW), []);
    assert.deepEqual(detectPriceChanges(renewals(20, {}, [0, 5900]), NOW), []);
    assert.deepEqual(detectPriceChanges(renewals(20, {}, [4900, 5900], ['2026-07-15T10:00:00+03:00', '2026-10-15T10:00:00+03:00']), NOW), []);
  });

  it('ignores changes older than the lookback window and charges dated in the future', () => {
    assert.deepEqual(detectPriceChanges(renewals(20, {}, [4900, 5900], ['2026-06-15T10:00:00+03:00', '2026-07-15T10:00:00+03:00']), NOW), []);
    assert.deepEqual(detectPriceChanges(renewals(20, {}, [4900, 5900], ['2026-10-15T10:00:00+03:00', '2026-11-15T10:00:00+02:00']), NOW), []);
  });

  it('handles unsorted input and counts each customer once per change', () => {
    const shuffled = renewals(20).reverse();
    const doubled = [...shuffled, ...renewals(1).map((c) => ({ ...c, chargedAt: c.amountMinor === 4900 ? '2026-08-15T10:00:00+03:00' : '2026-09-14T10:00:00+03:00' }))];
    assert.equal(detectPriceChanges(doubled, NOW)[0]?.customers, 20);
  });

  it('never outputs customer keys and reports only the day', () => {
    const output = JSON.stringify(detectPriceChanges(renewals(25), NOW));
    assert.ok(!output.includes('ck-'));
    assert.ok(!output.includes('T10:00'));
  });

  it('rejects malformed charges', () => {
    assert.throws(() => detectPriceChanges(renewals(1, { amountMinor: -5 }), NOW), DomainError);
    assert.throws(() => detectPriceChanges(renewals(1, { currency: 'ron' }), NOW), DomainError);
  });
});

describe('priceAlertsFor', () => {
  const clusters = detectPriceChanges(renewals(20), NOW);
  const mine = (overrides: Partial<CustomerSubscriptionView> = {}): CustomerSubscriptionView => ({
    subscriptionId: 'sub-streamly',
    merchantId: 'streamly',
    planKey: 'standard',
    currency: 'RON',
    currentMinor: 4900,
    nextChargeAt: '2026-11-05T12:00:00+02:00',
    ...overrides,
  });

  it('warns before the customer’s own next charge', () => {
    assert.deepEqual(priceAlertsFor([mine()], clusters, NOW), [
      { subscriptionId: 'sub-streamly', merchantId: 'streamly', currentMinor: 4900, expectedMinor: 5900, increaseMinor: 1000, nextChargeAt: '2026-11-05T12:00:00+02:00', customersSeen: 20 },
    ]);
  });

  it('stays quiet when the customer already pays the new price or another plan', () => {
    assert.deepEqual(priceAlertsFor([mine({ currentMinor: 5900 })], clusters, NOW), []);
    assert.deepEqual(priceAlertsFor([mine({ planKey: 'premium' })], clusters, NOW), []);
    assert.deepEqual(priceAlertsFor([mine({ currency: 'EUR' })], clusters, NOW), []);
  });

  it('only alerts inside the lead window and before the charge', () => {
    assert.deepEqual(priceAlertsFor([mine({ nextChargeAt: '2026-11-15T12:00:00+02:00' })], clusters, NOW), []);
    assert.equal(priceAlertsFor([mine({ nextChargeAt: '2026-11-15T12:00:00+02:00' })], clusters, NOW, 20).length, 1);
    assert.deepEqual(priceAlertsFor([mine({ nextChargeAt: NOW })], clusters, NOW), []);
  });

  it('does not alert on decreases', () => {
    const down = detectPriceChanges(renewals(20, {}, [5900, 4900]), NOW);
    assert.deepEqual(priceAlertsFor([mine({ currentMinor: 5900 })], down, NOW), []);
  });
});
