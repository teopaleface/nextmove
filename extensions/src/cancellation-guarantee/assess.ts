import { endingInForce, type MerchantReceipt } from '../shared/receipts.ts';
import { sameScope, type Scope } from '../shared/authority.ts';
import { assertCurrency, assertMinor, assertNonNegativeMinor } from '../shared/money.ts';
import { addDays, assertInstant, isAfter, isBefore, localDate, type Instant, type IsoDate } from '../shared/time.ts';
import { invariant } from '../shared/errors.ts';

export type TransactionStatus = 'PENDING' | 'POSTED' | 'REVERSED';

export interface CardTransaction {
  readonly txId: string;
  readonly scope: Scope;
  readonly cardId: string;
  /** Normalised merchant identity; descriptor matching happens upstream. */
  readonly merchantId: string;
  /** Set when the bank's recurring-payment matching already linked the charge to a subscription. */
  readonly subscriptionId?: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: TransactionStatus;
  readonly authorizedAt: Instant;
  readonly postedAt?: Instant;
  /** Start of the service period the merchant says the charge pays for, when sent. */
  readonly servicePeriodStart?: Instant;
  /** Card-network recurring indicator. */
  readonly recurring: boolean;
}

/** A merchant refund already posted to the account and linked to a specific charge. */
export interface MerchantCredit {
  readonly creditId: string;
  readonly scope: Scope;
  readonly refundsTxId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly postedAt: Instant;
}

export interface GuaranteePolicy {
  /** Days after posting during which the bank can still raise the dispute. */
  readonly disputeWindowDays: number;
  /** Hours to wait before rechecking a pending authorisation. */
  readonly pendingRecheckHours: number;
}

export const DEFAULT_POLICY: GuaranteePolicy = { disputeWindowDays: 120, pendingRecheckHours: 24 };

export type NotApplicableReason =
  | 'REVERSED'
  | 'ZERO_AMOUNT'
  | 'NO_CONFIRMED_CANCELLATION'
  | 'MERCHANT_MISMATCH'
  | 'AUTHORIZED_BEFORE_CANCELLATION';

export type ReviewReason =
  | 'AMBIGUOUS_SUBSCRIPTION'
  | 'UNKNOWN_SERVICE_PERIOD'
  | 'SERVICE_PERIOD_OVERLAPS_PAID_ACCESS'
  | 'NOT_MARKED_RECURRING'
  | 'WEAK_PROOF'
  | 'WINDOW_EXPIRED'
  | 'CREDIT_CURRENCY_MISMATCH';

export type Assessment =
  | { readonly kind: 'NOT_APPLICABLE'; readonly reason: NotApplicableReason }
  | { readonly kind: 'ALREADY_HANDLED'; readonly reason: 'ALREADY_DISPUTED' | 'FULLY_REFUNDED' }
  | { readonly kind: 'WAIT'; readonly reason: 'PENDING_AUTHORIZATION'; readonly recheckAfter: Instant; readonly receiptId: string }
  | { readonly kind: 'NEEDS_REVIEW'; readonly reason: ReviewReason; readonly receiptId?: string }
  | {
      readonly kind: 'ELIGIBLE';
      readonly txId: string;
      readonly subscriptionId: string;
      readonly receiptId: string;
      readonly chargedMinor: number;
      readonly alreadyRefundedMinor: number;
      readonly disputableMinor: number;
      readonly currency: string;
      readonly deadline: IsoDate;
      readonly reasonCode: 'CANCELLED_RECURRING';
    };

export interface AssessmentInput {
  readonly tx: CardTransaction;
  readonly receipts: readonly MerchantReceipt[];
  readonly credits: readonly MerchantCredit[];
  /** Transaction IDs that already have a dispute in any state. */
  readonly disputedTxIds: ReadonlySet<string>;
  /** The customer's subscription IDs at this merchant, used when the charge is not linked to one. */
  readonly subscriptionsAtMerchant: readonly string[];
  readonly policy?: GuaranteePolicy;
  readonly now: Instant;
}

function validate(tx: CardTransaction): void {
  assertMinor(tx.amountMinor, 'tx.amountMinor');
  assertCurrency(tx.currency);
  assertInstant(tx.authorizedAt, 'tx.authorizedAt');
  if (tx.postedAt !== undefined) assertInstant(tx.postedAt, 'tx.postedAt');
  if (tx.servicePeriodStart !== undefined) assertInstant(tx.servicePeriodStart, 'tx.servicePeriodStart');
  invariant(tx.status !== 'POSTED' || tx.postedAt !== undefined, 'POSTED_WITHOUT_DATE', `posted transaction ${tx.txId} has no postedAt`);
}

