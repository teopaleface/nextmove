import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { funds, startStack, type Api, type Stack } from "./harness";

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await stack?.teardown(); });
const analyze = (a: Api, inputs: Record<string, unknown> = {}) => a.ok("/api/capabilities/O9", { inputs });
const field = (a: any, name: string) => {
  const f = a.inputs.find((f: any) => f.type === "select" && f.label.includes(name));
  if (!f) throw new Error(`Missing Airbag service choice: ${name}`);
  return f.key as string;
};
const serviceRows = (a: any) => a.blocks.find((b: any) => b.title === "Services and protections").rows;

describe("O9 Financial Airbag", () => {
  it("opening the review preserves every service, cash and forecast; protects essential dependencies", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const before = funds(stack, t, `${t}:personal`);
    const forecast = stack.q("SELECT id, status, amount_minor, due_at FROM forecast_items WHERE tenant_id=? ORDER BY id", t);
    const r = await analyze(a);
    expect(r.candidates).toEqual([]);
    expect(r.numbers.conditionalAfterMinor).toBe(r.numbers.beforeMinor);
    expect(r.numbers.currentCashMinor).toBe(before);
    expect(r.inputs.filter((f: any) => f.type === "select").every((f: any) => f.value === "keep")).toBe(true);
    for (const name of ["StudyPlus", "CloudBox", "MobileNet", "SafeTrip", "Streamly"]) {
      expect(serviceRows(r).find((r: any) => r.cells[0].includes(name)).cells.join(" ")).toMatch(/Keep.*[Pp]rotected/);
      expect(r.inputs.some((f: any) => f.type === "select" && f.label.includes(name))).toBe(false);
    }
    expect(stack.q("SELECT id FROM proposals WHERE tenant_id=?", t)).toEqual([]);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toEqual([]);
    expect(stack.q("SELECT id, status, amount_minor, due_at FROM forecast_items WHERE tenant_id=? ORDER BY id", t)).toEqual(forecast);
    expect(funds(stack, t, `${t}:personal`)).toBe(before);
    expect((await a.post("/api/capabilities/O9/propose", { keys: [] })).status).toBe(400);
  });

  it("one exact batch pauses Streamly and turns off DashEats renewal, with separate receipts and no duplicate replay", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const initial = await analyze(a, { keepPlayback: false });
    const inputs = { keepPlayback: false, [field(initial, "Streamly")]: "pause", [field(initial, "DashEats")]: "stop" };
    const r = await analyze(a, inputs);
    expect(r.candidates.map((c: any) => c.spec.operation).sort()).toEqual(["PAUSE", "STOP_RENEWAL"]);
    expect(r.numbers.conditionalAvoidedMinor).toBe(4900 + 2999);
    expect(r.candidates.every((c: any) => c.spec.money.immediateDebitMinor === 0 && c.spec.money.feesMinor === 0)).toBe(true);
    expect(r.candidates.find((c: any) => c.spec.operation === "PAUSE").spec.consequences.lostBenefits).toEqual(expect.arrayContaining([expect.stringContaining("TV access"), expect.stringContaining("Offline playback")]));
    const keys = r.candidates.map((c: any) => c.key);
    const p = await stack.propose(a, "O9", keys, inputs);
    expect(p.scope).toBe("BATCH");
    expect(p.actions).toHaveLength(2);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(0);
    const bad = await a.post(`/api/proposals/${p.id}/approve`, { digest: "wrong", actionIds: p.actions.map((x) => x.id) });
    expect(bad.status).toBe(409);
    const cash = funds(stack, t, `${t}:personal`);
    await stack.approve(a, p);
    const queued = await analyze(a, inputs);
    expect(queued.numbers.beforeMinor).toBe(r.numbers.beforeMinor);
    expect(queued.numbers.conditionalAvoidedMinor).toBe(0);
    expect(queued.candidates.every((c: any) => !c.available && /approved/.test(c.unavailableReason))).toBe(true);
    expect((await a.post("/api/capabilities/O9/propose", { keys, inputs })).status).toBe(409);
    const w = await stack.worker();
    try {
      for (const action of p.actions) expect((await stack.waitAction(action.id, ["CONFIRMED", "UNKNOWN", "REFUSED", "BLOCKED"])).status).toBe("CONFIRMED");
    } finally { await w.stop(); }
    const after = await analyze(a, inputs);
    expect(after.numbers.beforeMinor).toBe(r.numbers.conditionalAfterMinor);
    expect(after.numbers.currentCashMinor).toBe(cash);
    expect(funds(stack, t, `${t}:personal`)).toBe(cash);
    expect(stack.q("SELECT id FROM forecast_items WHERE tenant_id=? AND subscription_id=? AND status='SCHEDULED'", t, `${t}:sub:dasheats`)).toHaveLength(0);
    expect(stack.q1<any>("SELECT due_at FROM forecast_items WHERE tenant_id=? AND subscription_id=? AND status='SCHEDULED'", t, `${t}:sub:streamly`)!.due_at).toMatch(/^2026-12-26/);
    for (const action of p.actions) {
      expect(stack.q("SELECT id FROM receipts WHERE action_id=?", action.id)).toHaveLength(1);
      expect(stack.attempts(action.id)).toHaveLength(1);
    }
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(2);
    expect((await stack.approve(a, p)).alreadyApproved).toBe(true);
    expect(after.blocks.filter((b: any) => b.kind === "status" && b.href?.startsWith("/receipts/"))).toHaveLength(2);
    expect(after.candidates.every((c: any) => !c.available)).toBe(true);
  });

  it("keeps a provider-pending result in the forecast and blocks pending and unknown repeat choices", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const initial = await analyze(a);
    const inputs = { [field(initial, "DashEats")]: "stop" };
    const r = await analyze(a, inputs);
    const keys = r.candidates.map((c: any) => c.key);
    await stack.labs(a, "set_cancellation_mode", { merchantId: "dasheats", mode: "review" });
    const p = await stack.propose(a, "O9", keys, inputs);
    await stack.approve(a, p);
    const w = await stack.worker();
    try { expect((await stack.waitAction(p.actions[0].id, ["PENDING", "CONFIRMED", "UNKNOWN", "REFUSED"])).status).toBe("PENDING"); }
    finally { await w.stop(); }
    const pending = await analyze(a, inputs);
    expect(pending.numbers.beforeMinor).toBe(r.numbers.beforeMinor);
    expect(pending.numbers.conditionalAfterMinor).toBe(r.numbers.beforeMinor);
    expect(pending.candidates[0]).toMatchObject({ available: false });
    expect((await a.post("/api/capabilities/O9/propose", { keys, inputs })).status).toBe(409);
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", p.actions[0].id)).toHaveLength(0);
    // Fixture only for the O9 read guard. Transport-loss production/reconciliation coverage remains in recovery.test.ts.
    stack.exec("UPDATE proposal_actions SET status='UNKNOWN' WHERE id=?", p.actions[0].id);
    const unknown = await analyze(a, inputs);
    expect(unknown.candidates[0].unavailableReason).toMatch(/unknown/);
    expect(unknown.numbers.conditionalAfterMinor).toBe(r.numbers.beforeMinor);
    expect((await a.post("/api/capabilities/O9/propose", { keys, inputs })).status).toBe(409);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(1);
  });

  it("ignores foreign choice keys, keeps context/tenant boundaries and exposes unsupported operations", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    const options = await analyze(a);
    const inputs = { [field(options, "DashEats")]: "stop" };
    const r = await analyze(a, inputs);
    expect((await analyze(b, inputs)).candidates).toHaveLength(0);
    expect((await b.post("/api/capabilities/O9/propose", { keys: [r.candidates[0].key], inputs })).status).toBe(400);
    expect((await a.post("/api/session/context", { contextId: `${b.tenantId}:personal` })).status).toBe(404);
    // A foreign context passed at the capability seam cannot expose either tenant's subscriptions or balances.
    const user = stack.q1<any>("SELECT user_id FROM contexts WHERE id=?", `${a.tenantId}:personal`)!.user_id;
    const { analyzeCapability } = await import("../../src/server/capabilities/registry");
    const foreign = await analyzeCapability(stack.db, { tenantId: a.tenantId, userId: user, contextId: `${b.tenantId}:personal` } as any, "O9", inputs);
    expect(foreign.candidates).toEqual([]);
    expect(foreign.numbers.currentCashMinor).toBe(0);
    expect(foreign.numbers.beforeMinor).toBe(0);
    const laziz = await stack.login("laziz");
    expect((await laziz.get("/api/capabilities/O9")).status).toBe(404);
    // Simulate a provider directory capability withdrawal, in this test tenant only.
    const key = `directory:${a.tenantId}`;
    const providers = JSON.parse(stack.q1<any>("SELECT value_json FROM system_status WHERE key=?", key)!.value_json);
    providers.find((p: any) => p.id === "dasheats").operations = [];
    stack.exec("UPDATE system_status SET value_json=? WHERE key=?", JSON.stringify(providers), key);
    const unavailable = await analyze(a, inputs);
    expect(unavailable.candidates).toHaveLength(0);
    expect(serviceRows(unavailable).find((r: any) => r.cells[0].includes("DashEats")).cells[2]).toMatch(/Neither a supported provider pause nor renewal-off/);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
  });
});
