import { assertMinor, ceilDiv, divRoundHalfUp, sumMinor, MoneyError } from "../../shared/money";
import { toMs, toLocalIso, addDaysMs, inWindow, addLocalMonths, withLocalDay, localDaysBetween } from "../../shared/time";

// Deterministic calculators for the optimisation, recovery and planning capabilities (A2–A14).
// Inputs are explicit; unknown values stay unknown and are reported instead of being treated as zero.

/* ----------------------------------------------------------------- A2 right-size */
export interface PlanOption {
  id: string;
  name: string;
  monthlyMinor: number;
  dataGb: number;
  hotspot: boolean;
  euRoamingGb: number;
}

export function rightSizePlan(input: { currentPlanId: string; plans: PlanOption[]; usageGb: number[]; hotspotRequired: boolean | null }) {
  if (!input.usageGb.length) throw new MoneyError("Usage history is required");
  const current = input.plans.find((p) => p.id === input.currentPlanId);
  if (!current) throw new MoneyError("Current plan not found in catalog");
  const peak = Math.max(...input.usageGb);
  const average = Math.round((input.usageGb.reduce((s, v) => s + v, 0) / input.usageGb.length) * 10) / 10;
  const rows = input.plans.map((p) => {
    const lost: string[] = [];
    if (current.hotspot && !p.hotspot) lost.push("Hotspot");
    if (p.euRoamingGb < current.euRoamingGb) lost.push(`EU roaming ${current.euRoamingGb} GB → ${p.euRoamingGb} GB`);
    if (p.dataGb < current.dataGb) lost.push(`Data ${current.dataGb} GB → ${p.dataGb} GB`);
    const fitsPeak = p.dataGb >= peak;
    const hotspotOk = input.hotspotRequired === null ? null : !input.hotspotRequired || p.hotspot;
    const compatible = fitsPeak && hotspotOk !== false;
    return {
      id: p.id,
      name: p.name,
      monthlyMinor: p.monthlyMinor,
      dataGb: p.dataGb,
      headroomGb: Math.round((p.dataGb - peak) * 10) / 10,
      fitsPeak,
      hotspotOk,
      lostBenefits: lost,
      monthlySavingMinor: current.monthlyMinor - p.monthlyMinor,
      compatible,
      isCurrent: p.id === current.id,
    };
  });
  const candidates = rows.filter((r) => !r.isCurrent && r.compatible && r.monthlySavingMinor > 0).sort((a, b) => a.monthlyMinor - b.monthlyMinor);
  return {
    peakGb: peak,
    averageGb: average,
    rows,
    recommendedId: candidates[0]?.id ?? null,
    unknowns: input.hotspotRequired === null ? ["Whether you need hotspot"] : [],
    note: "Usage is the merchant's reported cellular data per billing cycle; Wi-Fi use is not included.",
  };
}

/* ----------------------------------------------------------------- A3 monthly vs annual */
export function monthlyVsAnnual(input: { monthlyMinor: number; annualMinor: number; horizonMonths: number }) {
  const { monthlyMinor, annualMinor, horizonMonths } = input;
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 60) throw new MoneyError("Horizon must be 1–60 months");
  const monthlyTotal = assertMinor(monthlyMinor * horizonMonths);
  const annualPayments = Math.ceil(horizonMonths / 12);
  const annualTotal = assertMinor(annualMinor * annualPayments);
  const committedMonths = annualPayments * 12;
  const breakEvenMonths = ceilDiv(annualMinor, monthlyMinor); // months of use at which monthly spend reaches the annual price
  const better = monthlyTotal < annualTotal ? "MONTHLY" : monthlyTotal > annualTotal ? "ANNUAL" : "EQUAL";
  return {
    horizonMonths,
    monthlyTotalMinor: monthlyTotal,
    annualTotalMinor: annualTotal,
    annualPayments,
    committedMonths,
    unusedCommittedMonths: committedMonths - horizonMonths,
    breakEvenMonths,
    differenceMinor: Math.abs(monthlyTotal - annualTotal),
    better,
    nextRenewalCashImpactMinor: annualMinor - monthlyMinor,
    note: "Annual is cheaper only when you would keep the plan past the break-even month. The annual charge is due at once.",
  };
}

