import { describe, expect, it } from "vitest";
import { businessDayBefore, interestMinor, nextPayday, overdraftCostMinor, planShield, planVault, project } from "../../src/server/finance/cash-autopilot";
import { toLocalIso, toMs } from "../../src/shared/time";

// O7 bill vault and O8 overdraft shield calculations over the seeded Alex numbers (fictional rates).

const SALARY_AT = toMs("2026-11-10T08:00:00+02:00");
const BILLS = [
  { id: "rent", label: "Vatra Homes rent", amountMinor: 145000, dueAt: "2026-11-25T09:00:00+02:00" },
  { id: "studyplus", label: "StudyPlus renewal", amountMinor: 7900, dueAt: "2026-11-26T10:14:00+02:00" },
  { id: "streamly", label: "Streamly renewal", amountMinor: 4900, dueAt: "2026-11-26T14:22:00+02:00" },
  { id: "cloudbox", label: "CloudBox renewal", amountMinor: 3500, dueAt: "2026-11-26T09:03:00+02:00" },
];

describe("calendar", () => {
  it("returns one business day before, skipping weekends, at 08:00 local", () => {
    expect(toLocalIso(businessDayBefore(toMs("2026-11-25T09:00:00+02:00"), 8))).toBe("2026-11-24T08:00:00+02:00"); // Wed → Tue
    expect(toLocalIso(businessDayBefore(toMs("2026-11-30T09:00:00+02:00"), 8))).toBe("2026-11-27T08:00:00+02:00"); // Mon → Fri
    expect(toLocalIso(businessDayBefore(toMs("2026-11-01T09:00:00+02:00"), 8))).toBe("2026-10-30T08:00:00+02:00"); // Sun → Fri
  });
  it("next payday is the same day next month, across DST and year end", () => {
    expect(toLocalIso(nextPayday(toMs("2026-10-10T08:00:00+03:00"), 10, 8))).toBe("2026-11-10T08:00:00+02:00");
    expect(toLocalIso(nextPayday(toMs("2026-12-10T08:00:00+02:00"), 10, 8))).toBe("2027-01-10T08:00:00+02:00");
    expect(toLocalIso(nextPayday(toMs("2027-01-31T08:00:00+02:00"), 31, 8))).toBe("2027-02-28T08:00:00+02:00");
  });
  it("simple interest rounds half up to the ban", () => {
    expect(interestMinor(145000, 2.0, 14)).toBe(111); // 111.23
    expect(interestMinor(16300, 2.0, 15)).toBe(13); // 13.40
    expect(interestMinor(0, 2.0, 10)).toBe(0);
    expect(interestMinor(100000, 2.5, 0)).toBe(0);
  });
});

describe("O7 bill vault plan", () => {
  const base = { nowMs: SALARY_AT, nextPaydayMs: toMs("2026-12-10T08:00:00+02:00"), dailyBalanceMinor: 1568000, keepInDailyMinor: 50000, minDaysAway: 5, annualRatePct: 2.0, returnHourLocal: 8, toIso: toLocalIso };

  it("parks the rent and subscriptions with two returns one business day before each due date", () => {
    const p = planVault({ ...base, outflows: BILLS });
    expect(p.parkMinor).toBe(161300);
    expect(p.returns.map((r) => [r.returnAt, r.amountMinor, r.days])).toEqual([
      ["2026-11-24T08:00:00+02:00", 145000, 14],
      ["2026-11-25T08:00:00+02:00", 16300, 15],
    ]);
    expect(p.interestMinor).toBe(124);
    expect(p.bills.every((b) => b.status === "PARK")).toBe(true);
  });

  it("never parks money needed sooner or bills after the next payday", () => {
    const p = planVault({ ...base, outflows: [...BILLS, { id: "soon", label: "Gym", amountMinor: 9000, dueAt: "2026-11-13T09:00:00+02:00" }, { id: "late", label: "Phone", amountMinor: 6500, dueAt: "2026-12-11T09:00:00+02:00" }] });
    expect(p.bills.find((b) => b.id === "soon")!.status).toBe("TOO_SOON");
    expect(p.bills.find((b) => b.id === "late")!.status).toBe("AFTER_PAYDAY");
    expect(p.keptForSoonMinor).toBe(9000);
    expect(p.parkMinor).toBe(161300);
  });

  it("keeps the Daily buffer: bills that do not fit stay in Daily", () => {
    const p = planVault({ ...base, dailyBalanceMinor: 200000, outflows: BILLS });
    // capacity 2,000 − 500 = 1,500 RON: the rent fits, the 79 RON StudyPlus renewal would exceed it.
    expect(p.capacityMinor).toBe(150000);
    expect(p.parkMinor).toBe(148500);
    expect(p.bills.filter((b) => b.status === "NO_ROOM").map((b) => b.id)).toEqual(["studyplus", "streamly"]);
  });
});

