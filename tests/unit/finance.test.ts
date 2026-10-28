import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { traceCash, TraceError } from "../../src/server/finance/cashflow";
import { homeReadiness, comparePurchases, afterHomeBudget } from "../../src/server/finance/goals";
import { inventoryNeed, compareFunding, newShopPlan, withFunding, compareSupplierQuotes, ownerTransferEffect } from "../../src/server/finance/business";
import { compareSubscriptions, type ForecastEntry } from "../../src/server/finance/subscriptions";
import {
  rightSizePlan,
  monthlyVsAnnual,
  detectPriceChanges,
  planContentSchedule,
  pauseEffect,
  classifyPossibleDuplicates,
  priceAdjustmentCheck,
  totalCostOfOwnership,
  billingDateOptions,
  expiringCreditMatch,
  reviewLicenses,
  travelComparison,
} from "../../src/server/finance/capabilities";
import { divRoundHalfUp, formatMoney, parseMajorToMinor } from "../../src/shared/money";

const root = path.resolve(__dirname, "../..");
const cases = JSON.parse(fs.readFileSync(path.join(root, "demo/cases.json"), "utf8"));
const ui = JSON.parse(fs.readFileSync(path.join(root, "design/ui-fixtures.json"), "utf8"));
const caps = JSON.parse(fs.readFileSync(path.join(root, "demo/capability-scenarios.json"), "utf8"));

describe("money primitives", () => {
  it("formats and parses English RON amounts", () => {
    expect(formatMoney(11000000)).toBe("110,000.00 RON");
    expect(formatMoney(-4900)).toBe("−49.00 RON");
    expect(parseMajorToMinor("1,234.56")).toBe(123456);
    expect(() => parseMajorToMinor("1.234,56")).toThrow();
    expect(divRoundHalfUp(24000 * 3, 30)).toBe(2400);
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
  });
});

describe("O1 home and phone (demo/cases.json phoneAndHome)", () => {
  const p = cases.phoneAndHome;
  const home = {
    liquidMinor: p.openingCashMinor,
    downPaymentMinor: p.homeDepositMinor,
    transactionCostsMinor: p.closingAndMovingMinor,
    protectedReserveMinor: p.protectedReserveMinor,
    monthlyContributionMinor: p.monthlySavingsBeforeHomeMinor,
  };
  it("matches target, gap and 4/5/4 contributions", () => {
    const base = homeReadiness(home);
    expect(base.targetMinor).toBe(p.expected.homeTargetMinor);
    expect(base.gapMinor).toBe(p.expected.homeGapMinor);
    const cmp = comparePurchases(home, [
      { id: "phone-6000", label: "6,000", priceMinor: p.phonePriceMinor },
      { id: "phone-3500", label: "3,500", priceMinor: p.alternativePhonePriceMinor },
    ]);
    expect(cmp.baseline.contributions).toBe(p.expected.contributionsWithoutPhone);
    expect(cmp.rows[0].contributions).toBe(p.expected.contributionsWithPhone);
    expect(cmp.rows[1].contributions).toBe(p.expected.contributionsWithAlternativePhone);
    expect(cmp.rows[0].liquidAfterMinor).toBe(10400000);
    expect(cmp.rows[1].liquidAfterMinor).toBe(10650000);
    expect(cmp.rows[0].delaysHome).toBe(true);
    expect(cmp.rows[1].delaysHome).toBe(false);
  });
  it("matches the post-home budget and downside", () => {
    const b = afterHomeBudget({
      incomeMinor: p.monthlyIncomeMinor,
      otherSpendingMinor: p.monthlyOtherSpendingMinor,
      mortgagePaymentMinor: p.mockQuotedMortgagePaymentMinor,
      downsideIncomeReductionMinor: p.downsideIncomeReductionMinor,
    });
    expect(b.monthlyMinor).toBe(p.expected.monthlyAfterHomeMinor);
    expect(b.downsideMonthlyMinor).toBe(p.expected.downsideMonthlyAfterHomeMinor);
  });
  it("keeps missing transaction costs unknown instead of zero", () => {
    const r = homeReadiness({ ...home, transactionCostsMinor: null });
    expect(r.complete).toBe(false);
    expect(r.contributions).toBeNull();
    expect(r.missing).toContain("transaction_costs");
  });
  it("agrees with the UI fixture home readiness", () => {
    const h = ui.homeReadiness;
    const r = homeReadiness({
      liquidMinor: h.currentLiquidMinor,
      downPaymentMinor: h.downPaymentMinor,
      transactionCostsMinor: h.transactionCostsMinor,
      protectedReserveMinor: h.protectedReserveMinor,
      monthlyContributionMinor: h.monthlyContributionMinor,
    });
    expect(r.targetMinor).toBe(h.targetMinor);
    expect(r.contributions).toBe(h.contributionsBeforePhone);
  });
});

