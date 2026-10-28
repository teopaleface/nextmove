import { assertMinor, ceilDiv, divRoundHalfUp, sumMinor, MoneyError } from "../../shared/money";
import { addDaysMs, localDate, toLocalIso, toMs } from "../../shared/time";

// Deterministic detectors for losses that are visible in the bank statement (A15–A18).
// Each returns the evidence it used, so the capability can show it and the planner can only cite these numbers.

export interface Debit {
  id: string;
  bookedAt: string;
  /** Positive amount paid, in bani. */
  amountMinor: number;
}

/* ----------------------------------------------------------------- A15 delivery membership */
export function deliveryMembershipValue(input: {
  membershipMinor: number;
  deliveryFeeMinor: number;
  freeDeliveryMinOrderMinor: number;
  charges: Debit[];
  orders: Debit[];
  now: string;
  windowDays?: number;
}) {
  assertMinor(input.membershipMinor);
  if (input.deliveryFeeMinor <= 0) throw new MoneyError("Delivery fee must be positive");
  const windowDays = input.windowDays ?? 60;
  const nowMs = toMs(input.now);
  const startMs = addDaysMs(nowMs, -windowDays);
  const inWin = (d: Debit) => toMs(d.bookedAt) >= startMs && toMs(d.bookedAt) <= nowMs;
  const charges = input.charges.filter(inWin);
  const orders = input.orders.filter(inWin);
  const qualifying = orders.filter((o) => o.amountMinor >= input.freeDeliveryMinOrderMinor);
  const paidMinor = sumMinor(charges.map((c) => c.amountMinor));
  const savedMinor = qualifying.length * input.deliveryFeeMinor;
  const breakEvenOrdersPerMonth = ceilDiv(input.membershipMinor, input.deliveryFeeMinor);
  // Per billing month (YYYY-MM of each charge), so the customer sees when the habit changed.
  const months = [...new Set(input.charges.map((c) => localDate(toMs(c.bookedAt)).slice(0, 7)))].sort();
  const monthly = months.map((m) => {
    const n = input.orders.filter((o) => localDate(toMs(o.bookedAt)).slice(0, 7) === m && o.amountMinor >= input.freeDeliveryMinOrderMinor).length;
    return { month: m, orders: n, savedMinor: n * input.deliveryFeeMinor, feeMinor: input.membershipMinor, paidOff: n * input.deliveryFeeMinor >= input.membershipMinor };
  });
  const netLossMinor = paidMinor - savedMinor;
  return {
    windowStart: toLocalIso(startMs),
    windowDays,
    chargesInWindow: charges,
    ordersInWindow: orders.length,
    qualifyingOrders: qualifying.length,
    paidMinor,
    savedMinor,
    netLossMinor,
    breakEvenOrdersPerMonth,
    neededInWindow: breakEvenOrdersPerMonth * charges.length,
    paysOff: netLossMinor <= 0,
    lastPaidOffMonth: [...monthly].reverse().find((m) => m.paidOff)?.month ?? null,
    monthly,
  };
}

/* ----------------------------------------------------------------- A16 FX markup on foreign subscriptions */
export interface ForeignCharge extends Debit {
  merchantName: string;
  originalMinor: number;
  currency: string;
}

