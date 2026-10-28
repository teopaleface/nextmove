import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { funds, startStack, type Api, type Stack } from "./harness";
import { applyReissuePlan } from "../../src/server/extensions/card-reissue/bank";

// E6 card reissue end to end: Labs replaces the card, the customer approves one exact KEEP/DROP list, the worker
// records it after the gate, and simulated card-updater inquiries are answered from that list only (fail closed).

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const labs = (a: Api, action: string, body: Record<string, unknown>) => a.post("/api/labs/ext", { module: "card-reissue", action, body });
const reissue = (t: string) => stack.q1<any>("SELECT * FROM ext_card_reissue WHERE tenant_id=?", t);
const candidate = async (a: Api) => (await a.json("/api/capabilities/E6")).candidates.find((c: any) => c.key === "apply-reissue-plan");
const PAN = /\b\d{12,19}\b/;

describe("E6 before a list is approved", () => {
  it("shows the cards on file, starts one bounded replacement, and shares nothing", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const idle = await a.json("/api/capabilities/E6");
    expect(idle.candidates).toEqual([]);
    expect(idle.numbers.onFile).toBe(10);
    expect(idle.labs.map((l: any) => l.body.action)).toEqual(["start_reissue", "start_reissue"]);
    expect((await labs(a, "updater_inquiry", { merchantId: "streamly" })).status).toBe(409);

    expect((await labs(a, "start_reissue", { reason: "MOON" })).status).toBe(400);
    expect((await labs(a, "start_reissue", { reason: 7 })).status).toBe(400);
    const s = await labs(a, "start_reissue", { reason: "EXPIRY" });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ started: true, oldCardLast4: "4821" });
    expect(s.json.newCardLast4).toMatch(/^\d{4}$/);
    expect(s.text).not.toMatch(PAN);
    expect((await labs(a, "start_reissue", { reason: "STOLEN" })).json).toMatchObject({ started: false, alreadyStarted: true, reason: "EXPIRY" });
    expect(stack.q<any>("SELECT * FROM ext_card_reissue WHERE tenant_id=?", t)).toHaveLength(1);

    for (const bad of [{}, { merchantId: "Bad Id!" }, { merchantId: "x".repeat(41) }, { merchantId: ["streamly"] }]) expect((await labs(a, "updater_inquiry", bad)).status).toBe(400);
    expect((await labs(a, "updater_inquiry", { merchantId: "nosuchshop" })).status).toBe(404);
    const before = await labs(a, "updater_inquiry", { merchantId: "streamly" });
    expect(before.json).toMatchObject({ answer: "WITHHOLD", signal: "NO_APPROVED_PLAN" });
    expect(before.json.newCard).toBeUndefined();

    const e6 = await a.json("/api/capabilities/E6");
    const c = await candidate(a);
    expect(c.spec).toMatchObject({ operation: "EXT_APPLY_REISSUE_PLAN", route: "BANK_INTERNAL", capability: "E6", subjectRef: reissue(t).reissue_id });
    expect(c.spec.params.drop).toEqual(["reelbox"]);
    expect(c.spec.params.keep).toHaveLength(9);
    expect(e6.numbers).toMatchObject({ onFile: 10, questions: 1 });
    expect(e6.inputs.map((i: any) => i.key)).toContain("c_lingora");
    expect(JSON.stringify(e6)).not.toMatch(PAN);
    expect(funds(stack, t, `${t}:personal`)).toBe(11_000_000);
  });
});

