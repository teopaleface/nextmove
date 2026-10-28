import { assertMinor, MoneyError } from "./money";
import { addLocalMonths } from "./time";

// What-if simulations shown inside agent answers and the goal analysis. Pure and deterministic: the server
// computes the first result from tool data, the phone recomputes with the same functions while the customer
// moves a slider. Amounts are integer minor units (bani); rates are basis points (1% = 100 bp). Every
// intermediate amount is rounded half away from zero to whole bani, so server and phone agree to the ban.
// Nothing here is an offer, an approval or a forecast of returns.

export const SIMULATION_KINDS = ["loan", "income", "invest"] as const;
export type SimulationKind = (typeof SIMULATION_KINDS)[number];

const MAX_MONTHS = 600;

const roundMinor = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

function int(value: number, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new MoneyError(`${label} must be a whole number between ${min} and ${max}`);
  return value;
}

/* ------------------------------------------------------------------------------------------- loan */

export interface LoanInputs {
  principalMinor: number;
  termMonths: number;
  annualRateBp: number;
}

export interface LoanResult {
  monthlyPaymentMinor: number;
  /** Payment in each month; the last one absorbs rounding so the balance ends at exactly zero. */
  payments: number[];
  /** Balance still owed after each month. */
  balances: number[];
  totalInterestMinor: number;
  totalPaidMinor: number;
}

/** Fixed-payment (annuity) installments with monthly compounding: payment = P·r / (1 − (1 + r)^−n). */
export function loanSchedule(i: LoanInputs): LoanResult {
  const principal = assertMinor(i.principalMinor, "loan amount");
  if (principal < 0) throw new MoneyError("loan amount must not be negative");
  const n = int(i.termMonths, "term", 1, 120);
  const bp = int(i.annualRateBp, "annual rate", 0, 5000);
  const r = bp / 10_000 / 12;
  const payment = principal === 0 ? 0 : bp === 0 ? Math.ceil(principal / n) : roundMinor((principal * r) / (1 - Math.pow(1 + r, -n)));
  const payments: number[] = [];
  const balances: number[] = [];
  let balance = principal;
  let interestTotal = 0;
  for (let m = 1; m <= n; m++) {
    const interest = roundMinor(balance * r);
    const due = m === n ? balance + interest : Math.min(payment, balance + interest);
    balance = balance + interest - due;
    interestTotal += interest;
    payments.push(due);
    balances.push(balance);
  }
  return { monthlyPaymentMinor: payment, payments, balances, totalInterestMinor: interestTotal, totalPaidMinor: principal + interestTotal };
}

/* ------------------------------------------------------------------------------------------- goal */

export interface GoalPathInputs {
  /** Money counted toward the goal today (all liquid accounts, once). */
  startMinor: number;
  targetMinor: number;
  /** Regular saving deposited at the end of each month. */
  monthlySavingMinor: number;
  /** Paid today, before the first month (for example a phone bought outright). */
  upfrontMinor?: number;
  /** Extra outflow in month k (index 0 = month 1), for example an installment. */
  outflows?: number[];
}

export interface GoalPath {
  /** Monthly contributions until the target is covered; 0 = already covered; null = not reached within 50 years. */
  months: number | null;
  /** Saved amount at month 0, 1, 2 … up to arrival (or a bounded horizon when the target is not reached). */
  path: number[];
}

/** Month-by-month: saved(n) = start − upfront + Σ (saving − outflow_k). Matches O1's ceil(gap / saving) without outflows. */
export function goalPath(i: GoalPathInputs, horizon = MAX_MONTHS): GoalPath {
  const start = assertMinor(i.startMinor) - assertMinor(i.upfrontMinor ?? 0);
  const target = assertMinor(i.targetMinor);
  const saving = assertMinor(i.monthlySavingMinor);
  const out = i.outflows ?? [];
  const path = [start];
  if (start >= target) return { months: 0, path };
  let saved = start;
  for (let m = 1; m <= horizon; m++) {
    saved += saving - (out[m - 1] ?? 0);
    path.push(saved);
    if (saved >= target) return { months: m, path };
    // Past every outflow with no net saving, the target can never be reached.
    if (m >= out.length && saving <= 0) break;
  }
  return { months: null, path: path.slice(0, 61) };
}

