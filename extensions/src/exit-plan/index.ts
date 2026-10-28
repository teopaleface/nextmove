import { checkGrant, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { DomainError, invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor } from '../shared/money.ts';
import type { MerchantReceipt } from '../shared/receipts.ts';
import { assertDate, assertInstant, daysBetween, isBefore, localDate, type Instant, type IsoDate } from '../shared/time.ts';

/**
 * "Stop this unless I use it N times by day D", set when the customer signs up.
 * Approved once as a conditional mandate; the bank evaluates it on day D and, if the condition
 * holds, executes the stop-renewal through the normal execution path before the merchant's deadline.
 */
export interface ExitPlanTerms {
  readonly scope: Scope;
  readonly subscriptionId: string;
  readonly merchantId: string;
  /** Terms the customer saw; a different revision voids the mandate. */
  readonly termsRevision: number;
  /** Highest renewal price the customer agreed to keep paying without being asked again. */
  readonly priceCeilingMinor: number;
  readonly currency: string;
  readonly minUses: number;
  /** First local day on which the condition is evaluated. */
  readonly evaluateOn: IsoDate;
  /** Merchant's last moment to cancel without the next charge (e.g. trial end). */
  readonly cancelDeadline: Instant;
}

export type ExitPlanStatus = 'DRAFT' | 'ACTIVE' | 'STOP_REQUESTED' | 'KEPT' | 'STOPPED' | 'VOID' | 'REVOKED';

export interface ExitPlan {
  readonly ruleId: string;
  readonly terms: ExitPlanTerms;
  readonly manifestDigest: string;
  readonly createdOn: IsoDate;
  readonly status: ExitPlanStatus;
  readonly grantId?: string;
  readonly idempotencyKey?: string;
  readonly closedReason?: string;
}

export interface ExitPlanPolicy {
  /** Whole local days between evaluation and the merchant deadline, leaving time to retry or ask. */
  readonly minMarginDays: number;
}

export const DEFAULT_EXIT_POLICY: ExitPlanPolicy = { minMarginDays: 1 };

export function createExitPlan(terms: ExitPlanTerms, now: Instant, policy: ExitPlanPolicy = DEFAULT_EXIT_POLICY): ExitPlan {
  assertInstant(now, 'now');
  assertDate(terms.evaluateOn, 'evaluateOn');
  assertInstant(terms.cancelDeadline, 'cancelDeadline');
  assertCurrency(terms.currency);
  assertNonNegativeMinor(terms.priceCeilingMinor, 'priceCeilingMinor');
  invariant(Number.isSafeInteger(terms.minUses) && terms.minUses >= 1, 'INVALID_MIN_USES', `minUses must be a positive integer, got ${terms.minUses}`);
  invariant(Number.isSafeInteger(terms.termsRevision) && terms.termsRevision >= 0, 'INVALID_TERMS_REVISION', 'termsRevision must be a non-negative integer');
  const createdOn = localDate(now);
  invariant(terms.evaluateOn > createdOn, 'EVALUATION_NOT_IN_FUTURE', `evaluateOn ${terms.evaluateOn} must be after ${createdOn}`);
  const margin = daysBetween(terms.evaluateOn, localDate(terms.cancelDeadline));
  invariant(margin >= policy.minMarginDays, 'EVALUATION_TOO_CLOSE_TO_DEADLINE', `evaluateOn must be at least ${policy.minMarginDays} day(s) before the merchant deadline, margin is ${margin}`);

  const manifestDigest = digestOf({ kind: 'EXIT_PLAN', terms });
  return { ruleId: `exit_${manifestDigest.slice(0, 24)}`, terms, manifestDigest, createdOn, status: 'DRAFT' };
}

export type ActivationResult = { readonly ok: true; readonly plan: ExitPlan } | { readonly ok: false; readonly reason: Extract<GrantCheck, { ok: false }>['reason'] | 'INVALID_STATE' };

export function activateExitPlan(plan: ExitPlan, grant: ApprovalGrant, now: Instant): ActivationResult {
  if (plan.status !== 'DRAFT') return { ok: false, reason: 'INVALID_STATE' };
  const check = checkGrant(grant, { scope: plan.terms.scope, manifestDigest: plan.manifestDigest }, now);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, plan: { ...plan, status: 'ACTIVE', grantId: grant.grantId } };
}

export function revokeExitPlan(plan: ExitPlan): ExitPlan {
  if (plan.status === 'DRAFT' || plan.status === 'ACTIVE') return { ...plan, status: 'REVOKED', closedReason: 'REVOKED_BY_CUSTOMER' };
  return plan;
}

/** Where a usage count came from. Only sources the customer chose to share count. */
export type UsageSource = 'MERCHANT_REPORTED' | 'DEVICE_SCREEN_TIME' | 'CUSTOMER_REPORTED';
/** Merchant-wide data covers every device and family profile; a phone only sees itself. */
export type UsageCoverage = 'ALL_DEVICES' | 'THIS_DEVICE_ONLY';

export interface UsageEvidence {
  readonly source: UsageSource;
  readonly coverage: UsageCoverage;
  readonly sharedByCustomer: boolean;
  readonly uses: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
}