describe("O1–O5 business order (demo/cases.json businessOrder)", () => {
  const b = cases.businessOrder;
  it("derives stock need 800 units / 24,000 RON", () => {
    const need = inventoryNeed(b.inventory);
    expect(need.unitsToBuy).toBe(b.inventory.expectedPurchaseUnits);
    expect(need.purchaseCostMinor).toBe(b.inventory.expectedPurchaseCostMinor);
  });
  it("reproduces every scenario minimum, final and feasibility", () => {
    for (const s of b.scenarios) {
      const t = traceCash(b.openingCashMinor, s.events, b.businessReserveMinor);
      expect(t.minimumMinor, s.id).toBe(s.expected.minimumCashMinor);
      expect(t.finalMinor, s.id).toBe(s.expected.finalCashMinor);
      expect(t.feasible, s.id).toBe(s.expected.feasible);
    }
  });
  it("reproduces conditional funding offers and the same-day ordering check", () => {
    const partial = b.scenarios.find((s: any) => s.id === "partial_reply").events;
    const results = compareFunding(b.openingCashMinor, b.businessReserveMinor, partial, b.mockFundingOffers);
    for (const offer of b.mockFundingOffers) {
      const r = results.find((x) => x.offerId === offer.id)!;
      expect(r.minimumMinor).toBe(offer.expectedMinimumCashMinor);
      expect(r.finalMinor).toBe(offer.expectedFinalCashMinor);
      expect(r.eligibility).toBe("unknown");
    }
    const a = results.find((x) => x.offerId === "offer-a")!;
    expect(a.finalMinor - b.expectedFinalCashBaselineMinor).toBe(1590000);
    expect(a.orderingCheck.minimumMinor).toBe(390000);
    expect(a.orderingCheck.feasible).toBe(false);
  });
  it("rejects ambiguous intraday order and duplicate ids", () => {
    expect(() => traceCash(0, [{ id: "a", day: 1, sequence: 1, amountMinor: 1 }, { id: "a", day: 2, sequence: 1, amountMinor: 1 }])).toThrow(TraceError);
    expect(() => traceCash(0, [{ id: "a", day: 1, sequence: 1, amountMinor: 1 }, { id: "b", day: 1, sequence: 1, amountMinor: 1 }])).toThrow(TraceError);
  });
  it("conserves funds across the owner transfer and household-linked events", () => {
    const hh = traceCash(0, b.householdLinkedEvents);
    expect(hh.finalMinor).toBe(50000);
    const eff = ownerTransferEffect(400000, 2600000, 28000, b.businessReserveMinor);
    expect(eff.consolidatedAfterMinor).toBe(eff.consolidatedBeforeMinor);
  });
  it("reproduces the new pretzel shop plan", () => {
    const shop = cases.newPretzelShop;
    const r = newShopPlan(shop);
    expect(r.cash.cashAfterPurchaseMinor).toBe(shop.expected.cashAfterCashPurchaseMinor);
    expect(r.cash.reserveMinor).toBe(shop.expected.cashPurchaseReserveMinor);
    expect(r.cash.reserveGapMinor).toBe(shop.expected.cashPurchaseReserveGapMinor);
    expect(r.cash.breakEvenUnitsPerDay).toBe(shop.expected.cashPurchaseBreakEvenUnitsPerDay);
    expect(r.lease.cashAfterInitialMinor).toBe(shop.expected.cashAfterLeaseInitialMinor);
    expect(r.lease.reserveMinor).toBe(shop.expected.leaseReserveMinor);
    expect(r.lease.breakEvenUnitsPerDay).toBe(shop.expected.leaseBreakEvenUnitsPerDay);
    expect(r.lease.nominalTotalMinor).toBe(shop.expected.nominalLeaseTotalMinor);
  });
  it("compares supplier quotes inside the cash plan", () => {
    const base = b.scenarios.find((s: any) => s.id === "deposit_and_early_collection").events;
    const quotes = caps.lazizBusiness.supplierQuotes;
    const rows = compareSupplierQuotes(b.openingCashMinor, b.businessReserveMinor, base, quotes);
    const millco = rows.find((r) => r.quoteId === "quote-millco")!;
    expect(millco.minimumMinor).toBe(1000000); // identical to the canonical scenario
    const dob = rows.find((r) => r.quoteId === "quote-dobrogea")!;
    expect(dob.totalCostMinor).toBe(2520000);
    expect(dob.paymentsAfterWindow).toHaveLength(1);
    expect(dob.minimumMinor).toBeGreaterThan(millco.minimumMinor);
  });
});

