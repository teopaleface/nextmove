import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, startStack, type Api, type Stack } from "./harness";

// E1 Cancellation guarantee end to end: a real STOP_RENEWAL (A15, partner API, read back) is the only evidence; a Labs
// charge after it becomes an exact dispute candidate; the approved packet is re-checked by the bank-internal handler,
// filed once and credited once; the simulated card network's decision is applied once.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const labs = (a: Api, action: string, body: Record<string, unknown>) => a.post("/api/labs/ext", { module: "cancellation-guarantee", action, body });
const sub = (t: string) => stack.q1<any>("SELECT * FROM subscriptions WHERE tenant_id=? AND merchant_id='dasheats'", t)!;
const unbalanced = (t: string) => stack.q<any>("SELECT e.id, SUM(l.amount_minor) s FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id WHERE e.tenant_id=? GROUP BY e.id HAVING s != 0", t);

async function stopDashEats(a: Api) {
  const p = await stack.propose(a, "A15", ["stop-dasheats"]);
  await stack.approve(a, p);
  const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "UNKNOWN"]);
  expect(done.status).toBe("CONFIRMED");
  await stack.clock(a, 1);
}

describe("E1 before any confirmed stop", () => {
  it("covers nothing, offers nothing and refuses to simulate a charge without a real stop receipt", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const e1 = await a.json("/api/capabilities/E1");
    expect(e1.candidates).toEqual([]);
    expect(e1.numbers).toMatchObject({ confirmedStops: 0, eligibleCharges: 0 });
    expect(e1.blocks.find((b: any) => b.kind === "note").text).toContain("No confirmed stop yet");
    const r = await labs(a, "charge_after_cancellation", { subscriptionId: sub(t).id });
    expect(r.status).toBe(404);
    expect(stack.q("SELECT 1 FROM ext_dispute_case WHERE tenant_id=?", t)).toHaveLength(0);
  });
});

