import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateExitPlan,
  answerExitQuestion,
  countUses,
  createExitPlan,
  recordStopOutcome,
  revokeExitPlan,
  runExitPlan,
  type ExitPlan,
  type ExitPlanTerms,
  type SubscriptionSnapshot,
  type UsageEvidence,
} from '../src/exit-plan/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { ALEX, grant, MARIA, NOW, receipt } from './fixtures.ts';

/** FitFlow trial signed up on 28 Oct: "stop it unless I train 4 times by 1 Nov"; the trial converts after 3 Nov. */
function terms(overrides: Partial<ExitPlanTerms> = {}): ExitPlanTerms {
  return {
    scope: ALEX,
    subscriptionId: 'sub-fitflow',
    merchantId: 'fitflow',
    termsRevision: 1,
    priceCeilingMinor: 7900,
    currency: 'RON',
    minUses: 4,
    evaluateOn: '2026-11-01',
    cancelDeadline: '2026-11-03T23:59:59+02:00',
    ...overrides,
  };
}

function activePlan(overrides: Partial<ExitPlanTerms> = {}): ExitPlan {
  const draft = createExitPlan(terms(overrides), NOW);
  const result = activateExitPlan(draft, grant(draft.manifestDigest), NOW);
  assert.equal(result.ok, true);
  return (result as { plan: ExitPlan }).plan;
}

function sub(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return { subscriptionId: 'sub-fitflow', state: 'TRIAL', termsRevision: 1, nextChargeMinor: 7900, currency: 'RON', ...overrides };
}

function uses(n: number, overrides: Partial<UsageEvidence> = {}): UsageEvidence {
  return { source: 'MERCHANT_REPORTED', coverage: 'ALL_DEVICES', sharedByCustomer: true, uses: n, periodStart: '2026-10-28', periodEnd: '2026-10-31', ...overrides };
}

const EVAL_TIME = '2026-11-01T08:00:00+02:00';
const run = (plan: ExitPlan, evidence: UsageEvidence[], overrides: { subscription?: SubscriptionSnapshot; now?: string } = {}) =>
  runExitPlan(plan, { subscription: overrides.subscription ?? sub(), evidence, now: overrides.now ?? EVAL_TIME });

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code);

describe('createExitPlan', () => {
  it('creates a draft with a deterministic id bound to every term', () => {
    const a = createExitPlan(terms(), NOW);
    assert.equal(a.status, 'DRAFT');
    assert.equal(a.createdOn, '2026-10-28');
    assert.equal(a.ruleId, createExitPlan(terms(), NOW).ruleId);
    assert.notEqual(a.manifestDigest, createExitPlan(terms({ priceCeilingMinor: 8000 }), NOW).manifestDigest);
    assert.notEqual(a.manifestDigest, createExitPlan(terms({ termsRevision: 2 }), NOW).manifestDigest);
  });

  it('requires evaluation strictly after today and at least the margin before the deadline', () => {
    throwsCode(() => createExitPlan(terms({ evaluateOn: '2026-10-28' }), NOW), 'EVALUATION_NOT_IN_FUTURE');
    throwsCode(() => createExitPlan(terms({ evaluateOn: '2026-11-03' }), NOW), 'EVALUATION_TOO_CLOSE_TO_DEADLINE');
    throwsCode(() => createExitPlan(terms({ evaluateOn: '2026-11-05' }), NOW), 'EVALUATION_TOO_CLOSE_TO_DEADLINE');
    assert.equal(createExitPlan(terms({ evaluateOn: '2026-11-02' }), NOW).status, 'DRAFT');
    throwsCode(() => createExitPlan(terms({ evaluateOn: '2026-11-02' }), NOW, { minMarginDays: 2 }), 'EVALUATION_TOO_CLOSE_TO_DEADLINE');
  });

  it('reads the deadline as a Bucharest calendar day', () => {
    // 3 Nov 22:30 UTC is already 4 Nov in Bucharest, so a 3 Nov evaluation still has a day of margin.
    assert.equal(createExitPlan(terms({ evaluateOn: '2026-11-03', cancelDeadline: '2026-11-03T22:30:00Z' }), NOW).status, 'DRAFT');
  });

  it('rejects malformed terms', () => {
    throwsCode(() => createExitPlan(terms({ minUses: 0 }), NOW), 'INVALID_MIN_USES');
    throwsCode(() => createExitPlan(terms({ minUses: 2.5 }), NOW), 'INVALID_MIN_USES');
    throwsCode(() => createExitPlan(terms({ priceCeilingMinor: -1 }), NOW), 'NEGATIVE_AMOUNT');
    throwsCode(() => createExitPlan(terms({ termsRevision: -1 }), NOW), 'INVALID_TERMS_REVISION');
    throwsCode(() => createExitPlan(terms({ evaluateOn: '2026-11-31' }), NOW), 'INVALID_DATE');
    throwsCode(() => createExitPlan(terms({ currency: 'Ron' }), NOW), 'INVALID_CURRENCY');
  });
});

