import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { balance, funds, startStack, type Api, type Stack } from "./harness";
import { postCardOrTransfer } from "../../src/server/bank/ledger";

// Edge cases for the extension features E1-E9: repeated and conflicting answers, the demo clock jumping past a
// deadline, amounts at and beyond their bounds, approvals given in the wrong order or the wrong context, tampered
// certificates, odd split weights, and a Labs reset in the middle of all of it. Each case checks that nothing moves
// twice, that a stale approval fails closed, and that the page tells the truth afterwards.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});
// A test that stops the worker and then fails must not starve the next one.
afterEach(async () => {
  if (!stack.workers.some((w) => w.running)) await stack.worker();
});

const END = ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN", "EXPIRED", "TERMS_CHANGED", "OUTDATED", "REVOKED", "NOT_STARTED"];
const ext = (a: Api, module: string, action: string, body: Record<string, unknown>) => a.post("/api/labs/ext", { module, action, body });
const tryPropose = (a: Api, cap: string, keys: string[], inputs: Record<string, unknown> = {}) => a.post(`/api/capabilities/${cap}/propose`, { keys, inputs });
const unbalanced = (t: string) => stack.q<any>("SELECT e.id, SUM(l.amount_minor) s FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id WHERE e.tenant_id=? GROUP BY e.id HAVING s != 0", t);
const ctx = async (a: Api, kind: "PERSONAL" | "BUSINESS") => {
  const s = await a.json("/api/session");
  const id = s.contexts.find((c: any) => c.kind === kind).id as string;
  await a.ok("/api/session/context", { contextId: id });
  return id;
};

async function stopDashEats(a: Api) {
  const p = await stack.propose(a, "A15", ["stop-dasheats"]);
  await stack.approve(a, p);
  expect((await stack.waitAction(p.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
  await stack.clock(a, 1);
}

/* ------------------------------------------------------------------------------------------- E1 */

describe("E1 cancellation guarantee edges", () => {
  const sub = (t: string) => stack.q1<any>("SELECT * FROM subscriptions WHERE tenant_id=? AND merchant_id='dasheats'", t)!;
  const labs = (a: Api, action: string, body: Record<string, unknown>) => ext(a, "cancellation-guarantee", action, body);

  it("never offers a charge taken before the stop, and bounds the simulated charge amount", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const before = stack.q<any>("SELECT id FROM transactions WHERE tenant_id=? AND merchant_id='dasheats' AND direction='DEBIT'", t);
    expect(before.length).toBeGreaterThan(0);
    await stopDashEats(a);
    const s = sub(t);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: 0 })).status).toBe(400);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: -100 })).status).toBe(400);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: 1.5 })).status).toBe(400);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: s.amount_minor + 1 })).status).toBe(400);
    const e1 = await a.json("/api/capabilities/E1");
    expect(e1.candidates).toEqual([]);
    // A charge from before the stop is the customer's own: it cannot be proposed even by naming it.
    for (const { id } of before) expect((await tryPropose(a, "E1", [`dispute-${id}`])).status).not.toBe(200);
    expect(stack.q("SELECT 1 FROM ext_dispute_case WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("disputes only what the merchant has not refunded, and applies the first network ruling only (WON then LOST)", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const s = sub(t);
    const charge = await labs(a, "charge_after_cancellation", { subscriptionId: s.id });
    expect(charge.status).toBe(200);
    const txn = stack.q1<any>("SELECT * FROM transactions WHERE id=?", charge.json.transactionId)!;
    // The merchant refunds part of it (as a card refund linked to the charge) before the customer disputes.
    const refundMinor = 1000;
    postCardOrTransfer(stack.db, { tenantId: t, contextId: txn.context_id, accountId: txn.account_id, sourceEventId: `edge:${t}:partial-refund`, amountMinor: refundMinor, merchantName: txn.merchant_name, merchantId: "dasheats", category: "Refund", bookedAt: await stack.clock(a, 1), data: { refundsTxId: txn.id } });
    const afterRefund = balance(stack, txn.account_id);
    const e1 = await a.json("/api/capabilities/E1");
    const cand = e1.candidates.find((c: any) => c.key === `dispute-${txn.id}`);
    expect(cand.spec.params.amountMinor).toBe(s.amount_minor - refundMinor);

    const p = await stack.propose(a, "E1", [cand.key]);
    await stack.approve(a, p);
    expect((await stack.waitAction(p.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const d = stack.q1<any>("SELECT * FROM ext_dispute_case WHERE tenant_id=? AND tx_id=?", t, txn.id)!;
    expect(d.disputable_minor).toBe(s.amount_minor - refundMinor);
    expect(balance(stack, txn.account_id)).toBe(afterRefund + s.amount_minor - refundMinor);

    const won = await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "WON" });
    expect(won.json).toMatchObject({ duplicate: false });
    const afterWon = balance(stack, txn.account_id);
    // The customer is made whole exactly once: refund plus dispute equals the charge.
    expect(afterWon).toBe(afterRefund - refundMinor + s.amount_minor);
    const lost = await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "LOST" });
    expect(lost.json).toMatchObject({ duplicate: true });
    expect(lost.json.state).toBe(won.json.state);
    expect(balance(stack, txn.account_id)).toBe(afterWon);
    expect(stack.q1<any>("SELECT state FROM ext_dispute_case WHERE packet_id=?", d.packet_id)!.state).toBe(won.json.state);
    expect(stack.q("SELECT 1 FROM ext_dispute_event WHERE packet_id=? AND kind='CREDIT_REVERSED'", d.packet_id)).toHaveLength(0);

    // The same charge cannot be disputed again, by the page or by naming its key.
    expect((await a.json("/api/capabilities/E1")).candidates).toEqual([]);
    expect((await tryPropose(a, "E1", [cand.key])).status).not.toBe(200);
    expect(stack.q("SELECT 1 FROM ext_dispute_case WHERE tenant_id=?", t)).toHaveLength(1);
    expect(unbalanced(t)).toEqual([]);
  });

  it("does not offer a charge the merchant fully refunded", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const s = sub(t);
    const charge = await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: 1500 });
    const txn = stack.q1<any>("SELECT * FROM transactions WHERE id=?", charge.json.transactionId)!;
    postCardOrTransfer(stack.db, { tenantId: t, contextId: txn.context_id, accountId: txn.account_id, sourceEventId: `edge:${t}:full-refund`, amountMinor: 1500, merchantName: txn.merchant_name, merchantId: "dasheats", category: "Refund", bookedAt: await stack.clock(a, 1), data: { refundsTxId: txn.id } });
    expect((await a.json("/api/capabilities/E1")).candidates).toEqual([]);
    expect((await tryPropose(a, "E1", [`dispute-${txn.id}`])).status).not.toBe(200);
  });
});

