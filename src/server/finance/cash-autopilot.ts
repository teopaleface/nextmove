import { divRoundHalfUp } from "../../shared/money";
import { TIMEZONE, toMs } from "../../shared/time";

// Deterministic cash-autopilot calculations (O7 bill vault, O8 overdraft shield). Pure functions over minor
// units and epoch milliseconds; the capability layer reads bank state and turns the results into proposals.

export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------------------------------- calendar */

function localParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour: +get("hour"), weekday: get("weekday") };
}

/** Epoch ms of a wall-clock hour in Europe/Bucharest (EET/EEST). */
export function atLocal(year: number, month: number, day: number, hour: number): number {
  for (const offsetH of [2, 3]) {
    const ms = Date.UTC(year, month - 1, day, hour - offsetH, 0, 0);
    const p = localParts(ms);
    if (p.day === new Date(Date.UTC(year, month - 1, day)).getUTCDate() && p.hour === hour) return ms;
  }
  return Date.UTC(year, month - 1, day, hour - 2, 0, 0);
}

/** The previous business day (Mon–Fri) before the local calendar day of `dueMs`, at `hour` local time. */
export function businessDayBefore(dueMs: number, hour: number): number {
  const p = localParts(dueMs);
  let d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  do d = new Date(d.getTime() - DAY_MS);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return atLocal(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour);
}

/** Next monthly payday after a salary credit: same day of the following month (clamped to month length). */
export function nextPayday(lastSalaryMs: number, dayOfMonth: number, hour: number): number {
  const p = localParts(lastSalaryMs);
  const y = p.month === 12 ? p.year + 1 : p.year;
  const m = p.month === 12 ? 1 : p.month + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return atLocal(y, m, Math.min(dayOfMonth, last), hour);
}

/** Simple interest for whole days at an annual percentage rate, rounded half up to the ban. */
export function interestMinor(amountMinor: number, annualRatePct: number, days: number): number {
  if (amountMinor <= 0 || days <= 0) return 0;
  const bps = Math.round(annualRatePct * 100);
  return divRoundHalfUp(amountMinor * bps * days, 10_000 * 365);
}

/** Calendar days between two instants' local dates (Europe/Bucharest); interest accrues per calendar day. */
export function wholeDays(fromMs: number, toMs_: number): number {
  const a = localParts(fromMs);
  const b = localParts(toMs_);
  return Math.max(0, Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS));
}

/* ------------------------------------------------------------------------------------------ bill vault */

export interface Outflow {
  id: string;
  label: string;
  amountMinor: number; // positive amount that will leave the account
  dueAt: string;
}

export type VaultBillStatus = "PARK" | "TOO_SOON" | "AFTER_PAYDAY" | "NO_ROOM";

export interface VaultPlan {
  bills: (Outflow & { status: VaultBillStatus; returnAt: string | null })[];
  returns: { returnAt: string; amountMinor: number; billIds: string[]; labels: string[]; days: number; interestMinor: number }[];
  parkMinor: number;
  interestMinor: number;
  capacityMinor: number;
  keptForSoonMinor: number;
  soonCutoffAt: number;
}

/**
 * Plan the bill vault after a salary credit. Bills due at least `minDaysAway` days from now and before the
 * next payday are parked; each comes back one business day before it is due. Money needed sooner (bills
 * inside the cutoff and the chosen Daily buffer) is never parked.
 */