/* ------------------------------------------------------------------------------------------- invest */

export interface InvestInputs {
  monthlyMinor: number;
  annualRateBp: number;
  years: number;
}

export interface InvestResult {
  /** Value at the end of each month, index 0 = start (0). */
  values: number[];
  /** Total put in at the end of each month. */
  contributed: number[];
  finalMinor: number;
  contributedMinor: number;
  growthMinor: number;
}

/** Deposit at the end of each month; growth credited monthly at annual rate / 12, rounded to the ban. */
export function investDelta(i: InvestInputs): InvestResult {
  const monthly = assertMinor(i.monthlyMinor, "monthly amount");
  if (monthly < 0) throw new MoneyError("monthly amount must not be negative");
  const bp = int(i.annualRateBp, "annual rate", 0, 2000);
  const years = int(i.years, "horizon", 1, 30);
  const r = bp / 10_000 / 12;
  const values = [0];
  const contributed = [0];
  let v = 0;
  for (let m = 1; m <= years * 12; m++) {
    v = v + roundMinor(v * r) + monthly;
    values.push(v);
    contributed.push(monthly * m);
  }
  const final = values[values.length - 1];
  const put = contributed[contributed.length - 1];
  return { values, contributed, finalMinor: final, contributedMinor: put, growthMinor: final - put };
}

/* ------------------------------------------------------------------------------------------- dates */

/** Same month arithmetic as O1: the demo clock plus n months, named in Europe/Bucharest. */
export function monthLabel(asOfIso: string, months: number | null, style: "long" | "short" = "long"): string {
  if (months == null) return "Not within 50 years";
  const d = new Date(addLocalMonths(Date.parse(asOfIso), months));
  return new Intl.DateTimeFormat("en-GB", { month: style, year: "numeric", timeZone: "Europe/Bucharest" }).format(d);
}

/* ------------------------------------------------------------------------------------------- descriptors */