/* ----------------------------------------------------------------- A4 price changes */
export interface ChargeEvidence {
  id: string;
  amountMinor: number; // positive charge amount
  bookedAt: string;
}
export interface PriceNotice {
  termsRevision: number;
  monthlyMinor: number;
  effectiveFrom: string;
  noticeDate: string | null;
  noticeText?: string;
}

export function detectPriceChanges(input: { contractKey: string; charges: ChargeEvidence[]; notices: PriceNotice[] }) {
  const charges = [...input.charges].sort((a, b) => toMs(a.bookedAt) - toMs(b.bookedAt));
  const findings: {
    dedupeKey: string;
    fromMinor: number;
    toMinor: number;
    changeMinor: number;
    changeBasisPoints: number;
    firstChargedAt: string;
    evidence: string[];
    explanation: "MERCHANT_NOTICE" | "UNEXPLAINED";
    notice: PriceNotice | null;
  }[] = [];
  for (let i = 1; i < charges.length; i++) {
    const prev = charges[i - 1];
    const cur = charges[i];
    if (prev.amountMinor === cur.amountMinor) continue;
    const notice =
      input.notices
        .filter((n) => n.monthlyMinor === cur.amountMinor && toMs(n.effectiveFrom) <= toMs(cur.bookedAt))
        .sort((a, b) => b.termsRevision - a.termsRevision)[0] ?? null;
    findings.push({
      dedupeKey: `${input.contractKey}:price:${notice ? `rev${notice.termsRevision}` : cur.id}`,
      fromMinor: prev.amountMinor,
      toMinor: cur.amountMinor,
      changeMinor: cur.amountMinor - prev.amountMinor,
      changeBasisPoints: divRoundHalfUp((cur.amountMinor - prev.amountMinor) * 10000, prev.amountMinor),
      firstChargedAt: cur.bookedAt,
      evidence: [prev.id, cur.id],
      explanation: notice ? "MERCHANT_NOTICE" : "UNEXPLAINED",
      notice,
    });
  }
  return { findings };
}

/* ----------------------------------------------------------------- A5 content schedule */
export interface CatalogTitle {
  id: string;
  title: string;
  service: string;
  availableFrom: string; // YYYY-MM-DD
  availableUntil: string | null;
}

export function planContentSchedule(input: {
  wanted: { titleId: string; watchFrom: string; watchUntil: string }[];
  titles: CatalogTitle[];
  services: { id: string; name: string; monthlyMinor: number }[];
  alreadySubscribed: string[];
}) {
  const periodDays = 30;
  const dayMs = 86_400_000;
  const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / dayMs;
  const fromDay = (n: number) => new Date(n * dayMs).toISOString().slice(0, 10);
  const issues: string[] = [];
  const byService = new Map<string, { from: number; until: number; titles: string[] }[]>();
  for (const w of input.wanted) {
    const t = input.titles.find((x) => x.id === w.titleId);
    if (!t) {
      issues.push(`Unknown title ${w.titleId}`);
      continue;
    }
    const start = Math.max(toDay(w.watchFrom), toDay(t.availableFrom));
    const end = t.availableUntil ? Math.min(toDay(w.watchUntil), toDay(t.availableUntil)) : toDay(w.watchUntil);
    if (end < start) {
      issues.push(`${t.title} is not available in the dates you chose`);
      continue;
    }
    const arr = byService.get(t.service) ?? [];
    arr.push({ from: start, until: end, titles: [t.title] });
    byService.set(t.service, arr);
  }
  const periods: { serviceId: string; serviceName: string; start: string; end: string; costMinor: number; titles: string[]; alreadySubscribed: boolean }[] = [];
  let rotationTotal = 0;
  let continuousTotal = 0;
  for (const [serviceId, windows] of byService) {
    const svc = input.services.find((s) => s.id === serviceId);
    const subscribed = input.alreadySubscribed.includes(serviceId);
    if (!svc && !subscribed) {
      issues.push(`No terms for ${serviceId}`);
      continue;
    }
    windows.sort((a, b) => a.from - b.from);
    // Greedy cover with 30-day paid periods starting at the first uncovered viewing day.
    let cursor = -Infinity;
    let current: { start: number; end: number; titles: string[] } | null = null;
    const svcPeriods: { start: number; end: number; titles: string[] }[] = [];
    for (const w of windows) {
      let day = Math.max(w.from, cursor);
      while (day <= w.until) {
        if (!current || day > current.end) {
          current = { start: day, end: day + periodDays - 1, titles: [] };
          svcPeriods.push(current);
        }
        if (!current.titles.includes(w.titles[0])) current.titles.push(w.titles[0]);
        day = current.end + 1;
        cursor = day;
      }
    }
    if (subscribed) {
      for (const p of svcPeriods) periods.push({ serviceId, serviceName: svc?.name ?? serviceId, start: fromDay(p.start), end: fromDay(p.end), costMinor: 0, titles: p.titles, alreadySubscribed: true });
      continue;
    }
    for (const p of svcPeriods) {
      periods.push({ serviceId, serviceName: svc!.name, start: fromDay(p.start), end: fromDay(p.end), costMinor: svc!.monthlyMinor, titles: p.titles, alreadySubscribed: false });
      rotationTotal += svc!.monthlyMinor;
    }
    const first = svcPeriods[0]?.start;
    const last = svcPeriods[svcPeriods.length - 1]?.end;
    if (first != null && last != null) continuousTotal += Math.ceil((last - first + 1) / periodDays) * svc!.monthlyMinor;
  }
  periods.sort((a, b) => a.start.localeCompare(b.start));
  return {
    periods,
    rotationTotalMinor: rotationTotal,
    continuousTotalMinor: continuousTotal,
    differenceMinor: continuousTotal - rotationTotal,
    issues,
    assumptions: [
      "Availability comes from a fictional versioned catalog and can change; re-check before each start.",
      "Each start is a separate commitment that needs its own approval.",
      "Paid periods last 30 days from the start date; renewal is turned off at sign-up.",
    ],
  };
}