export function planVault(input: {
  nowMs: number;
  nextPaydayMs: number;
  dailyBalanceMinor: number;
  keepInDailyMinor: number;
  minDaysAway: number;
  annualRatePct: number;
  returnHourLocal: number;
  outflows: Outflow[];
  toIso: (ms: number) => string;
}): VaultPlan {
  const soonCutoff = input.nowMs + input.minDaysAway * DAY_MS;
  const sorted = [...input.outflows].filter((o) => o.amountMinor > 0 && toMs(o.dueAt) >= input.nowMs).sort((a, b) => toMs(a.dueAt) - toMs(b.dueAt) || a.id.localeCompare(b.id));
  const soon = sorted.filter((o) => toMs(o.dueAt) < soonCutoff);
  const keptForSoon = soon.reduce((s, o) => s + o.amountMinor, 0);
  const capacity = Math.max(0, input.dailyBalanceMinor - input.keepInDailyMinor - keptForSoon);
  let parked = 0;
  const bills: VaultPlan["bills"] = sorted.map((o) => {
    const due = toMs(o.dueAt);
    if (due < soonCutoff) return { ...o, status: "TOO_SOON", returnAt: null };
    if (due >= input.nextPaydayMs) return { ...o, status: "AFTER_PAYDAY", returnAt: null };
    if (parked + o.amountMinor > capacity) return { ...o, status: "NO_ROOM", returnAt: null };
    parked += o.amountMinor;
    return { ...o, status: "PARK", returnAt: input.toIso(businessDayBefore(due, input.returnHourLocal)) };
  });
  const groups = new Map<string, VaultPlan["returns"][number]>();
  for (const b of bills) {
    if (b.status !== "PARK" || !b.returnAt) continue;
    const g = groups.get(b.returnAt) ?? { returnAt: b.returnAt, amountMinor: 0, billIds: [], labels: [], days: wholeDays(input.nowMs, toMs(b.returnAt)), interestMinor: 0 };
    g.amountMinor += b.amountMinor;
    g.billIds.push(b.id);
    g.labels.push(b.label);
    groups.set(b.returnAt, g);
  }
  const returns = [...groups.values()].sort((a, b) => toMs(a.returnAt) - toMs(b.returnAt));
  for (const r of returns) r.interestMinor = interestMinor(r.amountMinor, input.annualRatePct, r.days);
  return { bills, returns, parkMinor: parked, interestMinor: returns.reduce((s, r) => s + r.interestMinor, 0), capacityMinor: capacity, keptForSoonMinor: keptForSoon, soonCutoffAt: soonCutoff };
}

/* ------------------------------------------------------------------------------------- overdraft shield */

export interface Flow {
  id: string;
  label: string;
  amountMinor: number; // signed: negative leaves the account
  at: string;
}

export interface Projection {
  points: { id: string; label: string; at: string; amountMinor: number; balanceMinor: number }[];
  lowestMinor: number;
  lowestAt: string | null;
  firstBelowFloor: { id: string; label: string; at: string; amountMinor: number; balanceMinor: number } | null;
}

/** Running balance over dated flows inside [now, horizon). Same-instant flows apply debits before credits. */
export function project(startMinor: number, nowMs: number, horizonMs: number, flows: Flow[], floorMinor = 0): Projection {
  const inside = flows.filter((f) => toMs(f.at) >= nowMs && toMs(f.at) < horizonMs).sort((a, b) => toMs(a.at) - toMs(b.at) || a.amountMinor - b.amountMinor || a.id.localeCompare(b.id));
  let bal = startMinor;
  let lowest = startMinor;
  let lowestAt: string | null = null;
  let first: Projection["firstBelowFloor"] = null;
  const points = inside.map((f) => {
    bal += f.amountMinor;
    const p = { id: f.id, label: f.label, at: f.at, amountMinor: f.amountMinor, balanceMinor: bal };
    if (bal < lowest) {
      lowest = bal;
      lowestAt = f.at;
    }
    if (!first && bal < floorMinor) first = p;
    return p;
  });
  return { points, lowestMinor: lowest, lowestAt, firstBelowFloor: first };
}