describe("O8 overdraft shield", () => {
  const now = toMs("2026-10-28T09:41:00+02:00");
  const horizon = toMs("2026-11-10T08:00:00+02:00");
  const flows = [
    { id: "fitflow", label: "FitFlow trial becomes paid", amountMinor: -7900, at: "2026-10-30T09:00:00+02:00" },
    { id: "dental", label: "SmileCare Clinic dental treatment", amountMinor: -1490000, at: "2026-10-31T10:00:00+02:00" },
    { id: "mobilenet", label: "MobileNet bill", amountMinor: -6500, at: "2026-11-03T07:10:00+02:00" },
    { id: "after", label: "After salary", amountMinor: -99999900, at: "2026-11-26T09:00:00+02:00" },
  ];
  const overdraft = { annualRatePct: 21.9, feePerEventMinor: 2500 };
  const savings = { accountId: "savings", name: "Savings", balanceMinor: 9752000, keepMinor: 3000000, annualRatePct: 2.5, withdrawalFeeMinor: 0 };

  it("projects the lowest point before the next income and ignores later flows", () => {
    const pr = project(1248000, now, horizon, flows);
    expect(pr.lowestMinor).toBe(-256400);
    expect(pr.firstBelowFloor?.id).toBe("dental");
  });

  it("proposes the exact top-up from the cheapest eligible pocket and prices the overdraft it avoids", () => {
    const vault = { accountId: "vault", name: "Bill vault", balanceMinor: 161300, keepMinor: 0, annualRatePct: 2.0, withdrawalFeeMinor: 0, excludedReason: "Reserved for your scheduled bills" };
    const p = planShield({ balanceMinor: 1248000, floorMinor: 0, nowMs: now, horizonMs: horizon, flows, sources: [savings, vault], overdraft });
    expect(p.needMinor).toBe(256400);
    expect(p.legs).toEqual([{ accountId: "savings", name: "Savings", amountMinor: 256400, forgoneInterestMinor: 228, feeMinor: 0 }]);
    expect(p.shortfallMinor).toBe(0);
    expect(p.overdraftAfterMinor.costMinor).toBe(0);
    // 25 RON fee + 21.9% a year on 2,499 RON (31 Oct 10:00 → 3 Nov 07:10) and 2,564 RON (→ 10 Nov 08:00).
    expect(p.overdraftWithoutMinor.feeMinor).toBe(2500);
    expect(p.overdraftWithoutMinor.interestMinor).toBe(1514);
    expect(p.overdraftWithoutMinor.costMinor).toBe(4014);
    expect(p.sources.find((s) => s.accountId === "vault")!.usedMinor).toBe(0);
  });

  it("uses the cheaper pocket first when two are free", () => {
    const cheap = { accountId: "pocket", name: "Pocket", balanceMinor: 100000, keepMinor: 0, annualRatePct: 1.0, withdrawalFeeMinor: 0 };
    const p = planShield({ balanceMinor: 1248000, floorMinor: 0, nowMs: now, horizonMs: horizon, flows, sources: [savings, cheap], overdraft });
    expect(p.legs.map((l) => [l.accountId, l.amountMinor])).toEqual([["pocket", 100000], ["savings", 156400]]);
  });

  it("insufficient pocket: partial top-up with an explicit shortfall and the remaining overdraft cost", () => {
    const p = planShield({ balanceMinor: 1248000, floorMinor: 0, nowMs: now, horizonMs: horizon, flows, sources: [{ ...savings, keepMinor: 9700000 }], overdraft });
    expect(p.needMinor).toBe(256400);
    expect(p.coveredMinor).toBe(52000);
    expect(p.shortfallMinor).toBe(204400);
    expect(p.overdraftAfterMinor.costMinor).toBeGreaterThan(0);
    expect(p.overdraftAfterMinor.costMinor).toBeLessThan(p.overdraftWithoutMinor.costMinor);
  });

  it("no top-up when the balance stays above the floor", () => {
    const p = planShield({ balanceMinor: 1248000, floorMinor: 0, nowMs: now, horizonMs: horizon, flows: flows.filter((f) => f.id !== "dental"), sources: [savings], overdraft });
    expect(p.needMinor).toBe(0);
    expect(p.legs).toEqual([]);
    expect(overdraftCostMinor(1248000, now, horizon, [], overdraft).costMinor).toBe(0);
  });
});
