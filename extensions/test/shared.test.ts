import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  addDays,
  addMonthsClamped,
  assertDate,
  basisPointsOf,
  canonicalJson,
  checkGrant,
  daysBetween,
  digestOf,
  DomainError,
  endingInForce,
  localDate,
  MAX_ABS_MINOR,
  money,
  signPayload,
  subtract,
  sum,
  verifySignature,
} from '../src/shared/index.ts';
import { ALEX, ALEX_BUSINESS, grant, MARIA, NOW, receipt } from './fixtures.ts';

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);

describe('money', () => {
  it('accepts integer minor units and adds same-currency amounts', () => {
    assert.deepEqual(add(money(7900, 'RON'), money(4900, 'RON')), { amountMinor: 12800, currency: 'RON' });
    assert.deepEqual(subtract(money(24200, 'RON'), money(7900, 'RON')), { amountMinor: 16300, currency: 'RON' });
  });

  it('sums an empty list to zero in the requested currency', () => {
    assert.deepEqual(sum([], 'RON'), { amountMinor: 0, currency: 'RON' });
  });

  it('rejects fractional, non-finite and out-of-range amounts', () => {
    throwsCode(() => money(79.5, 'RON'), 'INVALID_AMOUNT');
    throwsCode(() => money(Number.NaN, 'RON'), 'INVALID_AMOUNT');
    throwsCode(() => money(Number.POSITIVE_INFINITY, 'RON'), 'INVALID_AMOUNT');
    throwsCode(() => money(MAX_ABS_MINOR + 1, 'RON'), 'AMOUNT_OUT_OF_RANGE');
  });

  it('rejects malformed currencies and mixing currencies', () => {
    throwsCode(() => money(1, 'ron'), 'INVALID_CURRENCY');
    throwsCode(() => money(1, 'LEI1'), 'INVALID_CURRENCY');
    throwsCode(() => add(money(1, 'RON'), money(1, 'EUR')), 'CURRENCY_MISMATCH');
  });

  it('takes basis points rounding down, exactly for large amounts', () => {
    assert.equal(basisPointsOf(7900, 5000), 3950);
    assert.equal(basisPointsOf(999, 3333), 332);
    assert.equal(basisPointsOf(1, 9999), 0);
    assert.equal(basisPointsOf(MAX_ABS_MINOR, 10_000), MAX_ABS_MINOR);
    throwsCode(() => basisPointsOf(100, 10_001), 'INVALID_BASIS_POINTS');
    throwsCode(() => basisPointsOf(-1, 100), 'NEGATIVE_AMOUNT');
  });
});

describe('time', () => {
  it('validates calendar dates including leap days', () => {
    assertDate('2028-02-29');
    throwsCode(() => assertDate('2026-02-29'), 'INVALID_DATE');
    throwsCode(() => assertDate('2026-13-01'), 'INVALID_DATE');
    throwsCode(() => assertDate('2026-1-01'), 'INVALID_DATE');
  });

  it('clamps month arithmetic to month end and keeps the anchor day', () => {
    assert.equal(addMonthsClamped('2027-01-31', 1), '2027-02-28');
    assert.equal(addMonthsClamped('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonthsClamped('2027-02-28', 1, 31), '2027-03-31');
    assert.equal(addMonthsClamped('2026-12-15', 1), '2027-01-15');
    assert.equal(addMonthsClamped('2027-01-15', -1), '2026-12-15');
    assert.equal(addMonthsClamped('2028-02-29', 12), '2029-02-28');
    assert.equal(addMonthsClamped('2029-02-28', 36, 29), '2032-02-29');
  });

  it('counts days across DST changes without drift', () => {
    assert.equal(addDays('2026-10-24', 2), '2026-10-26');
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(daysBetween('2026-11-03', '2026-10-28'), -6);
  });

  it('derives the Bucharest calendar day from an instant', () => {
    assert.equal(localDate('2026-10-31T22:30:00Z'), '2026-11-01');
    assert.equal(localDate('2026-07-31T20:59:00Z'), '2026-07-31');
    assert.equal(localDate('2026-07-31T21:00:00Z'), '2026-08-01');
  });

  it('rejects instants without an offset', () => {
    throwsCode(() => localDate('2026-10-28T09:45:00'), 'INVALID_INSTANT');
  });
});

describe('digest and signatures', () => {
  it('is independent of key order and nesting order of keys', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), '{"a":{"c":null,"d":[1,2]},"b":1}');
    assert.equal(digestOf({ x: 1, y: 2 }), digestOf({ y: 2, x: 1 }));
    assert.notEqual(digestOf({ x: [1, 2] }), digestOf({ x: [2, 1] }));
  });

  it('refuses values JSON would drop or distort', () => {
    throwsCode(() => canonicalJson({ a: undefined }), 'NON_CANONICAL_VALUE');
    throwsCode(() => canonicalJson({ a: Number.NaN }), 'NON_CANONICAL_VALUE');
    throwsCode(() => canonicalJson({ a: new Date(0) }), 'NON_CANONICAL_VALUE');
    throwsCode(() => canonicalJson({ a: 1n }), 'NON_CANONICAL_VALUE');
    assert.equal(canonicalJson(-0), '0');
  });

  it('verifies HMAC signatures and rejects tampering or malformed signatures', () => {
    const payload = { offerId: 'o1', priceMinor: 3900 };
    const signature = signPayload(payload, 'test-secret');
    assert.equal(verifySignature(payload, signature, 'test-secret'), true);
    assert.equal(verifySignature({ ...payload, priceMinor: 3800 }, signature, 'test-secret'), false);
    assert.equal(verifySignature(payload, signature, 'other-secret'), false);
    assert.equal(verifySignature(payload, 'zz', 'test-secret'), false);
    assert.equal(verifySignature(payload, signature.toUpperCase(), 'test-secret'), false);
  });
});