/** Fictional overdraft cost of a projection: one fee if the balance goes below zero, plus daily interest. */
export function overdraftCostMinor(startMinor: number, nowMs: number, horizonMs: number, flows: Flow[], terms: { annualRatePct: number; feePerEventMinor: number }): { costMinor: number; feeMinor: number; interestMinor: number; daysOverdrawn: number } {
  const pr = project(startMinor, nowMs, horizonMs, flows);
  const steps = [{ at: nowMs, bal: startMinor }, ...pr.points.map((p) => ({ at: toMs(p.at), bal: p.balanceMinor }))];
  const bps = Math.round(terms.annualRatePct * 100);
  let weighted = 0; // overdrawn bani × ms
  let overdrawnMs = 0;
  for (let i = 0; i < steps.length; i++) {
    const end = i + 1 < steps.length ? steps[i + 1].at : horizonMs;
    if (steps[i].bal < 0 && end > steps[i].at) {
      weighted += -steps[i].bal * (end - steps[i].at);
      overdrawnMs += end - steps[i].at;
    }
  }
  if (overdrawnMs === 0) return { costMinor: 0, feeMinor: 0, interestMinor: 0, daysOverdrawn: 0 };
  const interest = Math.round((weighted * bps) / (10_000 * 365 * DAY_MS));
  return { costMinor: terms.feePerEventMinor + interest, feeMinor: terms.feePerEventMinor, interestMinor: interest, daysOverdrawn: Math.ceil(overdrawnMs / DAY_MS) };
}

export interface ShieldSource {
  accountId: string;
  name: string;
  balanceMinor: number;
  keepMinor: number;
  annualRatePct: number;
  withdrawalFeeMinor: number;
  excludedReason?: string | null;
}

export interface ShieldPlan {
  lowestMinor: number;
  lowestAt: string | null;
  trigger: Projection["firstBelowFloor"];
  needMinor: number;
  legs: { accountId: string; name: string; amountMinor: number; forgoneInterestMinor: number; feeMinor: number }[];
  coveredMinor: number;
  shortfallMinor: number;
  overdraftWithoutMinor: ReturnType<typeof overdraftCostMinor>;
  overdraftAfterMinor: ReturnType<typeof overdraftCostMinor>;
  sources: (ShieldSource & { availableMinor: number; usedMinor: number })[];
}

/**
 * Find the exact top-up that keeps the account at or above `floorMinor` until the horizon (next income), taken
 * from the cheapest eligible pockets first (lowest rate forgone, then lowest fee). When the pockets cannot
 * cover it, the plan is partial and the shortfall is explicit.
 */
export function planShield(input: { balanceMinor: number; floorMinor: number; nowMs: number; horizonMs: number; flows: Flow[]; sources: ShieldSource[]; overdraft: { annualRatePct: number; feePerEventMinor: number } }): ShieldPlan {
  const pr = project(input.balanceMinor, input.nowMs, input.horizonMs, input.flows, input.floorMinor);
  const need = Math.max(0, input.floorMinor - pr.lowestMinor);
  const days = wholeDays(input.nowMs, input.horizonMs);
  const ranked = input.sources
    .map((s) => ({ ...s, availableMinor: s.excludedReason ? 0 : Math.max(0, s.balanceMinor - s.keepMinor - s.withdrawalFeeMinor), usedMinor: 0 }))
    .sort((a, b) => a.annualRatePct - b.annualRatePct || a.withdrawalFeeMinor - b.withdrawalFeeMinor || a.accountId.localeCompare(b.accountId));
  let remaining = need;
  const legs: ShieldPlan["legs"] = [];
  for (const s of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, s.availableMinor);
    if (take <= 0) continue;
    s.usedMinor = take;
    legs.push({ accountId: s.accountId, name: s.name, amountMinor: take, forgoneInterestMinor: interestMinor(take, s.annualRatePct, days), feeMinor: s.withdrawalFeeMinor });
    remaining -= take;
  }
  const covered = need - remaining;
  return {
    lowestMinor: pr.lowestMinor,
    lowestAt: pr.lowestAt,
    trigger: pr.firstBelowFloor,
    needMinor: need,
    legs,
    coveredMinor: covered,
    shortfallMinor: remaining,
    overdraftWithoutMinor: overdraftCostMinor(input.balanceMinor, input.nowMs, input.horizonMs, input.flows, input.overdraft),
    overdraftAfterMinor: overdraftCostMinor(input.balanceMinor + covered, input.nowMs, input.horizonMs, input.flows, input.overdraft),
    sources: ranked,
  };
}