/** rates[currency][YYYY-MM-DD] = "4.9710" (RON per unit, fictional reference). */
export function fxMarkup(input: { charges: ForeignCharge[]; rates: Record<string, Record<string, string>>; minMarkupBasisPoints?: number }) {
  const min = input.minMarkupBasisPoints ?? 50;
  const rows = input.charges.map((c) => {
    const day = localDate(toMs(c.bookedAt));
    const rate = input.rates[c.currency]?.[day];
    if (!rate) return { ...c, day, rate: null, referenceMinor: null, markupMinor: null, markupBasisPoints: null };
    const rate4 = Math.round(Number(rate) * 10_000);
    const referenceMinor = divRoundHalfUp(c.originalMinor * rate4, 10_000);
    const markupMinor = c.amountMinor - referenceMinor;
    return { ...c, day, rate, referenceMinor, markupMinor, markupBasisPoints: divRoundHalfUp(markupMinor * 10_000, referenceMinor) };
  });
  const byMerchant = new Map<string, typeof rows>();
  for (const r of rows) byMerchant.set(r.merchantName, [...(byMerchant.get(r.merchantName) ?? []), r]);
  const merchants = [...byMerchant.entries()].map(([merchantName, rs]) => {
    const priced = rs.filter((r) => r.markupMinor != null);
    const observedMinor = sumMinor(priced.map((r) => r.markupMinor!));
    const avgMonthlyMinor = priced.length ? divRoundHalfUp(observedMinor, priced.length) : 0;
    const avgBps = priced.length ? divRoundHalfUp(sumMinor(priced.map((r) => r.markupBasisPoints!)), priced.length) : 0;
    return {
      merchantName,
      currency: rs[0].currency,
      originalMinor: rs[rs.length - 1].originalMinor,
      charges: rs.length,
      unpriced: rs.length - priced.length,
      observedMinor,
      avgMonthlyMinor,
      annualMinor: avgMonthlyMinor * 12,
      avgBasisPoints: avgBps,
      flagged: priced.length > 0 && avgBps >= min,
    };
  });
  const flagged = merchants.filter((m) => m.flagged);
  return {
    rows,
    merchants,
    flagged,
    observedMinor: sumMinor(flagged.map((m) => m.observedMinor)),
    annualMinor: sumMinor(flagged.map((m) => m.annualMinor)),
  };
}

/* ----------------------------------------------------------------- A17 paid but probably unused */
export type UseRisk = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export function behavioralFootprint(input: { membershipCharges: Debit[]; related: (Debit & { merchantName: string })[]; now: string }) {
  const charges = [...input.membershipCharges].sort((a, b) => toMs(a.bookedAt) - toMs(b.bookedAt));
  if (!charges.length) throw new MoneyError("Membership charges are required");
  const related = [...input.related].sort((a, b) => toMs(a.bookedAt) - toMs(b.bookedAt));
  // Each charge pays for the period until the next charge (or until now for the latest one).
  const cycles = charges.map((c, i) => {
    const from = toMs(c.bookedAt);
    const to = i + 1 < charges.length ? toMs(charges[i + 1].bookedAt) : toMs(input.now);
    const signals = related.filter((r) => toMs(r.bookedAt) >= from && toMs(r.bookedAt) < to);
    return { chargeId: c.id, chargedAt: c.bookedAt, paidMinor: c.amountMinor, until: toLocalIso(to), signals: signals.length };
  });
  let silent = 0;
  for (let i = cycles.length - 1; i >= 0 && cycles[i].signals === 0; i--) silent++;
  const active = cycles.slice(0, cycles.length - silent);
  const activeSignals = active.reduce((s, c) => s + c.signals, 0);
  const baselinePerCycle = active.length ? Math.round((activeSignals / active.length) * 10) / 10 : 0;
  const lastSignal = related.filter((r) => toMs(r.bookedAt) <= toMs(input.now)).slice(-1)[0] ?? null;
  const silentPaidMinor = sumMinor(cycles.slice(cycles.length - silent).map((c) => c.paidMinor));
  let risk: UseRisk;
  if (!activeSignals) risk = "UNKNOWN"; // no footprint ever: the statement cannot tell us anything
  else if (silent >= 3 && baselinePerCycle >= 2) risk = "HIGH";
  else if (silent >= 2) risk = "MEDIUM";
  else risk = "LOW";
  return {
    cycles,
    silentCycles: silent,
    silentPaidMinor,
    activeCycles: active.length,
    baselinePerCycle,
    lastSignalAt: lastSignal?.bookedAt ?? null,
    daysSinceLastSignal: lastSignal ? Math.floor((toMs(input.now) - toMs(lastSignal.bookedAt)) / 86_400_000) : null,
    risk,
  };
}

/* ----------------------------------------------------------------- A18 insurance you may already have */
export interface CoverRow {
  id: string;
  label: string;
  policy: string;
  card: string;
  gap: string | null;
}

export function coverageOverlap(input: { rows: CoverRow[]; tripPaidWithCard: boolean | null }) {
  const gaps = input.rows.filter((r) => r.gap);
  const overlap = input.rows.filter((r) => !r.gap);
  // Equivalence is never claimed while any difference exists.
  return { gaps, overlap, equivalent: gaps.length === 0, cardCoverAppliesToTrip: input.tripPaidWithCard };
}