/* ----------------------------------------------------------------- A6 pause */
export function pauseEffect(input: { monthlyMinor: number; pauseStartsAt: string; months: number; allowedMonths: number[]; feeMinor: number; window: { startInclusive: string; endExclusive: string } }) {
  if (!input.allowedMonths.includes(input.months)) throw new MoneyError(`Pause of ${input.months} month(s) is not offered`);
  // Calendar months in Europe/Bucharest, the same maths the merchant uses for the resume date.
  const start = toMs(input.pauseStartsAt);
  const skipped: string[] = [];
  for (let i = 0; i < input.months; i++) skipped.push(toLocalIso(addLocalMonths(start, i)));
  const skippedInWindow = skipped.filter((s) => inWindow(s, input.window.startInclusive, input.window.endExclusive));
  return {
    accessEndsAt: input.pauseStartsAt,
    resumesAt: toLocalIso(addLocalMonths(start, input.months)),
    skippedCharges: skipped,
    skippedInWindowMinor: skippedInWindow.length * input.monthlyMinor,
    totalSkippedMinor: skipped.length * input.monthlyMinor,
    feeMinor: input.feeMinor,
    resumePriceMinor: input.monthlyMinor,
    note: "A pause is not a cancellation: the plan restarts automatically at the resume date and price.",
  };
}

/* ----------------------------------------------------------------- A8 possible duplicates */
export interface TxnLite {
  id: string;
  merchantName: string;
  amountMinor: number;
  status: "POSTED" | "PENDING" | "RELEASED";
  bookedAt: string;
  orderRef?: string | null;
  authId?: string | null;
}

export type DuplicateClass = "AUTHORIZATION_HOLD" | "LIKELY_TWO_PURCHASES" | "POSSIBLE_SETTLED_DUPLICATE";

