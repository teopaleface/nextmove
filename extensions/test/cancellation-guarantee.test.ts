import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveDispute,
  assessPostCancellationCharge,
  expireIfLate,
  markSubmitted,
  openDispute,
  prepareDisputePacket,
  recordBankCredit,
  recordMerchantRefund,
  recordNetworkDecision,
  type AssessmentInput,
  type CardTransaction,
  type DisputeCase,
  type MerchantCredit,
  type Transition,
} from '../src/cancellation-guarantee/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { ALEX, ALEX_BUSINESS, grant, MARIA, receipt } from './fixtures.ts';

/** FitFlow trial from ui-fixtures: cancelled 28 Oct, access until 3 Nov, the 79 RON charge arrives anyway on 4 Nov. */
function charge(overrides: Partial<CardTransaction> = {}): CardTransaction {
  return {
    txId: 'tx-fitflow-1104',
    scope: ALEX,
    cardId: 'card-daily',
    merchantId: 'fitflow',
    subscriptionId: 'sub-fitflow',
    amountMinor: 7900,
    currency: 'RON',
    status: 'POSTED',
    authorizedAt: '2026-11-04T06:00:00+02:00',
    postedAt: '2026-11-05T06:00:00+02:00',
    servicePeriodStart: '2026-11-04T00:00:00+02:00',
    recurring: true,
    ...overrides,
  };
}

const ASSESS_NOW = '2026-11-05T08:00:00+02:00';

function assess(overrides: Partial<AssessmentInput> = {}) {
  return assessPostCancellationCharge({
    tx: charge(),
    receipts: [receipt()],
    credits: [],
    disputedTxIds: new Set(),
    subscriptionsAtMerchant: ['sub-fitflow'],
    now: ASSESS_NOW,
    ...overrides,
  });
}

function credit(overrides: Partial<MerchantCredit> = {}): MerchantCredit {
  return { creditId: 'cr-1', scope: ALEX, refundsTxId: 'tx-fitflow-1104', amountMinor: 2000, currency: 'RON', postedAt: '2026-11-05T07:00:00+02:00', ...overrides };
}

