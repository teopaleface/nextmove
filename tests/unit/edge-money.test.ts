import { describe, expect, it } from "vitest";
import { MAX_MINOR, MoneyError, add, assertMinor, ceilDiv, divRoundHalfUp, formatMoney, formatShort, money, parseMajorToMinor } from "../../src/shared/money";
import { addLocalMonths, formatDay, fromLocal, localDate, localDaysBetween, toLocalIso, toMs, withLocalDay } from "../../src/shared/time";
import {
  clampValues,
  evaluate,
  formatPct,
  formatRon,
  goalPath,
  initialValues,
  investDelta,
  loanSchedule,
  makeIncomeSimulation,
  makeInvestSimulation,
  makeLoanSimulation,
  monthLabel,
} from "../../src/shared/simulations";

// Edge cases for the pure money, calendar and simulation helpers. Amounts are whole bani with a hard bound; display
// uses a true minus sign; parsing accepts only the English "1,234.56" form and refuses everything else (including
// the Romanian "1.234,56", which is not supported). Calendar maths runs in Europe/Bucharest: month ends clamp, leap
// days survive, DST gaps and overlaps resolve to one real instant, and local days turn at local midnight. Simulations
// stay finite and monotonic at their limits and never print NaN, whatever the slider values.

const L = (iso: string) => toMs(iso);
const local = (ms: number) => toLocalIso(ms);
const BAD = /NaN|Infinity|undefined/;

describe("money: bounds, rounding and display", () => {
  it("formats negative, zero, large and EUR amounts with grouping and a true minus sign", () => {
    expect(formatMoney(-1)).toBe("−0.01 RON");
    expect(formatMoney(-150, "EUR")).toBe("−1.50 EUR");
    expect(formatMoney(0)).toBe("0.00 RON");
    expect(formatMoney(-0)).toBe("0.00 RON"); // never "−0.00"
    expect(formatMoney(MAX_MINOR, "EUR")).toBe("1,000,000,000.00 EUR");
    expect(formatMoney(-MAX_MINOR)).toBe("−1,000,000,000.00 RON");
    expect(formatMoney(1_234_567, "EUR")).toBe("12,345.67 EUR");
    expect(formatMoney(5, "RON", { sign: true })).toBe("+0.05 RON");
    expect(formatMoney(-5, "RON", { sign: true })).toBe("−0.05 RON");
    expect(formatMoney(0, "RON", { sign: true })).toBe("0.00 RON"); // zero carries no sign
    expect(formatShort(-15_300)).toBe("−153 RON");
    expect(formatShort(15_350)).toBe("153.50 RON");
  });

  it("keeps amounts to safe whole bani inside the bound", () => {
    for (const bad of [0.5, 0.005, NaN, Infinity, -Infinity, 2 ** 53, "100", null, undefined]) expect(() => assertMinor(bad)).toThrow(MoneyError);
    expect(() => assertMinor(MAX_MINOR + 1)).toThrow(/bound/);
    expect(() => assertMinor(-MAX_MINOR - 1)).toThrow(/bound/);
    expect(assertMinor(MAX_MINOR)).toBe(MAX_MINOR);
    expect(assertMinor(-0)).toBe(-0);
    expect(() => money(2 ** 53)).toThrow(MoneyError);
    expect(() => add(money(1, "RON"), money(1, "EUR"))).toThrow(/Mixed currency/);
    expect(add(money(1, "EUR"), money(-1, "EUR"))).toEqual({ minor: 0, currency: "EUR" });
  });

  it("rounds half away from zero and refuses a zero denominator", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(divRoundHalfUp(1, 3)).toBe(0);
    expect(divRoundHalfUp(2, 3)).toBe(1);
    expect(() => divRoundHalfUp(1, 0)).toThrow(MoneyError);
    expect(ceilDiv(5, 2)).toBe(3);
    expect(ceilDiv(0, 7)).toBe(0);
    // Months-to-goal semantics: nothing left to cover is zero months, never negative.
    expect(ceilDiv(-5, 2)).toBe(0);
    expect(() => ceilDiv(1, 0)).toThrow(MoneyError);
  });

  it("parses only the English 1,234.56 form; Romanian 1.234,56 and other shapes are refused", () => {
    expect(parseMajorToMinor("1,234.56")).toBe(123_456);
    expect(parseMajorToMinor("1,234,567.8")).toBe(123_456_780);
    expect(parseMajorToMinor("-0.01")).toBe(-1);
    expect(parseMajorToMinor("  12 RON")).toBe(1_200);
    for (const bad of ["1.234,56", "1234,56", "12.345", "1,23", "0.005", "1e3", ".5", "-", "", "99999999999999999"]) {
      expect(() => parseMajorToMinor(bad), bad).toThrow(MoneyError);
    }
  });
});