export function classifyPossibleDuplicates(txns: TxnLite[], windowHours = 48) {
  const groups: { key: string; transactions: TxnLite[]; classification: DuplicateClass; reason: string; claimable: boolean; question: string | null }[] = [];
  const debits = txns.filter((t) => t.amountMinor < 0 && t.status !== "RELEASED").sort((a, b) => toMs(a.bookedAt) - toMs(b.bookedAt));
  const used = new Set<string>();
  for (let i = 0; i < debits.length; i++) {
    if (used.has(debits[i].id)) continue;
    const a = debits[i];
    const peers = debits.filter(
      (b) => b.id !== a.id && !used.has(b.id) && b.merchantName === a.merchantName && b.amountMinor === a.amountMinor && Math.abs(toMs(b.bookedAt) - toMs(a.bookedAt)) <= windowHours * 3_600_000,
    );
    if (!peers.length) continue;
    const b = peers[0];
    used.add(a.id);
    used.add(b.id);
    const pair = [a, b];
    const pending = pair.filter((t) => t.status === "PENDING");
    const sameRef = a.orderRef && b.orderRef && a.orderRef === b.orderRef;
    const sameAuth = a.authId && b.authId && a.authId === b.authId;
    let classification: DuplicateClass;
    let reason: string;
    let question: string | null = null;
    if (pending.length === 1 && (sameRef || sameAuth)) {
      classification = "AUTHORIZATION_HOLD";
      reason = "One payment is posted and the other is a pending card authorization for the same purchase. The hold should be released; no claim is needed.";
    } else if (pending.length === 0 && sameRef) {
      classification = "POSSIBLE_SETTLED_DUPLICATE";
      reason = `Two posted payments share order reference ${a.orderRef}, ${Math.round(Math.abs(toMs(b.bookedAt) - toMs(a.bookedAt)) / 60000)} minutes apart.`;
      question = `Did you place only one order with ${a.merchantName}?`;
    } else {
      classification = "LIKELY_TWO_PURCHASES";
      reason = "Same merchant and amount, but different references and times. These look like two separate purchases.";
      question = `Were these two separate ${a.merchantName} purchases?`;
    }
    groups.push({ key: pair.map((t) => t.id).sort().join("+"), transactions: pair, classification, reason, claimable: classification === "POSSIBLE_SETTLED_DUPLICATE", question });
  }
  return { groups };
}

/* ----------------------------------------------------------------- A9 price adjustment */
export function priceAdjustmentCheck(input: {
  policy: { windowDays: number; policyRevision: number; text: string } | null;
  purchase: { sku: string; paidMinor: number; purchasedAt: string; seller: string };
  currentPrice: { sku: string; priceMinor: number; observedAt: string; clearance: boolean; seller: string };
  nowIso: string;
  merchantSeller: string;
}) {
  if (!input.policy) {
    return { eligible: false, status: "UNKNOWN_POLICY", differenceMinor: null, reasons: ["No documented price-adjustment policy; eligibility cannot be claimed."], windowEndsAt: null };
  }
  const windowEnd = toLocalIso(addDaysMs(toMs(input.purchase.purchasedAt), input.policy.windowDays));
  const reasons: string[] = [];
  const checks = [
    { ok: input.purchase.sku === input.currentPrice.sku, text: "Same item (SKU)" },
    { ok: input.currentPrice.seller === input.merchantSeller && input.purchase.seller === input.merchantSeller, text: "Sold by the merchant, not a marketplace seller" },
    { ok: !input.currentPrice.clearance, text: "Not a clearance price" },
    { ok: toMs(input.nowIso) <= toMs(windowEnd), text: `Inside the ${input.policy.windowDays}-day window` },
    { ok: input.currentPrice.priceMinor < input.purchase.paidMinor, text: "Current price is lower than the price paid" },
  ];
  for (const c of checks) if (!c.ok) reasons.push(`Fails: ${c.text}`);
  const eligible = reasons.length === 0;
  return {
    eligible,
    status: eligible ? "ELIGIBLE" : "NOT_ELIGIBLE",
    differenceMinor: eligible ? input.purchase.paidMinor - input.currentPrice.priceMinor : null,
    checks,
    reasons,
    windowEndsAt: windowEnd,
  };
}

/* ----------------------------------------------------------------- A10 total cost of ownership */
export interface TcoOption {
  id: string;
  name: string;
  priceMinor: number;
  requiredAccessoriesMinor: number;
  requiredAccessoriesNote?: string;
  protectionMonthlyMinor: number;
  batteryServiceMinor: number;
  batteryServiceMonth: number;
  resaleMinor: number | null;
}