export interface SubscriptionSnapshot {
  readonly subscriptionId: string;
  readonly state: 'ACTIVE' | 'TRIAL' | 'CANCELLED' | 'RENEWAL_OFF';
  readonly termsRevision: number;
  readonly nextChargeMinor: number;
  readonly currency: string;
}

export type ExitOutcome =
  | { readonly kind: 'TOO_EARLY'; readonly evaluateOn: IsoDate }
  | { readonly kind: 'KEEP'; readonly uses: number; readonly minUses: number }
  | { readonly kind: 'STOP'; readonly uses: number; readonly minUses: number }
  | { readonly kind: 'ASK'; readonly reason: 'NO_EVIDENCE' | 'PARTIAL_COVERAGE'; readonly uses: number; readonly answerBy: Instant }
  | { readonly kind: 'MISSED_DEADLINE' }
  | { readonly kind: 'STOPPED'; readonly receiptId: string }
  | { readonly kind: 'VOID'; readonly reason: 'TERMS_CHANGED' | 'PRICE_ABOVE_CEILING' | 'ALREADY_ENDED' | 'SUBSCRIPTION_MISMATCH' | 'CURRENCY_CHANGED' | 'MERCHANT_REFUSED' }
  | { readonly kind: 'INACTIVE'; readonly status: ExitPlanStatus };

export type ExitEffect =
  | {
      readonly type: 'REQUEST_STOP_RENEWAL';
      readonly idempotencyKey: string;
      readonly ruleId: string;
      readonly grantId: string;
      readonly manifestDigest: string;
      readonly subscriptionId: string;
      readonly merchantId: string;
      readonly expectedTermsRevision: number;
      readonly mustCompleteBefore: Instant;
    }
  | { readonly type: 'ASK_CUSTOMER'; readonly ruleId: string; readonly reason: 'NO_EVIDENCE' | 'PARTIAL_COVERAGE'; readonly answerBy: Instant }
  | { readonly type: 'NOTIFY_CUSTOMER'; readonly ruleId: string; readonly message: 'KEPT' | 'VOIDED' | 'MISSED_DEADLINE' | 'STOPPED' | 'STOP_REFUSED' };

export interface ExitRun {
  readonly outcome: ExitOutcome;
  readonly next: ExitPlan;
  readonly effects: readonly ExitEffect[];
}

/** Counts per source (adding that source's periods inside the window), then takes the best source, never the sum. */
export function countUses(evidence: readonly UsageEvidence[], from: IsoDate, to: IsoDate): { allDevices?: number; thisDevice?: number } {
  const totals = new Map<string, { coverage: UsageCoverage; uses: number }>();
  for (const e of evidence) {
    invariant(Number.isSafeInteger(e.uses) && e.uses >= 0, 'INVALID_USES', `uses must be a non-negative integer, got ${e.uses}`);
    assertDate(e.periodStart, 'periodStart');
    assertDate(e.periodEnd, 'periodEnd');
    invariant(e.periodStart <= e.periodEnd, 'INVALID_PERIOD', `period ${e.periodStart}..${e.periodEnd} is reversed`);
    if (!e.sharedByCustomer) continue;
    if (e.periodEnd < from || e.periodStart > to) continue;
    const key = `${e.source}:${e.coverage}`;
    const current = totals.get(key) ?? { coverage: e.coverage, uses: 0 };
    totals.set(key, { coverage: e.coverage, uses: current.uses + e.uses });
  }
  const result: { allDevices?: number; thisDevice?: number } = {};
  for (const { coverage, uses } of totals.values()) {
    if (coverage === 'ALL_DEVICES') result.allDevices = Math.max(result.allDevices ?? 0, uses);
    else result.thisDevice = Math.max(result.thisDevice ?? 0, uses);
  }
  return result;
}

function settle(plan: ExitPlan, outcome: ExitOutcome, status: ExitPlanStatus, effects: ExitEffect[]): ExitRun {
  const closedReason = outcome.kind === 'VOID' ? outcome.reason : outcome.kind === 'MISSED_DEADLINE' ? 'MISSED_DEADLINE' : plan.closedReason;
  const next: ExitPlan = closedReason === undefined ? { ...plan, status } : { ...plan, status, closedReason };
  return { outcome, next, effects };
}

/**
 * Evaluates an active plan. Safe to call on every worker tick: before `evaluateOn` it does nothing,
 * and once a stop is requested later runs return the plan unchanged with no new effects.
 */
