import { checkGrant, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf, verifySignature } from '../shared/digest.ts';
import { DomainError, invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor } from '../shared/money.ts';
import { assertInstant, isAfter, isBefore, toMillis, type Instant } from '../shared/time.ts';

/**
 * Retention offers sent by a merchant that is a verified business client of the bank.
 * The offer is signed data; its free-text message is display-only and never an instruction.
 * The agent can compare and counter, but accepting needs a grant for the exact offer revision,
 * and an offer never pauses a cancellation the customer already approved.
 */
export interface OfferTerms {
  readonly currency: string;
  readonly promoMonthlyMinor: number;
  readonly promoMonths: number;
  /** Monthly price after the promo, if the plan auto-renews. */
  readonly priceAfterMinor: number;
  readonly autoRenew: boolean;
  readonly lockInMonths: number;
  /** Fee to leave before lock-in ends. */
  readonly earlyExitFeeMinor: number;
  /** Discount paid as merchant credit cannot be withdrawn and is lost on cancellation. */
  readonly benefitForm: 'PRICE_REDUCTION' | 'ACCOUNT_CREDIT';
  readonly removedBenefits: readonly string[];
  /** Terms the merchant declared but did not quantify; any entry makes the comparison incomplete. */
  readonly unquantifiedTerms: readonly string[];
}

export interface RetentionOffer {
  readonly offerId: string;
  readonly revision: number;
  readonly merchantId: string;
  readonly subscriptionId: string;
  readonly subscriberAccountId: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly terms: OfferTerms;
  /** Untrusted merchant text, shown as quoted data only. */
  readonly message?: string;
  /** Set when this revision answers a customer counter. */
  readonly inReplyToCounterId?: string;
}

export interface SignedOffer {
  readonly offer: RetentionOffer;
  readonly keyId: string;
  readonly signature: string;
}

export interface MerchantKey {
  readonly keyId: string;
  readonly merchantId: string;
  readonly secret: string;
  readonly status: 'ACTIVE' | 'RETIRED';
}

export interface MerchantRecord {
  readonly merchantId: string;
  readonly verified: boolean;
  readonly retentionOffersEnabled: boolean;
}

/** The bank's own record of who owns the subscription the offer targets. */
export interface SubscriptionOwnership {
  readonly subscriptionId: string;
  readonly merchantId: string;
  readonly subscriberAccountId: string;
  readonly scope: Scope;
}

export interface ReceivedOffer {
  readonly offerId: string;
  readonly subscriptionId: string;
  readonly receivedAt: Instant;
  /** Revisions answering a customer counter do not count against the limit. */
  readonly isCounterReply: boolean;
}

export interface OfferPolicy {
  readonly maxUnsolicitedOffers: number;
  readonly perDays: number;
  readonly maxValidityHours: number;
  readonly clockSkewMinutes: number;
  readonly maxCounters: number;
}

export const DEFAULT_OFFER_POLICY: OfferPolicy = { maxUnsolicitedOffers: 1, perDays: 30, maxValidityHours: 72, clockSkewMinutes: 5, maxCounters: 2 };

export type OfferRejection =
  | 'UNKNOWN_KEY'
  | 'RETIRED_KEY'
  | 'KEY_MERCHANT_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'MERCHANT_NOT_VERIFIED'
  | 'OFFERS_NOT_ENABLED'
  | 'NOT_CUSTOMER_SUBSCRIPTION'
  | 'ISSUED_IN_FUTURE'
  | 'EXPIRED'
  | 'VALIDITY_TOO_LONG'
  | 'RATE_LIMITED'
  | 'INVALID_TERMS';

export type OfferFlag = 'MESSAGE_LOOKS_LIKE_INSTRUCTIONS' | 'MESSAGE_CONTAINS_LINK' | 'CREDIT_NOT_CASH';

export type OfferVerification =
  | { readonly ok: true; readonly offer: RetentionOffer; readonly offerDigest: string; readonly scope: Scope; readonly flags: readonly OfferFlag[] }
  | { readonly ok: false; readonly reason: OfferRejection };

const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|rules?|previous|above)\b/i,
  /\b(you are|act as|system prompt|assistant|developer message)\b/i,
  /\b(approve|accept|confirm|authori[sz]e)\b.{0,30}\b(automatically|now|immediately|on behalf)\b/i,
  /\b(call|use|invoke|run)\b.{0,20}\b(tool|function|executeApprovedAction|api)\b/i,
];

