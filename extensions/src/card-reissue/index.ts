import { checkGrant, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { invariant } from '../shared/errors.ts';
import { endingInForce, type MerchantReceipt } from '../shared/receipts.ts';
import { assertInstant, type Instant } from '../shared/time.ts';

/**
 * When a card is replaced, network account updaters (Visa VAU, Mastercard ABU) hand the new
 * number to every merchant holding the old one, including subscriptions the customer already
 * cancelled. The bank decides, per merchant, whether that update is given.
 *
 * Network tokens are different: a token keeps working when the card number changes, so
 * withholding an update is not enough; the token itself has to be suspended.
 */
export type ReissueReason = 'EXPIRY' | 'LOST' | 'STOLEN' | 'COMPROMISED' | 'CUSTOMER_REQUEST';

export interface CardOnFile {
  readonly merchantId: string;
  /** Groups merchant IDs of one brand so the customer answers once per brand. */
  readonly brandId?: string;
  readonly credential: { readonly kind: 'PAN' } | { readonly kind: 'NETWORK_TOKEN'; readonly tokenId: string };
  /** Whether this merchant receives account-updater data at all. */
  readonly participatesInUpdater: boolean;
  /** Subscriptions the bank has linked to this merchant for this card; empty when unknown. */
  readonly subscriptionIds: readonly string[];
}

export type Choice = 'KEEP' | 'DROP';

export type DecisionBasis =
  | 'CUSTOMER_CHOICE'
  | 'ALL_SUBSCRIPTIONS_CANCELLED'
  | 'ACTIVE_SUBSCRIPTION'
  | 'UNANSWERED_KEEPS_SERVICE'
  | 'UNANSWERED_AFTER_FRAUD';

export type Question = 'MIXED_SUBSCRIPTIONS' | 'UNKNOWN_PURPOSE';

export interface MerchantDecision {
  readonly merchantId: string;
  readonly groupKey: string;
  readonly decision: Choice;
  readonly basis: DecisionBasis;
  /** Set when the customer should have been asked; recorded even after a default applied. */
  readonly question?: Question;
  readonly warnings: readonly ('KEEPING_CANCELLED_MERCHANT' | 'MANUAL_UPDATE_NEEDED')[];
}

export interface ReissuePlan {
  readonly planId: string;
  readonly scope: Scope;
  readonly oldCardId: string;
  readonly newCardId: string;
  readonly reason: ReissueReason;
  readonly decisions: readonly MerchantDecision[];
  readonly manifestDigest: string;
}

/** Only an expiry or a customer-requested swap keeps an unanswered merchant; after loss or fraud nothing is passed on unasked. */
const FRAUD_LIKE: ReadonlySet<ReissueReason> = new Set(['LOST', 'STOLEN', 'COMPROMISED']);

export function groupKeyOf(card: CardOnFile): string {
  return card.brandId ?? card.merchantId;
}

/** Merchants the customer must be asked about, grouped by brand, before a plan is final. */
export function questionsFor(input: { readonly scope: Scope; readonly merchants: readonly CardOnFile[]; readonly receipts: readonly MerchantReceipt[]; readonly now: Instant }): { readonly groupKey: string; readonly merchantIds: readonly string[]; readonly question: Question }[] {
  const groups = new Map<string, { merchantIds: string[]; question: Question }>();
  for (const m of input.merchants) {
    const q = classify(m, brandMerchantIds(input.merchants, m), input.scope, input.receipts, input.now).question;
    if (q === undefined) continue;
    const key = groupKeyOf(m);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { merchantIds: [m.merchantId], question: q });
    else {
      existing.merchantIds.push(m.merchantId);
      if (q === 'MIXED_SUBSCRIPTIONS') existing.question = q;
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([groupKey, g]) => ({ groupKey, merchantIds: g.merchantIds.sort(), question: g.question }));
}

/** Merchant IDs that bill for the same brand; a cancellation confirmed under one counts for all. */
function brandMerchantIds(merchants: readonly CardOnFile[], m: CardOnFile): ReadonlySet<string> {
  const key = groupKeyOf(m);
  return new Set(merchants.filter((x) => groupKeyOf(x) === key).map((x) => x.merchantId));
}

function classify(m: CardOnFile, brand: ReadonlySet<string>, scope: Scope, receipts: readonly MerchantReceipt[], now: Instant): { readonly default?: Choice; readonly basis?: DecisionBasis; readonly question?: Question } {
  if (m.subscriptionIds.length === 0) return { question: 'UNKNOWN_PURPOSE' };
  const ended = m.subscriptionIds.filter((id) => {
    const r = endingInForce(receipts, scope, id, now);
    return r !== undefined && brand.has(r.merchantId) && r.verification === 'INDEPENDENT_READ_BACK';
  });
  if (ended.length === m.subscriptionIds.length) return { default: 'DROP', basis: 'ALL_SUBSCRIPTIONS_CANCELLED' };
  if (ended.length === 0) return { default: 'KEEP', basis: 'ACTIVE_SUBSCRIPTION' };
  return { question: 'MIXED_SUBSCRIPTIONS' };
}

export function planReissue(input: {
  readonly scope: Scope;
  readonly oldCardId: string;
  readonly newCardId: string;
  readonly reason: ReissueReason;
  readonly merchants: readonly CardOnFile[];
  readonly receipts: readonly MerchantReceipt[];
  /** Customer answers keyed by brand (groupKey); they apply to every merchant ID of the brand. */
  readonly choices: ReadonlyMap<string, Choice>;
  readonly now: Instant;
}): ReissuePlan {
  assertInstant(input.now, 'now');
  invariant(input.oldCardId !== input.newCardId, 'SAME_CARD', 'the new card must differ from the old one');
  const ids = input.merchants.map((m) => m.merchantId);
  invariant(new Set(ids).size === ids.length, 'DUPLICATE_MERCHANT', 'each merchant appears once per card');
  const known = new Set(input.merchants.map(groupKeyOf));
  for (const key of input.choices.keys()) invariant(known.has(key), 'UNKNOWN_CHOICE', `no merchant on file for ${key}`);

  const decisions = input.merchants
    .map((m): MerchantDecision => {
      const groupKey = groupKeyOf(m);
      const c = classify(m, brandMerchantIds(input.merchants, m), input.scope, input.receipts, input.now);
      const chosen = input.choices.get(groupKey);
      let decision: Choice;
      let basis: DecisionBasis;
      if (chosen !== undefined) {
        decision = chosen;
        basis = 'CUSTOMER_CHOICE';
      } else if (c.default !== undefined && c.basis !== undefined) {
        // A known live subscription keeps its card even after fraud; a known cancellation never gets one.
        decision = c.default;
        basis = c.basis;
      } else if (FRAUD_LIKE.has(input.reason)) {
        decision = 'DROP';
        basis = 'UNANSWERED_AFTER_FRAUD';
      } else {
        decision = 'KEEP';
        basis = 'UNANSWERED_KEEPS_SERVICE';
      }
      const warnings: MerchantDecision['warnings'][number][] = [];
      if (decision === 'KEEP' && c.basis === 'ALL_SUBSCRIPTIONS_CANCELLED') warnings.push('KEEPING_CANCELLED_MERCHANT');
      if (decision === 'KEEP' && m.credential.kind === 'PAN' && !m.participatesInUpdater) warnings.push('MANUAL_UPDATE_NEEDED');
      return { merchantId: m.merchantId, groupKey, decision, basis, ...(c.question === undefined ? {} : { question: c.question }), warnings };
    })
    .sort((a, b) => (a.merchantId < b.merchantId ? -1 : 1));

  const body = { kind: 'CARD_REISSUE', scope: input.scope, oldCardId: input.oldCardId, newCardId: input.newCardId, reason: input.reason, decisions };
  const manifestDigest = digestOf(body);
  return { planId: `reissue_${manifestDigest.slice(0, 24)}`, ...body, manifestDigest };
}

export type ReissueEffect =
  | { readonly type: 'ALLOW_UPDATER'; readonly merchantId: string; readonly newCardId: string }
  | { readonly type: 'BLOCK_UPDATER'; readonly merchantId: string; readonly oldCardId: string }
  | { readonly type: 'SUSPEND_TOKEN'; readonly merchantId: string; readonly tokenId: string; readonly idempotencyKey: string }
  | { readonly type: 'TELL_CUSTOMER_TO_UPDATE'; readonly merchantId: string };

export function approveReissuePlan(
  plan: ReissuePlan,
  merchants: readonly CardOnFile[],
  grant: ApprovalGrant,
  now: Instant,
): { ok: true; effects: readonly ReissueEffect[] } | { ok: false; reason: Extract<GrantCheck, { ok: false }>['reason'] | 'MERCHANTS_CHANGED' } {
  const check = checkGrant(grant, { scope: plan.scope, manifestDigest: plan.manifestDigest }, now);
  if (!check.ok) return check;
  const byId = new Map(merchants.map((m) => [m.merchantId, m]));
  if (byId.size !== plan.decisions.length || plan.decisions.some((d) => !byId.has(d.merchantId))) return { ok: false, reason: 'MERCHANTS_CHANGED' };

  const effects: ReissueEffect[] = [];
  for (const d of plan.decisions) {
    const m = byId.get(d.merchantId) as CardOnFile;
    if (m.credential.kind === 'NETWORK_TOKEN') {
      // The token follows the account automatically; dropping means suspending it.
      if (d.decision === 'DROP') effects.push({ type: 'SUSPEND_TOKEN', merchantId: m.merchantId, tokenId: m.credential.tokenId, idempotencyKey: `${plan.planId}:token:${m.credential.tokenId}` });
      continue;
    }
    if (d.decision === 'KEEP') {
      effects.push(m.participatesInUpdater ? { type: 'ALLOW_UPDATER', merchantId: m.merchantId, newCardId: plan.newCardId } : { type: 'TELL_CUSTOMER_TO_UPDATE', merchantId: m.merchantId });
    } else if (m.participatesInUpdater) {
      effects.push({ type: 'BLOCK_UPDATER', merchantId: m.merchantId, oldCardId: plan.oldCardId });
    }
  }
  return { ok: true, effects };
}

export interface UpdaterInquiry {
  readonly merchantId: string;
  readonly oldCardId: string;
  readonly receivedAt: Instant;
}

export type InquiryAnswer =
  | { readonly answer: 'PROVIDE'; readonly newCardId: string }
  | { readonly answer: 'WITHHOLD'; readonly signal?: 'REQUEST_AFTER_CANCELLATION' | 'MERCHANT_NOT_ON_FILE' };

/**
 * Answers a merchant's account-updater inquiry from the approved plan. A merchant asking for
 * the new number after a confirmed cancellation is worth recording: it is evidence for the
 * cancellation guarantee if that merchant charges again.
 */
export function answerUpdaterInquiry(plan: ReissuePlan, inquiry: UpdaterInquiry): InquiryAnswer {
  assertInstant(inquiry.receivedAt, 'receivedAt');
  if (inquiry.oldCardId !== plan.oldCardId) return { answer: 'WITHHOLD', signal: 'MERCHANT_NOT_ON_FILE' };
  const d = plan.decisions.find((x) => x.merchantId === inquiry.merchantId);
  if (d === undefined) return { answer: 'WITHHOLD', signal: 'MERCHANT_NOT_ON_FILE' };
  if (d.decision === 'KEEP') return { answer: 'PROVIDE', newCardId: plan.newCardId };
  return d.basis === 'ALL_SUBSCRIPTIONS_CANCELLED' ? { answer: 'WITHHOLD', signal: 'REQUEST_AFTER_CANCELLATION' } : { answer: 'WITHHOLD' };
}
