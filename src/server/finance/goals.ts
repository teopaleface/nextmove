import { assertMinor, ceilDiv, MoneyError } from "../../shared/money";

// Home readiness and purchase decisions (O1). Planning measures only: no purchase, transfer or loan decision.

export interface HomeInputs {
  liquidMinor: number;          // all liquid accounts counted once
  downPaymentMinor: number;
  transactionCostsMinor: number | null; // null = not supplied: ask, never assume zero
  protectedReserveMinor: number;
  monthlyContributionMinor: number;
}

export interface HomeReadiness {
  complete: boolean;
  missing: string[];
  targetMinor: number | null;
  gapMinor: number | null;
  contributions: number | null;
  breakdown: { label: string; minor: number | null }[];
  formula: string;
}

export function homeReadiness(input: HomeInputs, purchaseMinor = 0): HomeReadiness {
  assertMinor(input.liquidMinor);
  assertMinor(purchaseMinor);
  if (!(input.monthlyContributionMinor > 0)) throw new MoneyError("Monthly contribution must be positive");
  const missing: string[] = [];
  if (input.transactionCostsMinor == null) missing.push("transaction_costs");
  const breakdown = [
    { label: "Down payment", minor: input.downPaymentMinor },
    { label: "Transaction and moving costs", minor: input.transactionCostsMinor },
    { label: "Protected reserve", minor: input.protectedReserveMinor },
  ];
  if (missing.length) {
    return { complete: false, missing, targetMinor: null, gapMinor: null, contributions: null, breakdown, formula: "Target needs every cost component; missing values stay unknown." };
  }
  const target = assertMinor(input.downPaymentMinor + (input.transactionCostsMinor as number) + input.protectedReserveMinor);
  const modeled = assertMinor(input.liquidMinor - purchaseMinor);
  const gap = Math.max(0, target - modeled);
  return {
    complete: true,
    missing,
    targetMinor: target,
    gapMinor: gap,
    contributions: ceilDiv(gap, input.monthlyContributionMinor),
    breakdown,
    formula: "contributions = ceil(max(0, target − (liquid funds − purchase)) / monthly contribution)",
  };
}

export interface PurchaseOption {
  id: string;
  label: string;
  priceMinor: number;
}

export interface PurchaseComparisonRow {
  id: string;
  label: string;
  priceMinor: number;
  liquidAfterMinor: number;
  contributions: number | null;
  delaysHome: boolean;
}

export function comparePurchases(home: HomeInputs, options: PurchaseOption[]) {
  const baseline = homeReadiness(home, 0);
  const rows: PurchaseComparisonRow[] = options.map((o) => {
    const r = homeReadiness(home, o.priceMinor);
    return {
      id: o.id,
      label: o.label,
      priceMinor: o.priceMinor,
      liquidAfterMinor: home.liquidMinor - o.priceMinor,
      contributions: r.contributions,
      delaysHome: r.contributions != null && baseline.contributions != null && r.contributions > baseline.contributions,
    };
  });
  return { baseline, rows };
}

export interface AfterHomeBudget {
  incomeMinor: number;
  otherSpendingMinor: number;
  mortgagePaymentMinor: number;
  downsideIncomeReductionMinor: number;
}

export function afterHomeBudget(b: AfterHomeBudget) {
  const monthly = assertMinor(b.incomeMinor - b.otherSpendingMinor - b.mortgagePaymentMinor);
  const downside = assertMinor(monthly - b.downsideIncomeReductionMinor);
  return {
    monthlyMinor: monthly,
    downsideMonthlyMinor: downside,
    downsideNegative: downside < 0,
    note: "Separate period from pre-home saving. The mortgage payment is a fictional supplied quote, not an approval or amortization.",
  };
}
