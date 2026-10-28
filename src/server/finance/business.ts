import { assertMinor, ceilDiv, MoneyError } from "../../shared/money";
import { traceCash, type CashEvent, type CashTrace } from "./cashflow";

// Business order, stock, receivables, owner income and funding (O1–O5). Closed Day 0–30 fixture semantics.

export interface InventoryInput {
  requiredUnits: number;
  onHandUnits: number;
  unitMaterialCostMinor: number;
}

export function inventoryNeed(inv: InventoryInput) {
  if (!Number.isInteger(inv.requiredUnits) || !Number.isInteger(inv.onHandUnits)) throw new MoneyError("Units must be integers");
  const units = Math.max(0, inv.requiredUnits - inv.onHandUnits);
  return {
    unitsToBuy: units,
    purchaseCostMinor: assertMinor(units * inv.unitMaterialCostMinor),
    heldMaterialValueMinor: assertMinor(inv.onHandUnits * inv.unitMaterialCostMinor),
    formula: "units to buy = max(0, required − on hand); cost = units × unit material cost",
  };
}

export interface ScenarioInput {
  id: string;
  events: CashEvent[];
}

export interface FundingOffer {
  id: string;
  drawMinor: number;
  drawDay: number;
  repayDay: number;
  feeMinor: number;
  repaySequence: number;
  available?: string;
}

export function runScenario(openingMinor: number, floorMinor: number, scenario: ScenarioInput): CashTrace {
  return traceCash(openingMinor, scenario.events, floorMinor);
}

export function withFunding(events: CashEvent[], offer: FundingOffer, repaySequenceOverride?: number): CashEvent[] {
  return [
    ...events,
    { id: "funding-draw", day: offer.drawDay, sequence: 1, amountMinor: offer.drawMinor, kind: "funding_draw", label: `Funding draw (${offer.id})`, conditional: true },
    {
      id: "funding-repayment",
      day: offer.repayDay,
      sequence: repaySequenceOverride ?? offer.repaySequence,
      amountMinor: -(offer.drawMinor + offer.feeMinor),
      kind: "funding_repayment",
      label: `Repayment incl. fee (${offer.id})`,
      conditional: true,
    },
  ];
}

export function compareFunding(openingMinor: number, floorMinor: number, baseEvents: CashEvent[], offers: FundingOffer[]) {
  return offers.map((offer) => {
    const trace = traceCash(openingMinor, withFunding(baseEvents, offer), floorMinor);
    const earlyRepay = traceCash(openingMinor, withFunding(baseEvents, offer, 0), floorMinor);
    return {
      offerId: offer.id,
      feeMinor: offer.feeMinor,
      totalRepaidMinor: offer.drawMinor + offer.feeMinor,
      minimumMinor: trace.minimumMinor,
      finalMinor: trace.finalMinor,
      feasible: trace.feasible,
      trace,
      orderingCheck: {
        description: "If the repayment were processed before the same-day invoice receipt",
        minimumMinor: earlyRepay.minimumMinor,
        feasible: earlyRepay.feasible,
      },
      eligibility: "unknown",
      availability: offer.available ?? "assumed_not_approved",
    };
  });
}

/** Owner transfer: one business debit and one linked household credit. Consolidated funds are conserved. */
export function ownerTransferEffect(amountMinor: number, businessBalanceMinor: number, householdBalanceMinor: number, businessFloorMinor: number) {
  assertMinor(amountMinor);
  const businessAfter = businessBalanceMinor - amountMinor;
  const householdAfter = householdBalanceMinor + amountMinor;
  return {
    businessAfterMinor: businessAfter,
    householdAfterMinor: householdAfter,
    consolidatedBeforeMinor: businessBalanceMinor + householdBalanceMinor,
    consolidatedAfterMinor: businessAfter + householdAfter,
    businessBelowFloor: businessAfter < businessFloorMinor,
  };
}