describe("E1 dispute after a confirmed stop", () => {
  it("files an exact dispute, credits it once and applies the network decision once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const s = sub(t);
    const before = await a.json("/api/capabilities/E1");
    expect(before.numbers.confirmedStops).toBe(1);
    expect(before.candidates).toEqual([]);
    expect(before.labs.map((l: any) => l.body.action)).toContain("charge_after_cancellation");

    // Out-of-bounds Labs input is refused.
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id, amountMinor: s.amount_minor + 1 })).status).toBe(400);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: "x".repeat(500) })).status).toBe(400);

    const charge = await labs(a, "charge_after_cancellation", { subscriptionId: s.id });
    expect(charge.status).toBe(200);
    const txn = stack.q1<any>("SELECT * FROM transactions WHERE id=?", charge.json.transactionId)!;
    expect(txn).toMatchObject({ direction: "DEBIT", amount_minor: -s.amount_minor, merchant_id: "dasheats", tenant_id: t });
    const afterCharge = balance(stack, txn.account_id);

    const e1 = await a.json("/api/capabilities/E1");
    expect(e1.candidates).toHaveLength(1);
    const cand = e1.candidates[0];
    expect(cand.key).toBe(`dispute-${txn.id}`);
    expect(cand.spec).toMatchObject({ operation: "EXT_FILE_DISPUTE", route: "BANK_INTERNAL", capability: "E1", subjectRef: txn.id, params: { txId: txn.id, amountMinor: s.amount_minor } });
    expect(cand.spec.params.manifestDigest).toMatch(/^[0-9a-f]{64}$/);

    const p = await stack.propose(a, "E1", [cand.key]);
    await stack.approve(a, p);
    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN"]);
    expect(done.status).toBe("CONFIRMED");
    expect(balance(stack, txn.account_id)).toBe(afterCharge + s.amount_minor);
    const d = stack.q1<any>("SELECT * FROM ext_dispute_case WHERE tenant_id=? AND tx_id=?", t, txn.id)!;
    expect(d).toMatchObject({ state: "PROVISIONAL_CREDIT", credited_minor: s.amount_minor, provisional_minor: s.amount_minor, disputable_minor: s.amount_minor, action_id: p.actions[0].id });
    expect(d.manifest_digest).toBe(cand.spec.params.manifestDigest);
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", p.actions[0].id)!;
    expect(receipt).toMatchObject({ issuer: "nextmove-bank", operation: "EXT_FILE_DISPUTE", status: "CONFIRMED" });
    expect(receipt.issuer_reference).toMatch(/^NMD-[0-9A-F]{10}$/);
    // The dispute is keyed on the bank's stop receipt; the provider's own reference is shown, never used as a key.
    const stop = stack.q1<any>("SELECT r.* FROM receipts r JOIN proposal_actions a ON a.id=r.action_id WHERE r.tenant_id=? AND a.subject_ref=? AND r.operation='STOP_RENEWAL'", t, s.id)!;
    expect(d.receipt_id).toBe(stop.id);
    expect(cand.spec.params.receiptId).toBe(stop.id);
    expect(JSON.parse(receipt.money_effect_json).details.cancellationReceipt).toBe(stop.issuer_reference);
    expect(unbalanced(t)).toEqual([]);

    // Filed charges are not offered again.
    const again = await a.json("/api/capabilities/E1");
    expect(again.candidates).toEqual([]);
    expect(again.numbers).toMatchObject({ disputes: 1, creditedMinor: s.amount_minor });

    // Another customer cannot decide this dispute or charge this subscription.
    const b = await stack.login("alex");
    expect((await labs(b, "network_decision", { disputeId: d.packet_id, outcome: "LOST" })).status).toBe(404);
    expect((await labs(b, "charge_after_cancellation", { subscriptionId: s.id })).status).toBe(404);
    expect((await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "MAYBE" })).status).toBe(400);

    const lost = await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "LOST" });
    expect(lost.json).toMatchObject({ state: "LOST", duplicate: false });
    expect(balance(stack, txn.account_id)).toBe(afterCharge);
    const replay = await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "LOST" });
    expect(replay.json).toMatchObject({ duplicate: true });
    expect(balance(stack, txn.account_id)).toBe(afterCharge);
    expect(stack.q1<any>("SELECT credited_minor, provisional_minor FROM ext_dispute_case WHERE packet_id=?", d.packet_id)).toMatchObject({ credited_minor: 0, provisional_minor: 0 });
    expect(stack.q("SELECT kind FROM ext_dispute_event WHERE packet_id=? ORDER BY kind", d.packet_id).map((r: any) => r.kind)).toEqual(["BANK_CREDIT_PROVISIONAL", "CREDIT_REVERSED", "NETWORK_LOST"]);
    expect(unbalanced(t)).toEqual([]);
  });

  it("re-checks at execution: a second approved packet for an already disputed charge files nothing", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const s = sub(t);
    const charge = await labs(a, "charge_after_cancellation", { subscriptionId: s.id });
    const key = `dispute-${charge.json.transactionId}`;
    const p1 = await stack.propose(a, "E1", [key]);
    const p2 = await stack.propose(a, "E1", [key]);
    await stack.approve(a, p1);
    expect((await stack.waitAction(p1.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN"])).status).toBe("CONFIRMED");
    const acct = stack.q1<any>("SELECT account_id FROM transactions WHERE id=?", charge.json.transactionId)!.account_id;
    const credited = balance(stack, acct);
    const r = await a.post(`/api/proposals/${p2.id}/approve`, { digest: p2.digest, actionIds: p2.actions.map((x) => x.id) });
    if (r.status === 200) {
      const second = await stack.waitAction(p2.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN", "EXPIRED"]);
      expect(second.status).not.toBe("UNKNOWN");
    }
    expect(balance(stack, acct)).toBe(credited);
    expect(stack.q("SELECT 1 FROM ext_dispute_case WHERE tenant_id=?", t)).toHaveLength(1);
    expect(stack.q("SELECT 1 FROM ext_dispute_event WHERE tenant_id=? AND kind='BANK_CREDIT_PROVISIONAL'", t)).toHaveLength(1);

    // The network rules for the customer: the provisional credit becomes final, with no new posting.
    const d = stack.q1<any>("SELECT packet_id FROM ext_dispute_case WHERE tenant_id=?", t)!;
    expect((await labs(a, "network_decision", { disputeId: d.packet_id, outcome: "WON" })).json).toMatchObject({ state: "WON" });
    expect(balance(stack, acct)).toBe(credited);

    // At most three simulated charges per subscription.
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id })).status).toBe(200);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id })).status).toBe(200);
    expect((await labs(a, "charge_after_cancellation", { subscriptionId: s.id })).status).toBe(409);
  });
});