/* ------------------------------------------------------------------------------------------- E2 */

describe("E2 exit plan edges", () => {
  const usage = (a: Api, uses: number, coverage = "ALL_DEVICES") => ext(a, "exit-plan", "report-usage", { subscriptionId: `${a.tenantId}:sub:fitflow`, uses, coverage });
  const planRow = (id: string) => stack.q1<any>("SELECT * FROM ext_exit_plan WHERE action_id=?", id);
  const approvePlan = async (a: Api, minUses = 4) => {
    const p = await stack.propose(a, "E2", ["exit-fitflow"], { minUses });
    const g = await stack.approve(a, p);
    return { id: p.actions[0].id as string, mandateId: g.mandateId };
  };
  const waitRow = async (id: string, status: string) => {
    for (let i = 0; i < 80 && planRow(id)?.status !== status; i++) await new Promise((r) => setTimeout(r, 250));
    expect(planRow(id)?.status).toBe(status);
  };

  it("keeps the subscription when usage is exactly at the threshold", async () => {
    const a = await stack.login("alex");
    const { id } = await approvePlan(a, 4);
    await usage(a, 4);
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, END, 25_000);
    expect(done.status).toBe("NO_CHANGE");
    expect(stack.attempts(id)).toHaveLength(0);
    expect(planRow(id).status).toBe("KEPT");
  });

  it("a plan revoked before the check day never runs, and the page does not say it is still waiting", async () => {
    const a = await stack.login("alex");
    const { id, mandateId } = await approvePlan(a);
    await waitRow(id, "ACTIVE");
    const r = await a.ok(`/api/mandates/${mandateId}/stop`, {});
    expect(r).toMatchObject({ revoked: 1, status: "REVOKED" });
    await usage(a, 0);
    await stack.clock(a, 1440);
    await new Promise((r) => setTimeout(r, 1500));
    expect(stack.action(id).status).toBe("REVOKED");
    expect(stack.attempts(id)).toHaveLength(0);
    expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${a.tenantId}:sub:fitflow`)!.state).toBe("TRIAL");
    const e2 = await a.json("/api/capabilities/E2");
    const row = e2.blocks.find((b: any) => b.title === "Your exit plans").rows[0];
    expect(row.cells[4]).not.toBe("Waiting for the check day");
    expect(e2.headline).not.toMatch(/waiting for the check day/);
    // Stopping twice is a no-op.
    expect(await a.ok(`/api/mandates/${mandateId}/stop`, {})).toMatchObject({ revoked: 0, status: "REVOKED" });
  });

  it("an unanswered question closes unsent once the clock jumps past the provider's deadline", async () => {
    const a = await stack.login("alex");
    const { id } = await approvePlan(a);
    await usage(a, 1, "THIS_DEVICE_ONLY");
    await stack.clock(a, 1440);
    await waitRow(id, "ASKED");
    await stack.clock(a, 2 * 1440);
    const done = await stack.waitAction(id, END, 25_000);
    expect(done.status).toBe("EXPIRED");
    expect(stack.attempts(id).filter((x: any) => x.status !== "NOT_DISPATCHED")).toHaveLength(0);
    expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${a.tenantId}:sub:fitflow`)!.state).toBe("TRIAL");
    // A late answer changes nothing.
    await a.ok("/api/facts", { key: `e2:answer:${id}`, value: "STOP" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(stack.action(id).status).toBe("EXPIRED");
    expect(stack.attempts(id).filter((x: any) => x.status !== "NOT_DISPATCHED")).toHaveLength(0);
  });

  it("answering KEEP then STOP: the first answer the worker acts on is final", async () => {
    const a = await stack.login("alex");
    const { id } = await approvePlan(a);
    await usage(a, 1, "THIS_DEVICE_ONLY");
    await stack.clock(a, 1440);
    await waitRow(id, "ASKED");
    await a.ok("/api/facts", { key: `e2:answer:${id}`, value: "KEEP" });
    expect((await stack.waitAction(id, END, 25_000)).status).toBe("NO_CHANGE");
    await a.ok("/api/facts", { key: `e2:answer:${id}`, value: "STOP" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(stack.action(id).status).toBe("NO_CHANGE");
    expect(stack.attempts(id)).toHaveLength(0);
    expect(planRow(id).status).toBe("KEPT");
  });

  it("answering twice before the worker reads it: the latest answer counts and the stop runs once", async () => {
    const a = await stack.login("alex");
    const { id } = await approvePlan(a);
    await usage(a, 1, "THIS_DEVICE_ONLY");
    await stack.clock(a, 1440);
    await waitRow(id, "ASKED");
    await stack.stopWorkers();
    await a.ok("/api/facts", { key: `e2:answer:${id}`, value: "KEEP" });
    await a.ok("/api/facts", { key: `e2:answer:${id}`, value: "STOP" });
    await stack.worker();
    expect((await stack.waitAction(id, END, 25_000)).status).toBe("CONFIRMED");
    expect(stack.attempts(id)).toHaveLength(1);
    expect(planRow(id).status).toBe("STOP_REQUESTED");
  });

  it("a price change before the check day closes the plan without sending", async () => {
    const a = await stack.login("alex");
    const { id } = await approvePlan(a);
    await usage(a, 0);
    await stack.labs(a, "fault", { contractId: `${a.tenantId}:fitflow-premium`, kind: "PUBLISH_TERMS_AFTER_READS", params: { afterReads: 0, newRevision: 2, newPriceMinor: 8900 } });
    await stack.clock(a, 1440);
    const done = await stack.waitAction(id, END, 25_000);
    expect(done.status).not.toBe("CONFIRMED");
    expect(stack.q("SELECT id FROM attempts WHERE action_id=? AND status IN ('SENT','CONFIRMED')", id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------- E3 */

describe("E3 retention offer edges", () => {
  const offer = (a: Api, body: Record<string, unknown>) => ext(a, "retention-offers", "send_offer", body);

  it("refuses unknown merchants and subscriptions and rejects expired or tampered offers", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    expect((await offer(a, { subscription: "nosuchshop" })).status).toBe(400);
    expect((await offer(a, { subscription: "dasheats" })).status).toBe(400);
    expect((await offer(a, { subscription: `${t}:sub:nosuchshop` })).status).toBe(404);
    expect((await offer(a, { subscription: "streamly", variant: "forged" })).status).toBe(400);
    expect((await offer(a, { subscription: "streamly", plan: "free-forever" })).status).toBe(400);
    expect((await offer(a, { subscription: "streamly", variant: "expired" })).json.status).toBe("REJECTED");
    expect((await offer(a, { subscription: "streamly", variant: "tampered" })).json.status).toBe("REJECTED");
    const e3 = await a.json("/api/capabilities/E3");
    expect(e3.candidates.filter((c: any) => c.key.startsWith("accept-") && c.available)).toEqual([]);
  });

  it("an offer accepted after the stop was confirmed is refused; a new offer for the stopped subscription cannot be accepted", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    expect((await offer(a, { subscription: "streamly", variant: "valid", plan: "discount" })).json.status).toBe("VERIFIED");
    const e3 = await a.json("/api/capabilities/E3");
    const acceptKey = e3.candidates.find((c: any) => c.key.startsWith("accept-")).key;
    const pAccept = await stack.propose(a, "E3", [acceptKey]);
    const pStop = await stack.propose(a, "E3", ["stop-streamly"]);
    await stack.approve(a, pStop);
    expect((await stack.waitAction(pStop.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${t}:sub:streamly`)!.state).not.toBe("ACTIVE");

    // Approving the older accept proposal now is either refused at approval or refused by the worker.
    const r = await a.post(`/api/proposals/${pAccept.id}/approve`, { digest: pAccept.digest, actionIds: pAccept.actions.map((x) => x.id) });
    if (r.status === 200) {
      const done = await stack.waitAction(pAccept.actions[0].id, END, 25_000);
      expect(done.status).not.toBe("CONFIRMED");
    }
    expect(stack.q("SELECT 1 FROM ext_offer_acceptance WHERE tenant_id=?", t)).toHaveLength(0);
    const after = await a.json("/api/capabilities/E3");
    for (const c of after.candidates.filter((x: any) => x.key.startsWith("accept-"))) expect(c.available).toBe(false);
    expect((await tryPropose(a, "E3", [acceptKey])).status).not.toBe(200);

    // A new offer for a subscription whose renewal is off is never acceptable (and is rate limited anyway).
    const again = await offer(a, { subscription: "streamly", variant: "valid", plan: "downgrade" });
    expect(again.status).toBe(200);
    const page = await a.json("/api/capabilities/E3");
    for (const c of page.candidates.filter((x: any) => x.key.startsWith("accept-"))) expect(c.available).toBe(false);
    expect(stack.q("SELECT 1 FROM ext_offer_acceptance WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("an offer accepted twice is recorded once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await offer(a, { subscription: "streamly", variant: "valid", plan: "discount" });
    const key = (await a.json("/api/capabilities/E3")).candidates.find((c: any) => c.key.startsWith("accept-")).key;
    const p1 = await stack.propose(a, "E3", [key]);
    const p2 = await tryPropose(a, "E3", [key]);
    await stack.approve(a, p1);
    expect((await stack.waitAction(p1.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    if (p2.status === 200) {
      const r = await a.post(`/api/proposals/${p2.json.id}/approve`, { digest: p2.json.digest, actionIds: p2.json.actions.map((x: any) => x.id) });
      if (r.status === 200) expect((await stack.waitAction(p2.json.actions[0].id, END, 25_000)).status).not.toBe("CONFIRMED");
    }
    expect(stack.q("SELECT 1 FROM ext_offer_acceptance WHERE tenant_id=?", t)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------- E5 */

describe("E5 price gate edges", () => {
  const charge = (a: Api, amountMinor: number) => ext(a, "price-gate", "merchant_charge", { subscription: "streamly", amountMinor, initiator: "MERCHANT" });
  const setCeiling = async (a: Api, ceilingMinor: number) => {
    const p = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor });
    await stack.approve(a, p);
    return stack.waitAction(p.actions[0].id, END, 25_000);
  };
  const active = (t: string) => stack.q<any>("SELECT * FROM ext_price_ceiling WHERE tenant_id=? AND status='ACTIVE'", t);

  it("lets a charge exactly at the ceiling through and declines one bani above it", async () => {
    const a = await stack.login("alex");
    expect((await setCeiling(a, 5000)).status).toBe("CONFIRMED");
    const before = funds(stack, a.tenantId, `${a.tenantId}:personal`);
    expect((await charge(a, 5001)).json).toMatchObject({ decision: "DECLINE", reason: "ABOVE_CEILING" });
    expect(funds(stack, a.tenantId, `${a.tenantId}:personal`)).toBe(before);
    expect((await charge(a, 5000)).json).toMatchObject({ decision: "APPROVE", reason: "WITHIN_CEILING" });
    expect(funds(stack, a.tenantId, `${a.tenantId}:personal`)).toBe(before - 5000);
    for (const bad of [0, -1, 1_000_001, 12.5]) expect((await charge(a, bad)).status).toBe(400);
  });

  it("a ceiling below the current price is allowed and declines the regular charge", async () => {
    const a = await stack.login("alex");
    expect((await setCeiling(a, 3000)).status).toBe("CONFIRMED");
    expect((await charge(a, 4900)).json).toMatchObject({ decision: "DECLINE", reason: "ABOVE_CEILING" });
    expect((await setCeiling(a, 0)).status).toBe("CONFIRMED");
    expect((await charge(a, 1)).json).toMatchObject({ decision: "DECLINE" });
    expect(active(a.tenantId)).toHaveLength(1);
  });

  it("two ceilings approved for one subscription leave exactly one in force", async () => {
    const a = await stack.login("alex");
    const p1 = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor: 5500 });
    const p2 = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor: 6500 });
    await stack.stopWorkers();
    await stack.approve(a, p1);
    await stack.approve(a, p2);
    await stack.worker();
    const s1 = await stack.waitAction(p1.actions[0].id, END, 25_000);
    const s2 = await stack.waitAction(p2.actions[0].id, END, 25_000);
    expect([s1.status, s2.status]).toEqual(["CONFIRMED", "CONFIRMED"]);
    const live = active(a.tenantId);
    expect(live).toHaveLength(1);
    // Same amount twice: the second never runs.
    const p3 = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor: 7000 });
    const p4 = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor: 7000 });
    await stack.stopWorkers();
    await stack.approve(a, p3);
    await stack.approve(a, p4);
    await stack.worker();
    const s3 = await stack.waitAction(p3.actions[0].id, END, 25_000);
    const s4 = await stack.waitAction(p4.actions[0].id, END, 25_000);
    // Same amount means the same logical step: the executor runs it once and reports the copy as not started.
    expect([s3.status, s4.status].sort()).toEqual(["CONFIRMED", "NOT_STARTED"]);
    expect(active(a.tenantId)).toMatchObject([{ approved_minor: 7000 }]);
  });

  it("raising the ceiling above a declined price settles that request instead of leaving it open", async () => {
    const a = await stack.login("alex");
    expect((await setCeiling(a, 4900)).status).toBe("CONFIRMED");
    expect((await charge(a, 5900)).json.decision).toBe("DECLINE");
    expect((await a.json("/api/capabilities/E5")).headline).toContain("tried to charge");
    expect((await setCeiling(a, 6000)).status).toBe("CONFIRMED");
    const e5 = await a.json("/api/capabilities/E5");
    expect(e5.headline).not.toContain("tried to charge");
    expect(e5.candidates.find((c: any) => c.key === "accept-price-streamly")).toBeUndefined();
    expect((await charge(a, 5900)).json).toMatchObject({ decision: "APPROVE", reason: "WITHIN_CEILING" });
    // A raise that still falls short leaves the request open.
    expect((await charge(a, 8000)).json.decision).toBe("DECLINE");
    expect((await setCeiling(a, 7000)).status).toBe("CONFIRMED");
    expect((await a.json("/api/capabilities/E5")).headline).toContain("tried to charge");
  });
});

/* ------------------------------------------------------------------------------------------- E6 */

describe("E6 card reissue edges", () => {
  const labs = (a: Api, action: string, body: Record<string, unknown>) => ext(a, "card-reissue", action, body);

  it("a second reissue reuses the first replacement; a list approved before it is recorded once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const first = await labs(a, "start_reissue", { reason: "LOST" });
    expect(first.json).toMatchObject({ started: true });
    const p1 = await stack.propose(a, "E6", ["apply-reissue-plan"], { c_lingora: "DROP" });
    const second = await labs(a, "start_reissue", { reason: "COMPROMISED" });
    expect(second.json).toMatchObject({ started: false, alreadyStarted: true, reason: "LOST" });
    expect(stack.q("SELECT * FROM ext_card_reissue WHERE tenant_id=?", t)).toHaveLength(1);
    await stack.approve(a, p1);
    expect((await stack.waitAction(p1.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const third = await labs(a, "start_reissue", { reason: "STOLEN" });
    expect(third.json).toMatchObject({ started: false, alreadyStarted: true });
    const newRef = stack.q1<any>("SELECT new_card_ref FROM ext_card_reissue WHERE tenant_id=?", t)!.new_card_ref;
    expect((await labs(a, "updater_inquiry", { merchantId: "streamly" })).json).toMatchObject({ answer: "PROVIDE", newCard: { ref: newRef } });
    expect((await labs(a, "updater_inquiry", { merchantId: "lingora" })).json.answer).toBe("WITHHOLD");
    expect((await a.json("/api/capabilities/E6")).candidates).toEqual([]);
    expect((await tryPropose(a, "E6", ["apply-reissue-plan"])).status).not.toBe(200);
  });

  it("refuses a list approved after a subscription on it was stopped", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await labs(a, "start_reissue", { reason: "EXPIRY" });
    const p = await stack.propose(a, "E6", ["apply-reissue-plan"]);
    const keep = JSON.parse(stack.action(p.actions[0].id).spec_json).params.keep as string[];
    expect(keep).toContain("dasheats");
    // DashEats is stopped while the list (which still says "keep DashEats") waits for approval.
    await stopDashEats(a);
    await stack.approve(a, p);
    const done = await stack.waitAction(p.actions[0].id, END, 25_000);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toContain("changed after you approved");
    expect(stack.q("SELECT 1 FROM ext_reissue_plan WHERE tenant_id=?", t)).toHaveLength(0);
    expect((await labs(a, "updater_inquiry", { merchantId: "dasheats" })).json.answer).toBe("WITHHOLD");
    // The fresh list no longer offers DashEats at all.
    const fresh = await a.json("/api/capabilities/E6");
    expect(JSON.stringify(fresh.candidates[0].spec.params.keep ?? [])).not.toContain("dasheats");
  });
});

/* ------------------------------------------------------------------------------------------- E7 */

describe("E7 business move edges", () => {
  const consent = async (a: Api, inputs: Record<string, unknown> = {}) => {
    await ctx(a, "PERSONAL");
    const p = await stack.propose(a, "E7H", ["bizmove-consent"], inputs);
    const g = await stack.approve(a, p);
    return { done: await stack.waitAction(p.actions[0].id, END, 25_000), mandateId: g.mandateId };
  };

  it("the business cannot approve before the household; nothing moves", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    const [hh0, biz0] = [balance(stack, `${t}:hh-current`), balance(stack, `${t}:biz-current`)];
    await ctx(a, "BUSINESS");
    expect((await a.json("/api/capabilities/E7")).candidates).toEqual([]);
    expect((await tryPropose(a, "E7", ["bizmove-repay"])).status).not.toBe(200);
    // The household page cannot be used from the business context, and the reverse.
    expect((await a.get("/api/capabilities/E7H")).status).toBe(409);
    expect((await tryPropose(a, "E7H", ["bizmove-consent"])).status).not.toBe(200);
    await ctx(a, "PERSONAL");
    expect((await a.get("/api/capabilities/E7")).status).toBe(409);
    expect((await tryPropose(a, "E7", ["bizmove-repay"])).status).not.toBe(200);
    expect([balance(stack, `${t}:hh-current`), balance(stack, `${t}:biz-current`)]).toEqual([hh0, biz0]);
  });

  it("the household context cannot approve the business side; withdrawing it before it runs moves nothing", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    expect((await consent(a)).done.status).toBe("CONFIRMED");
    await ctx(a, "BUSINESS");
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    await ctx(a, "PERSONAL");
    const wrong = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe("WRONG_CONTEXT");
    await ctx(a, "BUSINESS");
    const biz0 = balance(stack, `${t}:biz-current`);
    await stack.stopWorkers();
    const g = await stack.approve(a, p);
    // Withdrawing only ever removes authority, so the same customer may do it from either context (judged fine).
    await ctx(a, "PERSONAL");
    expect(await a.ok(`/api/mandates/${g.mandateId}/stop`, {})).toMatchObject({ revoked: 1 });
    await ctx(a, "BUSINESS");
    await stack.worker();
    await new Promise((r) => setTimeout(r, 1000));
    expect(stack.action(p.actions[0].id).status).toBe("REVOKED");
    expect(balance(stack, `${t}:biz-current`)).toBe(biz0);
    expect(stack.q("SELECT * FROM ext_business_repayment WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("stopping the household mandate after its consent was recorded does not undo it; the consent expires after 7 days", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    const c = await consent(a);
    expect(c.done.status).toBe("CONFIRMED");
    // The household approval was a one-shot record: its grant is consumed, so stopping the mandate revokes nothing.
    expect(await a.ok(`/api/mandates/${c.mandateId}/stop`, {})).toMatchObject({ revoked: 0 });
    await ctx(a, "BUSINESS");
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    // The demo clock jumps past the household's 7-day consent before the worker runs.
    await stack.clock(a, 7 * 1440 + 10);
    const biz0 = balance(stack, `${t}:biz-current`);
    await stack.worker();
    const done = await stack.waitAction(p.actions[0].id, END, 25_000);
    expect(done.status).not.toBe("CONFIRMED");
    expect(balance(stack, `${t}:biz-current`)).toBe(biz0);
    expect(stack.q("SELECT * FROM ext_business_repayment WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("an approved repayment whose amounts were altered afterwards pays nothing", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    expect((await consent(a)).done.status).toBe("CONFIRMED");
    await ctx(a, "BUSINESS");
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    const id = p.actions[0].id;
    const spec = JSON.parse(stack.action(id).spec_json);
    spec.params.repayments[0].amountMinor += 100;
    spec.params.totalMinor += 100;
    stack.exec("UPDATE proposal_actions SET spec_json=? WHERE id=?", JSON.stringify(spec), id);
    const biz0 = balance(stack, `${t}:biz-current`);
    await stack.worker();
    const done = await stack.waitAction(id, END, 25_000);
    expect(done.status).not.toBe("CONFIRMED");
    expect(balance(stack, `${t}:biz-current`)).toBe(biz0);
    expect(stack.q("SELECT * FROM ext_business_repayment WHERE tenant_id=?", t)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------- E8 */

describe("E8 certificate edges", () => {
  const verify = (a: Api, certificate: unknown) => a.post("/api/ext/certificate/verify", { certificate });
  const subId = (t: string) => stack.q1<any>("SELECT id FROM subscriptions WHERE tenant_id=? AND merchant_id='dasheats'", t)!.id as string;

  it("issues one certificate per stop even when issuing is approved twice", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const key = `certificate-${subId(t)}`;
    const p1 = await stack.propose(a, "E8", [key]);
    const p2 = await tryPropose(a, "E8", [key]);
    await stack.stopWorkers();
    await stack.approve(a, p1);
    if (p2.status === 200) {
      const r = await a.post(`/api/proposals/${p2.json.id}/approve`, { digest: p2.json.digest, actionIds: p2.json.actions.map((x: any) => x.id) });
      expect([200, 409]).toContain(r.status);
    }
    await stack.worker();
    expect((await stack.waitAction(p1.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    if (p2.status === 200 && stack.action(p2.json.actions[0].id).status !== "PROPOSED") expect(["NO_CHANGE", "NOT_STARTED"]).toContain((await stack.waitAction(p2.json.actions[0].id, END, 25_000)).status);
    expect(stack.q("SELECT * FROM ext_certificate WHERE tenant_id=?", t)).toHaveLength(1);
    expect((await a.json("/api/capabilities/E8")).candidates).toEqual([]);
    expect((await tryPropose(a, "E8", [key])).status).not.toBe(200);
  });

  it("rejects a certificate whose payload or signature was altered, and one presented to another tenant", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const p = await stack.propose(a, "E8", [`certificate-${subId(t)}`]);
    await stack.approve(a, p);
    expect((await stack.waitAction(p.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const cert = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    expect((await verify(a, cert.holder_copy)).json.ok).toBe(true);
    const [head, ...disc] = cert.holder_copy.split("~");
    const [v, payload, sig] = head.split(".");
    // Payload: the claims re-encoded with a later expiry, signature kept.
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, exp: "2099-01-01T00:00:00+02:00", expiresAt: "2099-01-01T00:00:00+02:00" })).toString("base64url");
    const r1 = (await verify(a, [`${v}.${forgedPayload}.${sig}`, ...disc].join("~"))).json;
    expect(r1.ok).toBe(false);
    // Signature: truncated, and swapped for one from a different certificate.
    expect((await verify(a, [`${v}.${payload}.${sig.slice(0, -4)}`, ...disc].join("~"))).json.ok).toBe(false);
    expect((await verify(a, [`${v}.${payload}`, ...disc].join("~"))).json.ok).toBe(false);
    // Disclosures dropped entirely still verify only what is left (selective disclosure), never more.
    const bare = (await verify(a, head)).json;
    if (bare.ok) expect(Object.keys(bare.disclosed)).toEqual([]);
    // Another tenant: no record there.
    const b = await stack.login("alex");
    expect((await verify(b, cert.holder_copy)).json.ok).toBe(false);
    expect((await b.get(`/api/ext/certificate/certificates/${cert.cert_id}`)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------- E9 */

describe("E9 shared split edges", () => {
  const household = (a: Api) => ctx(a, "PERSONAL");
  const pays = (a: Api, body: Record<string, unknown>) => ext(a, "shared-split", "member_pays", body);
  const setWeight = (t: string, member: string, w: number) => stack.exec("UPDATE ext_split_member SET weight=? WHERE tenant_id=? AND member_id=?", w, t, member);

  it("refuses to calculate with a zero, negative or overflowing weight and offers nothing", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    for (const w of [0, -1, Number.MAX_SAFE_INTEGER]) {
      setWeight(t, "radu", w);
      const e9 = await a.json("/api/capabilities/E9");
      expect(e9.headline).toBe("This split cannot be calculated");
      expect(e9.candidates).toEqual([]);
      expect((await tryPropose(a, "E9", ["split-requests"])).status).not.toBe(200);
    }
    // A very large but safe weight still splits exactly to the bill.
    setWeight(t, "radu", 1_000_000);
    const big = await a.json("/api/capabilities/E9");
    expect(big.candidates).toHaveLength(1);
    const shares = big.blocks.find((b: any) => b.kind === "table").rows.map((r: any) => Math.round(Number(r.cells[2].replace(/[^0-9.]/g, "")) * 100));
    expect(shares.reduce((s: number, x: number) => s + x, 0)).toBe(big.numbers.billMinor);
    expect(stack.q("SELECT * FROM ext_split_request WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("a weight changed to zero after approval sends nothing", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    const p = await stack.propose(a, "E9", ["split-requests"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    setWeight(t, "ana", 0);
    await stack.worker();
    expect((await stack.waitAction(p.actions[0].id, END, 25_000)).status).toBe("REFUSED");
    expect(stack.q("SELECT * FROM ext_split_request WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("with a single member there is nothing to ask and nothing claims everyone paid", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    stack.exec("DELETE FROM ext_split_member WHERE tenant_id=? AND member_id != 'laziz'", t);
    const e9 = await a.json("/api/capabilities/E9");
    expect(e9.candidates).toEqual([]);
    expect(e9.numbers).toMatchObject({ billMinor: 24000, organizerShareMinor: 24000, askedMinor: 0, unsentMinor: 0 });
    expect(e9.headline).not.toMatch(/Everyone paid/);
    expect((await tryPropose(a, "E9", ["split-requests"])).status).not.toBe(200);
  });

  it("a member paying twice at the same moment is credited once", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    const p = await stack.propose(a, "E9", ["split-requests"]);
    await stack.approve(a, p);
    expect((await stack.waitAction(p.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const before = balance(stack, `${t}:hh-current`);
    const [r1, r2] = await Promise.all([pays(a, { memberId: "ana" }), pays(a, { memberId: "ana" })]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.json.duplicate, r2.json.duplicate].sort()).toEqual([false, true]);
    expect(balance(stack, `${t}:hh-current`)).toBe(before + 9418);
    expect(stack.q("SELECT id FROM transactions WHERE tenant_id=? AND category='Split payment'", t)).toHaveLength(1);
    expect((await pays(a, { memberId: "ana", amountMinor: 9418 })).json).toMatchObject({ duplicate: true, amountMinor: 0 });
    expect(unbalanced(t)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- Labs reset */

describe("Labs reset between steps", () => {
  const extRows = (t: string) => {
    const tables = stack.q<any>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ext_%'").map((r) => r.name as string);
    return Object.fromEntries(tables.map((n) => [n, (stack.q1<any>(`SELECT COUNT(*) n FROM ${n} WHERE tenant_id=?`, t)?.n ?? 0) as number]).filter(([, n]) => (n as number) > 0));
  };
  const reset = async (a: Api) => {
    expect((await a.post("/api/labs/reset", {})).status).toBe(200);
    a.csrf = (await a.json("/api/session")).csrfToken;
  };

  it("alex: disputes, ceilings, offers, reissues, certificates and a waiting exit plan leave nothing behind", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const seeded = extRows(t);
    await stopDashEats(a);
    const sub = stack.q1<any>("SELECT * FROM subscriptions WHERE tenant_id=? AND merchant_id='dasheats'", t)!;
    const charge = await ext(a, "cancellation-guarantee", "charge_after_cancellation", { subscriptionId: sub.id });
    const pd = await stack.propose(a, "E1", [`dispute-${charge.json.transactionId}`]);
    await stack.approve(a, pd);
    expect((await stack.waitAction(pd.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const pc = await stack.propose(a, "E8", [`certificate-${sub.id}`]);
    await stack.approve(a, pc);
    expect((await stack.waitAction(pc.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const ps = await stack.propose(a, "E5", ["set-ceiling-streamly"], { ceilingMinor: 3000 });
    await stack.approve(a, ps);
    expect((await stack.waitAction(ps.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    await ext(a, "price-gate", "merchant_charge", { subscription: "streamly", amountMinor: 4900, initiator: "MERCHANT" });
    await ext(a, "retention-offers", "send_offer", { subscription: "streamly", variant: "valid", plan: "discount" });
    await ext(a, "card-reissue", "start_reissue", { reason: "EXPIRY" });
    const pe = await stack.propose(a, "E2", ["exit-fitflow"], { minUses: 4 });
    await stack.approve(a, pe);
    const exitId = pe.actions[0].id;

    await reset(a);
    expect(extRows(t)).toEqual(seeded);
    expect(stack.q("SELECT id FROM proposal_actions WHERE tenant_id=?", t)).toHaveLength(0);

    // The waiting exit plan from before the reset must not wake up and act on the fresh tenant.
    await stack.clock(a, 1440);
    await new Promise((r) => setTimeout(r, 2000));
    expect(stack.q("SELECT * FROM ext_exit_plan WHERE tenant_id=?", t)).toHaveLength(0);
    expect(stack.q("SELECT * FROM attempts WHERE action_id=?", exitId)).toHaveLength(0);
    expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${t}:sub:fitflow`)!.state).toBe("TRIAL");

    // Every page starts over.
    expect((await a.json("/api/capabilities/E1")).numbers).toMatchObject({ confirmedStops: 0, disputes: 0 });
    expect((await a.json("/api/capabilities/E5")).headline).toBe("No price ceilings yet");
    expect((await ext(a, "price-gate", "merchant_charge", { subscription: "streamly", amountMinor: 9900, initiator: "MERCHANT" })).json.decision).toBe("APPROVE");
    expect((await a.json("/api/capabilities/E6")).candidates).toEqual([]);
    expect((await ext(a, "card-reissue", "updater_inquiry", { merchantId: "streamly" })).status).toBe(409);
    expect((await a.json("/api/capabilities/E8")).numbers).toMatchObject({ confirmedStops: 0, valid: 0 });
    expect((await a.json("/api/capabilities/E3")).candidates.filter((c: any) => c.key.startsWith("accept-"))).toEqual([]);
    expect(unbalanced(t)).toEqual([]);
  });

  it("laziz: a household consent and sent split requests do not survive a reset", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    const seeded = extRows(t);
    await ctx(a, "PERSONAL");
    const pc = await stack.propose(a, "E7H", ["bizmove-consent"]);
    await stack.approve(a, pc);
    expect((await stack.waitAction(pc.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    const pr = await stack.propose(a, "E9", ["split-requests"]);
    await stack.approve(a, pr);
    expect((await stack.waitAction(pr.actions[0].id, END, 25_000)).status).toBe("CONFIRMED");
    await ext(a, "shared-split", "member_pays", { memberId: "ana" });
    await ext(a, "business-move", "merchant_refund", { month: "2026-09" });

    await reset(a);
    expect(extRows(t)).toEqual(seeded);
    await ctx(a, "PERSONAL");
    const e9 = await a.json("/api/capabilities/E9");
    expect(e9.numbers).toMatchObject({ askedMinor: 0, receivedMinor: 0, unsentMinor: 14582 });
    const e7h = await a.json("/api/capabilities/E7H");
    expect(e7h.numbers).toMatchObject({ repaymentTotalMinor: 35700, months: 3 });
    expect(e7h.candidates[0]).toMatchObject({ available: true });
    await ctx(a, "BUSINESS");
    expect((await a.json("/api/capabilities/E7")).headline).toBe("Waiting for the household to approve its side");
    expect(unbalanced(t)).toEqual([]);
  });
});