describe('activation and revocation', () => {
  it('activates only with a grant for this exact plan and customer', () => {
    const draft = createExitPlan(terms(), NOW);
    assert.deepEqual(activateExitPlan(draft, grant('other'), NOW), { ok: false, reason: 'DIGEST_MISMATCH' });
    assert.deepEqual(activateExitPlan(draft, grant(draft.manifestDigest, { ownerId: MARIA.ownerId }), NOW), { ok: false, reason: 'WRONG_OWNER' });
    assert.deepEqual(activateExitPlan(draft, grant(draft.manifestDigest, { revokedAt: NOW }), NOW), { ok: false, reason: 'REVOKED' });
    const ok = activateExitPlan(draft, grant(draft.manifestDigest), NOW);
    assert.equal(ok.ok && ok.plan.status, 'ACTIVE');
    assert.equal(ok.ok && ok.plan.grantId, 'grant-1');
  });

  it('cannot activate twice', () => {
    const plan = activePlan();
    assert.deepEqual(activateExitPlan(plan, grant(plan.manifestDigest), NOW), { ok: false, reason: 'INVALID_STATE' });
  });

  it('a draft never runs; a revoked plan never runs', () => {
    const draft = createExitPlan(terms(), NOW);
    assert.deepEqual(run(draft, []).outcome, { kind: 'INACTIVE', status: 'DRAFT' });
    const revoked = revokeExitPlan(activePlan());
    assert.equal(revoked.status, 'REVOKED');
    assert.deepEqual(run(revoked, []).effects, []);
  });

  it('revoking after the stop was requested does nothing', () => {
    const requested = run(activePlan(), [uses(1)]).next;
    assert.equal(revokeExitPlan(requested).status, 'STOP_REQUESTED');
  });
});