export function totalCostOfOwnership(input: { options: TcoOption[]; horizonMonths: number; includeProtection: boolean }) {
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 6 || input.horizonMonths > 60) throw new MoneyError("Horizon must be 6–60 months");
  const rows = input.options.map((o) => {
    const parts = [
      { label: "Purchase price", minor: o.priceMinor },
      { label: o.requiredAccessoriesNote ? `Required accessories (${o.requiredAccessoriesNote.toLowerCase()})` : "Required accessories", minor: o.requiredAccessoriesMinor },
      { label: `Protection plan × ${input.horizonMonths} months`, minor: input.includeProtection ? o.protectionMonthlyMinor * input.horizonMonths : 0 },
      { label: `Battery service (month ${o.batteryServiceMonth})`, minor: o.batteryServiceMonth <= input.horizonMonths ? o.batteryServiceMinor : 0 },
    ];
    const total = sumMinor(parts.map((p) => p.minor));
    return {
      id: o.id,
      name: o.name,
      parts,
      totalMinor: total,
      monthlyEquivalentMinor: divRoundHalfUp(total, input.horizonMonths),
      unknowns: o.resaleMinor == null ? ["Resale value (not supplied, not subtracted)"] : [],
    };
  });
  const sorted = [...rows].sort((a, b) => a.totalMinor - b.totalMinor);
  return {
    horizonMonths: input.horizonMonths,
    includeProtection: input.includeProtection,
    rows,
    lowestId: sorted[0]?.id ?? null,
    differenceMinor: sorted.length > 1 ? sorted[sorted.length - 1].totalMinor - sorted[0].totalMinor : 0,
    note: "Same horizon for every option. Monthly instalments alone would hide the accessories, plan and service costs.",
  };
}

/* ----------------------------------------------------------------- A11 billing date */
export interface DatedFlow {
  id: string;
  label: string;
  amountMinor: number; // signed
  at: string;
}

export function billingDateOptions(input: {
  balanceMinor: number;
  flows: DatedFlow[]; // other dated flows in the period (income, essentials, other bills)
  bill: { id: string; label: string; amountMinor: number; currentDay: number; nextChargeAt: string };
  supportedDays: number[];
  failedPaymentFeeMinor: number;
  requestAt: string;
  minNoticeDays: number;
}) {
  const nextCharge = toMs(input.bill.nextChargeAt);
  const minNoticeMs = input.minNoticeDays * 86_400_000;
  const noticeOk = (ms: number) => ms - toMs(input.requestAt) >= minNoticeMs;
  const currentOk = noticeOk(nextCharge);
  const results = input.supportedDays.map((day) => {
    // Same rule as the merchant: the next bill moves to the new day of its local month (clamped), and both the
    // current and the new date must be at least the notice period away.
    const newDate = withLocalDay(nextCharge, day);
    const shift = localDaysBetween(nextCharge, newDate);
    const newDateTooSoon = currentOk && !noticeOk(newDate);
    const appliesNow = currentOk && !newDateTooSoon;
    const extraDays = Math.max(0, shift);
    const prorationMinor = shift > 0 ? divRoundHalfUp(input.bill.amountMinor * extraDays, 30) : 0;
    const chargeAt = appliesNow ? toLocalIso(newDate) : input.bill.nextChargeAt;
    const chargeMinor = input.bill.amountMinor + (appliesNow ? prorationMinor : 0);
    const flows = [...input.flows, { id: input.bill.id, label: input.bill.label, amountMinor: -chargeMinor, at: chargeAt }].sort((a, b) => toMs(a.at) - toMs(b.at));
    let bal = input.balanceMinor;
    let min = bal;
    let failedAt: string | null = null;
    for (const f of flows) {
      if (f.id === input.bill.id && bal + f.amountMinor < 0) failedAt = f.at;
      bal += f.amountMinor;
      min = Math.min(min, bal);
    }
    return {
      billingDay: day,
      isCurrent: day === input.bill.currentDay,
      firstChargeAt: chargeAt,
      appliesToNextBill: appliesNow,
      newDateTooSoon,
      prorationMinor: appliesNow ? prorationMinor : 0,
      minimumBalanceMinor: min,
      paymentWouldFail: failedAt !== null,
      expectedFeeMinor: failedAt ? input.failedPaymentFeeMinor : 0,
    };
  });
  const current = results.find((r) => r.isCurrent)!;
  const better = results
    .filter((r) => !r.isCurrent && !r.paymentWouldFail)
    .sort((a, b) => a.prorationMinor - b.prorationMinor || b.minimumBalanceMinor - a.minimumBalanceMinor)[0];
  return {
    current,
    options: results,
    recommendedDay: current.paymentWouldFail && better ? better.billingDay : null,
    note: "Moving the date changes timing, not the price: the extra days are charged once.",
  };
}