describe("T2/T3/A1 subscription comparison (design/ui-fixtures.json)", () => {
  const window = { startInclusive: ui.comparison.windowStartInclusive, endExclusive: ui.comparison.windowEndExclusive };
  const subs = ui.subscriptions;
  const entries: ForecastEntry[] = subs.map((s: any) => ({
    id: `fc-${s.id}`,
    subscriptionId: s.id,
    label: s.merchant,
    kind: s.state === "trial" ? "TRIAL_CONVERSION" : "RENEWAL",
    amountMinor: s.monthlyMinor,
    dueAt: s.nextChargeAt,
  }));
  const facts = subs.map((s: any) => ({
    id: s.id,
    merchantName: s.merchant,
    state: s.state === "trial" ? "TRIAL" : "ACTIVE",
    amountMinor: s.monthlyMinor,
    storageGb: s.cloudStorageGb,
    offlinePlayback: s.offlinePlayback,
    primaryBenefit: s.id === "cloudbox" ? "cloud_storage" : undefined,
  }));
  const offer = { ...ui.mockBundle };
  const base = {
    window,
    entries,
    subscriptions: facts,
    offer,
    protectedBenefits: ["offline_playback"],
    studentStatus: "unknown" as const,
    storageUsedGb: ui.usageEvidence.cloudUsageGb,
    migration: null,
    replacementStorageActive: false,
  };
  it("computes 242 baseline, 89 optimized and 153 = 74 + 79", () => {
    const r = compareSubscriptions(base);
    expect(r.baselineMinor).toBe(ui.comparison.baselineIncludingTrialConversionMinor);
    expect(r.optimizedMinor).toBe(ui.comparison.allActionsOptimizedMinor);
    expect(r.potentialMinor).toBe(ui.comparison.potentialReductionMinor);
    expect(r.paidPlanReductionMinor).toBe(ui.comparison.existingRecurringReductionMinor);
    expect(r.trialAvoidedMinor).toBe(ui.comparison.futureTrialChargeAvoidedMinor);
    const bundle = r.options.find((o) => o.id === "switch-bundle")!;
    expect(bundle.reductionMinor).toBe(3900);
    expect(bundle.status).toBe("CONDITIONAL"); // student status unknown
    const storage = r.options.find((o) => o.id === "remove-duplicate-storage")!;
    expect(storage.reductionMinor).toBe(3500);
    expect(storage.dependsOn).toEqual(["switch-bundle"]);
  });
  it("after only the trial cancellation the window total is 163", () => {
    const after = { ...base, entries: entries.filter((e) => e.subscriptionId !== "fitflow"), subscriptions: facts.map((f: any) => (f.id === "fitflow" ? { ...f, state: "RENEWAL_OFF" } : f)) };
    const r = compareSubscriptions(after);
    expect(r.baselineMinor).toBe(ui.comparison.afterOnlyTrialCancellationMinor);
    expect(r.options.find((o) => o.id === "stop-trial")).toBeUndefined();
  });
  it("changed terms without offline playback make the bundle and the dependent storage removal incompatible", () => {
    const changed = { ...base, offer: { ...offer, offlinePlayback: false, termRevision: 2 } };
    const r = compareSubscriptions(changed);
    expect(r.options.find((o) => o.id === "switch-bundle")!.status).toBe("INCOMPATIBLE");
    expect(r.options.find((o) => o.id === "remove-duplicate-storage")!.status).toBe("INCOMPATIBLE");
    expect(r.compatibleOnly.potentialMinor).toBe(7900);
  });
  it("without the bundle, duplicate storage relies on StudyPlus storage and is counted once", () => {
    const r = compareSubscriptions({ ...base, offer: null });
    const storage = r.options.find((o) => o.id === "remove-duplicate-storage")!;
    expect(storage.reductionMinor).toBe(3500);
    expect(storage.dependsOn).toEqual([]);
    expect(r.potentialMinor).toBe(7900 + 3500);
  });
});

