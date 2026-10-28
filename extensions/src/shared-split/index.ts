import { checkGrant, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor } from '../shared/money.ts';
import { addDays, assertDate, assertInstant, compareDates, daysBetween, localDate, type Instant, type IsoDate } from '../shared/time.ts';

/**
 * One person (the organizer) pays a family or team plan; every cycle each member is asked for
 * their share. A member is debited only under their own mandate, granted by them, capped at a
 * share they agreed to. Without one, or above the cap, they get a payment request they can
 * ignore, and the organizer is never told to squeeze the others for it.
 */
export interface SplitMember {
  readonly memberId: string;
  /** Relative share; a member with weight 2 pays twice a member with weight 1. */
  readonly weight: number;
  readonly joinedOn: IsoDate;
  /** Last day included; a member leaving mid-cycle pays for the days they had. */
  readonly leftOn?: IsoDate;
  /** Only customers of this bank can hold a debit mandate; others always get requests. */
  readonly bankCustomer: boolean;
}

export interface SplitGroup {
  readonly groupId: string;
  readonly organizerId: string;
  readonly subscriptionId: string;
  readonly currency: string;
  readonly members: readonly SplitMember[];
}

export interface Mandate {
  readonly mandateId: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly currency: string;
  readonly maxShareMinor: number;
  readonly manifestDigest: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'REVOKED';
  readonly grantId?: string;
}

export const memberScope = (memberId: string): Scope => ({ ownerId: memberId, contextId: 'PERSONAL' });

export function createMandate(group: SplitGroup, memberId: string, maxShareMinor: number): Mandate {
  assertNonNegativeMinor(maxShareMinor, 'maxShareMinor');
  invariant(maxShareMinor > 0, 'INVALID_AMOUNT', 'a mandate must allow a positive share');
  const member = group.members.find((m) => m.memberId === memberId);
  invariant(member !== undefined, 'NOT_A_MEMBER', `${memberId} is not in the group`);
  invariant(memberId !== group.organizerId, 'ORGANIZER_PAYS_DIRECTLY', 'the organizer already pays the merchant');
  invariant(member.bankCustomer, 'NOT_A_BANK_CUSTOMER', 'debit mandates need an account at this bank');
  const body = { kind: 'SPLIT_MANDATE', groupId: group.groupId, subscriptionId: group.subscriptionId, payeeId: group.organizerId, memberId, currency: group.currency, maxShareMinor };
  const manifestDigest = digestOf(body);
  return { mandateId: `mandate_${manifestDigest.slice(0, 24)}`, groupId: group.groupId, memberId, currency: group.currency, maxShareMinor, manifestDigest, status: 'DRAFT' };
}

/** Only the member's own grant activates it; the organizer cannot consent on their behalf. */
export function activateMandate(mandate: Mandate, grant: ApprovalGrant, now: Instant): { ok: true; mandate: Mandate } | { ok: false; reason: Extract<GrantCheck, { ok: false }>['reason'] | 'INVALID_STATE' } {
  if (mandate.status !== 'DRAFT') return { ok: false, reason: 'INVALID_STATE' };
  const check = checkGrant(grant, { scope: memberScope(mandate.memberId), manifestDigest: mandate.manifestDigest }, now);
  if (!check.ok) return check;
  return { ok: true, mandate: { ...mandate, status: 'ACTIVE', grantId: grant.grantId } };
}

export function revokeMandate(mandate: Mandate): Mandate {
  return { ...mandate, status: 'REVOKED' };
}

/**
 * Splits a total by weight so the parts sum exactly to the total. Each part is first rounded
 * down; the leftover minor units go one each to the largest fractional remainders, ties broken
 * by member ID, so the same inputs always give the same split.
 */
export function splitByWeight(totalMinor: number, weights: readonly { readonly id: string; readonly weight: number }[]): Map<string, number> {
  assertNonNegativeMinor(totalMinor, 'totalMinor');
  for (const w of weights) invariant(Number.isSafeInteger(w.weight) && w.weight >= 0, 'INVALID_WEIGHT', `weight for ${w.id} must be a non-negative integer`);
  invariant(new Set(weights.map((w) => w.id)).size === weights.length, 'DUPLICATE_MEMBER', 'member IDs must be distinct');
  const totalWeight = weights.reduce((t, w) => t + BigInt(w.weight), 0n);
  invariant(totalWeight > 0n, 'NO_WEIGHT', 'at least one member must have a positive weight');
  const parts = weights.map((w) => {
    const exact = BigInt(totalMinor) * BigInt(w.weight);
    return { id: w.id, base: exact / totalWeight, rem: exact % totalWeight };
  });
  let leftover = BigInt(totalMinor) - parts.reduce((t, p) => t + p.base, 0n);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : 1) : a.rem > b.rem ? -1 : 1));
  const result = new Map(parts.map((p) => [p.id, p.base]));
  for (const p of order) {
    if (leftover === 0n) break;
    result.set(p.id, (result.get(p.id) as bigint) + 1n);
    leftover -= 1n;
  }
  return new Map([...result].map(([id, v]) => [id, Number(v)]));
}