/* ----------------------------------------------------------------- A12 expiring credit */
export function expiringCreditMatch(input: {
  credit: { balanceMinor: number; expiresAt: string; restrictions: string };
  intended: { title: string; priceMinor: number; category: string } | null;
  eligibleCategories: string[];
  nowIso: string;
}) {
  const expired = toMs(input.nowIso) > toMs(input.credit.expiresAt);
  if (!input.intended) {
    return { status: "NO_INTENDED_PURCHASE", coveredMinor: 0, uncoveredMinor: null, forfeitMinor: input.credit.balanceMinor, expired, note: "No purchase you already planned matches this credit. Buying something only to use it is not a saving." };
  }
  const eligible = !expired && input.eligibleCategories.includes(input.intended.category);
  const covered = eligible ? Math.min(input.credit.balanceMinor, input.intended.priceMinor) : 0;
  return {
    status: expired ? "EXPIRED" : eligible ? "MATCH" : "NOT_ELIGIBLE",
    coveredMinor: covered,
    uncoveredMinor: input.intended.priceMinor - covered,
    forfeitMinor: input.credit.balanceMinor - covered,
    expired,
    note: "Only a purchase you already intended is matched. The uncovered part is paid from your account if you approve.",
  };
}

/* ----------------------------------------------------------------- A13 business licences */
export interface Seat {
  seatId: string;
  user: string | null;
  role: string;
  lastActive: string | null;
  ownsSharedFiles: number;
  note: string | null;
}

export function reviewLicenses(input: { seats: Seat[]; seatPriceMinor: number; minimumSeats: number; inactivityThresholdDays: number; asOf: string }) {
  const asOfDay = Date.parse(`${input.asOf.slice(0, 10)}T00:00:00Z`);
  const rows = input.seats.map((s) => {
    const inactiveDays = s.lastActive ? Math.round((asOfDay - Date.parse(`${s.lastActive}T00:00:00Z`)) / 86_400_000) : null;
    let status: "ACTIVE" | "CANDIDATE" | "PROTECTED";
    let reason: string;
    if (!s.user) {
      status = "CANDIDATE";
      reason = "Unassigned seat";
    } else if (/owner|billing admin/i.test(s.role)) {
      status = "PROTECTED";
      reason = "Owner and billing admin";
    } else if (/service account/i.test(s.role)) {
      status = "PROTECTED";
      reason = "Required access dependency (service account)";
    } else if (s.note) {
      status = "PROTECTED";
      reason = `Inactivity has a known reason: ${s.note}`;
    } else if (inactiveDays != null && inactiveDays > input.inactivityThresholdDays && s.ownsSharedFiles > 0) {
      status = "PROTECTED";
      reason = `Owns ${s.ownsSharedFiles} shared files: transfer ownership first`;
    } else if (inactiveDays != null && inactiveDays > input.inactivityThresholdDays) {
      status = "CANDIDATE";
      reason = `Inactive for ${inactiveDays} days, owns no shared files`;
    } else {
      status = "ACTIVE";
      reason = inactiveDays == null ? "No activity data" : `Active ${inactiveDays} day(s) ago`;
    }
    return { ...s, inactiveDays, status, reason };
  });
  const candidates = rows.filter((r) => r.status === "CANDIDATE");
  const maxRemovable = Math.max(0, input.seats.length - input.minimumSeats);
  const removable = candidates.slice(0, maxRemovable);
  const seatsAfter = input.seats.length - removable.length;
  return {
    rows,
    candidateSeatIds: removable.map((r) => r.seatId),
    seatsBefore: input.seats.length,
    seatsAfter,
    invoiceBeforeMinor: input.seats.length * input.seatPriceMinor,
    invoiceAfterMinor: seatsAfter * input.seatPriceMinor,
    monthlyReductionMinor: removable.length * input.seatPriceMinor,
    minimumSeats: input.minimumSeats,
    note: "A recent inactivity gap alone is not proof that a seat is unused; protected seats need a separate decision.",
  };
}