/**
 * Decides whether a card charge is one the merchant should not have taken because the customer's
 * cancellation was already confirmed. Ordering matters: cheap exclusions first, then whether a
 * confirmed cancellation covers the charge, then the conditions for raising a dispute.
 */
export function assessPostCancellationCharge(input: AssessmentInput): Assessment {
  const { tx, now } = input;
  const policy = input.policy ?? DEFAULT_POLICY;
  validate(tx);
  assertInstant(now, 'now');

  if (tx.status === 'REVERSED') return { kind: 'NOT_APPLICABLE', reason: 'REVERSED' };
  if (tx.amountMinor <= 0) return { kind: 'NOT_APPLICABLE', reason: 'ZERO_AMOUNT' };
  if (input.disputedTxIds.has(tx.txId)) return { kind: 'ALREADY_HANDLED', reason: 'ALREADY_DISPUTED' };

  let subscriptionId = tx.subscriptionId;
  if (subscriptionId === undefined) {
    const candidates = [...new Set(input.subscriptionsAtMerchant)];
    if (candidates.length > 1) return { kind: 'NEEDS_REVIEW', reason: 'AMBIGUOUS_SUBSCRIPTION' };
    subscriptionId = candidates[0];
  }
  if (subscriptionId === undefined) return { kind: 'NOT_APPLICABLE', reason: 'NO_CONFIRMED_CANCELLATION' };

  const ending = endingInForce(input.receipts, tx.scope, subscriptionId, tx.authorizedAt);
  if (ending === undefined) {
    // A cancellation confirmed only after the charge was authorised does not make the charge wrong.
    const later = endingInForce(input.receipts, tx.scope, subscriptionId, now);
    const reason = later !== undefined && isAfter(later.confirmedAt, tx.authorizedAt) ? 'AUTHORIZED_BEFORE_CANCELLATION' : 'NO_CONFIRMED_CANCELLATION';
    return { kind: 'NOT_APPLICABLE', reason };
  }
  if (ending.merchantId !== tx.merchantId) return { kind: 'NOT_APPLICABLE', reason: 'MERCHANT_MISMATCH' };
  // endingInForce only returns receipts confirmed at or before authorisation; equal times mean the
  // charge was already in flight when the cancellation landed.
  if (!isAfter(tx.authorizedAt, ending.confirmedAt)) return { kind: 'NOT_APPLICABLE', reason: 'AUTHORIZED_BEFORE_CANCELLATION' };

  const review = (reason: ReviewReason): Assessment => ({ kind: 'NEEDS_REVIEW', reason, receiptId: ending.receiptId });

  if (tx.servicePeriodStart !== undefined) {
    if (isBefore(tx.servicePeriodStart, ending.accessUntil)) return review('SERVICE_PERIOD_OVERLAPS_PAID_ACCESS');
  } else if (isBefore(tx.authorizedAt, ending.accessUntil)) {
    // Between confirmation and the end of paid access the charge could be a legitimate add-on.
    return review('UNKNOWN_SERVICE_PERIOD');
  }
  if (!tx.recurring) return review('NOT_MARKED_RECURRING');

  if (tx.status === 'PENDING') {
    const recheckAfter = new Date(Date.parse(now) + policy.pendingRecheckHours * 3_600_000).toISOString();
    return { kind: 'WAIT', reason: 'PENDING_AUTHORIZATION', recheckAfter, receiptId: ending.receiptId };
  }

  const deadline = addDays(localDate(tx.postedAt as Instant), policy.disputeWindowDays);
  if (localDate(now) > deadline) return review('WINDOW_EXPIRED');
  if (ending.verification !== 'INDEPENDENT_READ_BACK') return review('WEAK_PROOF');

  const linkedCredits = input.credits.filter((c) => c.refundsTxId === tx.txId && sameScope(c.scope, tx.scope));
  if (linkedCredits.some((c) => c.currency !== tx.currency)) return review('CREDIT_CURRENCY_MISMATCH');
  const alreadyRefundedMinor = linkedCredits.reduce((total, c) => {
    // A negative "refund" would raise the disputable amount above the charge.
    assertNonNegativeMinor(c.amountMinor, 'credit.amountMinor');
    return total + c.amountMinor;
  }, 0);
  if (alreadyRefundedMinor >= tx.amountMinor) return { kind: 'ALREADY_HANDLED', reason: 'FULLY_REFUNDED' };

  return {
    kind: 'ELIGIBLE',
    txId: tx.txId,
    subscriptionId,
    receiptId: ending.receiptId,
    chargedMinor: tx.amountMinor,
    alreadyRefundedMinor,
    disputableMinor: tx.amountMinor - alreadyRefundedMinor,
    currency: tx.currency,
    deadline,
    reasonCode: 'CANCELLED_RECURRING',
  };
}