export interface Cycle {
  readonly cycleId: string;
  readonly startsOn: IsoDate;
  /** Inclusive. */
  readonly endsOn: IsoDate;
}

export interface MemberShare {
  readonly memberId: string;
  readonly activeDays: number;
  readonly shareMinor: number;
}

export type SplitEffect =
  | { readonly type: 'DEBIT_MEMBER'; readonly idempotencyKey: string; readonly memberId: string; readonly mandateId: string; readonly amountMinor: number; readonly currency: string }
  | { readonly type: 'SEND_PAYMENT_REQUEST'; readonly idempotencyKey: string; readonly memberId: string; readonly amountMinor: number; readonly currency: string; readonly dueOn: IsoDate; readonly why: 'NO_MANDATE' | 'ABOVE_MANDATE' | 'NOT_A_BANK_CUSTOMER' }
  | { readonly type: 'ASK_PRICE_CONSENT'; readonly memberId: string; readonly currentMaxMinor: number; readonly newShareMinor: number }
  | { readonly type: 'SEND_REMINDER'; readonly idempotencyKey: string; readonly memberId: string; readonly outstandingMinor: number }
  | { readonly type: 'SUGGEST_REMOVE_MEMBER'; readonly memberId: string; readonly overdueCount: number };

export const requestKey = (groupId: string, cycleId: string, memberId: string): string => `split:${groupId}:${cycleId}:${memberId}`;

function activeDays(member: SplitMember, cycle: Cycle): number {
  const from = compareDates(member.joinedOn, cycle.startsOn) > 0 ? member.joinedOn : cycle.startsOn;
  const to = member.leftOn !== undefined && compareDates(member.leftOn, cycle.endsOn) < 0 ? member.leftOn : cycle.endsOn;
  return compareDates(from, to) > 0 ? 0 : daysBetween(from, to) + 1;
}