describe('runExitPlan', () => {
  it('waits until the evaluation day', () => {
    const result = run(activePlan(), [uses(0)], { now: '2026-10-31T23:59:00+02:00' });
    assert.deepEqual(result.outcome, { kind: 'TOO_EARLY', evaluateOn: '2026-11-01' });
    assert.equal(result.next.status, 'ACTIVE');
    assert.deepEqual(result.effects, []);
  });

  it('keeps the subscription when usage meets the threshold exactly', () => {
    const result = run(activePlan(), [uses(4)]);
    assert.deepEqual(result.outcome, { kind: 'KEEP', uses: 4, minUses: 4 });
    assert.equal(result.next.status, 'KEPT');
  });

  it('requests a stop with an idempotency key, the plan grant and the merchant deadline', () => {
    const plan = activePlan();
    const result = run(plan, [uses(3)]);
    assert.deepEqual(result.outcome, { kind: 'STOP', uses: 3, minUses: 4 });
    assert.equal(result.next.status, 'STOP_REQUESTED');
    assert.deepEqual(result.effects, [
      {
        type: 'REQUEST_STOP_RENEWAL',
        idempotencyKey: `exit:${plan.ruleId}:1`,
        ruleId: plan.ruleId,
        grantId: 'grant-1',
        manifestDigest: plan.manifestDigest,
        subscriptionId: 'sub-fitflow',
        merchantId: 'fitflow',
        expectedTermsRevision: 1,
        mustCompleteBefore: '2026-11-03T23:59:59+02:00',
      },
    ]);
  });

  it('does not request the stop twice on later ticks', () => {
    const first = run(activePlan(), [uses(0)]);
    const second = run(first.next, [uses(0)], { now: '2026-11-02T08:00:00+02:00' });
    assert.deepEqual(second.outcome, { kind: 'INACTIVE', status: 'STOP_REQUESTED' });
    assert.deepEqual(second.effects, []);
  });

  it('can still evaluate late if the deadline has not passed', () => {
    assert.equal(run(activePlan(), [uses(0)], { now: '2026-11-03T23:00:00+02:00' }).outcome.kind, 'STOP');
  });

  it('reports a missed deadline instead of acting after it', () => {
    const result = run(activePlan(), [uses(0)], { now: '2026-11-03T23:59:59+02:00' });
    assert.deepEqual(result.outcome, { kind: 'MISSED_DEADLINE' });
    assert.equal(result.next.status, 'VOID');
    assert.equal(result.next.closedReason, 'MISSED_DEADLINE');
    assert.ok(result.effects.every((e) => e.type !== 'REQUEST_STOP_RENEWAL'));
  });

  it('voids the mandate when the merchant changed terms or currency, or the price went above the ceiling', () => {
    assert.deepEqual(run(activePlan(), [uses(0)], { subscription: sub({ termsRevision: 2 }) }).outcome, { kind: 'VOID', reason: 'TERMS_CHANGED' });
    assert.deepEqual(run(activePlan(), [uses(0)], { subscription: sub({ nextChargeMinor: 7901 }) }).outcome, { kind: 'VOID', reason: 'PRICE_ABOVE_CEILING' });
    assert.deepEqual(run(activePlan(), [uses(0)], { subscription: sub({ currency: 'EUR' }) }).outcome, { kind: 'VOID', reason: 'CURRENCY_CHANGED' });
    assert.equal(run(activePlan(), [uses(0)], { subscription: sub({ nextChargeMinor: 7900 }) }).outcome.kind, 'STOP');
  });

  it('voids rather than acting before the evaluation day when terms change', () => {
    const result = run(activePlan(), [], { subscription: sub({ termsRevision: 2 }), now: '2026-10-29T10:00:00+02:00' });
    assert.deepEqual(result.outcome, { kind: 'VOID', reason: 'TERMS_CHANGED' });
    assert.deepEqual(result.effects, [{ type: 'NOTIFY_CUSTOMER', ruleId: result.next.ruleId, message: 'VOIDED' }]);
  });

  it('does nothing to a subscription that has already ended', () => {
    assert.deepEqual(run(activePlan(), [], { subscription: sub({ state: 'CANCELLED' }) }).outcome, { kind: 'VOID', reason: 'ALREADY_ENDED' });
    assert.deepEqual(run(activePlan(), [], { subscription: sub({ state: 'RENEWAL_OFF' }) }).outcome, { kind: 'VOID', reason: 'ALREADY_ENDED' });
    assert.deepEqual(run(activePlan(), [], { subscription: sub({ subscriptionId: 'sub-other' }) }).outcome, { kind: 'VOID', reason: 'SUBSCRIPTION_MISMATCH' });
  });

  it('asks the customer when there is no evidence at all, because silence is not proof of non-use', () => {
    const result = run(activePlan(), []);
    assert.deepEqual(result.outcome, { kind: 'ASK', reason: 'NO_EVIDENCE', uses: 0, answerBy: '2026-11-03T23:59:59+02:00' });
    assert.equal(result.next.status, 'ACTIVE');
    assert.equal(result.effects[0]?.type, 'ASK_CUSTOMER');
  });

  it('asks when only this phone reports low use (TV or family use is invisible to it)', () => {
    const phone = uses(1, { source: 'DEVICE_SCREEN_TIME', coverage: 'THIS_DEVICE_ONLY' });
    assert.deepEqual(run(activePlan(), [phone]).outcome, { kind: 'ASK', reason: 'PARTIAL_COVERAGE', uses: 1, answerBy: '2026-11-03T23:59:59+02:00' });
  });

  it('keeps when phone-only use already meets the threshold', () => {
    const phone = uses(5, { source: 'DEVICE_SCREEN_TIME', coverage: 'THIS_DEVICE_ONLY' });
    assert.equal(run(activePlan(), [phone]).outcome.kind, 'KEEP');
  });

  it('ignores evidence the customer did not share', () => {
    assert.deepEqual(run(activePlan(), [uses(10, { sharedByCustomer: false })]).outcome.kind, 'ASK');
  });
});

describe('countUses', () => {
  it('takes the best source rather than adding sources that saw the same sessions', () => {
    const counts = countUses([uses(3), uses(3, { source: 'CUSTOMER_REPORTED' })], '2026-10-28', '2026-11-01');
    assert.deepEqual(counts, { allDevices: 3 });
  });

  it('adds periods from the same source', () => {
    const counts = countUses([uses(2), uses(2, { periodStart: '2026-11-01', periodEnd: '2026-11-01' })], '2026-10-28', '2026-11-01');
    assert.deepEqual(counts, { allDevices: 4 });
  });

  it('excludes periods outside the window and keeps overlapping ones', () => {
    const counts = countUses(
      [uses(9, { periodStart: '2026-10-01', periodEnd: '2026-10-27' }), uses(1, { periodStart: '2026-10-25', periodEnd: '2026-10-28' }), uses(9, { periodStart: '2026-11-02', periodEnd: '2026-11-02' })],
      '2026-10-28',
      '2026-11-01',
    );
    assert.deepEqual(counts, { allDevices: 1 });
  });

  it('reports device-only and all-device counts separately', () => {
    assert.deepEqual(countUses([uses(2), uses(7, { source: 'DEVICE_SCREEN_TIME', coverage: 'THIS_DEVICE_ONLY' })], '2026-10-28', '2026-11-01'), { allDevices: 2, thisDevice: 7 });
  });

  it('a phone count higher than the merchant count still keeps the subscription', () => {
    const evidence = [uses(2), uses(4, { source: 'DEVICE_SCREEN_TIME', coverage: 'THIS_DEVICE_ONLY' })];
    assert.equal(run(activePlan(), evidence).outcome.kind, 'KEEP');
  });

  it('rejects negative or fractional counts and reversed periods', () => {
    throwsCode(() => countUses([uses(-1)], '2026-10-28', '2026-11-01'), 'INVALID_USES');
    throwsCode(() => countUses([uses(1.5)], '2026-10-28', '2026-11-01'), 'INVALID_USES');
    throwsCode(() => countUses([uses(1, { periodStart: '2026-10-31', periodEnd: '2026-10-30' })], '2026-10-28', '2026-11-01'), 'INVALID_PERIOD');
  });
});