describe("calendar in Europe/Bucharest", () => {
  it("clamps month ends and keeps leap days", () => {
    expect(local(addLocalMonths(L("2026-01-31T10:00:00+02:00"), 1))).toBe("2026-02-28T10:00:00+02:00");
    expect(local(addLocalMonths(L("2028-01-31T10:00:00+02:00"), 1))).toBe("2028-02-29T10:00:00+02:00");
    expect(local(addLocalMonths(L("2028-02-29T10:00:00+02:00"), 12))).toBe("2029-02-28T10:00:00+02:00");
    expect(local(addLocalMonths(L("2028-02-29T10:00:00+02:00"), 48))).toBe("2032-02-29T10:00:00+02:00");
    expect(local(addLocalMonths(L("2026-03-31T00:00:00+03:00"), -1))).toBe("2026-02-28T00:00:00+02:00");
    // Each step counts from the original day, so a 31st billing day comes back after a short month.
    expect([1, 2, 3, 4].map((n) => local(addLocalMonths(L("2027-01-31T00:00:00+02:00"), n)))).toEqual([
      "2027-02-28T00:00:00+02:00",
      "2027-03-31T00:00:00+03:00",
      "2027-04-30T00:00:00+03:00",
      "2027-05-31T00:00:00+03:00",
    ]);
  });

  it("puts billing day 29, 30 and 31 on the last day of a short month, and clamps nonsense days", () => {
    const feb = L("2027-02-10T08:00:00+02:00");
    for (const d of [29, 30, 31, 99]) expect(local(withLocalDay(feb, d))).toBe("2027-02-28T08:00:00+02:00");
    for (const d of [0, -3]) expect(local(withLocalDay(feb, d))).toBe("2027-02-01T08:00:00+02:00");
    expect(local(withLocalDay(L("2028-02-10T08:00:00+02:00"), 31))).toBe("2028-02-29T08:00:00+02:00");
    expect(local(withLocalDay(L("2026-04-10T08:00:00+03:00"), 31))).toBe("2026-04-30T08:00:00+03:00");
  });

  it("resolves the DST gap (29 Mar 2026) and overlap (25 Oct 2026) to one real instant", () => {
    // Spring forward: 03:00–03:59 does not exist; it lands an hour later.
    expect(local(fromLocal(2026, 3, 29, 2, 59))).toBe("2026-03-29T02:59:00+02:00");
    expect(local(fromLocal(2026, 3, 29, 3, 30))).toBe("2026-03-29T04:30:00+03:00");
    expect(local(fromLocal(2026, 3, 29, 4, 0))).toBe("2026-03-29T04:00:00+03:00");
    // Fall back: 03:00–03:59 happens twice; the later (winter) one is used.
    expect(local(fromLocal(2026, 10, 25, 2, 59))).toBe("2026-10-25T02:59:00+03:00");
    expect(local(fromLocal(2026, 10, 25, 3, 30))).toBe("2026-10-25T03:30:00+02:00");
    expect(local(L("2026-10-25T00:30:00Z"))).toBe("2026-10-25T03:30:00+03:00");
    expect(local(L("2026-10-25T01:30:00Z"))).toBe("2026-10-25T03:30:00+02:00");
    // A monthly charge keeps its wall-clock time across the change.
    expect(local(addLocalMonths(L("2026-02-28T09:00:00+02:00"), 1))).toBe("2026-03-28T09:00:00+02:00");
    expect(local(addLocalMonths(L("2026-03-15T09:00:00+02:00"), 1))).toBe("2026-04-15T09:00:00+03:00");
    expect(local(addLocalMonths(L("2026-10-15T09:00:00+03:00"), 1))).toBe("2026-11-15T09:00:00+02:00");
    // A 23-hour and a 25-hour day are each still one local day.
    expect(localDaysBetween(L("2026-03-28T12:00:00+02:00"), L("2026-03-29T12:00:00+03:00"))).toBe(1);
    expect(localDaysBetween(L("2026-10-24T23:30:00+03:00"), L("2026-10-25T23:30:00+02:00"))).toBe(1);
  });

  it("turns the local day at local midnight, not UTC midnight", () => {
    expect(localDate(L("2026-10-25T21:59:59Z"))).toBe("2026-10-25");
    expect(localDate(L("2026-10-25T22:00:00Z"))).toBe("2026-10-26");
    expect(localDate(L("2026-03-28T21:59:59Z"))).toBe("2026-03-28");
    expect(localDate(L("2026-03-28T22:00:00Z"))).toBe("2026-03-29");
    expect(localDate(L("2026-07-01T20:59:59Z"))).toBe("2026-07-01");
    expect(localDate(L("2026-07-01T21:00:00Z"))).toBe("2026-07-02");
    expect(formatDay("2026-10-31T21:59:00Z")).toBe("31 Oct");
    expect(formatDay("2026-10-31T22:30:00Z")).toBe("1 Nov");
    expect(monthLabel("2026-10-31T22:30:00Z", 0)).toBe("November 2026");
    expect(monthLabel("2026-01-31T10:00:00+02:00", 1)).toBe("February 2026");
    expect(monthLabel("2026-10-28T07:41:00Z", null)).toBe("Not within 50 years");
  });
});