export function planCycle(input: {
  readonly group: SplitGroup;
  readonly cycle: Cycle;
  /** What the merchant actually charged the organizer this cycle. */
  readonly chargedMinor: number;
  readonly chargeCurrency: string;
  readonly mandates: readonly Mandate[];
  readonly dueDays: number;
  readonly now: Instant;
}): { readonly shares: readonly MemberShare[]; readonly organizerShareMinor: number; readonly effects: readonly SplitEffect[] } {
  const { group, cycle } = input;
  assertInstant(input.now, 'now');
  assertDate(cycle.startsOn, 'startsOn');
  assertDate(cycle.endsOn, 'endsOn');
  invariant(compareDates(cycle.startsOn, cycle.endsOn) <= 0, 'INVALID_CYCLE', 'cycle ends before it starts');
  assertCurrency(group.currency);
  assertNonNegativeMinor(input.chargedMinor, 'chargedMinor');
  invariant(input.chargeCurrency === group.currency, 'CURRENCY_MISMATCH', 'the merchant charged in another currency; review the group first');
  invariant(Number.isInteger(input.dueDays) && input.dueDays >= 1, 'INVALID_DUE_DAYS', 'dueDays must be at least 1');
  invariant(group.members.some((m) => m.memberId === group.organizerId), 'ORGANIZER_NOT_MEMBER', 'the organizer must be a member');
  for (const m of group.members) {
    invariant(Number.isSafeInteger(m.weight) && m.weight >= 1, 'INVALID_WEIGHT', `weight for ${m.memberId} must be a positive integer`);
    if (m.leftOn !== undefined) invariant(compareDates(m.joinedOn, m.leftOn) <= 0, 'INVALID_MEMBERSHIP', `${m.memberId} left before joining`);
  }

  const weighted = group.members.map((m) => ({ id: m.memberId, days: activeDays(m, cycle), weight: m.weight * activeDays(m, cycle) }));
  const split = splitByWeight(input.chargedMinor, weighted.map(({ id, weight }) => ({ id, weight })));
  const shares = weighted
    .filter((w) => w.days > 0)
    .map((w) => ({ memberId: w.id, activeDays: w.days, shareMinor: split.get(w.id) ?? 0 }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));

  const dueOn = addDays(localDate(input.now), input.dueDays);
  const effects: SplitEffect[] = [];
  for (const s of shares) {
    if (s.memberId === group.organizerId || s.shareMinor === 0) continue;
    const member = group.members.find((m) => m.memberId === s.memberId) as SplitMember;
    const key = requestKey(group.groupId, cycle.cycleId, s.memberId);
    const request = (why: 'NO_MANDATE' | 'ABOVE_MANDATE' | 'NOT_A_BANK_CUSTOMER'): SplitEffect => ({ type: 'SEND_PAYMENT_REQUEST', idempotencyKey: key, memberId: s.memberId, amountMinor: s.shareMinor, currency: group.currency, dueOn, why });
    if (!member.bankCustomer) {
      effects.push(request('NOT_A_BANK_CUSTOMER'));
      continue;
    }
    const mandate = input.mandates.find((x) => x.status === 'ACTIVE' && x.groupId === group.groupId && x.memberId === s.memberId && x.currency === group.currency);
    if (mandate === undefined) effects.push(request('NO_MANDATE'));
    else if (s.shareMinor > mandate.maxShareMinor) {
      effects.push(request('ABOVE_MANDATE'), { type: 'ASK_PRICE_CONSENT', memberId: s.memberId, currentMaxMinor: mandate.maxShareMinor, newShareMinor: s.shareMinor });
    } else {
      effects.push({ type: 'DEBIT_MEMBER', idempotencyKey: key, memberId: s.memberId, mandateId: mandate.mandateId, amountMinor: s.shareMinor, currency: group.currency });
    }
  }
  return { shares, organizerShareMinor: shares.find((s) => s.memberId === group.organizerId)?.shareMinor ?? 0, effects };
}

export interface RequestState {
  readonly idempotencyKey: string;
  readonly memberId: string;
  readonly amountMinor: number;
  readonly paidMinor: number;
  readonly dueOn: IsoDate;
  readonly reminded: boolean;
}

export interface CollectionPolicy {
  /** Days after the due date before one reminder is sent. */
  readonly reminderAfterDays: number;
  /** Overdue requests from one member before the organizer is offered to remove them. */
  readonly suggestRemovalAfter: number;
}

export const DEFAULT_COLLECTION_POLICY: CollectionPolicy = { reminderAfterDays: 3, suggestRemovalAfter: 2 };

/**
 * Unpaid shares stay the organizer's shortfall. Nothing here debits anyone or moves the
 * missing amount onto the other members; that would need their fresh consent.
 */
export function assessCollections(requests: readonly RequestState[], now: Instant, policy: CollectionPolicy = DEFAULT_COLLECTION_POLICY): { readonly shortfallMinor: number; readonly effects: readonly SplitEffect[] } {
  assertInstant(now, 'now');
  const today = localDate(now);
  const effects: SplitEffect[] = [];
  const overdueByMember = new Map<string, number>();
  let shortfall = 0;
  for (const r of [...requests].sort((a, b) => (a.idempotencyKey < b.idempotencyKey ? -1 : 1))) {
    assertNonNegativeMinor(r.amountMinor);
    assertNonNegativeMinor(r.paidMinor, 'paidMinor');
    const outstanding = Math.max(0, r.amountMinor - r.paidMinor);
    if (outstanding === 0 || compareDates(today, r.dueOn) <= 0) continue;
    shortfall += outstanding;
    overdueByMember.set(r.memberId, (overdueByMember.get(r.memberId) ?? 0) + 1);
    if (!r.reminded && daysBetween(r.dueOn, today) >= policy.reminderAfterDays) {
      effects.push({ type: 'SEND_REMINDER', idempotencyKey: `${r.idempotencyKey}:reminder`, memberId: r.memberId, outstandingMinor: outstanding });
    }
  }
  for (const [memberId, count] of [...overdueByMember].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count >= policy.suggestRemovalAfter) effects.push({ type: 'SUGGEST_REMOVE_MEMBER', memberId, overdueCount: count });
  }
  return { shortfallMinor: shortfall, effects };
}
