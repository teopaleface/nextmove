import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Api, type Stack } from "./harness";

// E2 Exit plan end to end: an exact conditional STOP_RENEWAL is approved once, the worker holds it until the check
// day, the pure exit-plan module decides, and only a STOP outcome reaches the provider (through the normal gate).

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const usage = (a: Api, uses: number, coverage = "ALL_DEVICES", subscriptionId = `${a.tenantId}:sub:fitflow`) =>
  a.post("/api/labs/ext", { module: "exit-plan", action: "report-usage", body: { subscriptionId, uses, coverage } });
const planRow = (actionId: string) => stack.q1<any>("SELECT * FROM ext_exit_plan WHERE action_id=?", actionId);
const contract = (t: string) => stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${t}:sub:fitflow`);

async function approvePlan(a: Api, minUses = 4) {
  const e2 = await a.json("/api/capabilities/E2");
  const c = e2.candidates.find((x: any) => x.key === "exit-fitflow");
  expect(c).toBeTruthy();
  expect(c.available).toBe(true);
  expect(c.spec.operation).toBe("STOP_RENEWAL");
  expect(c.spec.params.exitPlan.terms).toMatchObject({ minUses: 4, evaluateOn: "2026-10-29", cancelDeadline: "2026-10-30T09:00:00+02:00" });
  const p = await stack.propose(a, "E2", ["exit-fitflow"], { minUses });
  const g = await stack.approve(a, p);
  // The grant lasts until the provider deadline, not the usual short start window.
  expect(g.grants[0].expiresAt).toBe("2026-10-30T09:00:00+02:00");
  return p.actions[0].id;
}

describe("E2 exit plan", () => {
  it("waits for the check day without sending anything", async () => {
    const a = await stack.login("alex");
    const id = await approvePlan(a);
    await new Promise((r) => setTimeout(r, 2500));
    expect(stack.action(id).status).toBe("APPROVED");
    expect(stack.attempts(id)).toHaveLength(0);
    expect(planRow(id)).toMatchObject({ status: "ACTIVE", tenant_id: a.tenantId });
    const e2 = await a.json("/api/capabilities/E2");
    expect(e2.blocks.find((b: any) => b.title === "Your exit plans").rows[0].cells[4]).toBe("Waiting for the check day");
  });

  it("keeps the subscription when the provider reports enough use: closed unsent", async () => {
    const a = await stack.login("alex");
    const id = await approvePlan(a);
    expect((await usage(a, 6)).status).toBe(200);
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, ["NO_CHANGE", "CONFIRMED", "BLOCKED"]);
    expect(done.status).toBe("NO_CHANGE");
    expect(JSON.parse(done.result_json).reason).toContain("used FitFlow 6 times");
    expect(stack.attempts(id)).toHaveLength(0);
    expect(planRow(id).status).toBe("KEPT");
    expect(contract(a.tenantId).state).toBe("TRIAL");
  });

  it("stops renewal through the normal route when usage is below the condition", async () => {
    const a = await stack.login("alex");
    const id = await approvePlan(a);
    await usage(a, 1);
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, ["CONFIRMED", "NO_CHANGE", "BLOCKED", "REFUSED"]);
    expect(done.status).toBe("CONFIRMED");
    expect(planRow(id).status).toBe("STOP_REQUESTED");
    expect(stack.attempts(id)).toHaveLength(1);
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", id)!.status).toBe("CONSUMED");
    expect(stack.q1("SELECT id FROM receipts WHERE action_id=?", id)).toBeTruthy();
  });

  it("asks instead of stopping on phone-only data; the customer's answer decides", async () => {
    const a = await stack.login("alex");
    const id = await approvePlan(a);
    await usage(a, 1, "THIS_DEVICE_ONLY");
    await stack.clock(a, 1440);
    const asked = await (async () => {
      for (let i = 0; i < 60; i++) {
        if (planRow(id)?.status === "ASKED") return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
    expect(asked).toBe(true);
    expect(stack.attempts(id)).toHaveLength(0);
    const e2 = await a.json("/api/capabilities/E2");
    const q = e2.blocks.find((b: any) => b.kind === "question");
    expect(q.id).toBe(`e2:answer:${id}`);
    expect(stack.q1("SELECT id FROM notifications WHERE id=?", `ntf_e2_ask_${id}`)).toBeTruthy();
    await a.ok("/api/facts", { key: q.id, value: "KEEP" });
    const done = await stack.waitAction(id, ["NO_CHANGE", "CONFIRMED"]);
    expect(done.status).toBe("NO_CHANGE");
    expect(stack.attempts(id)).toHaveLength(0);
  });

  it("closes without sending when the provider changes terms after approval", async () => {
    const a = await stack.login("alex");
    const id = await approvePlan(a);
    await usage(a, 0);
    await stack.labs(a, "fault", { contractId: `${a.tenantId}:fitflow-premium`, kind: "PUBLISH_TERMS_AFTER_READS", params: { afterReads: 0, newRevision: 2, newPriceMinor: 8900 } });
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, ["TERMS_CHANGED", "BLOCKED", "OUTDATED", "CONFIRMED", "NO_CHANGE"]);
    expect(done.status).not.toBe("CONFIRMED");
    expect(stack.q("SELECT id FROM attempts WHERE action_id=? AND status IN ('SENT','CONFIRMED')", id)).toHaveLength(0);
  });

  it("closes unsent when the deadline passed before evaluation", async () => {
    const a = await stack.login("alex");
    await stack.stopWorkers();
    const id = await approvePlan(a);
    await usage(a, 0);
    await stack.clock(a, 3 * 1440);
    await stack.worker();
    const done = await stack.waitAction(id, ["EXPIRED", "BLOCKED", "CONFIRMED", "NO_CHANGE"]);
    expect(["EXPIRED"]).toContain(done.status);
    expect(stack.attempts(id).filter((x: any) => x.status !== "NOT_DISPATCHED")).toHaveLength(0);
  });

  it("refuses a tampered plan and keeps Labs scoped and bounded", async () => {
    const a = await stack.login("alex");
    const other = await stack.login("alex");
    // Cross-tenant: another isolated tenant cannot report usage for this tenant's subscription.
    expect((await usage(other, 1, "ALL_DEVICES", `${a.tenantId}:sub:fitflow`)).status).toBe(404);
    expect((await usage(a, -1)).status).toBe(400);
    expect((await usage(a, 501)).status).toBe(400);
    expect((await usage(a, 1.5)).status).toBe(400);
    expect((await usage(a, 1, "EVERYWHERE")).status).toBe(400);
    expect((await a.post("/api/labs/ext", { module: "exit-plan", action: "constructor", body: {} })).status).toBe(400);
    // Editing the stored plan after approval (a compromised row) closes it unsent instead of running altered terms.
    const id = await approvePlan(a);
    const spec = JSON.parse(stack.action(id).spec_json);
    spec.params.exitPlan.terms.minUses = 1000;
    stack.exec("UPDATE proposal_actions SET spec_json=? WHERE id=?", JSON.stringify(spec), id);
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, ["BLOCKED", "CONFIRMED", "NO_CHANGE"]);
    expect(done.status).toBe("BLOCKED");
    expect(stack.attempts(id)).toHaveLength(0);
  });
});
