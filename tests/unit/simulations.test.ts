import { describe, expect, it } from "vitest";
import cases from "../../demo/cases.json";
import { homeReadiness } from "../../src/server/finance/goals";
import {
  clampValues,
  evaluate,
  goalPath,
  initialValues,
  investDelta,
  loanSchedule,
  makeIncomeSimulation,
  makeInvestSimulation,
  makeLoanSimulation,
  monthLabel,
} from "../../src/shared/simulations";
import { ensureSimulation, numbersIn, simulatedSimulationDecision, simulationIntent, valuesFromText } from "../../src/server/agent/simulations";

const p = cases.phoneAndHome;
const ASOF = "2026-10-28T07:41:00.000Z";
const home = {
  liquidMinor: p.openingCashMinor,
  targetMinor: p.homeDepositMinor + p.closingAndMovingMinor + p.protectedReserveMinor,
  monthlySavingMinor: p.monthlySavingsBeforeHomeMinor,
};

describe("loanSchedule (annuity installments)", () => {
  it("6,000 RON over 12 months at a fictional 12% pays 533.09 RON a month and repays exactly", () => {
    const r = loanSchedule({ principalMinor: 600_000, termMonths: 12, annualRateBp: 1200 });
    expect(r.monthlyPaymentMinor).toBe(53_309);
    expect(r.payments).toHaveLength(12);
    expect(r.balances.at(-1)).toBe(0);
    expect(r.payments.reduce((s, x) => s + x, 0)).toBe(r.totalPaidMinor);
    expect(r.totalPaidMinor - 600_000).toBe(r.totalInterestMinor);
    // Closed form: 12 × 533.0927… − 6,000 ≈ 397.11 RON; per-month rounding may move it by a few bani.
    expect(Math.abs(r.totalInterestMinor - 39_711)).toBeLessThanOrEqual(5);
    expect(Math.abs(r.payments[11] - r.monthlyPaymentMinor)).toBeLessThanOrEqual(5);
  });

  it("at 0% splits the principal evenly with no interest", () => {
    const r = loanSchedule({ principalMinor: 600_000, termMonths: 12, annualRateBp: 0 });
    expect(r.monthlyPaymentMinor).toBe(50_000);
    expect(r.totalInterestMinor).toBe(0);
    expect(r.balances.at(-1)).toBe(0);
  });

  it("rejects fractional terms and negative amounts", () => {
    expect(() => loanSchedule({ principalMinor: 600_000, termMonths: 1.5, annualRateBp: 0 })).toThrow();
    expect(() => loanSchedule({ principalMinor: -1, termMonths: 12, annualRateBp: 0 })).toThrow();
  });
});

describe("goalPath agrees with O1's homeReadiness", () => {
  it("reproduces the canonical 4 / 5 / 4 contributions", () => {
    expect(goalPath({ startMinor: home.liquidMinor, targetMinor: home.targetMinor, monthlySavingMinor: home.monthlySavingMinor }).months).toBe(p.expected.contributionsWithoutPhone);
    expect(goalPath({ startMinor: home.liquidMinor, targetMinor: home.targetMinor, monthlySavingMinor: home.monthlySavingMinor, upfrontMinor: p.phonePriceMinor }).months).toBe(p.expected.contributionsWithPhone);
    expect(goalPath({ startMinor: home.liquidMinor, targetMinor: home.targetMinor, monthlySavingMinor: home.monthlySavingMinor, upfrontMinor: p.alternativePhonePriceMinor }).months).toBe(p.expected.contributionsWithAlternativePhone);
  });

  it("matches ceil(gap / saving) across a grid of inputs", () => {
    for (const liquid of [0, 50_000_00, 110_000_00, 129_999_99, 130_000_00, 150_000_00])
      for (const saving of [500_00, 2_500_00, 6_000_00, 7_200_00])
        for (const purchase of [0, 3_500_00, 6_000_00]) {
          const ref = homeReadiness({ liquidMinor: liquid, downPaymentMinor: p.homeDepositMinor, transactionCostsMinor: p.closingAndMovingMinor, protectedReserveMinor: p.protectedReserveMinor, monthlyContributionMinor: saving }, purchase);
          expect(goalPath({ startMinor: liquid, targetMinor: ref.targetMinor!, monthlySavingMinor: saving, upfrontMinor: purchase }).months).toBe(ref.contributions);
        }
  });

  it("reports an unreachable target instead of looping", () => {
    expect(goalPath({ startMinor: 0, targetMinor: 1_000_00, monthlySavingMinor: 0 }).months).toBeNull();
    expect(goalPath({ startMinor: 0, targetMinor: 1_000_00, monthlySavingMinor: -5_00 }).months).toBeNull();
  });
});

