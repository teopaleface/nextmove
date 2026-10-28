import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, fixture, startStack, type Api, type Stack } from "./harness";

// E7 business move end to end: the household approves one exact plan (no money moves), the business approves the
// repayment from its own account, and the worker re-plans from bank state and refuses if anything changed.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const HH_OPENING = fixture("demo/capability-scenarios.json").lazizHousehold.openingBalanceMinor as number;
const BIZ_OPENING = fixture("demo/cases.json").businessOrder.openingCashMinor as number;

const ctx = async (a: Api, kind: "PERSONAL" | "BUSINESS") => {
  const s = await a.json("/api/session");
  const id = s.contexts.find((c: any) => c.kind === kind).id;
  await a.ok("/api/session/context", { contextId: id });
  return id as string;
};
const refund = (a: Api, body: Record<string, unknown>) => a.post("/api/labs/ext", { module: "business-move", action: "merchant_refund", body });
const consent = async (a: Api, inputs: Record<string, unknown> = {}) => {
  await ctx(a, "PERSONAL");
  const p = await stack.propose(a, "E7H", ["bizmove-consent"], inputs);
  await stack.approve(a, p);
  return stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
};

describe("E7 seed and analysis", () => {
  it("is additive: today's balances are unchanged; the household side shows the plan and the VAT note", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    expect(balance(stack, `${t}:hh-current`)).toBe(HH_OPENING);
    expect(balance(stack, `${t}:biz-current`)).toBe(BIZ_OPENING);
    expect(stack.q("SELECT id FROM transactions WHERE tenant_id=? AND merchant_id='pixelforge' AND status='POSTED'", t)).toHaveLength(3);

    const biz = await a.json("/api/capabilities/E7");
    expect(biz.headline).toBe("Waiting for the household to approve its side");
    expect(biz.candidates).toEqual([]);
    expect((await a.get("/api/capabilities/E7H")).status).toBe(409);

    await ctx(a, "PERSONAL");
    const hh = await a.json("/api/capabilities/E7H");
    expect(hh.numbers).toMatchObject({ repaymentTotalMinor: 35700, months: 3, businessUseBp: 10000 });
    expect(hh.candidates[0]).toMatchObject({ key: "bizmove-consent", available: true });
    expect(hh.candidates[0].spec.money.maxDebitMinor).toBe(0);
    const note = hh.blocks.find((b: any) => b.kind === "table" && b.title === "Note for your accountant");
    expect(note.note).toContain("not tax advice");
    expect(note.rows[0].cells[2]).toContain("possible reverse charge");
    expect(note.rows[0].cells[2]).toContain("invoice in your personal name");
    expect(hh.labs[0]).toMatchObject({ endpoint: "/labs/ext", body: { module: "business-move", action: "merchant_refund", body: { month: "2026-10" } } });

    const half = await a.post("/api/capabilities/E7H", { inputs: { businessUse: 50, m2026_10: false } });
    expect(half.json.numbers).toMatchObject({ repaymentTotalMinor: 11900, months: 2, businessUseBp: 5000 });
    expect((await a.get("/api/capabilities/E7")).status).toBe(409);
  });
});

describe("E7 click path", () => {
  it("household approves (no money), business approves, one balanced transfer per month, receipt, note filed", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    const hhAcct = `${t}:hh-current`;
    const bizAcct = `${t}:biz-current`;
    const [hh0, biz0] = [balance(stack, hhAcct), balance(stack, bizAcct)];

    const c = await consent(a);
    expect(c.status).toBe("CONFIRMED");
    expect([balance(stack, hhAcct), balance(stack, bizAcct)]).toEqual([hh0, biz0]);
    const move = stack.q1<any>("SELECT * FROM ext_business_move WHERE tenant_id=?", t)!;
    expect(move).toMatchObject({ status: "HOUSEHOLD_APPROVED", household_action_id: c.id });
    const hhAgain = await a.json("/api/capabilities/E7H");
    expect(hhAgain.candidates[0]).toMatchObject({ available: false, unavailableReason: "The household already approved this exact plan" });

    await ctx(a, "BUSINESS");
    const e7 = await a.json("/api/capabilities/E7");
    expect(e7.candidates[0]).toMatchObject({ key: "bizmove-repay", available: true });
    expect(e7.candidates[0].spec.money).toMatchObject({ maxDebitMinor: 35700, immediateDebitMinor: 35700 });
    expect(e7.candidates[0].spec.params).toMatchObject({ planId: move.plan_id, fromAccountId: bizAcct, toAccountId: hhAcct, totalMinor: 35700 });
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    await stack.approve(a, p);
    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
    expect(done.status).toBe("CONFIRMED");

    expect(balance(stack, bizAcct)).toBe(biz0 - 35700);
    expect(balance(stack, hhAcct)).toBe(hh0 + 35700);
    const entries = stack.q<any>("SELECT id FROM ledger_entries WHERE tenant_id=? AND kind='INTERNAL_TRANSFER' AND source_event_id LIKE ?", t, `${t}:bizmove:%`);
    expect(entries).toHaveLength(3);
    expect(stack.q("SELECT * FROM ext_business_repayment WHERE tenant_id=?", t)).toHaveLength(3);
    const filed = stack.q1<any>("SELECT * FROM ext_business_move WHERE tenant_id=?", t)!;
    expect(filed).toMatchObject({ status: "COMPLETED", repaid_minor: 35700, business_action_id: p.actions[0].id });
    expect(JSON.parse(filed.vat_note_json).disclaimer).toBe("INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE");
    expect(JSON.parse(filed.future_json).type).toBe("SHOW_MANUAL_STEPS");
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", p.actions[0].id)!;
    expect(receipt.issuer_reference).toMatch(/^NMB-[0-9A-F]{8}$/);
    expect(JSON.parse(receipt.money_effect_json).details).toMatchObject({ repaidMinor: 35700, transfers: 3 });

    // Double run of the handler on the settled action: no new posting, status unchanged.
    const { businessMove } = await import("../../src/server/extensions/modules/business-move");
    const action = stack.action(p.actions[0].id);
    await businessMove.operations!.EXT_BIZMOVE_REPAY({ db: stack.db, action, spec: JSON.parse(action.spec_json), attemptId: "att_replay" });
    expect(stack.action(p.actions[0].id).status).toBe("CONFIRMED");
    expect(balance(stack, bizAcct)).toBe(biz0 - 35700);
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id LIKE ?", t, `${t}:bizmove:%`)).toHaveLength(3);

    expect((await a.json("/api/capabilities/E7")).headline).toBe("Repaid the household 357.00 RON for PixelForge Studio");
    await ctx(a, "PERSONAL");
    const after = await a.json("/api/capabilities/E7H");
    expect(after.candidates).toEqual([]);
    expect(after.headline).toBe("Nothing left to move");
    // A repaid month cannot be refunded in the simulation (the business would have overpaid).
    expect((await refund(a, { month: "2026-10" })).status).toBe(409);
  });
});

