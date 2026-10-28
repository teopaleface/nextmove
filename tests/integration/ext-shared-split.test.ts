import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, startStack, type Api, type Stack } from "./harness";

// E9 shared split end to end: the split comes from the pure planner, the only action sends payment requests (bank
// records, no money moves), and a Labs member payment is one bounded, idempotent incoming credit.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const household = async (a: Api) => {
  const s = await a.json("/api/session");
  await a.ok("/api/session/context", { contextId: s.contexts.find((c: any) => c.kind === "PERSONAL").id });
};
const pays = (a: Api, body: Record<string, unknown>) => a.post("/api/labs/ext", { module: "shared-split", action: "member_pays", body });
const send = async (a: Api) => {
  const p = await stack.propose(a, "E9", ["split-requests"]);
  await stack.approve(a, p);
  return { p, done: await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]) };
};

describe("E9 split", () => {
  it("shows an exact split by days in the home; the business context cannot open it", async () => {
    const a = await stack.login("laziz");
    expect((await a.get("/api/capabilities/E9")).status).toBe(409);
    await household(a);
    const e9 = await a.json("/api/capabilities/E9");
    // 240.00 RON over 31 + 31 + 17 member-days; remainders go to the largest fractions, ties by member id.
    expect(e9.numbers).toMatchObject({ billMinor: 24000, organizerShareMinor: 9418, askedMinor: 0, unsentMinor: 14582 });
    const rows = e9.blocks.find((b: any) => b.kind === "table").rows.map((r: any) => r.cells.slice(0, 3));
    expect(rows).toEqual([["Ana (sister)", "31", "94.18 RON"], ["You", "31", "94.18 RON"], ["Radu (lodger since 15 Oct)", "17", "51.64 RON"]]);
    expect(e9.candidates[0].spec).toMatchObject({ operation: "EXT_SEND_SPLIT_REQUESTS", route: "BANK_INTERNAL", money: { maxDebitMinor: 0, immediateDebitMinor: 0 } });
    expect(e9.candidates[0].spec.params.requests.map((r: any) => [r.memberId, r.amountMinor, r.why])).toEqual([["ana", 9418, "NOT_A_BANK_CUSTOMER"], ["radu", 5164, "NO_MANDATE"]]);
    expect(e9.labs ?? []).toEqual([]);
  });

  it("click path: requests recorded with a receipt, nobody debited; a member pays once, exactly their share", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    const hh = `${t}:hh-current`;
    const before = balance(stack, hh);
    const ledger0 = stack.q("SELECT id FROM ledger_entries WHERE tenant_id=?", t).length;

    const { p, done } = await send(a);
    expect(done.status).toBe("CONFIRMED");
    expect(stack.q<any>("SELECT member_id, amount_minor, status, paid_minor FROM ext_split_request WHERE tenant_id=? ORDER BY member_id", t)).toEqual([
      { member_id: "ana", amount_minor: 9418, status: "REQUESTED", paid_minor: 0 },
      { member_id: "radu", amount_minor: 5164, status: "REQUESTED", paid_minor: 0 },
    ]);
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=?", t)).toHaveLength(ledger0);
    expect(balance(stack, hh)).toBe(before);
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", p.actions[0].id)!;
    expect(receipt.issuer_reference).toMatch(/^NMQ-[0-9A-F]{8}$/);
    expect(JSON.parse(receipt.money_effect_json).details).toMatchObject({ requestedMinor: 14582, debitedMinor: 0 });

    const e9 = await a.json("/api/capabilities/E9");
    expect(e9.candidates).toEqual([]);
    expect(e9.numbers).toMatchObject({ askedMinor: 14582, receivedMinor: 0 });
    expect(e9.labs.map((l: any) => l.body)).toEqual([
      { module: "shared-split", action: "member_pays", body: { memberId: "ana" } },
      { module: "shared-split", action: "member_pays", body: { memberId: "radu" } },
    ]);

    // Bounded: an amount other than the outstanding share is refused; the share itself is credited once.
    expect((await pays(a, { memberId: "ana", amountMinor: 1_000_000 })).status).toBe(400);
    expect((await pays(a, { memberId: "ana", amountMinor: -5 })).status).toBe(400);
    const paid = await pays(a, { memberId: "ana" });
    expect(paid.json).toMatchObject({ paid: true, duplicate: false, amountMinor: 9418 });
    expect((await pays(a, { memberId: "ana" })).json).toMatchObject({ duplicate: true, amountMinor: 0 });
    expect(balance(stack, hh)).toBe(before + 9418);
    expect(stack.q("SELECT id FROM transactions WHERE tenant_id=? AND category='Split payment'", t)).toHaveLength(1);
    const after = await a.json("/api/capabilities/E9");
    expect(after.numbers).toMatchObject({ askedMinor: 14582, receivedMinor: 9418 });
    expect(after.labs.map((l: any) => l.body.body.memberId)).toEqual(["radu"]);
    await pays(a, { memberId: "radu", amountMinor: 5164 });
    expect((await a.json("/api/capabilities/E9")).headline).toBe("Everyone paid their share of ElectraCasa");

    // Replay: the handler run again on the settled action changes nothing; a re-proposal is no longer offered.
    const { sharedSplit } = await import("../../src/server/extensions/modules/shared-split");
    const action = stack.action(p.actions[0].id);
    await sharedSplit.operations!.EXT_SEND_SPLIT_REQUESTS({ db: stack.db, action, spec: JSON.parse(action.spec_json), attemptId: "att_replay" });
    expect(stack.action(p.actions[0].id).status).toBe("CONFIRMED");
    expect(stack.q("SELECT * FROM ext_split_request WHERE tenant_id=?", t)).toHaveLength(2);
    expect((await a.post("/api/capabilities/E9/propose", { keys: ["split-requests"] })).status).toBe(400);
  });

  it("fails closed when the split changes after approval: no requests recorded", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    await household(a);
    const p = await stack.propose(a, "E9", ["split-requests"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    stack.exec("UPDATE ext_split_member SET weight=2 WHERE tenant_id=? AND member_id='radu'", t);
    await stack.worker();
    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toContain("split changed");
    expect(stack.q("SELECT * FROM ext_split_request WHERE tenant_id=?", t)).toHaveLength(0);
    // The bill amount is bound too.
    stack.exec("UPDATE ext_split_member SET weight=1 WHERE tenant_id=? AND member_id='radu'", t);
    const p2 = await stack.propose(a, "E9", ["split-requests"]);
    await stack.stopWorkers();
    await stack.approve(a, p2);
    stack.exec("UPDATE subscriptions SET amount_minor=26000 WHERE tenant_id=? AND merchant_id='electracasa'", t);
    await stack.worker();
    const d2 = await stack.waitAction(p2.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
    expect(d2.status).toBe("REFUSED");
    expect(stack.q("SELECT * FROM ext_split_request WHERE tenant_id=?", t)).toHaveLength(0);
  });

  it("another tenant cannot approve or pay into this split; Labs input is validated", async () => {
    const a = await stack.login("laziz");
    const b = await stack.login("laziz");
    await household(a);
    await household(b);
    const p = await stack.propose(a, "E9", ["split-requests"]);
    const other = await b.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(other.status).toBe(404);
    expect((await send(a)).done.status).toBe("CONFIRMED");

    // b has no requests of its own: a's requests are invisible to it.
    expect((await pays(b, { memberId: "ana" })).status).toBe(404);
    expect(stack.q1<any>("SELECT paid_minor FROM ext_split_request WHERE tenant_id=? AND member_id='ana'", a.tenantId)!.paid_minor).toBe(0);
    expect((await pays(a, { memberId: "Ana; DROP TABLE x" })).status).toBe(400);
    expect((await pays(a, {})).status).toBe(400);
    expect((await pays(a, { memberId: "nobody" })).status).toBe(404);
    const s = await a.json("/api/session");
    await a.ok("/api/session/context", { contextId: s.contexts.find((c: any) => c.kind === "BUSINESS").id });
    expect((await pays(a, { memberId: "ana" })).status).toBe(404);
  });
});