describe("E6 approved list", () => {
  it("records exactly the approved list after the gate and answers inquiries from it", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await labs(a, "start_reissue", { reason: "EXPIRY" });
    const p = await stack.propose(a, "E6", ["apply-reissue-plan"], { c_lingora: "DROP", c_dasheats: "DROP" });
    expect(p.actions).toHaveLength(1);
    const spec = JSON.parse(stack.action(p.actions[0]!.id).spec_json);
    expect(spec.params.drop.sort()).toEqual(["dasheats", "lingora", "reelbox"]);
    await stack.approve(a, p);
    const done = await stack.waitAction(p.actions[0]!.id, ["CONFIRMED", "REFUSED", "NO_CHANGE", "BLOCKED"]);
    expect(done.status).toBe("CONFIRMED");
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", done.id)!.status).toBe("CONSUMED");
    const rcp = stack.q<any>("SELECT * FROM receipts WHERE action_id=?", done.id);
    expect(rcp).toHaveLength(1);
    expect(rcp[0].operation).toBe("EXT_APPLY_REISSUE_PLAN");
    const plan = stack.q1<any>("SELECT * FROM ext_reissue_plan WHERE tenant_id=?", t)!;
    expect(plan).toMatchObject({ action_id: done.id, manifest_digest: spec.params.manifestDigest, reference: rcp[0].issuer_reference });
    expect(reissue(t)).toMatchObject({ status: "PLAN_APPROVED", plan_id: plan.plan_id });
    expect(stack.q<any>("SELECT merchant_id FROM ext_reissue_decision WHERE tenant_id=? AND decision='DROP' ORDER BY merchant_id", t).map((r) => r.merchant_id)).toEqual(["dasheats", "lingora", "reelbox"]);
    // A dropped network token is suspended; nothing else about the card or money changes.
    expect(stack.q1<any>("SELECT token_status FROM ext_card_on_file WHERE tenant_id=? AND merchant_id='dasheats'", t)!.token_status).toBe("SUSPENDED");
    expect(funds(stack, t, `${t}:personal`)).toBe(11_000_000);

    const keep = await labs(a, "updater_inquiry", { merchantId: "streamly" });
    expect(keep.json).toMatchObject({ answer: "PROVIDE", newCard: { last4: reissue(t).new_last4, ref: reissue(t).new_card_ref } });
    expect(keep.text).not.toMatch(PAN);
    expect((await labs(a, "updater_inquiry", { merchantId: "lingora" })).json).toMatchObject({ answer: "WITHHOLD", signal: null });
    const cancelled = await labs(a, "updater_inquiry", { merchantId: "reelbox" });
    expect(cancelled.json).toMatchObject({ answer: "WITHHOLD", signal: "REQUEST_AFTER_CANCELLATION" });
    expect(cancelled.json.newCard).toBeUndefined();
    expect(stack.q1("SELECT 1 FROM notifications WHERE tenant_id=? AND title='ReelBox asked for your new card'", t)).toBeTruthy();

    const e6 = await a.json("/api/capabilities/E6");
    expect(e6.candidates).toEqual([]);
    expect(e6.blocks[0]).toMatchObject({ kind: "status", state: "List approved" });
    expect(e6.blocks.find((b: any) => b.title === "Card-updater requests from merchants").rows).toHaveLength(3);

    // Replay of the same action is a no-op on the same receipt; nothing is written twice.
    await applyReissuePlan({ db: stack.db, action: stack.action(done.id), spec, attemptId: null as any });
    expect(stack.q<any>("SELECT id FROM receipts WHERE action_id=?", done.id)).toHaveLength(1);
    expect(stack.q<any>("SELECT plan_id FROM ext_reissue_plan WHERE tenant_id=?", t)).toHaveLength(1);
    expect(stack.q<any>("SELECT * FROM ext_reissue_decision WHERE tenant_id=?", t)).toHaveLength(10);
    expect(stack.action(done.id).status).toBe("CONFIRMED");
  });

  it("refuses another tenant: no approval, no inquiry answer, no view of the replacement", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    await labs(a, "start_reissue", { reason: "EXPIRY" });
    const p = await stack.propose(a, "E6", ["apply-reissue-plan"]);
    const r = await b.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(r.status).not.toBe(200);
    expect(stack.q1("SELECT 1 FROM grants WHERE action_id=?", p.actions[0]!.id)).toBeUndefined();
    expect((await labs(b, "updater_inquiry", { merchantId: "streamly" })).status).toBe(409);
    expect((await b.json("/api/capabilities/E6")).candidates).toEqual([]);
    expect(reissue(b.tenantId)).toBeUndefined();
    const l = await stack.login("laziz");
    expect((await l.call("GET", "/api/capabilities/E6")).status).not.toBe(200);
    expect((await l.post("/api/labs/ext", { module: "card-reissue", action: "start_reissue", body: { reason: "EXPIRY" } })).status).not.toBe(200);
  });
});

describe("E6 fails closed when things change after approval", () => {
  it("refuses when a merchant is added to the card between approval and the worker", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await labs(a, "start_reissue", { reason: "EXPIRY" });
    const p = await stack.propose(a, "E6", ["apply-reissue-plan"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    const acct = reissue(t).account_id;
    stack.exec("INSERT INTO ext_card_on_file(tenant_id, context_id, account_id, merchant_id, merchant_name, brand_id, credential_kind, token_ref, token_status, participates_in_updater, added_at) VALUES (?,?,?,?,?,NULL,'PAN',NULL,NULL,1,?)",
      t, `${t}:personal`, acct, "newshop", "NewShop", "2026-10-28T09:45:00+02:00");
    await stack.worker();
    const done = await stack.waitAction(p.actions[0]!.id, ["CONFIRMED", "REFUSED", "NO_CHANGE", "BLOCKED"]);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toContain("changed after you approved");
    expect(stack.q1("SELECT 1 FROM ext_reissue_plan WHERE tenant_id=?", t)).toBeUndefined();
    expect(reissue(t).status).toBe("STARTED");
    expect((await labs(a, "updater_inquiry", { merchantId: "streamly" })).json).toMatchObject({ answer: "WITHHOLD", signal: "NO_APPROVED_PLAN" });
    // The page now shows the new merchant and asks again.
    const c = await candidate(a);
    expect(c.spec.params.keep).toContain("newshop");
  });

  it("records only the first of two approved lists for one replacement", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await labs(a, "start_reissue", { reason: "EXPIRY" });
    const p1 = await stack.propose(a, "E6", ["apply-reissue-plan"], { c_lingora: "KEEP" });
    const p2 = await stack.propose(a, "E6", ["apply-reissue-plan"], { c_lingora: "DROP" });
    await stack.stopWorkers();
    await stack.approve(a, p1);
    await stack.approve(a, p2);
    await stack.worker();
    const s1 = await stack.waitAction(p1.actions[0]!.id, ["CONFIRMED", "REFUSED", "NO_CHANGE", "BLOCKED"]);
    const s2 = await stack.waitAction(p2.actions[0]!.id, ["CONFIRMED", "REFUSED", "NO_CHANGE", "BLOCKED"]);
    expect([s1.status, s2.status].sort()).toEqual(["CONFIRMED", "NO_CHANGE"]);
    expect(stack.q<any>("SELECT * FROM ext_reissue_plan WHERE tenant_id=?", t)).toHaveLength(1);
  });
});