describe('answering and outcomes', () => {
  it('stops on a "stop" answer using the original mandate', () => {
    const asked = run(activePlan(), []).next;
    const result = answerExitQuestion(asked, 'STOP', '2026-11-02T10:00:00+02:00');
    assert.equal(result.next.status, 'STOP_REQUESTED');
    assert.equal(result.effects[0]?.type, 'REQUEST_STOP_RENEWAL');
  });

  it('closes the plan on a "keep" answer and refuses answers after the deadline', () => {
    const asked = run(activePlan(), []).next;
    assert.equal(answerExitQuestion(asked, 'KEEP', '2026-11-02T10:00:00+02:00').next.status, 'KEPT');
    assert.deepEqual(answerExitQuestion(asked, 'STOP', '2026-11-04T00:00:00+02:00').outcome, { kind: 'MISSED_DEADLINE' });
    assert.deepEqual(answerExitQuestion(createExitPlan(terms(), NOW), 'STOP', EVAL_TIME).outcome, { kind: 'INACTIVE', status: 'DRAFT' });
  });

  it('marks the plan stopped on a confirmed receipt and ignores pending ones', () => {
    const requested = run(activePlan(), [uses(0)]).next;
    assert.equal(recordStopOutcome(requested, receipt({ state: 'PENDING' })).next.status, 'STOP_REQUESTED');
    const stopped = recordStopOutcome(requested, receipt());
    assert.deepEqual(stopped.outcome, { kind: 'STOPPED', receiptId: 'NF-1047' });
    assert.equal(stopped.next.status, 'STOPPED');
    assert.deepEqual(recordStopOutcome(stopped.next, receipt()).effects, []);
  });

  it('voids and tells the customer when the merchant refuses', () => {
    const requested = run(activePlan(), [uses(0)]).next;
    const refused = recordStopOutcome(requested, receipt({ state: 'REFUSED' }));
    assert.deepEqual(refused.outcome, { kind: 'VOID', reason: 'MERCHANT_REFUSED' });
    assert.equal(refused.next.closedReason, 'MERCHANT_REFUSED');
  });

  it('rejects a receipt for another subscription or customer', () => {
    const requested = run(activePlan(), [uses(0)]).next;
    throwsCode(() => recordStopOutcome(requested, receipt({ subscriptionId: 'sub-x' })), 'RECEIPT_MISMATCH');
    throwsCode(() => recordStopOutcome(requested, receipt({ merchantId: 'other' })), 'RECEIPT_MISMATCH');
    throwsCode(() => recordStopOutcome(requested, receipt({ scope: MARIA })), 'RECEIPT_MISMATCH');
  });

  it('counts only a read-back confirmation of an ending as the stop', () => {
    const requested = run(activePlan(), [uses(0)]).next;
    // A confirmed pause or reactivation is not the stop this plan asked for.
    throwsCode(() => recordStopOutcome(requested, receipt({ operation: 'PAUSE' })), 'RECEIPT_MISMATCH');
    throwsCode(() => recordStopOutcome(requested, receipt({ operation: 'REACTIVATE' })), 'RECEIPT_MISMATCH');
    // A merchant message alone proves nothing: the plan keeps waiting for a read-back.
    const weak = recordStopOutcome(requested, receipt({ verification: 'MERCHANT_MESSAGE_ONLY' }));
    assert.equal(weak.next.status, 'STOP_REQUESTED');
    assert.deepEqual(weak.effects, []);
    assert.equal(recordStopOutcome(requested, receipt({ operation: 'CANCEL_IMMEDIATELY' })).next.status, 'STOPPED');
  });
});