describe("A2–A14 calculators (demo/capability-scenarios.json)", () => {
  const a = caps.alex;
  it("A2 right-sizes MobileNet to Smart 20 and rejects Basic 10", () => {
    const r = rightSizePlan({ currentPlanId: "unlimited-plus", plans: a.mobileNet.plans, usageGb: a.mobileNet.usageGb.map((u: any) => u.gb), hotspotRequired: true });
    expect(r.peakGb).toBe(11.5);
    expect(r.recommendedId).toBe("smart-20");
    const basic = r.rows.find((x) => x.id === "basic-10")!;
    expect(basic.compatible).toBe(false);
    expect(r.rows.find((x) => x.id === "smart-20")!.monthlySavingMinor).toBe(2600);
  });
  it("A3 break-even is 10 months; 8-month horizon favours monthly, 12 favours annual", () => {
    const short = monthlyVsAnnual({ monthlyMinor: 7900, annualMinor: 79000, horizonMonths: 8 });
    expect(short.breakEvenMonths).toBe(10);
    expect(short.better).toBe("MONTHLY");
    expect(short.monthlyTotalMinor).toBe(63200);
    const year = monthlyVsAnnual({ monthlyMinor: 7900, annualMinor: 79000, horizonMonths: 12 });
    expect(year.better).toBe("ANNUAL");
    expect(year.differenceMinor).toBe(15800);
    expect(year.nextRenewalCashImpactMinor).toBe(71100);
  });
  it("A4 detects the 39 → 49 Streamly increase with its notice", () => {
    const charges = a.transactions.filter((t: any) => t.merchant === "Streamly").map((t: any) => ({ id: t.id, amountMinor: -t.amountMinor, bookedAt: t.bookedAt }));
    const r = detectPriceChanges({ contractKey: "streamly|alex", charges, notices: a.streamlyPriceHistory });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fromMinor).toBe(3900);
    expect(r.findings[0].toMinor).toBe(4900);
    expect(r.findings[0].explanation).toBe("MERCHANT_NOTICE");
    expect(r.findings[0].dedupeKey).toBe("streamly|alex:price:rev2");
  });
  it("A5 rotation covers both titles for 78 RON instead of a continuous 117 RON", () => {
    const r = planContentSchedule({
      wanted: [
        { titleId: "atlas-files", watchFrom: "2026-11-20", watchUntil: "2026-12-10" },
        { titleId: "code-and-chaos-s2", watchFrom: "2027-01-08", watchUntil: "2027-02-05" },
      ],
      titles: a.contentCatalog.titles,
      services: a.contentCatalog.services,
      alreadySubscribed: [],
    });
    expect(r.periods.map((p) => p.start)).toEqual(["2026-11-20", "2027-01-08"]);
    expect(r.rotationTotalMinor).toBe(7800);
    expect(r.continuousTotalMinor).toBe(11700);
  });
  it("A6 pause of one month skips the 26 Nov Streamly charge and resumes 26 Dec", () => {
    const r = pauseEffect({
      monthlyMinor: 4900,
      pauseStartsAt: a.streamlyPause.startsAt,
      months: 1,
      allowedMonths: a.streamlyPause.allowedMonths,
      feeMinor: 0,
      window: { startInclusive: ui.comparison.windowStartInclusive, endExclusive: ui.comparison.windowEndExclusive },
    });
    expect(r.skippedInWindowMinor).toBe(4900);
    expect(r.resumesAt.startsWith("2026-12-26T14:22")).toBe(true);
    expect(() => pauseEffect({ ...{ monthlyMinor: 4900, pauseStartsAt: a.streamlyPause.startsAt, allowedMonths: [1, 2, 3], feeMinor: 0, window: { startInclusive: "2026-10-28T09:41:00+02:00", endExclusive: "2026-11-27T09:41:00+02:00" } }, months: 6 })).toThrow();
  });
  it("A8 distinguishes a hold, two purchases and a possible settled duplicate", () => {
    const txns = a.transactions.map((t: any) => ({ id: t.id, merchantName: t.merchant, amountMinor: t.amountMinor, status: t.status, bookedAt: t.bookedAt, orderRef: t.orderRef, authId: t.authId }));
    const r = classifyPossibleDuplicates(txns);
    const byMerchant = Object.fromEntries(r.groups.map((g) => [g.transactions[0].merchantName, g.classification]));
    expect(byMerchant["Fresh Market"]).toBe("AUTHORIZATION_HOLD");
    expect(byMerchant["UrbanRide"]).toBe("LIKELY_TWO_PURCHASES");
    expect(byMerchant["TechBits"]).toBe("POSSIBLE_SETTLED_DUPLICATE");
    expect(r.groups.filter((g) => g.claimable)).toHaveLength(1);
  });
  it("A9 SoundHub price adjustment is eligible for 100 RON until 3 Nov", () => {
    const pol = a.soundHubPolicy;
    const r = priceAdjustmentCheck({ policy: pol, purchase: pol.purchase, currentPrice: pol.currentPrice, nowIso: "2026-10-28T09:41:00+02:00", merchantSeller: "SoundHub" });
    expect(r.eligible).toBe(true);
    expect(r.differenceMinor).toBe(10000);
    expect(r.windowEndsAt!.startsWith("2026-11-03")).toBe(true);
    const late = priceAdjustmentCheck({ policy: pol, purchase: pol.purchase, currentPrice: pol.currentPrice, nowIso: "2026-11-05T09:41:00+02:00", merchantSeller: "SoundHub" });
    expect(late.eligible).toBe(false);
    const unknown = priceAdjustmentCheck({ policy: null, purchase: pol.purchase, currentPrice: pol.currentPrice, nowIso: "2026-10-28T09:41:00+02:00", merchantSeller: "SoundHub" });
    expect(unknown.status).toBe("UNKNOWN_POLICY");
  });
  it("A10 total cost over 24 months includes protection and service", () => {
    const r = totalCostOfOwnership({ options: a.phoneTco.options, horizonMonths: 24, includeProtection: true });
    const pro = r.rows.find((x) => x.id === "phone-6000")!;
    const lite = r.rows.find((x) => x.id === "phone-3500")!;
    expect(pro.totalMinor).toBe(600000 + 9900 + 2900 * 24);
    expect(lite.totalMinor).toBe(350000 + 1900 * 24 + 27900);
    expect(r.lowestId).toBe("phone-3500");
    expect(lite.unknowns.length).toBe(1);
  });
  it("A11 moving ElectraCasa from the 2nd to the 5th avoids a failed payment for a 24 RON one-off", () => {
    const h = caps.lazizHousehold;
    const fiber = h.bills.find((x: any) => x.id === "bill-fiberlink");
    const ec = h.bills.find((x: any) => x.id === "bill-electracasa");
    const r = billingDateOptions({
      balanceMinor: h.openingBalanceMinor,
      flows: [
        { id: fiber.id, label: "FiberLink", amountMinor: -fiber.amountMinor, at: fiber.nextChargeAt },
        { id: "owner", label: "Owner transfer", amountMinor: 400000, at: h.income[0].expectedAt },
        { id: "rent", label: "Rent", amountMinor: -350000, at: h.essentials[0].dueAt },
      ],
      bill: { id: ec.id, label: "ElectraCasa", amountMinor: ec.amountMinor, currentDay: 2, nextChargeAt: ec.nextChargeAt },
      supportedDays: ec.supportedBillingDays,
      failedPaymentFeeMinor: ec.failedPaymentFeeMinor,
      requestAt: "2026-10-28T09:41:00+02:00",
      minNoticeDays: 3,
    });
    expect(r.current.paymentWouldFail).toBe(true);
    expect(r.recommendedDay).toBe(5);
    const five = r.options.find((o) => o.billingDay === 5)!;
    expect(five.prorationMinor).toBe(2400);
    expect(five.paymentWouldFail).toBe(false);
    expect(five.firstChargeAt.startsWith("2026-11-05")).toBe(true);
  });
  it("A12 BookNook credit covers 120 of the 189 RON textbook", () => {
    const c = a.bookNookCredit;
    const r = expiringCreditMatch({ credit: c, intended: c.intendedPurchase, eligibleCategories: ["books", "stationery"], nowIso: "2026-10-28T09:41:00+02:00" });
    expect(r.status).toBe("MATCH");
    expect(r.coveredMinor).toBe(12000);
    expect(r.uncoveredMinor).toBe(6900);
    const none = expiringCreditMatch({ credit: c, intended: null, eligibleCategories: ["books"], nowIso: "2026-10-28T09:41:00+02:00" });
    expect(none.status).toBe("NO_INTENDED_PURCHASE");
  });
  it("A13 TeamDesk: three removable seats, protected seats kept, 540 → 405", () => {
    const t = caps.lazizBusiness.teamDesk;
    const r = reviewLicenses({ seats: t.seats, seatPriceMinor: t.seatPriceMinor, minimumSeats: t.minimumSeats, inactivityThresholdDays: t.inactivityThresholdDays, asOf: "2026-10-28" });
    expect(r.candidateSeatIds).toEqual(["seat-07", "seat-10", "seat-12"]);
    expect(r.invoiceBeforeMinor).toBe(54000);
    expect(r.invoiceAfterMinor).toBe(40500);
    const sorin = r.rows.find((x) => x.seatId === "seat-08")!;
    expect(sorin.status).toBe("PROTECTED");
    expect(r.rows.find((x) => x.seatId === "seat-09")!.status).toBe("PROTECTED");
    expect(r.rows.find((x) => x.seatId === "seat-11")!.status).toBe("PROTECTED");
  });
  it("A14 travel keeps eligibility unknown until verified, then DataPass nets 14 RON", () => {
    const t = a.travel;
    const input = {
      dataNeedGb: t.dataNeedGb,
      tripDays: 5,
      homePlan: { name: "Unlimited Plus 100 GB", euRoamingGb: 4, extraEuGbMinor: a.mobileNet.extraEuGbMinor },
      connectivity: t.connectivity,
      benefit: { amountMinor: t.cardBenefit.amountMinor, eligibleMerchants: t.cardBenefit.eligibleMerchants, verified: null as boolean | null },
      expectedCardSpendMinor: t.expectedCardSpendMinor,
      paymentMethods: t.paymentMethods,
      fxRate: t.fxRate,
    };
    const before = travelComparison(input);
    expect(before.unknowns).toContain("Card travel credit eligibility");
    expect(before.connectivity.find((c) => c.id === "datapass")!.netMinor).toBeNull();
    expect(before.connectivity.find((c) => c.id === "home-plan")!.netMinor).toBe(1500);
    const after = travelComparison({ ...input, benefit: { ...input.benefit, verified: true } });
    expect(after.connectivity.find((c) => c.id === "datapass")!.netMinor).toBe(1400);
    expect(after.recommendedConnectivityId).toBe("datapass");
    expect(after.payments.find((p) => p.id === "airport-kiosk")!.fxCostMinor).toBe(8400);
    expect(after.payments.find((p) => p.id === "other-card")!.fxCostMinor).toBe(3000);
    expect(after.recommendedPaymentId).toBe("nextmove-card");
  });
});