describe("investDelta (monthly deposits, monthly growth)", () => {
  it("at 0% equals the money put in", () => {
    const r = investDelta({ monthlyMinor: 153_00, annualRateBp: 0, years: 5 });
    expect(r.values[12]).toBe(1_836_00);
    expect(r.finalMinor).toBe(9_180_00);
    expect(r.growthMinor).toBe(0);
  });

  it("at a fictional 5% stays within a ban per month of the closed-form annuity", () => {
    const r = investDelta({ monthlyMinor: 153_00, annualRateBp: 500, years: 5 });
    const i = 0.05 / 12;
    for (const y of [1, 3, 5]) {
      const n = y * 12;
      const exact = 153_00 * ((Math.pow(1 + i, n) - 1) / i);
      expect(Math.abs(r.values[n] - exact)).toBeLessThanOrEqual(n);
    }
    expect(r.contributedMinor).toBe(153_00 * 60);
    expect(r.growthMinor).toBeGreaterThan(0);
  });
});

describe("simulation descriptors", () => {
  it("loan: the 6,000 RON phone in 12 installments keeps the home goal in the same month but leaves a balance", () => {
    const sim = makeLoanSimulation(ASOF, home, { principalMinor: p.phonePriceMinor, itemLabel: "the phone", sources: [] });
    const o = evaluate(sim, initialValues(sim));
    expect(o.numbers.monthlyPaymentMinor).toBe(53_309);
    expect(o.numbers.baselineMonths).toBe(4);
    expect(o.numbers.upfrontMonths).toBe(5);
    expect(o.numbers.months).toBe(4);
    expect(o.numbers.freeCashMinor).toBe(600_000 - 53_309);
    expect(o.numbers.owedAtGoalMinor).toBeGreaterThan(0);
    expect(o.headline).toBe(`Home target ${monthLabel(ASOF, 4)}`);
    expect(o.summary).toContain("533.09 RON");
    // Sliders recompute with the same functions: a longer, costlier loan only changes the derived numbers.
    const o2 = evaluate(sim, { ...initialValues(sim), termMonths: 3 });
    expect(o2.numbers.monthlyPaymentMinor).toBeGreaterThan(200_000);
    expect(o2.numbers.months).toBe(5);
  });

  it("income: a 10% raise brings the home goal one month sooner; a 50% cut puts it out of reach", () => {
    const sim = makeIncomeSimulation(ASOF, { ...home, incomeMinor: p.monthlyIncomeMinor }, { changeBp: 1000, sources: [] });
    const o = evaluate(sim, initialValues(sim));
    expect(o.numbers.monthlySavingMinor).toBe(720_000);
    expect(o.numbers.months).toBe(3);
    expect(o.sub).toBe("1 month sooner than today's plan");
    const drop = evaluate(sim, { changeBp: -p.downsideIncomeReductionMinor / 120 });
    expect(drop.numbers.months).toBe(7);
    expect(evaluate(sim, { changeBp: -3000 }).numbers.months).toBe(9);
  });

  it("invest: 153 RON a month at a fictional 5% shows 1, 3 and 5 years", () => {
    const sim = makeInvestSimulation(ASOF, { confirmedMinor: 79_00, foundMinor: 74_00 }, { sources: [] });
    const v = initialValues(sim);
    expect(v).toEqual({ monthlyMinor: 153_00, annualRateBp: 500, years: 5 });
    const o = evaluate(sim, v);
    expect(o.lines.map((l) => l.label)).toEqual(["After 1 year", "After 3 years", "After 5 years"]);
    expect(o.numbers.year5Minor).toBe(o.numbers.finalMinor);
    expect(o.summary).toContain("Illustration, not a promise");
    expect(evaluate(sim, { ...v, years: 2 }).numbers.year3Minor).toBeNull();
  });

  it("clamps tampered or off-step values into the modelled range", () => {
    const sim = makeLoanSimulation(ASOF, home, { principalMinor: 600_000, itemLabel: "the phone", sources: [] });
    expect(clampValues(sim, { principalMinor: 1e12, termMonths: -4, annualRateBp: 1234 })).toEqual({ principalMinor: 2_000_000, termMonths: 3, annualRateBp: 1250 });
    expect(clampValues(sim, { principalMinor: Number.NaN })).toEqual(initialValues(sim));
  });
});

