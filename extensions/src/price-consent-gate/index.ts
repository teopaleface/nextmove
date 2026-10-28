import { checkGrant, sameScope, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor } from '../shared/money.ts';
import { assertInstant, type Instant } from '../shared/time.ts';

/**
 * A customer-set price ceiling on a subscription, enforced when the merchant asks for money
 * rather than noticed afterwards. Only merchant-initiated charges are gated: when the customer
 * is present and authenticates, they are consenting to that price themselves.
 *
 * Declining a payment does not end the contract, so a rejected price rise always suggests a
 * proper stop-renewal instead of leaving the customer with a merchant chasing a debt.
 */
export interface PriceCeilingTerms {
  readonly scope: Scope;
  readonly subscriptionId: string;
  /** One brand can bill under several merchant IDs (acquirers, regions); all are gated. */
  readonly merchantIds: readonly string[];
  /** Currency of the merchant's price (the transaction currency), not the card's. */
  readonly currency: string;
  readonly approvedMinor: number;
}

export interface PriceCeiling {
  readonly ceilingId: string;
  readonly terms: PriceCeilingTerms;
  readonly manifestDigest: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
  readonly grantId?: string;
  /** A price rise the customer turned down; further attempts at it get a hard decline. */
  readonly rejected?: { readonly amountMinor: number; readonly currency: string };
}

export function createPriceCeiling(terms: PriceCeilingTerms): PriceCeiling {
  assertCurrency(terms.currency);
  assertNonNegativeMinor(terms.approvedMinor, 'approvedMinor');
  invariant(terms.merchantIds.length > 0, 'NO_MERCHANT', 'a ceiling needs at least one merchant ID');
  invariant(new Set(terms.merchantIds).size === terms.merchantIds.length, 'DUPLICATE_MERCHANT', 'merchant IDs must be distinct');
  const normalized: PriceCeilingTerms = { ...terms, merchantIds: [...terms.merchantIds].sort() };
  const manifestDigest = digestOf({ kind: 'PRICE_CEILING', ...normalized });
  return { ceilingId: `ceil_${manifestDigest.slice(0, 24)}`, terms: normalized, manifestDigest, status: 'DRAFT' };
}

type GrantRejection = Extract<GrantCheck, { ok: false }>['reason'];

export function activatePriceCeiling(ceiling: PriceCeiling, grant: ApprovalGrant, now: Instant): { ok: true; ceiling: PriceCeiling } | { ok: false; reason: GrantRejection | 'INVALID_STATE' } {
  if (ceiling.status !== 'DRAFT' && ceiling.status !== 'PAUSED') return { ok: false, reason: 'INVALID_STATE' };
  const check = checkGrant(grant, { scope: ceiling.terms.scope, manifestDigest: ceiling.manifestDigest }, now);
  if (!check.ok) return check;
  return { ok: true, ceiling: { ...ceiling, status: 'ACTIVE', grantId: grant.grantId } };
}

export function pausePriceCeiling(ceiling: PriceCeiling): PriceCeiling {
  invariant(ceiling.status === 'ACTIVE', 'INVALID_STATE', 'only an active ceiling can be paused');
  return { ...ceiling, status: 'PAUSED' };
}

export function revokePriceCeiling(ceiling: PriceCeiling): PriceCeiling {
  return { ...ceiling, status: 'REVOKED' };
}

export interface AuthorizationRequest {
  readonly authId: string;
  readonly scope: Scope;
  readonly merchantId: string;
  /** Merchant price in the merchant's currency; FX movement on the card side does not change it. */
  readonly amountMinor: number;
  readonly currency: string;
  /** What the card account is charged after conversion; informational only. */
  readonly billingAmountMinor: number;
  readonly billingCurrency: string;
  readonly initiator: 'CUSTOMER' | 'MERCHANT';
  /** An incremental authorization adds to an earlier one; the gate judges the running total. */
  readonly incrementOf?: { readonly authId: string; readonly approvedSoFarMinor: number };
  readonly receivedAt: Instant;
}

export interface GatePolicy {
  /** Soft declines let the merchant retry after the customer answers; then the decline turns hard. */
  readonly maxSoftDeclines: number;
}

export const DEFAULT_GATE_POLICY: GatePolicy = { maxSoftDeclines: 3 };

export type GateEffect =
  | { readonly type: 'NOTIFY_PRICE_RISE'; readonly key: string; readonly ceilingIds: readonly string[]; readonly currentMinor: number; readonly requestedMinor: number; readonly currency: string }
  | { readonly type: 'SUGGEST_STOP_RENEWAL'; readonly subscriptionId: string };

export type DeclineAdvice = 'RETRY_LATER' | 'DO_NOT_RETRY';

export type GateDecision =
  | { readonly action: 'APPROVE'; readonly reason: 'NOT_GATED' | 'CUSTOMER_PRESENT' | 'WITHIN_CEILING'; readonly ceilingId?: string; readonly effects: readonly GateEffect[] }
  | { readonly action: 'DECLINE'; readonly reason: 'ABOVE_CEILING' | 'CURRENCY_CHANGED' | 'RISE_REJECTED'; readonly advice: DeclineAdvice; readonly key: string; readonly effects: readonly GateEffect[] };

/** Stable identity of one requested price, so notices and retry counts are shared across retries. */
export function riseKey(ceilings: readonly PriceCeiling[], amountMinor: number, currency: string): string {
  return `pricerise:${ceilings.map((c) => c.ceilingId).sort().join('+')}:${currency}:${amountMinor}`;
}

