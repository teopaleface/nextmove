import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateRoute, roadblockFlows, roadblocksFromText, simulate, splitEven, type RouteInputs, type Saving } from "../../src/server/finance/route";
import { homeReadiness } from "../../src/server/finance/goals";

const root = path.resolve(__dirname, "../..");
const p = JSON.parse(fs.readFileSync(path.join(root, "demo/cases.json"), "utf8")).phoneAndHome;

// Alex's home goal, exactly the inputs O1 uses.
const alex: RouteInputs = {
  startMinor: p.openingCashMinor,
  targetMinor: p.homeDepositMinor + p.closingAndMovingMinor + p.protectedReserveMinor,
  reserveMinor: p.protectedReserveMinor,
  contributionMinor: p.monthlySavingsBeforeHomeMinor,
  incomeMinor: p.monthlyIncomeMinor,
  afterHomeMonthlyMinor: p.expected.monthlyAfterHomeMinor,
};
const fitflow: Saving = { key: "T2:stop-fitflow", capability: "T2", label: "FitFlow trial", amountMinor: 7900, month: 1 };
const pos = (r: { checkpoints: { positionMinor: number }[] }) => r.checkpoints.map((c) => c.positionMinor / 100);

describe("route planner (O6)", () => {
  it("matches O1: four monthly checkpoints to the 130,000 RON target", () => {
    const r = simulate(alex, []);
    const o1 = homeReadiness({ liquidMinor: alex.startMinor, downPaymentMinor: p.homeDepositMinor, transactionCostsMinor: p.closingAndMovingMinor, protectedReserveMinor: p.protectedReserveMinor, monthlyContributionMinor: p.monthlySavingsBeforeHomeMinor });
    expect(r.arrivalMonth).toBe(o1.contributions);
    expect(r.arrivalMonth).toBe(p.expected.contributionsWithoutPhone);
    expect(pos(r)).toEqual([110000, 116000, 122000, 128000, 134000]);
    expect(r.spareOnArrivalMinor).toBe(400000);
  });

  it("no roadblocks: nothing to reroute", () => {
    const e = evaluateRoute(alex, [], [fitflow]);
    expect(e.recalculated.arrivalMonth).toBe(4);
    expect(e.totalHitMinor).toBe(0);
    expect(e.recommended).toBeNull();
    expect(e.reroutes.find((r) => r.id === "D")).toBeUndefined();
  });

  it("900 RON dental bill: same arrival, spare drops to 3,100 RON", () => {
    const e = evaluateRoute(alex, ["dental"], [fitflow]);
    expect(e.recalculated.arrivalMonth).toBe(4);
    expect(e.recalculated.spareOnArrivalMinor).toBe(310000);
    expect(e.totalHitMinor).toBe(90000);
    const b = e.reroutes.find((r) => r.id === "B")!;
    expect(b.impact).toEqual({ kind: "TRANSFER", transferMinor: 510000, months: [1], schedule: [{ month: 1, transferMinor: 510000 }] });
    const c = e.reroutes.find((r) => r.id === "C")!;
    expect(c.verdict).toBe("OK");
    expect(c.impact).toEqual({ kind: "INSTALLMENT", perMonthMinor: 7500, months: 12 });
    expect(c.spareOnArrivalMinor).toBe(370000);
    expect(c.outstandingAfterArrivalMinor).toBe(60000); // 8 × 75 RON paid after the move
    const a = e.reroutes.find((r) => r.id === "A")!;
    expect(a.spareOnArrivalMinor).toBe(310000 + 7900);
    expect(e.recommended).toBe("A"); // C's spare is not counted while 600 RON is still owed
    expect(e.reroutes.find((r) => r.id === "D")).toBeUndefined();
  });

  it("income −20% for 2 months: arrival moves one month; keeping the date would breach the reserve", () => {
    const e = evaluateRoute(alex, ["income"], [fitflow]);
    expect(pos(e.recalculated)).toEqual([110000, 113600, 117200, 123200, 129200, 135200]);
    expect(e.recalculated.arrivalMonth).toBe(5);
    const b = e.reroutes.find((r) => r.id === "B")!;
    expect(b.delayMonths).toBe(1);
    expect(b.impact).toEqual({ kind: "TRANSFER", transferMinor: 360000, months: [1, 2], schedule: [{ month: 1, transferMinor: 360000 }, { month: 2, transferMinor: 360000 }] });
    const d = e.reroutes.find((r) => r.id === "D")!;
    expect(d.verdict).toBe("REJECTED");
    expect(d.reason).toEqual({ code: "RESERVE_ON_ARRIVAL", amountMinor: 2920000 });
    expect(d.action).toBeNull();
    expect(e.reroutes.find((r) => r.id === "C")!.verdict).toBe("UNAVAILABLE");
    // Only what other capabilities computed is counted: 79 RON does not close an 800 RON gap.
    expect(e.reroutes.find((r) => r.id === "A")!.arrivalMonth).toBe(5);
    for (const r of e.reroutes.filter((x) => x.verdict === "OK")) expect(r.reserveOnArrivalMinor).toBe(alex.reserveMinor);
  });

  it("monthly roadblocks run every month; cancelling the forgotten tool removes it", () => {
    const flows = roadblockFlows(["rent", "tool"], { ...alex, horizonMonths: 6 });
    expect(flows.filter((f) => f.source === "rent")).toHaveLength(6);
    const e = evaluateRoute(alex, ["rent", "tool"], []);
    expect(e.recalculated.spareOnArrivalMinor).toBe(400000 - 4 * 15000);
    const a = e.reroutes.find((r) => r.id === "A")!;
    expect(a.cancelsTool).toBe(true);
    expect(a.action).toBe("PLAN_CHANGE");
    expect(a.spareOnArrivalMinor).toBe(400000 - 4 * 10000);
  });

  it("all four roadblocks stack and every accepted route keeps the reserve", () => {
    const e = evaluateRoute(alex, ["dental", "rent", "tool", "income"], [fitflow]);
    expect(e.recalculated.arrivalMonth).toBe(5);
    expect(e.totalHitMinor).toBe(90000 + 480000 + 5 * 15000);
    expect(e.reroutes.find((r) => r.id === "D")!.verdict).toBe("REJECTED");
    expect(e.reroutes.filter((r) => r.verdict === "OK").every((r) => (r.minPositionMinor ?? 0) >= alex.reserveMinor)).toBe(true);
  });

  it("rejects a route whose funds fall below the reserve before arrival", () => {
    const tight = { ...alex, startMinor: 3050000 }; // 30,500 RON, reserve 30,000
    const e = evaluateRoute(tight, ["dental"], []);
    const b = e.reroutes.find((r) => r.id === "B")!;
    expect(b.verdict).toBe("REJECTED");
    expect(b.reason?.code).toBe("RESERVE_BEFORE_ARRIVAL");
    const c = e.reroutes.find((r) => r.id === "C")!;
    expect(c.verdict).toBe("OK"); // spreading keeps funds above the reserve
  });

  it("rejects installments the after-home budget cannot carry", () => {
    const e = evaluateRoute({ ...alex, afterHomeMonthlyMinor: 5000 }, ["dental"], []);
    expect(e.reroutes.find((r) => r.id === "C")!.reason).toEqual({ code: "AFTER_HOME_BUDGET", amountMinor: 5000 });
  });

  it("is deterministic and splits money exactly", () => {
    expect(JSON.stringify(evaluateRoute(alex, ["income", "dental"], [fitflow]))).toBe(JSON.stringify(evaluateRoute(alex, ["income", "dental"], [fitflow])));
    expect(splitEven(100001, 12).reduce((s, x) => s + x, 0)).toBe(100001);
  });

  it("reads roadblocks from the agent's request text", () => {
    expect(roadblocksFromText("A 900 RON dental bill just came in. Am I still on track for the home?")).toEqual(["dental"]);
    expect(roadblocksFromText("rent,income")).toEqual(["rent", "income"]);
    expect(roadblocksFromText("Am I on track?")).toEqual([]);
  });
});
