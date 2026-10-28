import { checkGrant, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { DomainError, invariant } from '../shared/errors.ts';
import { assertMinor } from '../shared/money.ts';
import type { MerchantReceipt } from '../shared/receipts.ts';
import { localDate, type Instant, type IsoDate } from '../shared/time.ts';
import type { Assessment, CardTransaction } from './assess.ts';

export interface DisputeManifest {
  readonly kind: 'CANCELLATION_GUARANTEE_DISPUTE';
  readonly scope: Scope;
  readonly txId: string;
  readonly merchantId: string;
  readonly subscriptionId: string;
  readonly receiptId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reasonCode: 'CANCELLED_RECURRING';
  readonly deadline: IsoDate;
  readonly facts: {
    readonly cancellationConfirmedAt: Instant;
    readonly accessUntil: Instant;
    readonly chargeAuthorizedAt: Instant;
    readonly chargePostedAt: Instant;
    readonly termsRevision: number;
  };
  readonly evidenceRefs: readonly string[];
}

export interface DisputePacket {
  readonly packetId: string;
  readonly manifest: DisputeManifest;
  readonly manifestDigest: string;
}

/** Builds the evidence packet the customer approves. Same inputs always give the same packet. */
export function prepareDisputePacket(assessment: Assessment, tx: CardTransaction, receipt: MerchantReceipt): DisputePacket {
  if (assessment.kind !== 'ELIGIBLE') throw new DomainError('NOT_ELIGIBLE', `cannot prepare a dispute from a ${assessment.kind} assessment`);
  invariant(assessment.txId === tx.txId, 'TX_MISMATCH', 'assessment belongs to another transaction');
  invariant(assessment.receiptId === receipt.receiptId, 'RECEIPT_MISMATCH', 'assessment cites another receipt');
  invariant(tx.postedAt !== undefined, 'POSTED_WITHOUT_DATE', 'a dispute needs a posted charge');
  const manifest: DisputeManifest = {
    kind: 'CANCELLATION_GUARANTEE_DISPUTE',
    scope: { ownerId: tx.scope.ownerId, contextId: tx.scope.contextId },
    txId: tx.txId,
    merchantId: tx.merchantId,
    subscriptionId: assessment.subscriptionId,
    receiptId: receipt.receiptId,
    amountMinor: assessment.disputableMinor,
    currency: assessment.currency,
    reasonCode: assessment.reasonCode,
    deadline: assessment.deadline,
    facts: {
      cancellationConfirmedAt: receipt.confirmedAt,
      accessUntil: receipt.accessUntil,
      chargeAuthorizedAt: tx.authorizedAt,
      chargePostedAt: tx.postedAt,
      termsRevision: receipt.termsRevision,
    },
    evidenceRefs: [...receipt.evidenceRefs].sort(),
  };
  const manifestDigest = digestOf(manifest);
  return { packetId: `dsp_${manifestDigest.slice(0, 24)}`, manifest, manifestDigest };
}

export type DisputeState =
  | 'PREPARED'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'PROVISIONAL_CREDIT'
  | 'AWAITING_FINAL_CREDIT'
  | 'WON'
  | 'LOST'
  | 'MERCHANT_REFUNDED'
  | 'DOUBLE_RECOVERY_REVIEW'
  | 'EXPIRED';

export interface DisputeCase {
  readonly packet: DisputePacket;
  readonly state: DisputeState;
  readonly grantId?: string;
  readonly networkRef?: string;
  readonly creditedMinor: number;
  readonly provisionalMinor: number;
  /** Bank and merchant event IDs already applied; replays are ignored. */
  readonly appliedEventIds: readonly string[];
}

/** Instructions for the app. Only POST_CREDIT and REVERSE_CREDIT change money, each keyed by a unique event. */
export type DisputeEffect =
  | { readonly type: 'SUBMIT_TO_NETWORK'; readonly packetId: string; readonly manifestDigest: string }
  | { readonly type: 'POST_CREDIT'; readonly eventId: string; readonly amountMinor: number; readonly currency: string; readonly provisional: boolean }
  | { readonly type: 'REVERSE_CREDIT'; readonly eventId: string; readonly amountMinor: number; readonly currency: string }
  | { readonly type: 'WITHDRAW_DISPUTE'; readonly networkRef: string }
  | { readonly type: 'FLAG_DOUBLE_RECOVERY'; readonly eventId: string; readonly amountMinor: number }
  | { readonly type: 'NOTIFY_CUSTOMER'; readonly message: DisputeNotice };

export type DisputeNotice = 'DISPUTE_FILED' | 'PROVISIONAL_CREDIT_POSTED' | 'DISPUTE_WON' | 'DISPUTE_LOST' | 'MERCHANT_REFUNDED' | 'DEADLINE_MISSED';

export type RejectionReason = Extract<GrantCheck, { ok: false }>['reason'];

export type Transition =
  | { readonly ok: true; readonly next: DisputeCase; readonly effects: readonly DisputeEffect[]; readonly duplicate?: boolean }
  | { readonly ok: false; readonly reason: RejectionReason | 'INVALID_STATE' | 'DEADLINE_PASSED' | 'OVER_CREDIT' | 'CURRENCY_MISMATCH' | 'INVALID_AMOUNT' };

export function openDispute(packet: DisputePacket): DisputeCase {
  return { packet, state: 'PREPARED', creditedMinor: 0, provisionalMinor: 0, appliedEventIds: [] };
}

function deadlinePassed(c: DisputeCase, now: Instant): boolean {
  return localDate(now) > c.packet.manifest.deadline;
}

export function approveDispute(c: DisputeCase, grant: ApprovalGrant, now: Instant): Transition {
  if (c.state !== 'PREPARED') return { ok: false, reason: 'INVALID_STATE' };
  const check = checkGrant(grant, { scope: c.packet.manifest.scope, manifestDigest: c.packet.manifestDigest }, now);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (deadlinePassed(c, now)) return { ok: false, reason: 'DEADLINE_PASSED' };
  return {
    ok: true,
    next: { ...c, state: 'APPROVED', grantId: grant.grantId },
    effects: [{ type: 'SUBMIT_TO_NETWORK', packetId: c.packet.packetId, manifestDigest: c.packet.manifestDigest }],
  };
}

export function markSubmitted(c: DisputeCase, networkRef: string, now: Instant): Transition {
  if (c.state === 'SUBMITTED' && c.networkRef === networkRef) return { ok: true, next: c, effects: [], duplicate: true };
  if (c.state !== 'APPROVED') return { ok: false, reason: 'INVALID_STATE' };
  if (deadlinePassed(c, now)) return { ok: false, reason: 'DEADLINE_PASSED' };
  return { ok: true, next: { ...c, state: 'SUBMITTED', networkRef }, effects: [{ type: 'NOTIFY_CUSTOMER', message: 'DISPUTE_FILED' }] };
}

/** Called by the worker's sweep: an unsubmitted dispute past its deadline becomes a manual case. */
export function expireIfLate(c: DisputeCase, now: Instant): Transition {
  if ((c.state === 'PREPARED' || c.state === 'APPROVED') && deadlinePassed(c, now)) {
    return { ok: true, next: { ...c, state: 'EXPIRED' }, effects: [{ type: 'NOTIFY_CUSTOMER', message: 'DEADLINE_MISSED' }] };
  }
  return { ok: true, next: c, effects: [] };
}

export interface BankCreditEvent {
  readonly eventId: string;
  readonly kind: 'PROVISIONAL' | 'FINAL';
  readonly amountMinor: number;
  readonly currency: string;
}

export function recordBankCredit(c: DisputeCase, event: BankCreditEvent): Transition {
  if (c.appliedEventIds.includes(event.eventId)) return { ok: true, next: c, effects: [], duplicate: true };
  if (!['SUBMITTED', 'PROVISIONAL_CREDIT', 'AWAITING_FINAL_CREDIT'].includes(c.state)) return { ok: false, reason: 'INVALID_STATE' };
  if (event.currency !== c.packet.manifest.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  try {
    assertMinor(event.amountMinor);
  } catch {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  if (event.amountMinor <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (event.kind === 'PROVISIONAL' && c.state === 'AWAITING_FINAL_CREDIT') return { ok: false, reason: 'INVALID_STATE' };

  // A final credit replaces the provisional one: only the difference moves, up when the final is larger and back
  // down (a reversal) when it is smaller, so the customer ends with exactly the final amount.
  const delta = event.kind === 'FINAL' ? event.amountMinor - c.provisionalMinor : event.amountMinor;
  const creditedMinor = c.creditedMinor + delta;
  if (creditedMinor > c.packet.manifest.amountMinor) return { ok: false, reason: 'OVER_CREDIT' };

  const effects: DisputeEffect[] = [];
  if (delta > 0) effects.push({ type: 'POST_CREDIT', eventId: event.eventId, amountMinor: delta, currency: event.currency, provisional: event.kind === 'PROVISIONAL' });
  if (delta < 0) effects.push({ type: 'REVERSE_CREDIT', eventId: event.eventId, amountMinor: -delta, currency: event.currency });
  effects.push({ type: 'NOTIFY_CUSTOMER', message: event.kind === 'FINAL' ? 'DISPUTE_WON' : 'PROVISIONAL_CREDIT_POSTED' });
  return {
    ok: true,
    next: {
      ...c,
      state: event.kind === 'FINAL' ? 'WON' : 'PROVISIONAL_CREDIT',
      creditedMinor,
      provisionalMinor: event.kind === 'FINAL' ? 0 : c.provisionalMinor + event.amountMinor,
      appliedEventIds: [...c.appliedEventIds, event.eventId],
    },
    effects,
  };
}

export interface NetworkDecisionEvent {
  readonly eventId: string;
  readonly outcome: 'WON' | 'LOST';
}

export function recordNetworkDecision(c: DisputeCase, event: NetworkDecisionEvent): Transition {
  if (c.appliedEventIds.includes(event.eventId)) return { ok: true, next: c, effects: [], duplicate: true };
  const applied = [...c.appliedEventIds, event.eventId];
  const currency = c.packet.manifest.currency;
  if (c.state === 'SUBMITTED') {
    if (event.outcome === 'WON') return { ok: true, next: { ...c, state: 'AWAITING_FINAL_CREDIT', appliedEventIds: applied }, effects: [] };
    return { ok: true, next: { ...c, state: 'LOST', appliedEventIds: applied }, effects: [{ type: 'NOTIFY_CUSTOMER', message: 'DISPUTE_LOST' }] };
  }
  if (c.state === 'PROVISIONAL_CREDIT') {
    if (event.outcome === 'WON') {
      // The provisional money becomes final; no new posting.
      return { ok: true, next: { ...c, state: 'WON', provisionalMinor: 0, appliedEventIds: applied }, effects: [{ type: 'NOTIFY_CUSTOMER', message: 'DISPUTE_WON' }] };
    }
    return {
      ok: true,
      next: { ...c, state: 'LOST', creditedMinor: c.creditedMinor - c.provisionalMinor, provisionalMinor: 0, appliedEventIds: applied },
      effects: [
        { type: 'REVERSE_CREDIT', eventId: event.eventId, amountMinor: c.provisionalMinor, currency },
        { type: 'NOTIFY_CUSTOMER', message: 'DISPUTE_LOST' },
      ],
    };
  }
  return { ok: false, reason: 'INVALID_STATE' };
}

export interface MerchantRefundEvent {
  readonly eventId: string;
  /** The refund is already a posted bank transaction; this module never posts it again. */
  readonly amountMinor: number;
}

export function recordMerchantRefund(c: DisputeCase, event: MerchantRefundEvent): Transition {
  if (c.appliedEventIds.includes(event.eventId)) return { ok: true, next: c, effects: [], duplicate: true };
  const applied = [...c.appliedEventIds, event.eventId];
  try {
    assertMinor(event.amountMinor);
  } catch {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  if (event.amountMinor <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  // Only a refund of the whole disputed amount ends the dispute. A partial one leaves money still owed, so a
  // person decides how much to keep disputing; nothing is withdrawn automatically.
  if (event.amountMinor < c.packet.manifest.amountMinor && ['PREPARED', 'APPROVED', 'SUBMITTED', 'AWAITING_FINAL_CREDIT'].includes(c.state)) {
    return { ok: true, next: { ...c, state: 'DOUBLE_RECOVERY_REVIEW', appliedEventIds: applied }, effects: [{ type: 'FLAG_DOUBLE_RECOVERY', eventId: event.eventId, amountMinor: event.amountMinor }] };
  }
  if (c.state === 'PREPARED' || c.state === 'APPROVED') {
    return { ok: true, next: { ...c, state: 'MERCHANT_REFUNDED', appliedEventIds: applied }, effects: [{ type: 'NOTIFY_CUSTOMER', message: 'MERCHANT_REFUNDED' }] };
  }
  if (c.state === 'SUBMITTED' || c.state === 'AWAITING_FINAL_CREDIT') {
    return {
      ok: true,
      next: { ...c, state: 'MERCHANT_REFUNDED', appliedEventIds: applied },
      effects: [
        { type: 'WITHDRAW_DISPUTE', networkRef: c.networkRef ?? '' },
        { type: 'NOTIFY_CUSTOMER', message: 'MERCHANT_REFUNDED' },
      ],
    };
  }
  if (c.state === 'PROVISIONAL_CREDIT' || c.state === 'WON') {
    // Money came back twice. A person decides which recovery to reverse.
    return {
      ok: true,
      next: { ...c, state: 'DOUBLE_RECOVERY_REVIEW', appliedEventIds: applied },
      effects: [{ type: 'FLAG_DOUBLE_RECOVERY', eventId: event.eventId, amountMinor: event.amountMinor }],
    };
  }
  return { ok: false, reason: 'INVALID_STATE' };
}