describe("simulations at their limits", () => {
  it("loan: 1 and 120 months, 0% and the 50% cap, zero and huge principal stay exact and end at zero", () => {
    expect(loanSchedule({ principalMinor: 600_000, termMonths: 1, annualRateBp: 0 }).payments).toEqual([600_000]);
    expect(loanSchedule({ principalMinor: 0, termMonths: 12, annualRateBp: 1200 }).totalPaidMinor).toBe(0);
    // Rounding remainders go into the last payment; nothing is lost or invented.
    expect(loanSchedule({ principalMinor: 100, termMonths: 3, annualRateBp: 0 }).payments).toEqual([34, 34, 32]);
    expect(loanSchedule({ principalMinor: 1, termMonths: 3, annualRateBp: 0 }).payments).toEqual([1, 0, 0]);
    for (const [principalMinor, termMonths, annualRateBp] of [[600_000, 12, 5000], [MAX_MINOR, 120, 5000], [10_000, 7, 0], [99_999, 120, 1]]) {
      const r = loanSchedule({ principalMinor, termMonths, annualRateBp });
      expect(r.payments).toHaveLength(termMonths);
      expect(r.balances.at(-1)).toBe(0);
      expect([...r.payments, ...r.balances, r.totalPaidMinor, r.totalInterestMinor].every(Number.isSafeInteger)).toBe(true);
      expect(r.totalPaidMinor).toBe(principalMinor + r.totalInterestMinor);
      expect(r.payments.reduce((s, p) => s + p, 0)).toBe(r.totalPaidMinor);
    }
    for (const bad of [{ termMonths: 0 }, { termMonths: 121 }, { termMonths: 1.5 }, { annualRateBp: -1 }, { annualRateBp: 5001 }, { annualRateBp: 10_000 }, { principalMinor: -1 }, { principalMinor: NaN }]) {
      expect(() => loanSchedule({ principalMinor: 600_000, termMonths: 12, annualRateBp: 1200, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it("loan: the monthly payment rises with the rate and falls with the term", () => {
    let prev = -1;
    for (const bp of [0, 1, 500, 1200, 2500, 5000]) {
      const p = loanSchedule({ principalMinor: 600_000, termMonths: 24, annualRateBp: bp }).monthlyPaymentMinor;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    prev = Infinity;
    for (const term of [1, 3, 6, 12, 24, 60, 120]) {
      const p = loanSchedule({ principalMinor: 600_000, termMonths: term, annualRateBp: 1200 }).monthlyPaymentMinor;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it("goal path: unreachable is null, never a fake date; outflows push the date later", () => {
    expect(goalPath({ startMinor: 0, targetMinor: 100, monthlySavingMinor: 1 }).months).toBe(100);
    expect(goalPath({ startMinor: 0, targetMinor: 1e9, monthlySavingMinor: 1 }).months).toBeNull();
    expect(goalPath({ startMinor: 0, targetMinor: 1_000, monthlySavingMinor: 0 }).months).toBeNull();
    expect(goalPath({ startMinor: 5_000, targetMinor: 1_000, monthlySavingMinor: 0 }).months).toBe(0);
    expect(goalPath({ startMinor: 0, targetMinor: 1_000, monthlySavingMinor: 100, outflows: [500, 500, 500] }).months).toBe(25);
    expect(goalPath({ startMinor: 0, targetMinor: 1_000, monthlySavingMinor: 100 }).months).toBe(10);
  });

  it("invest: 0% is exactly what you put in; growth rises with rate and years; out-of-range inputs throw", () => {
    expect(investDelta({ monthlyMinor: 100, annualRateBp: 0, years: 1 })).toMatchObject({ finalMinor: 1_200, contributedMinor: 1_200, growthMinor: 0 });
    expect(investDelta({ monthlyMinor: 0, annualRateBp: 2000, years: 30 }).finalMinor).toBe(0);
    let prev = -1;
    for (const bp of [0, 100, 500, 1000, 2000]) {
      const f = investDelta({ monthlyMinor: 10_000, annualRateBp: bp, years: 10 }).finalMinor;
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    prev = -1;
    for (const years of [1, 2, 5, 10, 30]) {
      const f = investDelta({ monthlyMinor: 10_000, annualRateBp: 500, years }).finalMinor;
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    expect(Number.isSafeInteger(investDelta({ monthlyMinor: MAX_MINOR, annualRateBp: 2000, years: 30 }).finalMinor)).toBe(true);
    for (const bad of [{ years: 0 }, { years: 31 }, { annualRateBp: -1 }, { annualRateBp: 2001 }, { monthlyMinor: -1 }, { monthlyMinor: 0.5 }]) {
      expect(() => investDelta({ monthlyMinor: 100, annualRateBp: 500, years: 5, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it("tampered, non-finite or extreme slider values are clamped and never print NaN", () => {
    const ASOF = "2026-10-28T07:41:00.000Z";
    const home = { liquidMinor: 110_000_00, targetMinor: 130_000_00, monthlySavingMinor: 6_000_00 };
    const sims = [
      makeLoanSimulation(ASOF, home, { principalMinor: 600_000, itemLabel: "the phone", sources: [] }),
      makeLoanSimulation(ASOF, { ...home, monthlySavingMinor: 0 }, { principalMinor: 600_000, itemLabel: "the phone", sources: [] }),
      makeLoanSimulation(ASOF, { ...home, monthlySavingMinor: -100 }, { principalMinor: -5, itemLabel: "x", sources: [] }),
      makeIncomeSimulation(ASOF, { ...home, incomeMinor: 0 }, { changeBp: 5000, sources: [] }),
      makeIncomeSimulation(ASOF, { ...home, incomeMinor: 9_000_00 }, { sources: [] }),
      makeInvestSimulation(ASOF, { confirmedMinor: 0, foundMinor: 0 }, { sources: [] }),
      makeInvestSimulation(ASOF, { confirmedMinor: -500, foundMinor: 0 }, { sources: [], years: 0, annualRateBp: -5 }),
    ];
    const hostile: unknown[] = [NaN, Infinity, -Infinity, -1e300, 1e300, 2 ** 53, -5, 0, 0.5, "abc", null, undefined];
    for (const sim of sims) {
      const values = [initialValues(sim), ...hostile.map((v) => Object.fromEntries(sim.sliders.map((s) => [s.key, v])))];
      for (const raw of values) {
        const v = clampValues(sim, raw as any);
        for (const s of sim.sliders) {
          expect(v[s.key]).toBeGreaterThanOrEqual(s.min);
          expect(v[s.key]).toBeLessThanOrEqual(s.max);
        }
        const out = evaluate(sim, raw as any);
        const text = [out.headline, out.sub, out.summary, ...out.lines.map((l) => `${l.label} ${l.value} ${l.text ?? ""}`)].join(" | ");
        expect(text, `${sim.kind} ${JSON.stringify(raw)}`).not.toMatch(BAD);
        for (const [k, n] of Object.entries(out.numbers)) if (n !== null) expect(Number.isFinite(n), `${sim.kind} ${k}`).toBe(true);
        for (const series of out.chart.series) for (const p of series.points) expect(Number.isFinite(p.y) || p.y === null, `${sim.kind} ${series.key}`).toBe(true);
      }
    }
  });

  it("display helpers: whole lei drop the decimals, negative uses a true minus, percentages keep needed digits", () => {
    expect(formatRon(0)).toBe("0 RON");
    expect(formatRon(-0)).toBe("0 RON");
    expect(formatRon(5)).toBe("0.05 RON");
    expect(formatRon(-150)).toBe("−1.50 RON");
    expect(formatRon(600_000)).toBe("6,000 RON");
    expect(formatPct(1200)).toBe("12%");
    expect(formatPct(1250)).toBe("12.5%");
    expect(formatPct(1234)).toBe("12.34%");
    expect(formatPct(5)).toBe("0.05%");
    expect(formatPct(0)).toBe("0%");
  });
});