describe("planner routing for what-if questions", () => {
  it("recognizes the suggestions and leaves other questions alone", () => {
    expect(simulationIntent("Can I buy a 6,000 RON phone and still reach my home goal?")).toBe("loan");
    expect(simulationIntent("What if I get a 10% raise?")).toBe("income");
    expect(simulationIntent("What if I invest what NextMove saves me?")).toBe("invest");
    for (const q of ["Can you stop the FitFlow trial before it charges me?", "Is the student bundle worth it for me?", "Am I paying twice for cloud storage?", "Can I use my card travel credit?"]) expect(simulationIntent(q)).toBeNull();
  });

  it("reads only the numbers the customer wrote", () => {
    expect(valuesFromText("Can I buy a 6,000 RON phone and still reach my home goal?")).toEqual({ amountRon: 6000 });
    expect(valuesFromText("What if I get a 10% raise?")).toEqual({ changePct: 10 });
    expect(valuesFromText("What if my salary drops 20%?")).toEqual({ changePct: -20 });
    expect(valuesFromText("Phone on 24 months at 9%")).toEqual({ termMonths: 24, ratePct: 9 });
  });

  it("simulated planner: O1 first, then the widget, then an answer quoting the tool", () => {
    const q = "Can I buy a 6,000 RON phone and still reach my home goal?";
    expect(simulatedSimulationDecision(q, [], true)).toMatchObject({ tool: "analyze", capabilityId: "O1" });
    const a = { tool: "analyze", result: { capability: "O1", headline: "Home ready after 4 contributions; the 6,000 RON phone adds 1" } };
    expect(simulatedSimulationDecision(q, [a], true)).toMatchObject({ tool: "show_simulation", simulation: "loan" });
    const d = simulatedSimulationDecision(q, [a, { tool: "show_simulation", result: { summary: "6,000 RON for the phone …" } }], true);
    expect(d).toMatchObject({ tool: "final_answer" });
    expect((d as any).text).toContain("Home ready after 4 contributions");
    expect(simulatedSimulationDecision(q, [], false)).toBeNull();
    expect(simulatedSimulationDecision("What if I invest what NextMove saves me?", [], true)).toMatchObject({ tool: "show_simulation", simulation: "invest" });
  });

  it("live planner safety net: a what-if answer without a widget becomes show_simulation once", () => {
    const fin = { tool: "final_answer", reason: "", text: "The tool is unavailable." };
    expect(ensureSimulation(fin, "What if I get a 10% raise?", [], true)).toMatchObject({ tool: "show_simulation", simulation: "income" });
    expect(ensureSimulation(fin, "What if I get a 10% raise?", [{ tool: "show_simulation", result: {} }], true)).toBe(fin);
    expect(ensureSimulation(fin, "Am I paying twice for cloud storage?", [], true)).toBe(fin);
    expect(ensureSimulation(fin, "What if I get a 10% raise?", [], false)).toBe(fin);
  });

  it("reads Romanian and space-grouped amounts as the customer meant them", () => {
    expect([...numbersIn("1.500 lei")]).toEqual([1500]);
    expect([...numbersIn("12,50 lei")]).toEqual([12.5]);
    expect(valuesFromText("a 5 000 RON phone").amountRon).toBe(5000);
    expect(valuesFromText("un telefon de 1.500,50 lei").amountRon).toBe(1500.5);
  });
});