export function runExitPlan(plan: ExitPlan, input: { readonly subscription: SubscriptionSnapshot; readonly evidence: readonly UsageEvidence[]; readonly now: Instant }): ExitRun {
  const { subscription, now } = input;
  assertInstant(now, 'now');
  const terms = plan.terms;
  if (plan.status !== 'ACTIVE') return { outcome: { kind: 'INACTIVE', status: plan.status }, next: plan, effects: [] };

  const voided = (reason: Extract<ExitOutcome, { kind: 'VOID' }>['reason']) =>
    settle(plan, { kind: 'VOID', reason }, 'VOID', [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'VOIDED' }]);

  if (subscription.subscriptionId !== terms.subscriptionId) return voided('SUBSCRIPTION_MISMATCH');
  if (subscription.state === 'CANCELLED' || subscription.state === 'RENEWAL_OFF') return voided('ALREADY_ENDED');
  if (subscription.termsRevision !== terms.termsRevision) return voided('TERMS_CHANGED');
  if (subscription.currency !== terms.currency) return voided('CURRENCY_CHANGED');
  if (subscription.nextChargeMinor > terms.priceCeilingMinor) return voided('PRICE_ABOVE_CEILING');

  if (!isBefore(now, terms.cancelDeadline)) {
    return settle(plan, { kind: 'MISSED_DEADLINE' }, 'VOID', [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'MISSED_DEADLINE' }]);
  }
  const today = localDate(now);
  if (today < terms.evaluateOn) return { outcome: { kind: 'TOO_EARLY', evaluateOn: terms.evaluateOn }, next: plan, effects: [] };

  const counts = countUses(input.evidence, plan.createdOn, today);
  const best = Math.max(counts.allDevices ?? 0, counts.thisDevice ?? 0);
  if (best >= terms.minUses) {
    return settle(plan, { kind: 'KEEP', uses: best, minUses: terms.minUses }, 'KEPT', [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'KEPT' }]);
  }
  if (counts.allDevices === undefined) {
    // A phone cannot see TV or family-profile use, and silence is not proof of non-use.
    const reason = counts.thisDevice === undefined ? 'NO_EVIDENCE' : 'PARTIAL_COVERAGE';
    return {
      outcome: { kind: 'ASK', reason, uses: best, answerBy: terms.cancelDeadline },
      next: plan,
      effects: [{ type: 'ASK_CUSTOMER', ruleId: plan.ruleId, reason, answerBy: terms.cancelDeadline }],
    };
  }

  return requestStop(plan, best);
}

function requestStop(plan: ExitPlan, uses: number): ExitRun {
  if (plan.grantId === undefined) throw new DomainError('ACTIVE_WITHOUT_GRANT', `plan ${plan.ruleId} is active without a grant`);
  const { terms } = plan;
  const idempotencyKey = `exit:${plan.ruleId}:${terms.termsRevision}`;
  return {
    outcome: { kind: 'STOP', uses, minUses: terms.minUses },
    next: { ...plan, status: 'STOP_REQUESTED', idempotencyKey },
    effects: [
      {
        type: 'REQUEST_STOP_RENEWAL',
        idempotencyKey,
        ruleId: plan.ruleId,
        grantId: plan.grantId,
        manifestDigest: plan.manifestDigest,
        subscriptionId: terms.subscriptionId,
        merchantId: terms.merchantId,
        expectedTermsRevision: terms.termsRevision,
        mustCompleteBefore: terms.cancelDeadline,
      },
    ],
  };
}

/** The customer's answer to an ASK. "Keep" closes the plan; "stop" requests the stop under the same mandate. */
export function answerExitQuestion(plan: ExitPlan, answer: 'KEEP' | 'STOP', now: Instant): ExitRun {
  if (plan.status !== 'ACTIVE') return { outcome: { kind: 'INACTIVE', status: plan.status }, next: plan, effects: [] };
  if (!isBefore(now, plan.terms.cancelDeadline)) {
    return settle(plan, { kind: 'MISSED_DEADLINE' }, 'VOID', [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'MISSED_DEADLINE' }]);
  }
  if (answer === 'KEEP') return settle(plan, { kind: 'KEEP', uses: 0, minUses: plan.terms.minUses }, 'KEPT', [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'KEPT' }]);
  return requestStop(plan, 0);
}

/** Applies the merchant outcome of the requested stop. Pending and repeated outcomes leave the plan unchanged. */
export function recordStopOutcome(plan: ExitPlan, receipt: MerchantReceipt): ExitRun {
  const inactive = { outcome: { kind: 'INACTIVE', status: plan.status } as const, next: plan, effects: [] };
  if (plan.status !== 'STOP_REQUESTED') return inactive;
  invariant(receipt.subscriptionId === plan.terms.subscriptionId, 'RECEIPT_MISMATCH', 'receipt is for another subscription');
  invariant(receipt.scope.ownerId === plan.terms.scope.ownerId && receipt.scope.contextId === plan.terms.scope.contextId, 'RECEIPT_MISMATCH', 'receipt belongs to another customer');
  if (receipt.state === 'PENDING') return inactive;
  if (receipt.state === 'CONFIRMED') {
    return { outcome: { kind: 'STOPPED', receiptId: receipt.receiptId }, next: { ...plan, status: 'STOPPED' }, effects: [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'STOPPED' }] };
  }
  return { outcome: { kind: 'VOID', reason: 'MERCHANT_REFUSED' }, next: { ...plan, status: 'VOID', closedReason: 'MERCHANT_REFUSED' }, effects: [{ type: 'NOTIFY_CUSTOMER', ruleId: plan.ruleId, message: 'STOP_REFUSED' }] };
}
