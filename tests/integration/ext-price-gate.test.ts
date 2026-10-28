import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { funds, startStack, type Api, type Stack } from "./harness";

// E5 Price consent gate end to end: an approved ceiling makes the bank soft-decline a higher merchant charge before
// any money moves; accepting the new price is its own exact approval, after which the merchant's retry posts.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const charge = (a: Api, amountMinor: number, initiator = "MERCHANT", subscription = "streamly") =>
  a.post("/api/labs/ext", { module: "price-gate", action: "merchant_charge", body: { subscription, amountMinor, initiator } });
const ctxOf = (a: Api) => `${a.tenantId}:personal`;
const nextItem = (t: string) => stack.q1<any>("SELECT amount_minor FROM forecast_items WHERE tenant_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at", t, `${t}:sub:streamly`);
const settle = (id: string) => stack.waitAction(id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);

async function setCeiling(a: Api, ceilingMinor?: number) {
  const e5 = await a.post("/api/capabilities/E5", { inputs: ceilingMinor == null ? {} : { ceilingMinor } });
  const c = e5.json.candidates.find((x: any) => x.key === "set-ceiling-streamly");
  expect(c).toMatchObject({ available: true, spec: { operation: "EXT_SET_PRICE_CEILING", route: "BANK_INTERNAL" } });
  const p = await stack.propose(a, "E5", [c.key], ceilingMinor == null ? {} : { ceilingMinor });
  await stack.approve(a, p);
  return p.actions[0].id as string;
}

describe("E5 price consent gate", () => {
  it("declines a higher merchant charge without moving money, then lets it through once the new price is accepted", async () => {
    const a = await stack.login("alex");
    const id = await setCeiling(a);
    expect((await settle(id)).status).toBe("CONFIRMED");
    expect(stack.q1<any>("SELECT * FROM ext_price_ceiling WHERE tenant_id=? AND status='ACTIVE'", a.tenantId)).toMatchObject({ approved_minor: 4900, context_id: ctxOf(a) });

    const before = funds(stack, a.tenantId, ctxOf(a));
    const d = await charge(a, 5900);
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ decision: "DECLINE", reason: "ABOVE_CEILING", transactionId: null });
    expect(funds(stack, a.tenantId, ctxOf(a))).toBe(before);
    expect(stack.q("SELECT * FROM ext_price_rise_notice WHERE tenant_id=? AND status='OPEN'", a.tenantId)).toHaveLength(1);
    expect(stack.q("SELECT * FROM notifications WHERE tenant_id=? AND link='/capabilities/E5'", a.tenantId)).toHaveLength(1);
    // Retries do not create a second notice or notification.
    expect((await charge(a, 5900)).json.decision).toBe("DECLINE");
    expect(stack.q("SELECT * FROM ext_price_rise_notice WHERE tenant_id=?", a.tenantId)).toHaveLength(1);
    expect(stack.q("SELECT * FROM notifications WHERE tenant_id=? AND link='/capabilities/E5'", a.tenantId)).toHaveLength(1);

    const e5 = await a.json("/api/capabilities/E5");
    expect(e5.blocks.some((b: any) => b.kind === "note" && /cannot cancel a contract/.test(b.text))).toBe(true);
    const accept = e5.candidates.find((x: any) => x.key === "accept-price-streamly");
    expect(accept).toMatchObject({ available: true, defaultSelected: false, spec: { operation: "EXT_ACCEPT_PRICE", params: { fromMinor: 4900, toMinor: 5900 } } });
    expect(e5.candidates.find((x: any) => x.key === "stop-streamly")?.spec.operation).toBe("STOP_RENEWAL");

    const p = await stack.propose(a, "E5", [accept.key]);
    await stack.approve(a, p);
    expect((await settle(p.actions[0].id)).status).toBe("CONFIRMED");
    expect(nextItem(a.tenantId).amount_minor).toBe(-5900);
    expect(stack.q1<any>("SELECT approved_minor FROM ext_price_ceiling WHERE tenant_id=? AND status='ACTIVE'", a.tenantId)!.approved_minor).toBe(5900);

    const ok = await charge(a, 5900);
    expect(ok.json).toMatchObject({ decision: "APPROVE", reason: "WITHIN_CEILING" });
    expect(funds(stack, a.tenantId, ctxOf(a))).toBe(before - 5900);
    expect(stack.q("SELECT id FROM transactions WHERE id=?", ok.json.transactionId)).toHaveLength(1);
  });

  it("lets payments the customer makes pass and charges within the ceiling post normally", async () => {
    const a = await stack.login("alex");
    expect((await settle(await setCeiling(a))).status).toBe("CONFIRMED");
    const before = funds(stack, a.tenantId, ctxOf(a));
    expect((await charge(a, 5900, "CUSTOMER")).json).toMatchObject({ decision: "APPROVE", reason: "CUSTOMER_PRESENT" });
    expect((await charge(a, 4900)).json).toMatchObject({ decision: "APPROVE", reason: "WITHIN_CEILING" });
    expect(funds(stack, a.tenantId, ctxOf(a))).toBe(before - 5900 - 4900);
    // A merchant with no ceiling is not gated.
    expect((await charge(a, 99_900, "MERCHANT", "cloudbox")).json.reason).not.toBe("ABOVE_CEILING");
  });

  it("refuses an accepted price when the ceiling changed after approval, and the same ceiling is not offered twice", async () => {
    const a = await stack.login("alex");
    expect((await settle(await setCeiling(a))).status).toBe("CONFIRMED");
    expect((await charge(a, 6900)).json.decision).toBe("DECLINE");
    await stack.stopWorkers();
    try {
      const e5 = await a.json("/api/capabilities/E5");
      const p = await stack.propose(a, "E5", ["accept-price-streamly"]);
      await stack.approve(a, p);
      // The ceiling moves under the approved price change (another approved change landed first).
      stack.exec("UPDATE ext_price_ceiling SET approved_minor=5400 WHERE tenant_id=? AND status='ACTIVE'", a.tenantId);
      await stack.worker();
      const d = await settle(p.actions[0].id);
      expect(d.status).toBe("REFUSED");
      expect(JSON.parse(d.result_json).reason).toMatch(/ceiling changed/);
      expect(e5.candidates.length).toBeGreaterThan(0);
      expect(nextItem(a.tenantId).amount_minor).toBe(-4900);
    } finally {
      if (!stack.workers.some((w) => w.running)) await stack.worker();
    }
    // Same ceiling twice: the candidate is unavailable once it is on.
    const again = await a.post("/api/capabilities/E5", { inputs: { ceilingMinor: 5400 } });
    expect(again.json.candidates.find((x: any) => x.key === "set-ceiling-streamly").available).toBe(false);
  });

  it("keeps Labs scoped and bounded and never approves anything itself", async () => {
    const a = await stack.login("alex");
    const other = await stack.login("alex");
    expect((await charge(other, 100, "MERCHANT", `${a.tenantId}:sub:streamly`)).status).toBe(404);
    expect((await charge(a, 0)).status).toBe(400);
    expect((await charge(a, 1.5)).status).toBe(400);
    expect((await charge(a, 2_000_000)).status).toBe(400);
    expect((await charge(a, 100, "BANK")).status).toBe(400);
    expect((await charge(a, 100, "MERCHANT", "../x")).status).toBe(400);
    expect((await a.post("/api/labs/ext", { module: "price-gate", action: "set_ceiling", body: {} })).status).toBe(400);
    expect(stack.q("SELECT id FROM proposals WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
    expect(stack.q("SELECT * FROM ext_price_ceiling WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
  });
});
