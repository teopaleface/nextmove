import type { Scope } from './authority.ts';
import { compareInstants, isAfter, type Instant } from './time.ts';

export type SubscriptionOperation = 'STOP_RENEWAL_AT_PERIOD_END' | 'CANCEL_IMMEDIATELY' | 'PAUSE' | 'REACTIVATE';
export type ReceiptState = 'CONFIRMED' | 'PENDING' | 'REFUSED';
/** Only an independent read-back of merchant state proves an outcome; a displayed message does not. */
export type ReceiptVerification = 'INDEPENDENT_READ_BACK' | 'MERCHANT_MESSAGE_ONLY';

/** A merchant outcome as stored by the app after execution (see the trialCancellationReceipt UI fixture). */
export interface MerchantReceipt {
  /** Unique per receipt; what everything is keyed on. */
  readonly receiptId: string;
  /** The merchant's own confirmation number, for display. Merchants may reuse one, so it is never a key. */
  readonly merchantReference?: string;
  readonly scope: Scope;
  readonly merchantId: string;
  readonly subscriptionId: string;
  readonly subscriberAccountId: string;
  readonly operation: SubscriptionOperation;
  readonly state: ReceiptState;
  readonly confirmedAt: Instant;
  /** End of access already paid for; charges for periods after this are not owed. */
  readonly accessUntil: Instant;
  readonly termsRevision: number;
  readonly verification: ReceiptVerification;
  readonly evidenceRefs: readonly string[];
}

export const ENDING_OPERATIONS: ReadonlySet<SubscriptionOperation> = new Set(['STOP_RENEWAL_AT_PERIOD_END', 'CANCEL_IMMEDIATELY']);

export function isEndingReceipt(receipt: MerchantReceipt): boolean {
  return receipt.state === 'CONFIRMED' && ENDING_OPERATIONS.has(receipt.operation);
}

/**
 * The confirmed ending (stop-renewal or cancel) in force for a subscription at `at`,
 * or undefined when none exists or a later confirmed reactivation superseded it.
 * Only receipts in the given scope are considered, so another customer's receipt never matches.
 */
export function endingInForce(receipts: readonly MerchantReceipt[], scope: Scope, subscriptionId: string, at: Instant): MerchantReceipt | undefined {
  const timeline = receipts
    .filter((r) => r.scope.ownerId === scope.ownerId && r.scope.contextId === scope.contextId)
    .filter((r) => r.subscriptionId === subscriptionId && r.state === 'CONFIRMED')
    .filter((r) => !isAfter(r.confirmedAt, at))
    .sort((a, b) => compareInstants(a.confirmedAt, b.confirmedAt));
  const latest = timeline.at(-1);
  return latest !== undefined && isEndingReceipt(latest) ? latest : undefined;
}