export interface NewShopInput {
  openingCashMinor: number;
  ovenCashPriceMinor: number;
  fitoutMinor: number;
  premisesDepositMinor: number;
  monthlyFixedMinor: number;
  reserveMonths: number;
  unitSellingPriceMinor: number;
  unitVariableCostMinor: number;
  operatingDaysPerMonth: number;
  mockLease: { initialMinor: number; monthlyMinor: number; months: number; ownershipAtEndIncluded: boolean };
}

export function newShopPlan(s: NewShopInput) {
  const contribution = s.unitSellingPriceMinor - s.unitVariableCostMinor;
  if (contribution <= 0) throw new MoneyError("Unit contribution must be positive for a break-even calculation");
  const cashAfterPurchase = s.openingCashMinor - s.ovenCashPriceMinor - s.fitoutMinor - s.premisesDepositMinor;
  const reserve = s.monthlyFixedMinor * s.reserveMonths;
  const leaseFixed = s.monthlyFixedMinor + s.mockLease.monthlyMinor;
  const cashAfterLease = s.openingCashMinor - s.mockLease.initialMinor - s.fitoutMinor - s.premisesDepositMinor;
  const leaseReserve = leaseFixed * s.reserveMonths;
  return {
    cash: {
      cashAfterPurchaseMinor: cashAfterPurchase,
      reserveMinor: reserve,
      reserveGapMinor: Math.max(0, reserve - cashAfterPurchase),
      breakEvenUnitsPerDay: ceilDiv(s.monthlyFixedMinor, contribution * s.operatingDaysPerMonth),
    },
    lease: {
      cashAfterInitialMinor: cashAfterLease,
      reserveMinor: leaseReserve,
      reserveGapMinor: Math.max(0, leaseReserve - cashAfterLease),
      breakEvenUnitsPerDay: ceilDiv(leaseFixed, contribution * s.operatingDaysPerMonth),
      nominalTotalMinor: s.mockLease.initialMinor + s.mockLease.months * s.mockLease.monthlyMinor,
      ownershipAtEndIncluded: s.mockLease.ownershipAtEndIncluded,
    },
    unitContributionMinor: contribution,
    assumptions: [
      "Reserve is a declared policy, not a legal minimum.",
      "Break-even is a simplified contribution model without taxes, seasonality, waste or demand validation.",
      "The lease is a mock offer; its total is undiscounted cash cost.",
    ],
  };
}

export interface SupplierQuote {
  id: string;
  supplier: string;
  unitPriceMinor: number;
  units: number;
  payments: { day: number; amountMinor: number; share: string }[];
  deliveryDay: number;
  validUntilDay: number;
}

/**
 * Compare supplier quotes inside a cash scenario: replace the scenario's stock-purchase event with each quote's payment schedule.
 * Payments outside the 30-day window are reported, not dropped.
 */
export function compareSupplierQuotes(openingMinor: number, floorMinor: number, scenarioEvents: CashEvent[], quotes: SupplierQuote[], horizonDay = 30) {
  const base = scenarioEvents.filter((e) => e.kind !== "supplier_payment");
  return quotes.map((q) => {
    const inWindow = q.payments.filter((p) => p.day <= horizonDay);
    const outside = q.payments.filter((p) => p.day > horizonDay);
    const events: CashEvent[] = [
      ...base,
      ...inWindow.map((p, i) => ({ id: `${q.id}-pay-${i}`, day: p.day, sequence: 1, amountMinor: -p.amountMinor, kind: "supplier_payment", label: `${q.supplier} ${p.share}` })),
    ];
    const trace = traceCash(openingMinor, events, floorMinor);
    const total = q.payments.reduce((s, p) => s + p.amountMinor, 0);
    return {
      quoteId: q.id,
      supplier: q.supplier,
      totalCostMinor: total,
      unitPriceMinor: q.unitPriceMinor,
      minimumMinor: trace.minimumMinor,
      minimumDay: trace.minimumDay,
      finalWithinWindowMinor: trace.finalMinor,
      paymentsAfterWindow: outside,
      feasible: trace.feasible,
      deliveryDay: q.deliveryDay,
    };
  });
}