describe('approval grants', () => {
  const expected = { scope: ALEX, manifestDigest: 'd1' };

  it('accepts a grant for the exact owner, context and digest inside its validity', () => {
    assert.deepEqual(checkGrant(grant('d1'), expected, NOW), { ok: true });
  });

  it('rejects each mismatch with its own reason', () => {
    assert.deepEqual(checkGrant(grant('d1', { ownerId: MARIA.ownerId }), expected, NOW), { ok: false, reason: 'WRONG_OWNER' });
    assert.deepEqual(checkGrant(grant('d1', { contextId: ALEX_BUSINESS.contextId }), expected, NOW), { ok: false, reason: 'WRONG_CONTEXT' });
    assert.deepEqual(checkGrant(grant('d2'), expected, NOW), { ok: false, reason: 'DIGEST_MISMATCH' });
    assert.deepEqual(checkGrant(grant('d1', { revokedAt: '2026-10-28T09:44:00+02:00' }), expected, NOW), { ok: false, reason: 'REVOKED' });
    assert.deepEqual(checkGrant(grant('d1'), expected, '2026-10-28T09:39:59+02:00'), { ok: false, reason: 'NOT_YET_VALID' });
  });

  it('treats expiry as exclusive and future revocation as not yet revoked', () => {
    assert.deepEqual(checkGrant(grant('d1'), expected, '2026-10-28T09:55:00+02:00'), { ok: false, reason: 'EXPIRED' });
    assert.deepEqual(checkGrant(grant('d1', { revokedAt: '2026-10-28T09:50:00+02:00' }), expected, NOW), { ok: true });
    assert.deepEqual(checkGrant(grant('d1', { revokedAt: NOW }), expected, NOW), { ok: false, reason: 'REVOKED' });
  });
});

describe('endingInForce', () => {
  const at = '2026-11-10T00:00:00+02:00';

  it('finds the confirmed ending for the subscription', () => {
    assert.equal(endingInForce([receipt()], ALEX, 'sub-fitflow', at)?.receiptId, 'NF-1047');
  });

  it('ignores other customers, other contexts, pending and refused receipts', () => {
    assert.equal(endingInForce([receipt({ scope: MARIA })], ALEX, 'sub-fitflow', at), undefined);
    assert.equal(endingInForce([receipt({ scope: ALEX_BUSINESS })], ALEX, 'sub-fitflow', at), undefined);
    assert.equal(endingInForce([receipt({ state: 'PENDING' })], ALEX, 'sub-fitflow', at), undefined);
    assert.equal(endingInForce([receipt({ state: 'REFUSED' })], ALEX, 'sub-fitflow', at), undefined);
  });

  it('ignores receipts confirmed after the moment in question', () => {
    assert.equal(endingInForce([receipt()], ALEX, 'sub-fitflow', '2026-10-28T09:40:59+02:00'), undefined);
  });

  it('is superseded by a later reactivation and restored by a later cancellation', () => {
    const reactivated = receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-11-01T10:00:00+02:00' });
    assert.equal(endingInForce([reactivated, receipt()], ALEX, 'sub-fitflow', at), undefined);
    const cancelledAgain = receipt({ receiptId: 'R3', confirmedAt: '2026-11-05T10:00:00+02:00' });
    assert.equal(endingInForce([cancelledAgain, reactivated, receipt()], ALEX, 'sub-fitflow', at)?.receiptId, 'R3');
  });

  it('does not treat a pause as an ending', () => {
    assert.equal(endingInForce([receipt({ operation: 'PAUSE' })], ALEX, 'sub-fitflow', at), undefined);
  });
});