describe('assessPostCancellationCharge', () => {
  it('flags a recurring charge after a verified cancellation as eligible with the full amount', () => {
    const result = assess();
    assert.equal(result.kind, 'ELIGIBLE');
    if (result.kind !== 'ELIGIBLE') return;
    assert.equal(result.disputableMinor, 7900);
    assert.equal(result.receiptId, 'NF-1047');
    assert.equal(result.deadline, '2027-03-05');
    assert.equal(result.reasonCode, 'CANCELLED_RECURRING');
  });

  it('ignores reversed and zero or negative charges', () => {
    assert.deepEqual(assess({ tx: charge({ status: 'REVERSED' }) }), { kind: 'NOT_APPLICABLE', reason: 'REVERSED' });
    assert.deepEqual(assess({ tx: charge({ amountMinor: 0 }) }), { kind: 'NOT_APPLICABLE', reason: 'ZERO_AMOUNT' });
    assert.deepEqual(assess({ tx: charge({ amountMinor: -7900 }) }), { kind: 'NOT_APPLICABLE', reason: 'ZERO_AMOUNT' });
  });

  it('is idempotent: a charge already under dispute is not raised again', () => {
    assert.deepEqual(assess({ disputedTxIds: new Set(['tx-fitflow-1104']) }), { kind: 'ALREADY_HANDLED', reason: 'ALREADY_DISPUTED' });
  });

  it('needs a confirmed cancellation for this customer and context', () => {
    assert.deepEqual(assess({ receipts: [] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
    assert.deepEqual(assess({ receipts: [receipt({ scope: MARIA })] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
    assert.deepEqual(assess({ receipts: [receipt({ scope: ALEX_BUSINESS })] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
    assert.deepEqual(assess({ receipts: [receipt({ state: 'PENDING' })] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
    assert.deepEqual(assess({ receipts: [receipt({ state: 'REFUSED' })] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
  });

  it('treats a reactivation before the charge as consent to be billed', () => {
    const reactivated = receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-11-02T12:00:00+02:00' });
    assert.deepEqual(assess({ receipts: [receipt(), reactivated] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
  });

  it('still flags the charge when the reactivation came after it', () => {
    const reactivatedLater = receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-11-04T12:00:00+02:00' });
    assert.equal(assess({ receipts: [receipt(), reactivatedLater] }).kind, 'ELIGIBLE');
  });

  it('does not match a cancellation at another merchant', () => {
    assert.deepEqual(assess({ receipts: [receipt({ merchantId: 'streamly' })] }), { kind: 'NOT_APPLICABLE', reason: 'MERCHANT_MISMATCH' });
  });

  it('does not dispute a charge authorised before or at the moment of confirmation', () => {
    const before = charge({ authorizedAt: '2026-10-28T09:30:00+02:00', servicePeriodStart: undefined });
    assert.deepEqual(assess({ tx: before }), { kind: 'NOT_APPLICABLE', reason: 'AUTHORIZED_BEFORE_CANCELLATION' });
    const atConfirmation = charge({ authorizedAt: '2026-10-28T09:41:00+02:00', servicePeriodStart: undefined });
    assert.deepEqual(assess({ tx: atConfirmation }), { kind: 'NOT_APPLICABLE', reason: 'AUTHORIZED_BEFORE_CANCELLATION' });
    const r = receipt({ confirmedAt: '2026-11-04T06:00:00+02:00', accessUntil: '2026-11-04T06:00:00+02:00' });
    assert.deepEqual(assess({ receipts: [r] }), { kind: 'NOT_APPLICABLE', reason: 'AUTHORIZED_BEFORE_CANCELLATION' });
  });

  it('sends charges for periods inside paid access to review', () => {
    const tx = charge({ servicePeriodStart: '2026-11-01T00:00:00+02:00' });
    assert.deepEqual(assess({ tx }), { kind: 'NEEDS_REVIEW', reason: 'SERVICE_PERIOD_OVERLAPS_PAID_ACCESS', receiptId: 'NF-1047' });
  });

  it('accepts a service period starting exactly when access ends', () => {
    assert.equal(assess({ tx: charge({ servicePeriodStart: '2026-11-03T23:59:59+02:00' }) }).kind, 'ELIGIBLE');
  });

  it('without a service period, uses the charge date against paid access', () => {
    const early = charge({ servicePeriodStart: undefined, authorizedAt: '2026-11-01T10:00:00+02:00' });
    assert.deepEqual(assess({ tx: early }), { kind: 'NEEDS_REVIEW', reason: 'UNKNOWN_SERVICE_PERIOD', receiptId: 'NF-1047' });
    assert.equal(assess({ tx: charge({ servicePeriodStart: undefined }) }).kind, 'ELIGIBLE');
  });

  it('sends one-off (non-recurring) charges to review', () => {
    assert.deepEqual(assess({ tx: charge({ recurring: false }) }), { kind: 'NEEDS_REVIEW', reason: 'NOT_MARKED_RECURRING', receiptId: 'NF-1047' });
  });

  it('waits on a pending authorisation and schedules a recheck', () => {
    const result = assess({ tx: charge({ status: 'PENDING', postedAt: undefined }) });
    assert.deepEqual(result, { kind: 'WAIT', reason: 'PENDING_AUTHORIZATION', recheckAfter: '2026-11-06T06:00:00.000Z', receiptId: 'NF-1047' });
  });

  it('honours a custom pending recheck interval', () => {
    const result = assess({ tx: charge({ status: 'PENDING', postedAt: undefined }), policy: { disputeWindowDays: 120, pendingRecheckHours: 6 } });
    assert.equal(result.kind === 'WAIT' && result.recheckAfter, '2026-11-05T12:00:00.000Z');
  });

  it('rejects a posted charge without a posting date', () => {
    assert.throws(() => assess({ tx: charge({ postedAt: undefined }) }), (e: unknown) => e instanceof DomainError && e.code === 'POSTED_WITHOUT_DATE');
  });

  it('sends charges outside the dispute window to review; the deadline day itself still counts', () => {
    assert.equal(assess({ now: '2027-03-05T23:00:00+02:00' }).kind, 'ELIGIBLE');
    assert.deepEqual(assess({ now: '2027-03-06T00:00:01+02:00' }), { kind: 'NEEDS_REVIEW', reason: 'WINDOW_EXPIRED', receiptId: 'NF-1047' });
  });

  it('sends weak proof (merchant message only) to review instead of disputing', () => {
    assert.deepEqual(assess({ receipts: [receipt({ verification: 'MERCHANT_MESSAGE_ONLY' })] }), { kind: 'NEEDS_REVIEW', reason: 'WEAK_PROOF', receiptId: 'NF-1047' });
  });

  it('disputes only the unrefunded remainder after a partial refund', () => {
    const result = assess({ credits: [credit(), credit({ creditId: 'cr-2', amountMinor: 900 })] });
    assert.equal(result.kind === 'ELIGIBLE' && result.disputableMinor, 5000);
    assert.equal(result.kind === 'ELIGIBLE' && result.alreadyRefundedMinor, 2900);
  });

  it('treats a full or excess refund as handled', () => {
    assert.deepEqual(assess({ credits: [credit({ amountMinor: 7900 })] }), { kind: 'ALREADY_HANDLED', reason: 'FULLY_REFUNDED' });
    assert.deepEqual(assess({ credits: [credit({ amountMinor: 8000 })] }), { kind: 'ALREADY_HANDLED', reason: 'FULLY_REFUNDED' });
  });

  it('ignores refunds for other charges or other customers', () => {
    const result = assess({ credits: [credit({ refundsTxId: 'tx-other' }), credit({ scope: MARIA })] });
    assert.equal(result.kind === 'ELIGIBLE' && result.disputableMinor, 7900);
  });

  it('sends a refund in another currency to review', () => {
    assert.deepEqual(assess({ credits: [credit({ currency: 'EUR' })] }), { kind: 'NEEDS_REVIEW', reason: 'CREDIT_CURRENCY_MISMATCH', receiptId: 'NF-1047' });
  });

  it('resolves an unlinked charge when the customer has one subscription at the merchant', () => {
    assert.equal(assess({ tx: charge({ subscriptionId: undefined }) }).kind, 'ELIGIBLE');
    assert.equal(assess({ tx: charge({ subscriptionId: undefined }), subscriptionsAtMerchant: ['sub-fitflow', 'sub-fitflow'] }).kind, 'ELIGIBLE');
  });

  it('sends an unlinked charge to review when several subscriptions exist at the merchant', () => {
    const result = assess({ tx: charge({ subscriptionId: undefined }), subscriptionsAtMerchant: ['sub-fitflow', 'sub-fitflow-family'] });
    assert.deepEqual(result, { kind: 'NEEDS_REVIEW', reason: 'AMBIGUOUS_SUBSCRIPTION' });
  });

  it('ignores an unlinked charge at a merchant with no known subscription', () => {
    assert.deepEqual(assess({ tx: charge({ subscriptionId: undefined }), subscriptionsAtMerchant: [] }), { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' });
  });

  it('rejects malformed transaction data', () => {
    assert.throws(() => assess({ tx: charge({ amountMinor: 79.5 }) }), DomainError);
    assert.throws(() => assess({ tx: charge({ currency: 'lei' }) }), DomainError);
    assert.throws(() => assess({ tx: charge({ authorizedAt: 'yesterday' }) }), DomainError);
  });
});

function eligiblePacket(credits: MerchantCredit[] = []) {
  const tx = charge();
  return prepareDisputePacket(assess({ credits }), tx, receipt());
}

const APPROVE_AT = '2026-11-05T09:00:00+02:00';
const approvalFor = (digest: string) => grant(digest, { issuedAt: '2026-11-05T08:55:00+02:00', expiresAt: '2026-11-05T09:10:00+02:00' });

function ok(t: Transition): Extract<Transition, { ok: true }> {
  assert.equal(t.ok, true, `expected success, got ${JSON.stringify(t)}`);
  return t as Extract<Transition, { ok: true }>;
}

function submitted(): DisputeCase {
  const packet = eligiblePacket();
  const approved = ok(approveDispute(openDispute(packet), approvalFor(packet.manifestDigest), APPROVE_AT)).next;
  return ok(markSubmitted(approved, 'NET-1', APPROVE_AT)).next;
}

describe('prepareDisputePacket', () => {
  it('produces a deterministic packet whose digest covers amount and evidence', () => {
    const a = eligiblePacket();
    const b = eligiblePacket();
    assert.equal(a.manifestDigest, b.manifestDigest);
    assert.equal(a.packetId, b.packetId);
    assert.equal(a.manifest.amountMinor, 7900);
    assert.notEqual(eligiblePacket([credit()]).manifestDigest, a.manifestDigest);
  });

  it('sorts evidence references so their order does not change the digest', () => {
    const tx = charge();
    const reversed = receipt({ evidenceRefs: [...receipt().evidenceRefs].reverse() });
    assert.equal(prepareDisputePacket(assess({ receipts: [reversed] }), tx, reversed).manifestDigest, eligiblePacket().manifestDigest);
  });

  it('refuses to prepare from a non-eligible assessment or mismatched inputs', () => {
    assert.throws(() => prepareDisputePacket(assess({ receipts: [] }), charge(), receipt()), (e: unknown) => e instanceof DomainError && e.code === 'NOT_ELIGIBLE');
    assert.throws(() => prepareDisputePacket(assess(), charge({ txId: 'other' }), receipt()), (e: unknown) => e instanceof DomainError && e.code === 'TX_MISMATCH');
    assert.throws(() => prepareDisputePacket(assess(), charge(), receipt({ receiptId: 'X' })), (e: unknown) => e instanceof DomainError && e.code === 'RECEIPT_MISMATCH');
  });
});

describe('dispute lifecycle', () => {
  it('requires a grant for the exact packet before submission', () => {
    const packet = eligiblePacket();
    const c = openDispute(packet);
    assert.deepEqual(approveDispute(c, approvalFor('other-digest'), APPROVE_AT), { ok: false, reason: 'DIGEST_MISMATCH' });
    assert.deepEqual(approveDispute(c, { ...approvalFor(packet.manifestDigest), ownerId: MARIA.ownerId }, APPROVE_AT), { ok: false, reason: 'WRONG_OWNER' });
    assert.deepEqual(approveDispute(c, approvalFor(packet.manifestDigest), '2026-11-05T09:10:00+02:00'), { ok: false, reason: 'EXPIRED' });
    const t = ok(approveDispute(c, approvalFor(packet.manifestDigest), APPROVE_AT));
    assert.equal(t.next.state, 'APPROVED');
    assert.equal(t.next.grantId, 'grant-1');
    assert.deepEqual(t.effects, [{ type: 'SUBMIT_TO_NETWORK', packetId: packet.packetId, manifestDigest: packet.manifestDigest }]);
  });

  it('cannot approve twice or approve after the deadline', () => {
    const packet = eligiblePacket();
    const approved = ok(approveDispute(openDispute(packet), approvalFor(packet.manifestDigest), APPROVE_AT)).next;
    assert.deepEqual(approveDispute(approved, approvalFor(packet.manifestDigest), APPROVE_AT), { ok: false, reason: 'INVALID_STATE' });
    const late = grant(packet.manifestDigest, { issuedAt: '2027-03-06T08:00:00+02:00', expiresAt: '2027-03-06T09:00:00+02:00' });
    assert.deepEqual(approveDispute(openDispute(packet), late, '2027-03-06T08:30:00+02:00'), { ok: false, reason: 'DEADLINE_PASSED' });
  });

  it('records submission once; the same network reference again is a duplicate', () => {
    const c = submitted();
    assert.equal(c.state, 'SUBMITTED');
    const again = ok(markSubmitted(c, 'NET-1', APPROVE_AT));
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.effects, []);
    assert.deepEqual(markSubmitted(c, 'NET-2', APPROVE_AT), { ok: false, reason: 'INVALID_STATE' });
    assert.deepEqual(markSubmitted(openDispute(eligiblePacket()), 'NET-1', APPROVE_AT), { ok: false, reason: 'INVALID_STATE' });
  });

  it('expires unsubmitted disputes past the deadline but leaves submitted ones alone', () => {
    const late = '2027-03-06T10:00:00+02:00';
    const expired = ok(expireIfLate(openDispute(eligiblePacket()), late));
    assert.equal(expired.next.state, 'EXPIRED');
    assert.deepEqual(expired.effects, [{ type: 'NOTIFY_CUSTOMER', message: 'DEADLINE_MISSED' }]);
    assert.equal(ok(expireIfLate(submitted(), late)).next.state, 'SUBMITTED');
    assert.equal(ok(expireIfLate(openDispute(eligiblePacket()), APPROVE_AT)).next.state, 'PREPARED');
  });

  it('posts a provisional credit once, then confirms it on a win without posting again', () => {
    const provisional = ok(recordBankCredit(submitted(), { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' }));
    assert.equal(provisional.next.state, 'PROVISIONAL_CREDIT');
    assert.deepEqual(provisional.effects[0], { type: 'POST_CREDIT', eventId: 'ev-p', amountMinor: 7900, currency: 'RON', provisional: true });

    const replay = ok(recordBankCredit(provisional.next, { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' }));
    assert.equal(replay.duplicate, true);

    const won = ok(recordNetworkDecision(provisional.next, { eventId: 'ev-w', outcome: 'WON' }));
    assert.equal(won.next.state, 'WON');
    assert.equal(won.next.creditedMinor, 7900);
    assert.ok(won.effects.every((e) => e.type !== 'POST_CREDIT'));
  });

  it('reverses only the provisional amount when the dispute is lost', () => {
    const provisional = ok(recordBankCredit(submitted(), { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' })).next;
    const lost = ok(recordNetworkDecision(provisional, { eventId: 'ev-l', outcome: 'LOST' }));
    assert.equal(lost.next.state, 'LOST');
    assert.equal(lost.next.creditedMinor, 0);
    assert.deepEqual(lost.effects[0], { type: 'REVERSE_CREDIT', eventId: 'ev-l', amountMinor: 7900, currency: 'RON' });
  });

  it('handles a win without provisional credit: decision first, then the final credit', () => {
    const awaiting = ok(recordNetworkDecision(submitted(), { eventId: 'ev-w', outcome: 'WON' })).next;
    assert.equal(awaiting.state, 'AWAITING_FINAL_CREDIT');
    assert.deepEqual(recordBankCredit(awaiting, { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' }), { ok: false, reason: 'INVALID_STATE' });
    const final = ok(recordBankCredit(awaiting, { eventId: 'ev-f', kind: 'FINAL', amountMinor: 7900, currency: 'RON' }));
    assert.equal(final.next.state, 'WON');
    assert.deepEqual(final.effects[0], { type: 'POST_CREDIT', eventId: 'ev-f', amountMinor: 7900, currency: 'RON', provisional: false });
  });

  it('a final credit after a partial provisional posts only the difference', () => {
    const provisional = ok(recordBankCredit(submitted(), { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 5000, currency: 'RON' })).next;
    const final = ok(recordBankCredit(provisional, { eventId: 'ev-f', kind: 'FINAL', amountMinor: 7900, currency: 'RON' }));
    assert.equal(final.next.creditedMinor, 7900);
    assert.deepEqual(final.effects[0], { type: 'POST_CREDIT', eventId: 'ev-f', amountMinor: 2900, currency: 'RON', provisional: false });
  });

  it('a final credit smaller than the provisional one reverses the excess', () => {
    const provisional = ok(recordBankCredit(submitted(), { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' })).next;
    const final = ok(recordBankCredit(provisional, { eventId: 'ev-f', kind: 'FINAL', amountMinor: 3000, currency: 'RON' }));
    assert.equal(final.next.state, 'WON');
    assert.equal(final.next.creditedMinor, 3000);
    assert.deepEqual(final.effects[0], { type: 'REVERSE_CREDIT', eventId: 'ev-f', amountMinor: 4900, currency: 'RON' });
  });

  it('never credits more than the disputed amount', () => {
    assert.deepEqual(recordBankCredit(submitted(), { eventId: 'ev', kind: 'PROVISIONAL', amountMinor: 7901, currency: 'RON' }), { ok: false, reason: 'OVER_CREDIT' });
    const half = ok(recordBankCredit(submitted(), { eventId: 'ev-1', kind: 'PROVISIONAL', amountMinor: 4000, currency: 'RON' })).next;
    assert.deepEqual(recordBankCredit(half, { eventId: 'ev-2', kind: 'PROVISIONAL', amountMinor: 4000, currency: 'RON' }), { ok: false, reason: 'OVER_CREDIT' });
  });

  it('rejects credits in the wrong currency, non-positive or fractional amounts, and before submission', () => {
    assert.deepEqual(recordBankCredit(submitted(), { eventId: 'e', kind: 'FINAL', amountMinor: 7900, currency: 'EUR' }), { ok: false, reason: 'CURRENCY_MISMATCH' });
    assert.deepEqual(recordBankCredit(submitted(), { eventId: 'e', kind: 'FINAL', amountMinor: 0, currency: 'RON' }), { ok: false, reason: 'INVALID_AMOUNT' });
    assert.deepEqual(recordBankCredit(submitted(), { eventId: 'e', kind: 'FINAL', amountMinor: 1.5, currency: 'RON' }), { ok: false, reason: 'INVALID_AMOUNT' });
    assert.deepEqual(recordBankCredit(openDispute(eligiblePacket()), { eventId: 'e', kind: 'FINAL', amountMinor: 7900, currency: 'RON' }), { ok: false, reason: 'INVALID_STATE' });
  });

  it('closes a not-yet-submitted dispute when the merchant refunds first', () => {
    const refunded = ok(recordMerchantRefund(openDispute(eligiblePacket()), { eventId: 'mr-1', amountMinor: 7900 }));
    assert.equal(refunded.next.state, 'MERCHANT_REFUNDED');
    assert.deepEqual(refunded.effects, [{ type: 'NOTIFY_CUSTOMER', message: 'MERCHANT_REFUNDED' }]);
  });

  it('withdraws a submitted dispute when the merchant refunds', () => {
    const refunded = ok(recordMerchantRefund(submitted(), { eventId: 'mr-1', amountMinor: 7900 }));
    assert.equal(refunded.next.state, 'MERCHANT_REFUNDED');
    assert.deepEqual(refunded.effects[0], { type: 'WITHDRAW_DISPUTE', networkRef: 'NET-1' });
  });

  it('a partial merchant refund goes to review instead of withdrawing the dispute', () => {
    const partial = ok(recordMerchantRefund(submitted(), { eventId: 'mr-1', amountMinor: 100 }));
    assert.equal(partial.next.state, 'DOUBLE_RECOVERY_REVIEW');
    assert.deepEqual(partial.effects, [{ type: 'FLAG_DOUBLE_RECOVERY', eventId: 'mr-1', amountMinor: 100 }]);
    assert.ok(!partial.effects.some((e) => e.type === 'WITHDRAW_DISPUTE'));
    assert.deepEqual(recordMerchantRefund(submitted(), { eventId: 'mr-2', amountMinor: 0 }), { ok: false, reason: 'INVALID_AMOUNT' });
  });

  it('flags double recovery when the merchant refunds after the bank already credited', () => {
    const provisional = ok(recordBankCredit(submitted(), { eventId: 'ev-p', kind: 'PROVISIONAL', amountMinor: 7900, currency: 'RON' })).next;
    const flagged = ok(recordMerchantRefund(provisional, { eventId: 'mr-1', amountMinor: 7900 }));
    assert.equal(flagged.next.state, 'DOUBLE_RECOVERY_REVIEW');
    assert.deepEqual(flagged.effects, [{ type: 'FLAG_DOUBLE_RECOVERY', eventId: 'mr-1', amountMinor: 7900 }]);
    const won = ok(recordNetworkDecision(provisional, { eventId: 'ev-w', outcome: 'WON' })).next;
    assert.equal(ok(recordMerchantRefund(won, { eventId: 'mr-1', amountMinor: 7900 })).next.state, 'DOUBLE_RECOVERY_REVIEW');
  });

  it('ignores replayed events and rejects events in terminal states', () => {
    const lost = ok(recordNetworkDecision(submitted(), { eventId: 'ev-l', outcome: 'LOST' })).next;
    assert.equal(ok(recordNetworkDecision(lost, { eventId: 'ev-l', outcome: 'LOST' })).duplicate, true);
    assert.deepEqual(recordNetworkDecision(lost, { eventId: 'ev-x', outcome: 'WON' }), { ok: false, reason: 'INVALID_STATE' });
    assert.deepEqual(recordMerchantRefund(lost, { eventId: 'mr-1', amountMinor: 1 }), { ok: false, reason: 'INVALID_STATE' });
    assert.deepEqual(recordNetworkDecision(openDispute(eligiblePacket()), { eventId: 'ev', outcome: 'WON' }), { ok: false, reason: 'INVALID_STATE' });
  });
});