export function decideAuthorization(
  request: AuthorizationRequest,
  ctx: {
    readonly ceilings: readonly PriceCeiling[];
    /** Rise keys already notified, so a retry storm produces one notice. */
    readonly notifiedKeys: ReadonlySet<string>;
    /** Declines already given per rise key. */
    readonly declinesByKey: ReadonlyMap<string, number>;
    readonly policy?: GatePolicy;
  },
): GateDecision {
  assertInstant(request.receivedAt, 'receivedAt');
  assertCurrency(request.currency);
  assertNonNegativeMinor(request.amountMinor);
  const policy = ctx.policy ?? DEFAULT_GATE_POLICY;
  const matching = ctx.ceilings.filter((c) => c.status === 'ACTIVE' && sameScope(c.terms.scope, request.scope) && c.terms.merchantIds.includes(request.merchantId));
  if (matching.length === 0) return { action: 'APPROVE', reason: 'NOT_GATED', effects: [] };
  if (request.initiator === 'CUSTOMER') return { action: 'APPROVE', reason: 'CUSTOMER_PRESENT', effects: [] };

  if (request.incrementOf !== undefined) assertNonNegativeMinor(request.incrementOf.approvedSoFarMinor, 'approvedSoFarMinor');
  const total = request.amountMinor + (request.incrementOf?.approvedSoFarMinor ?? 0);

  // Two subscriptions at one merchant: approve if any of them covers it, against the tightest fit.
  const covering = matching
    .filter((c) => c.terms.currency === request.currency && total <= c.terms.approvedMinor)
    .sort((a, b) => a.terms.approvedMinor - b.terms.approvedMinor || (a.ceilingId < b.ceilingId ? -1 : 1))[0];
  if (covering !== undefined) return { action: 'APPROVE', reason: 'WITHIN_CEILING', ceilingId: covering.ceilingId, effects: [] };

  const key = riseKey(matching, total, request.currency);
  const sameCurrency = matching.filter((c) => c.terms.currency === request.currency);
  const reason = sameCurrency.length === 0 ? 'CURRENCY_CHANGED' : 'ABOVE_CEILING';
  const rejected = matching.some((c) => c.rejected !== undefined && c.rejected.currency === request.currency && total >= c.rejected.amountMinor);
  if (rejected) return { action: 'DECLINE', reason: 'RISE_REJECTED', advice: 'DO_NOT_RETRY', key, effects: [] };

  const declinesSoFar = ctx.declinesByKey.get(key) ?? 0;
  const advice: DeclineAdvice = declinesSoFar + 1 >= policy.maxSoftDeclines ? 'DO_NOT_RETRY' : 'RETRY_LATER';
  const current = (sameCurrency.length > 0 ? sameCurrency : matching).reduce((max, c) => Math.max(max, c.terms.approvedMinor), 0);
  const effects: GateEffect[] = ctx.notifiedKeys.has(key)
    ? []
    : [{ type: 'NOTIFY_PRICE_RISE', key, ceilingIds: matching.map((c) => c.ceilingId).sort(), currentMinor: current, requestedMinor: total, currency: request.currency }];
  return { action: 'DECLINE', reason, advice, key, effects };
}

/** The exact rise the customer is asked to accept; the grant must be bound to this digest. */
export function priceRiseManifest(ceiling: PriceCeiling, newMinor: number, currency: string): { readonly manifest: object; readonly manifestDigest: string } {
  assertCurrency(currency);
  assertNonNegativeMinor(newMinor, 'newMinor');
  const manifest = { kind: 'PRICE_RISE', ceilingId: ceiling.ceilingId, subscriptionId: ceiling.terms.subscriptionId, fromMinor: ceiling.terms.approvedMinor, fromCurrency: ceiling.terms.currency, toMinor: newMinor, toCurrency: currency };
  return { manifest, manifestDigest: digestOf(manifest) };
}

export type RiseAnswer =
  | { readonly ok: true; readonly ceiling: PriceCeiling; readonly effects: readonly GateEffect[] }
  | { readonly ok: false; readonly reason: GrantRejection | 'INVALID_STATE' | 'NOT_A_RISE' };

/** Accepting raises the ceiling to exactly the shown price (grant required); rejecting needs no grant. */
export function answerPriceRise(ceiling: PriceCeiling, rise: { readonly newMinor: number; readonly currency: string }, answer: { readonly kind: 'ACCEPT'; readonly grant: ApprovalGrant } | { readonly kind: 'REJECT' }, now: Instant): RiseAnswer {
  if (ceiling.status !== 'ACTIVE') return { ok: false, reason: 'INVALID_STATE' };
  const { manifestDigest } = priceRiseManifest(ceiling, rise.newMinor, rise.currency);
  if (rise.currency === ceiling.terms.currency && rise.newMinor <= ceiling.terms.approvedMinor) return { ok: false, reason: 'NOT_A_RISE' };
  if (answer.kind === 'REJECT') {
    return { ok: true, ceiling: { ...ceiling, rejected: { amountMinor: rise.newMinor, currency: rise.currency } }, effects: [{ type: 'SUGGEST_STOP_RENEWAL', subscriptionId: ceiling.terms.subscriptionId }] };
  }
  const check = checkGrant(answer.grant, { scope: ceiling.terms.scope, manifestDigest }, now);
  if (!check.ok) return check;
  const terms: PriceCeilingTerms = { ...ceiling.terms, approvedMinor: rise.newMinor, currency: rise.currency };
  const { rejected: _dropped, ...rest } = ceiling;
  return { ok: true, ceiling: { ...rest, terms, manifestDigest: digestOf({ kind: 'PRICE_CEILING', ...terms }), grantId: answer.grant.grantId }, effects: [] };
}