describe("E7 security edges", () => {
  it("fails closed when the plan changes after the business approved: nothing is paid", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    expect((await consent(a)).status).toBe("CONFIRMED");
    await ctx(a, "BUSINESS");
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    const biz0 = balance(stack, `${t}:biz-current`);

    await stack.stopWorkers();
    await stack.approve(a, p);
    await ctx(a, "PERSONAL");
    const r = await refund(a, { month: "2026-10" });
    expect(r.json).toMatchObject({ refunded: true, duplicate: false, amountMinor: 11900 });
    expect((await refund(a, { month: "2026-10" })).json).toMatchObject({ duplicate: true, amountMinor: 0 });
    await stack.worker();

    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toContain("changed after approval");
    expect(balance(stack, `${t}:biz-current`)).toBe(biz0);
    expect(stack.q("SELECT * FROM ext_business_repayment WHERE tenant_id=?", t)).toHaveLength(0);

    // The business can no longer offer the stale plan; the household approves the new one (two months).
    await ctx(a, "BUSINESS");
    const stale = await a.json("/api/capabilities/E7");
    expect(stale.candidates[0]).toMatchObject({ available: false });
    expect((await a.post("/api/capabilities/E7/propose", { keys: ["bizmove-repay"] })).status).toBe(409);
    expect((await consent(a)).status).toBe("CONFIRMED");
    await ctx(a, "BUSINESS");
    const fresh = await a.json("/api/capabilities/E7");
    expect(fresh.candidates[0]).toMatchObject({ available: true });
    expect(fresh.numbers.repaymentTotalMinor).toBe(23800);
  });

  it("each side approves only in its own context, another tenant sees nothing, and Labs input is bounded", async () => {
    const a = await stack.login("laziz");
    const b = await stack.login("laziz");
    await ctx(a, "PERSONAL");
    const p = await stack.propose(a, "E7H", ["bizmove-consent"]);
    await ctx(a, "BUSINESS");
    const wrong = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe("WRONG_CONTEXT");
    await ctx(b, "PERSONAL");
    const other = await b.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(other.status).toBe(404);

    // Labs: bad input, wrong context, and a month that does not exist are refused; another tenant's refund touches only its own data.
    expect((await refund(b, { month: "Oct 2026" })).status).toBe(400);
    expect((await refund(b, { month: "2026-13" })).status).toBe(400);
    expect((await refund(b, { month: "2026-07" })).status).toBe(404);
    expect((await refund(a, { month: "2026-10" })).status).toBe(404); // a is in the business context
    expect((await b.post("/api/labs/ext", { module: "business-move", action: "approve_everything", body: {} })).status).toBe(400);
    expect((await refund(b, { month: "2026-10" })).status).toBe(200);
    expect(stack.q1<any>("SELECT refunded FROM ext_bizmove_charge WHERE tenant_id=? AND posted_on='2026-10-05'", a.tenantId)!.refunded).toBe(0);
  });

  it("refuses a business repayment whose household consent is missing, even with a valid grant", async () => {
    const a = await stack.login("laziz");
    const t = a.tenantId;
    expect((await consent(a)).status).toBe("CONFIRMED");
    await ctx(a, "BUSINESS");
    const p = await stack.propose(a, "E7", ["bizmove-repay"]);
    await stack.stopWorkers();
    await stack.approve(a, p);
    stack.exec("DELETE FROM ext_business_move WHERE tenant_id=?", t);
    const biz0 = balance(stack, `${t}:biz-current`);
    await stack.worker();
    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE"]);
    expect(done.status).toBe("REFUSED");
    expect(balance(stack, `${t}:biz-current`)).toBe(biz0);
  });
});