export function messageFlags(message: string | undefined): OfferFlag[] {
  if (message === undefined) return [];
  const flags: OfferFlag[] = [];
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(message))) flags.push('MESSAGE_LOOKS_LIKE_INSTRUCTIONS');
  if (/(https?:\/\/|www\.)\S+/i.test(message)) flags.push('MESSAGE_CONTAINS_LINK');
  return flags;
}

function termsValid(terms: OfferTerms): boolean {
  try {
    assertCurrency(terms.currency);
    for (const [field, value] of Object.entries({ promoMonthlyMinor: terms.promoMonthlyMinor, priceAfterMinor: terms.priceAfterMinor, earlyExitFeeMinor: terms.earlyExitFeeMinor })) {
      assertNonNegativeMinor(value, field);
    }
    return [terms.promoMonths, terms.lockInMonths].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 120);
  } catch {
    return false;
  }
}

/** The digest a customer grant must name to accept this exact offer revision. */
export function offerDigest(offer: RetentionOffer): string {
  return digestOf({ kind: 'RETENTION_OFFER', offer });
}

export function verifyOffer(
  signed: SignedOffer,
  ctx: {
    readonly keys: readonly MerchantKey[];
    readonly merchants: readonly MerchantRecord[];
    readonly ownership: readonly SubscriptionOwnership[];
    readonly received: readonly ReceivedOffer[];
    readonly now: Instant;
    readonly policy?: OfferPolicy;
  },
): OfferVerification {
  const policy = ctx.policy ?? DEFAULT_OFFER_POLICY;
  const { offer } = signed;
  const key = ctx.keys.find((k) => k.keyId === signed.keyId);
  if (key === undefined) return { ok: false, reason: 'UNKNOWN_KEY' };
  if (key.status === 'RETIRED') return { ok: false, reason: 'RETIRED_KEY' };
  if (key.merchantId !== offer.merchantId) return { ok: false, reason: 'KEY_MERCHANT_MISMATCH' };
  let signatureOk = false;
  try {
    signatureOk = verifySignature(offer, signed.signature, key.secret);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: 'BAD_SIGNATURE' };

  const merchant = ctx.merchants.find((m) => m.merchantId === offer.merchantId);
  if (merchant === undefined || !merchant.verified) return { ok: false, reason: 'MERCHANT_NOT_VERIFIED' };
  if (!merchant.retentionOffersEnabled) return { ok: false, reason: 'OFFERS_NOT_ENABLED' };

  const owner = ctx.ownership.find((o) => o.subscriptionId === offer.subscriptionId && o.merchantId === offer.merchantId && o.subscriberAccountId === offer.subscriberAccountId);
  if (owner === undefined) return { ok: false, reason: 'NOT_CUSTOMER_SUBSCRIPTION' };

  if (!termsValid(offer.terms)) return { ok: false, reason: 'INVALID_TERMS' };
  try {
    assertInstant(offer.issuedAt);
    assertInstant(offer.expiresAt);
  } catch {
    return { ok: false, reason: 'INVALID_TERMS' };
  }
  const skewMs = policy.clockSkewMinutes * 60_000;
  if (toMillis(offer.issuedAt) - skewMs > toMillis(ctx.now)) return { ok: false, reason: 'ISSUED_IN_FUTURE' };
  if (!isBefore(ctx.now, offer.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  if (toMillis(offer.expiresAt) - toMillis(offer.issuedAt) > policy.maxValidityHours * 3_600_000) return { ok: false, reason: 'VALIDITY_TOO_LONG' };

  if (offer.inReplyToCounterId === undefined) {
    const windowStart = toMillis(ctx.now) - policy.perDays * 86_400_000;
    const recent = ctx.received.filter(
      (r) => r.subscriptionId === offer.subscriptionId && !r.isCounterReply && r.offerId !== offer.offerId && toMillis(r.receivedAt) > windowStart,
    );
    if (recent.length >= policy.maxUnsolicitedOffers) return { ok: false, reason: 'RATE_LIMITED' };
  }

  const flags = messageFlags(offer.message);
  if (offer.terms.benefitForm === 'ACCOUNT_CREDIT') flags.push('CREDIT_NOT_CASH');
  return { ok: true, offer, offerDigest: offerDigest(offer), scope: owner.scope, flags };
}

export interface CurrentPlan {
  readonly monthlyMinor: number;
  readonly currency: string;
  /** Benefits the customer said they need (e.g. offline playback). */
  readonly requiredBenefits: readonly string[];
}

export type OfferVerdict = 'INCOMPLETE' | 'LOSES_REQUIRED_BENEFIT' | 'NOT_CHEAPER_THAN_CURRENT' | 'CHEAPER_THAN_CURRENT';

export interface OfferComparison {
  readonly horizonMonths: number;
  readonly cancelTotalMinor: number;
  readonly keepCurrentTotalMinor: number;
  readonly offerTotalMinor: number;
  /** Least the customer pays if they accept and leave as early as allowed. */
  readonly committedMinimumMinor: number;
  readonly savingVsCurrentMinor: number;
  readonly verdict: OfferVerdict;
  readonly lostBenefits: readonly string[];
  readonly flags: readonly OfferFlag[];
}

function paymentsFor(terms: OfferTerms, months: number): number {
  const promo = Math.min(months, terms.promoMonths);
  const after = terms.autoRenew ? months - promo : 0;
  return promo * terms.promoMonthlyMinor + after * terms.priceAfterMinor;
}

/**
 * Cost of each option over the same horizon. "Cancel" is always 0 from here on: the customer
 * already paid for the current period, and an offer is only a reason to stay if it beats the current plan.
 */
export function compareOffer(offer: RetentionOffer, current: CurrentPlan, horizonMonths: number): OfferComparison {
  invariant(Number.isSafeInteger(horizonMonths) && horizonMonths >= 1 && horizonMonths <= 120, 'INVALID_HORIZON', `horizon must be 1..120 months, got ${horizonMonths}`);
  const { terms } = offer;
  if (terms.currency !== current.currency) throw new DomainError('CURRENCY_MISMATCH', `offer in ${terms.currency}, plan in ${current.currency}`);
  assertNonNegativeMinor(current.monthlyMinor, 'current.monthlyMinor');
  invariant(termsValid(terms), 'INVALID_TERMS', 'offer terms are malformed');

  const offerTotalMinor = paymentsFor(terms, horizonMonths) + (terms.lockInMonths > horizonMonths ? terms.earlyExitFeeMinor : 0);
  const exitAt = Math.max(1, terms.lockInMonths);
  const committedMinimumMinor = Math.min(paymentsFor(terms, exitAt), paymentsFor(terms, 1) + (terms.lockInMonths > 1 ? terms.earlyExitFeeMinor : 0));
  const keepCurrentTotalMinor = current.monthlyMinor * horizonMonths;
  const lostBenefits = terms.removedBenefits.filter((b) => current.requiredBenefits.includes(b)).sort();

  const flags = messageFlags(offer.message);
  if (terms.benefitForm === 'ACCOUNT_CREDIT') flags.push('CREDIT_NOT_CASH');

  let verdict: OfferVerdict;
  if (terms.unquantifiedTerms.length > 0) verdict = 'INCOMPLETE';
  else if (lostBenefits.length > 0) verdict = 'LOSES_REQUIRED_BENEFIT';
  else if (offerTotalMinor >= keepCurrentTotalMinor) verdict = 'NOT_CHEAPER_THAN_CURRENT';
  else verdict = 'CHEAPER_THAN_CURRENT';

  return {
    horizonMonths,
    cancelTotalMinor: 0,
    keepCurrentTotalMinor,
    offerTotalMinor,
    committedMinimumMinor,
    savingVsCurrentMinor: keepCurrentTotalMinor - offerTotalMinor,
    verdict,
    lostBenefits,
    flags,
  };
}

/** A non-binding request for a better revision. The merchant must answer with a new signed offer. */
export interface CounterProposal {
  readonly counterId: string;
  readonly offerId: string;
  readonly offerRevision: number;
  readonly monthlyMinor: number;
  readonly months: number;
  readonly currency: string;
}

export type CounterResult =
  | { readonly ok: true; readonly counter: CounterProposal }
  | { readonly ok: false; readonly reason: 'ABOVE_CUSTOMER_LIMIT' | 'NOT_LOWER_THAN_OFFER' | 'TOO_MANY_COUNTERS' | 'OFFER_EXPIRED' | 'INVALID_COUNTER' };

export function prepareCounter(
  offer: RetentionOffer,
  proposal: { readonly monthlyMinor: number; readonly months: number },
  limits: { readonly customerMaxMonthlyMinor: number; readonly countersSoFar: number },
  now: Instant,
  policy: OfferPolicy = DEFAULT_OFFER_POLICY,
): CounterResult {
  if (!Number.isSafeInteger(proposal.monthlyMinor) || proposal.monthlyMinor < 0 || !Number.isSafeInteger(proposal.months) || proposal.months < 1 || proposal.months > 120) {
    return { ok: false, reason: 'INVALID_COUNTER' };
  }
  if (!isBefore(now, offer.expiresAt)) return { ok: false, reason: 'OFFER_EXPIRED' };
  if (limits.countersSoFar >= policy.maxCounters) return { ok: false, reason: 'TOO_MANY_COUNTERS' };
  if (proposal.monthlyMinor > limits.customerMaxMonthlyMinor) return { ok: false, reason: 'ABOVE_CUSTOMER_LIMIT' };
  if (proposal.monthlyMinor >= offer.terms.promoMonthlyMinor) return { ok: false, reason: 'NOT_LOWER_THAN_OFFER' };
  const body = { offerId: offer.offerId, offerRevision: offer.revision, monthlyMinor: proposal.monthlyMinor, months: proposal.months, currency: offer.terms.currency };
  return { ok: true, counter: { counterId: `ctr_${digestOf(body).slice(0, 24)}`, ...body } };
}

export interface PendingCancellation {
  readonly subscriptionId: string;
  readonly state: 'APPROVED' | 'IN_FLIGHT' | 'CONFIRMED' | 'UNKNOWN';
  readonly mustCompleteBefore: Instant;
}

/**
 * How an offer sits next to an approved cancellation: the cancellation keeps running, and the
 * offer can only be answered while it is still possible to withdraw the cancellation.
 */
export function offerWindow(offer: RetentionOffer, cancellation: PendingCancellation | undefined): { readonly cancellationContinues: true; readonly answerBy: Instant | null } {
  if (cancellation === undefined) return { cancellationContinues: true, answerBy: offer.expiresAt };
  if (cancellation.subscriptionId !== offer.subscriptionId) return { cancellationContinues: true, answerBy: offer.expiresAt };
  if (cancellation.state !== 'APPROVED') return { cancellationContinues: true, answerBy: null };
  const answerBy = isAfter(offer.expiresAt, cancellation.mustCompleteBefore) ? cancellation.mustCompleteBefore : offer.expiresAt;
  return { cancellationContinues: true, answerBy };
}

export type AcceptEffect =
  | { readonly type: 'WITHDRAW_CANCELLATION'; readonly subscriptionId: string }
  | { readonly type: 'ACCEPT_OFFER'; readonly idempotencyKey: string; readonly offerId: string; readonly revision: number; readonly offerDigest: string; readonly grantId: string };

export type AcceptResult =
  | { readonly ok: true; readonly effects: readonly AcceptEffect[] }
  | { readonly ok: false; readonly reason: Extract<GrantCheck, { ok: false }>['reason'] | 'OFFER_EXPIRED' | 'CANCELLATION_IN_FLIGHT' | 'ALREADY_ACCEPTED' };

export function acceptOffer(
  verified: Extract<OfferVerification, { ok: true }>,
  grant: ApprovalGrant,
  ctx: { readonly now: Instant; readonly cancellation?: PendingCancellation; readonly acceptedKeys: ReadonlySet<string> },
): AcceptResult {
  const { offer } = verified;
  const idempotencyKey = `offer:${offer.offerId}:${offer.revision}`;
  if (ctx.acceptedKeys.has(idempotencyKey)) return { ok: false, reason: 'ALREADY_ACCEPTED' };
  const check = checkGrant(grant, { scope: verified.scope, manifestDigest: verified.offerDigest }, ctx.now);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (!isBefore(ctx.now, offer.expiresAt)) return { ok: false, reason: 'OFFER_EXPIRED' };

  const effects: AcceptEffect[] = [];
  const cancellation = ctx.cancellation;
  if (cancellation !== undefined && cancellation.subscriptionId === offer.subscriptionId) {
    // Once the merchant may have acted, the outcome must be reconciled first (ADR: unknown before retry).
    if (cancellation.state !== 'APPROVED') return { ok: false, reason: 'CANCELLATION_IN_FLIGHT' };
    effects.push({ type: 'WITHDRAW_CANCELLATION', subscriptionId: cancellation.subscriptionId });
  }
  effects.push({ type: 'ACCEPT_OFFER', idempotencyKey, offerId: offer.offerId, revision: offer.revision, offerDigest: verified.offerDigest, grantId: grant.grantId });
  return { ok: true, effects };
}
