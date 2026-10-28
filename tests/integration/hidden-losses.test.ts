import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { funds, startStack, type Stack } from "./harness";

// A15–A18 through the real API: evidence and numbers from seeded statement data, confirmation before any action,
// execution through the existing proposal → approval → gated execution → receipt path.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

const scheduled = (subId: string) => stack.q<any>("SELECT amount_minor, due_at FROM forecast_items WHERE subscription_id=? AND status='SCHEDULED'", subId);

describe("hidden-loss detectors", () => {
  it("seeding is additive: balances, the 242 RON window and the repeated-payment groups are unchanged", async () => {
    const a = await stack.login("alex");
    const home = await a.json("/api/home");
    expect(home.upcoming.windowTotalMinor).toBe(24200);
    const a8 = await a.json("/api/capabilities/A8");
    expect(a8.numbers.groups).toBe(3);
  });

  it("A15: computes the loss and stops DashEats Plus renewal through the merchant", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const r = await a.json("/api/capabilities/A15");
    expect(r.numbers).toMatchObject({ paidMinor: 5998, savedMinor: 799, netLossMinor: 5199, breakEvenOrdersPerMonth: 4, ordersInWindow: 1, avoidedNextMinor: 2999 });
    const c = r.candidates.find((x: any) => x.key === "stop-dasheats");
    expect(c.available).toBe(true);
    expect(c.spec.money.forecastChangeMinor).toBe(-2999);
    const before = funds(stack, t, `${t}:personal`);
    const p = await stack.propose(a, "A15", ["stop-dasheats"]);
    const w = await stack.worker();
    try {
      await stack.approve(a, p);
      expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "UNKNOWN", "REFUSED", "BLOCKED"])).status).toBe("CONFIRMED");
    } finally {
      await w.stop();
    }
    expect(scheduled(`${t}:sub:dasheats`)).toHaveLength(0);
    expect(funds(stack, t, `${t}:personal`)).toBe(before); // avoided future charge, not a credit
    const after = await a.json("/api/capabilities/A15");
    expect(after.candidates).toHaveLength(0);
    expect(after.done.label).toMatch(/confirmed by the provider/);
    expect((await a.json("/api/home")).upcoming.windowTotalMinor).toBe(24200);
  });

  it("A16: advisory only, with the annual markup", async () => {
    const a = await stack.login("alex");
    const r = await a.json("/api/capabilities/A16");
    expect(r.numbers.flagged).toBe(2);
    expect(r.numbers.annualMinor).toBeGreaterThan(0);
    expect(r.candidates).toHaveLength(0);
    expect(r.evidence).toContain("PREPARED_NOT_SENT");
  });

  it("A17: asks first; nothing can be proposed until the customer answers, then a freeze runs", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const r = await a.json("/api/capabilities/A17");
    expect(r.numbers).toMatchObject({ silentPaidMinor: 75000, silentCycles: 3 });
    expect(r.blocks.find((b: any) => b.kind === "question").answer).toBeNull();
    expect(r.candidates.every((c: any) => !c.available)).toBe(true);
    const refused = await a.post("/api/capabilities/A17/propose", { keys: ["pause-pulsegym"] });
    expect(refused.status).toBe(409);

    await a.ok("/api/facts", { key: "agent:a17:pulsegym", value: "yes" });
    expect((await a.json("/api/capabilities/A17")).candidates).toHaveLength(0);

    await a.ok("/api/facts", { key: "agent:a17:pulsegym", value: "break" });
    const b = await a.ok("/api/capabilities/A17", { inputs: { months: 2 } });
    expect(b.candidates.map((c: any) => [c.key, c.available])).toEqual([["pause-pulsegym", true]]);
    const p = await stack.propose(a, "A17", ["pause-pulsegym"], { months: 2 });
    const w = await stack.worker();
    try {
      await stack.approve(a, p);
      expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "UNKNOWN", "REFUSED", "BLOCKED"])).status).toBe("CONFIRMED");
    } finally {
      await w.stop();
    }
    expect(scheduled(`${t}:sub:pulsegym`).map((f) => f.due_at)).toEqual(["2027-01-05T07:00:00+02:00"]);
    expect((await a.json("/api/capabilities/A17")).headline).toMatch(/frozen until/);
  });

  it("A18: lists every gap; stop renewal is offered only after the customer says the gaps don't matter", async () => {
    const a = await stack.login("alex");
    const r = await a.json("/api/capabilities/A18");
    expect(r.numbers).toMatchObject({ annualMinor: 21900, gaps: 6, rows: 7 });
    expect(r.candidates[0].available).toBe(false);
    await a.ok("/api/facts", { key: "agent:a18:safetrip", value: "no" });
    const b = await a.json("/api/capabilities/A18");
    expect(b.candidates[0].available).toBe(true);
    expect(b.candidates[0].spec.consequences.lostBenefits).toHaveLength(6);
  });
});