export interface Slider {
  key: string;
  label: string;
  /** "money" values are minor units; "percent" values are basis points. */
  unit: "money" | "months" | "percent" | "years";
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface HomeBase {
  liquidMinor: number;
  targetMinor: number;
  monthlySavingMinor: number;
}

interface SimBase {
  id: string;
  title: string;
  /** Demo clock the month labels are counted from. */
  asOf: string;
  sliders: Slider[];
  /** Where each starting value came from, in plain words. */
  sources: string[];
  assumptions: string[];
}

export type Simulation =
  | (SimBase & { kind: "loan"; base: HomeBase & { itemLabel: string } })
  | (SimBase & { kind: "income"; base: HomeBase & { incomeMinor: number } })
  | (SimBase & { kind: "invest"; base: { confirmedMinor: number; foundMinor: number } });

export type Values = Record<string, number>;

export function initialValues(sim: Simulation): Values {
  return Object.fromEntries(sim.sliders.map((s) => [s.key, s.value]));
}

/** Clamp to the slider's range and step so a tampered or stale value cannot leave the modelled space. */
export function clampValues(sim: Simulation, values: Partial<Values>): Values {
  const out: Values = {};
  for (const s of sim.sliders) {
    const raw = Number(values[s.key]);
    const v = Number.isFinite(raw) ? raw : s.value;
    const stepped = s.min + Math.round((v - s.min) / s.step) * s.step;
    out[s.key] = Math.min(s.max, Math.max(s.min, stepped));
  }
  return out;
}

export interface Point {
  x: number;
  y: number;
}

export interface Series {
  key: string;
  label: string;
  emphasis: "primary" | "reference";
  points: Point[];
}

export interface Outcome {
  headline: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "neutral";
  lines: { label: string; value: number; unit: "money" | "months" | "text"; text?: string }[];
  chart: { xUnit: "month" | "year"; series: Series[]; target?: number; marks: { x: number; label: string }[] };
  /** One plain sentence with every number, used as the chart's text alternative and by the planner. */
  summary: string;
  numbers: Record<string, number | null>;
}

const ron = (minor: number) => {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const s = new Intl.NumberFormat("en-US", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(abs / 100);
  return `${neg ? "−" : ""}${s} RON`;
};
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? (bp % 10 ? 2 : 1) : 0)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function shift(baseline: number | null, now: number | null) {
  if (baseline == null || now == null) return now == null ? "out of reach" : "reachable again";
  const d = now - baseline;
  return d === 0 ? "no change" : d > 0 ? `${plural(d, "month")} later` : `${plural(-d, "month")} sooner`;
}

export function evaluate(sim: Simulation, raw: Partial<Values>): Outcome {
  const v = clampValues(sim, raw);
  switch (sim.kind) {
    case "loan": {
      const b = sim.base;
      const loan = loanSchedule({ principalMinor: v.principalMinor, termMonths: v.termMonths, annualRateBp: v.annualRateBp });
      const baseline = goalPath({ startMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: b.monthlySavingMinor });
      const cash = goalPath({ startMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: b.monthlySavingMinor, upfrontMinor: v.principalMinor });
      const withLoan = goalPath({ startMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: b.monthlySavingMinor, outflows: loan.payments });
      const owedAtGoal = withLoan.months == null ? null : withLoan.months === 0 ? v.principalMinor : loan.balances[withLoan.months - 1] ?? 0;
      const freeCash = b.monthlySavingMinor - loan.monthlyPaymentMinor;
      const d = withLoan.months == null || baseline.months == null ? null : withLoan.months - baseline.months;
      const when = monthLabel(sim.asOf, withLoan.months);
      const summary =
        `${ron(v.principalMinor)} for ${b.itemLabel} in ${v.termMonths} installments at a fictional ${pct(v.annualRateBp)} a year: ${ron(loan.monthlyPaymentMinor)} a month, ${ron(loan.totalInterestMinor)} interest in total. ` +
        `Free cash for saving goes from ${ron(b.monthlySavingMinor)} to ${ron(freeCash)} a month while it runs. ` +
        `Home target: ${when} (${shift(baseline.months, withLoan.months)} vs. no purchase; paying ${ron(v.principalMinor)} upfront gives ${monthLabel(sim.asOf, cash.months)}).` +
        (owedAtGoal ? ` You would still owe ${ron(owedAtGoal)} when the target is reached.` : "");
      return {
        headline: withLoan.months == null ? "Home target out of reach" : `Home target ${when}`,
        sub: d == null ? "The installments use up your monthly saving" : d === 0 ? "Same month as without the purchase" : `${shift(baseline.months, withLoan.months)} than without the purchase`,
        tone: d == null ? "bad" : d === 0 ? "good" : "warn",
        lines: [
          { label: "Monthly installment", value: loan.monthlyPaymentMinor, unit: "money" },
          { label: "Interest in total", value: loan.totalInterestMinor, unit: "money" },
          { label: "Left to save each month", value: freeCash, unit: "money" },
          { label: "Home target if paid upfront", value: cash.months ?? 0, unit: "text", text: monthLabel(sim.asOf, cash.months) },
          ...(owedAtGoal ? [{ label: "Still owed at the home target", value: owedAtGoal, unit: "money" as const }] : []),
        ],
        chart: {
          xUnit: "month",
          target: b.targetMinor,
          series: [
            { key: "baseline", label: "Without the purchase", emphasis: "reference", points: baseline.path.map((y, x) => ({ x, y })) },
            { key: "scenario", label: "With installments", emphasis: "primary", points: withLoan.path.map((y, x) => ({ x, y })) },
          ],
          marks: withLoan.months != null ? [{ x: withLoan.months, label: when }] : [],
        },
        summary,
        numbers: { monthlyPaymentMinor: loan.monthlyPaymentMinor, totalInterestMinor: loan.totalInterestMinor, freeCashMinor: freeCash, months: withLoan.months, baselineMonths: baseline.months, upfrontMonths: cash.months, owedAtGoalMinor: owedAtGoal, principalMinor: v.principalMinor, termMonths: v.termMonths, annualRateBp: v.annualRateBp },
      };
    }
    case "income": {
      const b = sim.base;
      const deltaMinor = roundMinor((b.incomeMinor * v.changeBp) / 10_000);
      const saving = b.monthlySavingMinor + deltaMinor;
      const baseline = goalPath({ startMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: b.monthlySavingMinor });
      const next = goalPath({ startMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: saving });
      const when = monthLabel(sim.asOf, next.months);
      const d = next.months == null || baseline.months == null ? null : next.months - baseline.months;
      const change = v.changeBp === 0 ? "No change in income" : `A ${pct(Math.abs(v.changeBp))} ${v.changeBp > 0 ? "raise" : "drop"}`;
      const summary =
        `${change}: income ${ron(b.incomeMinor)} → ${ron(b.incomeMinor + deltaMinor)} a month, spending unchanged, so saving goes from ${ron(b.monthlySavingMinor)} to ${ron(saving)}. ` +
        `Home target: ${when} (${shift(baseline.months, next.months)}).`;
      return {
        headline: next.months == null ? "Home target out of reach" : `Home target ${when}`,
        sub: d == null ? "Nothing left to save each month" : d === 0 ? "Same month as today's plan" : `${shift(baseline.months, next.months)} than today's plan`,
        tone: d == null ? "bad" : d < 0 ? "good" : d === 0 ? "neutral" : "warn",
        lines: [
          { label: "Monthly income", value: b.incomeMinor + deltaMinor, unit: "money" },
          { label: "Monthly saving", value: saving, unit: "money" },
          { label: "Contributions to the target", value: next.months ?? 0, unit: "text", text: next.months == null ? "Not reached" : `${next.months}, today ${baseline.months}` },
        ],
        chart: {
          xUnit: "month",
          target: b.targetMinor,
          series: [
            { key: "baseline", label: "Today's income", emphasis: "reference", points: baseline.path.map((y, x) => ({ x, y })) },
            { key: "scenario", label: v.changeBp >= 0 ? "With the raise" : "With the drop", emphasis: "primary", points: next.path.map((y, x) => ({ x, y })) },
          ],
          marks: next.months != null ? [{ x: next.months, label: when }] : [],
        },
        summary,
        numbers: { changeBp: v.changeBp, newIncomeMinor: b.incomeMinor + deltaMinor, monthlySavingMinor: saving, months: next.months, baselineMonths: baseline.months },
      };
    }
    case "invest": {
      const r = investDelta({ monthlyMinor: v.monthlyMinor, annualRateBp: v.annualRateBp, years: v.years });
      const at = (y: number) => (y <= v.years ? r.values[y * 12] : null);
      const milestones = [1, 3, 5].filter((y) => y <= v.years);
      const yearly = Array.from({ length: v.years + 1 }, (_, y) => y);
      const summary =
        `Putting ${ron(v.monthlyMinor)} aside every month at a fictional ${pct(v.annualRateBp)} a year: ` +
        milestones.map((y) => `${ron(at(y)!)} after ${plural(y, "year")}`).join(", ") +
        `${milestones.includes(v.years) ? "" : `, ${ron(r.finalMinor)} after ${plural(v.years, "year")}`}; you put in ${ron(r.contributedMinor)} of it. Illustration, not a promise.`;
      return {
        headline: `${ron(r.finalMinor)} after ${plural(v.years, "year")}`,
        sub: `${ron(r.contributedMinor)} put in, ${ron(r.growthMinor)} illustrative growth`,
        tone: "neutral",
        lines: milestones.map((y) => ({ label: `After ${plural(y, "year")}`, value: at(y)!, unit: "money" as const })),
        chart: {
          xUnit: "year",
          series: [
            { key: "contributed", label: "Put in", emphasis: "reference", points: yearly.map((y) => ({ x: y, y: r.contributed[y * 12] })) },
            { key: "value", label: "With fictional growth", emphasis: "primary", points: yearly.map((y) => ({ x: y, y: r.values[y * 12] })) },
          ],
          marks: milestones.map((y) => ({ x: y, label: `${y}y` })),
        },
        summary,
        numbers: { monthlyMinor: v.monthlyMinor, annualRateBp: v.annualRateBp, years: v.years, year1Minor: at(1), year3Minor: at(3), year5Minor: at(5), finalMinor: r.finalMinor, contributedMinor: r.contributedMinor },
      };
    }
  }
}

export { ron as formatRon, pct as formatPct };

/* ------------------------------------------------------------------------------------------- builders */

/** Fictional demo assumptions, labelled wherever they appear. Not offers, products or forecasts. */
export const FICTIONAL = {
  installmentRateBp: 1200,
  growthRateBp: 500,
  termMonths: 12,
  years: 5,
} as const;

const RON = 100;

export function makeLoanSimulation(asOf: string, base: HomeBase, opts: { principalMinor: number; itemLabel: string; termMonths?: number; annualRateBp?: number; sources: string[] }): Simulation {
  const principal = Math.max(500 * RON, Math.round(opts.principalMinor / (100 * RON)) * 100 * RON);
  return {
    id: "loan",
    kind: "loan",
    title: `Pay ${opts.itemLabel} in installments`,
    asOf,
    base: { ...base, itemLabel: opts.itemLabel },
    sliders: [
      { key: "principalMinor", label: "Amount", unit: "money", min: 500 * RON, max: Math.max(20_000 * RON, principal), step: 100 * RON, value: principal },
      { key: "termMonths", label: "Term", unit: "months", min: 3, max: 36, step: 1, value: Math.min(36, Math.max(3, opts.termMonths ?? FICTIONAL.termMonths)) },
      { key: "annualRateBp", label: "Fictional annual rate", unit: "percent", min: 0, max: 3000, step: 50, value: Math.min(3000, Math.max(0, opts.annualRateBp ?? FICTIONAL.installmentRateBp)) },
    ],
    sources: opts.sources,
    assumptions: [
      "Fixed monthly installments; the rate is fictional, not an offer or a credit decision.",
      "Installments come out of the monthly saving; spending and income stay the same.",
    ],
  };
}

export function makeIncomeSimulation(asOf: string, base: HomeBase & { incomeMinor: number }, opts: { changeBp?: number; sources: string[] }): Simulation {
  return {
    id: "income",
    kind: "income",
    title: "If your income changes",
    asOf,
    base,
    sliders: [{ key: "changeBp", label: "Income change", unit: "percent", min: -3000, max: 3000, step: 100, value: Math.min(3000, Math.max(-3000, Math.round((opts.changeBp ?? 0) / 100) * 100)) }],
    sources: opts.sources,
    assumptions: ["The whole change goes to saving; spending stays the same. Taxes are not modelled."],
  };
}

export function makeInvestSimulation(asOf: string, base: { confirmedMinor: number; foundMinor: number }, opts: { monthlyMinor?: number; annualRateBp?: number; years?: number; sources: string[] }): Simulation {
  const monthly = Math.max(0, Math.round((opts.monthlyMinor ?? base.confirmedMinor + base.foundMinor) / RON) * RON);
  return {
    id: "invest",
    kind: "invest",
    title: "Invest what NextMove saves you",
    asOf,
    base,
    sliders: [
      { key: "monthlyMinor", label: "Each month", unit: "money", min: 0, max: Math.max(1_000 * RON, monthly * 2), step: RON, value: monthly },
      { key: "annualRateBp", label: "Fictional yearly growth", unit: "percent", min: 0, max: 1000, step: 25, value: Math.min(1000, Math.max(0, opts.annualRateBp ?? FICTIONAL.growthRateBp)) },
      { key: "years", label: "Horizon", unit: "years", min: 1, max: 10, step: 1, value: Math.min(10, Math.max(1, opts.years ?? FICTIONAL.years)) },
    ],
    sources: opts.sources,
    assumptions: ["Illustration, not a promise; fictional rate. Real investments can lose value.", "Deposits at the end of each month; growth credited monthly."],
  };
}