/* ----------------------------------------------------------------- A14 travel */
export function travelComparison(input: {
  dataNeedGb: number;
  tripDays: number;
  homePlan: { name: string; euRoamingGb: number; extraEuGbMinor: number } | null;
  connectivity: { id: string; name: string; dataGb: number; validDays: number; costMinor: number; partnerOfNextMoveCard: boolean }[];
  benefit: { amountMinor: number; eligibleMerchants: string[]; verified: boolean | null };
  expectedCardSpendMinor: number;
  paymentMethods: { id: string; name: string; fxMarkupBasisPoints: number | null; fixedFeeMinor: number | null; source: string }[];
  fxRate: { rate: string; observedAt: string };
}) {
  const connectivity: { id: string; name: string; coversNeed: boolean; costMinor: number; benefitAppliedMinor: number | null; netMinor: number | null; note: string }[] = [];
  if (input.homePlan) {
    const missing = Math.max(0, Math.ceil(input.dataNeedGb - input.homePlan.euRoamingGb));
    const cost = missing * input.homePlan.extraEuGbMinor;
    connectivity.push({
      id: "home-plan",
      name: `Your ${input.homePlan.name} plan`,
      coversNeed: true,
      costMinor: cost,
      benefitAppliedMinor: 0,
      netMinor: cost,
      note: missing ? `${input.homePlan.euRoamingGb} GB EU roaming included; ${missing} GB extra at the plan's EU rate` : `${input.homePlan.euRoamingGb} GB EU roaming included covers your ${input.dataNeedGb} GB`,
    });
  }
  for (const c of input.connectivity) {
    const covers = c.dataGb >= input.dataNeedGb && c.validDays >= input.tripDays;
    const benefitEligible = c.partnerOfNextMoveCard && input.benefit.eligibleMerchants.includes(c.id);
    const applied = input.benefit.verified === null ? null : input.benefit.verified && benefitEligible ? Math.min(input.benefit.amountMinor, c.costMinor) : 0;
    connectivity.push({
      id: c.id,
      name: c.name,
      coversNeed: covers,
      costMinor: c.costMinor,
      benefitAppliedMinor: applied,
      netMinor: applied === null ? null : c.costMinor - applied,
      note: `${c.dataGb} GB for ${c.validDays} days${applied === null && benefitEligible ? "; card credit eligibility not yet checked" : ""}`,
    });
  }
  const rateScaled = Math.round(Number(input.fxRate.rate) * 10000);
  const spendEurCents = divRoundHalfUp(input.expectedCardSpendMinor * 10000, rateScaled);
  const payments = input.paymentMethods.map((p) => ({
    id: p.id,
    name: p.name,
    source: p.source,
    fxCostMinor: p.fxMarkupBasisPoints == null ? null : divRoundHalfUp(input.expectedCardSpendMinor * p.fxMarkupBasisPoints, 10000),
    fixedFeeMinor: p.fixedFeeMinor,
  }));
  const known = connectivity.filter((c) => c.coversNeed && c.netMinor != null).sort((a, b) => (a.netMinor as number) - (b.netMinor as number));
  const cheapestPayment = payments.filter((p) => p.fxCostMinor != null).sort((a, b) => (a.fxCostMinor as number) - (b.fxCostMinor as number))[0];
  return {
    connectivity,
    payments,
    spendEurCents,
    recommendedConnectivityId: known[0]?.id ?? null,
    recommendedPaymentId: cheapestPayment?.id ?? null,
    unknowns: [
      ...(input.benefit.verified === null ? ["Card travel credit eligibility"] : []),
      ...payments.filter((p) => p.fxCostMinor == null).map((p) => `${p.name} fees`),
    ],
    note: `FX uses the supplied fictional rate ${input.fxRate.rate} RON per EUR from ${input.fxRate.observedAt}; it is not a live rate.`,
  };
}
