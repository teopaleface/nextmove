import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, funds, startStack, type Api, type Stack } from "./harness";

// "Put it to work": after a confirmed stop, offer to move the avoided amount from Daily into Savings or a simulated
// Titluri de stat holding. Each test uses its own isolated Alex tenant. The offer only drafts an INTERNAL_TRANSFER;
// money moves through exact approval → grant → dispatch gate → one ledger posting → receipt, once per receipt.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

const ids = (t: string) => ({ daily: `${t}:daily`, savings: `${t}:savings`, bonds: `${t}:bonds`, ctx: `${t}:personal` });
const putToWork = (a: Api, receiptId: string, choice: string) => a.post(`/api/receipts/${receiptId}/put-to-work`, { choice });
const proposals = (t: string) => stack.q<any>("SELECT id, status FROM proposals WHERE tenant_id=? ORDER BY created_at", t);

async function confirmedStop(a: Api, cap: string, key: string, timeout = 60_000) {
  const p = await stack.propose(a, cap, [key]);
  await stack.approve(a, p);
  // Not before: approved but not yet confirmed, there is no receipt and nothing to offer.
  const pending = await a.json(`/api/actions/${p.actions[0].id}`);
  expect(pending.receipt).toBeNull();
  expect(pending.putToWork).toBeNull();
  const w = await stack.worker();
  try {
    expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "UNKNOWN"], timeout)).status).toBe("CONFIRMED");
  } finally {
    await w.stop();
  }
  const receipt = stack.q1<any>("SELECT id FROM receipts WHERE action_id=?", p.actions[0].id)!;
  return { actionId: p.actions[0].id as string, receiptId: receipt.id as string };
}

async function runTransfer(a: Api, proposal: any) {
  await stack.approve(a, proposal);
  const w = await stack.worker();
  try {
    return await stack.waitAction(proposal.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "UNKNOWN"]);
  } finally {
    await w.stop();
  }
}

describe("Put it to work after a stop", () => {
  it("T2 FitFlow stop → offer of 79 RON; Not now prepares nothing; savings moves exactly 79.00 RON once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const k = ids(t);
    const stop = await confirmedStop(a, "T2", "stop-fitflow", 120_000);

    const r = await a.json(`/api/receipts/${stop.receiptId}`);
    expect(r.putToWork).toMatchObject({ state: "OFFER", amountMinor: 7900, merchant: "FitFlow", enoughInDaily: true, choice: null, projectionMonths: 12 });
    expect(r.putToWork.from).toMatchObject({ id: k.daily, balanceMinor: 1248000 });
    const [sav, bonds] = r.putToWork.options;
    // 12-month projections in whole bani: 79.00 RON at 5% = 3.95 RON; at 6% = 4.74 RON.
    expect(sav).toMatchObject({ choice: "savings", title: "Savings account, 5% a year", badge: "Demo rate", interestMinor: 395, totalMinor: 8295 });
    expect(bonds).toMatchObject({ choice: "bonds", title: "Titluri de stat (Romanian government bonds)", badge: "Simulated, not an offer", interestMinor: 474, totalMinor: 8374 });
    expect(bonds.body).toMatch(/No bond is bought/);
    expect((await a.json(`/api/actions/${stop.actionId}`)).putToWork).toEqual({ state: "OFFER", amountMinor: 7900 });

    // "Not now" prepares nothing and moves nothing.
    const proposalsBefore = proposals(t);
    const before = { daily: balance(stack, k.daily), savings: balance(stack, k.savings), funds: funds(stack, t, k.ctx) };
    expect((await putToWork(a, stop.receiptId, "not-now")).json).toEqual({ dismissed: true });
    expect(proposals(t)).toEqual(proposalsBefore);
    expect((await a.json(`/api/receipts/${stop.receiptId}`)).putToWork.state).toBe("DISMISSED");

    // An unknown option is refused; the client never names an amount or account.
    expect((await putToWork(a, stop.receiptId, "crypto")).status).toBe(400);
    const tampered = await a.post(`/api/receipts/${stop.receiptId}/put-to-work`, { choice: "savings", amountMinor: 999999, toAccountId: `${t}:daily` });
    expect(tampered.status).toBe(200);
    expect(tampered.json.actions[0].money.maxDebitMinor).toBe(7900);

    // Savings: one exact transfer of the avoided amount from Daily, built by the server.
    const p = (await putToWork(a, stop.receiptId, "savings")).json;
    expect(p.id).toBe(tampered.json.id); // same open draft for the same option
    expect(p.status).toBe("READY");
    expect(p.actions).toHaveLength(1);
    const act = p.actions[0];
    expect(act.operation).toBe("INTERNAL_TRANSFER");
    expect(act.route).toBe("BANK_INTERNAL");
    expect(act.money).toEqual({ currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 7900, feesMinor: 0, forecastChangeMinor: 0 });
    expect(act.display.title).toBe("Move 79.00 RON from Daily account to Savings");
    expect(act.display.confirmLabel).toBe("Move 79.00 RON");
    expect(JSON.stringify(act.display)).not.toMatch(/your [\d.,]+ RON refund/i);
    expect(act.display.lines.find((l: any) => l.label === "In 12 months").value).toBe("82.95 RON, of which 3.95 RON interest (projection, not a promise)");
    const spec = stack.q1<any>("SELECT spec_json FROM proposal_actions WHERE id=?", act.id)!;
    expect(JSON.parse(spec.spec_json).params).toMatchObject({ fromAccountId: k.daily, toAccountId: k.savings, amountMinor: 7900, mode: "EXACT", executeAt: null, purpose: "PUT_TO_WORK_SAVINGS", openPocket: null });
    expect(balance(stack, k.daily)).toBe(before.daily); // nothing moved while waiting for approval
    expect((await a.json(`/api/receipts/${stop.receiptId}`)).putToWork).toMatchObject({ state: "PREPARED", choice: "savings", proposalId: p.id });

    const done = await runTransfer(a, p);
    expect(done.status).toBe("CONFIRMED");
    expect(balance(stack, k.daily)).toBe(before.daily - 7900);
    expect(balance(stack, k.savings)).toBe(before.savings + 7900);
    expect(funds(stack, t, k.ctx)).toBe(before.funds);
    const a2 = stack.action(act.id);
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, `transfer:${a2.logical_key}`)).toHaveLength(1);
    expect(stack.attempts(act.id)).toHaveLength(1);
    expect(stack.q("SELECT id FROM grants WHERE action_id=?", act.id)).toHaveLength(1);

    // Accepted once: the offer is done, and no second move can be prepared for this receipt.
    const after = (await a.json(`/api/receipts/${stop.receiptId}`)).putToWork;
    expect(after).toMatchObject({ state: "DONE", choice: "savings", actionId: act.id });
    expect(after.transferReceipt.reference).toMatch(/^NMT-/);
    for (const choice of ["savings", "bonds"]) {
      const again = await putToWork(a, stop.receiptId, choice);
      expect(again.status).toBe(409);
      expect(again.json.error).toBe("ALREADY_DONE");
    }
    const replay = await stack.approve(a, p);
    expect(replay.alreadyApproved).toBe(true);
    expect(stack.attempts(act.id)).toHaveLength(1);
    expect(balance(stack, k.daily)).toBe(before.daily - 7900);

    // The transfer's own receipt avoided nothing, so it offers nothing.
    expect((await a.json(`/api/receipts/${after.transferReceipt.id}`)).putToWork).toBeNull();
    const home = await a.json("/api/home");
    expect(home.accounts.find((x: any) => x.id === k.savings).rateNote).toBe("5.00% a year, demo rate");
  }, 240_000);

  it("A15 DashEats stop → bonds opens a simulated holding; switching option retires the other draft", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const k = ids(t);
    const stop = await confirmedStop(a, "A15", "stop-dasheats");
    const offer = (await a.json(`/api/receipts/${stop.receiptId}`)).putToWork;
    expect(offer).toMatchObject({ state: "OFFER", amountMinor: 2999, merchant: "DashEats Plus" });
    expect(offer.options.map((o: any) => [o.interestMinor, o.totalMinor])).toEqual([
      [150, 3149],
      [180, 3179],
    ]);
    const before = { daily: balance(stack, k.daily), funds: funds(stack, t, k.ctx) };

    const sav = (await putToWork(a, stop.receiptId, "savings")).json;
    const bonds = (await putToWork(a, stop.receiptId, "bonds")).json;
    expect(bonds.id).not.toBe(sav.id);
    // Only one draft per receipt can be approved: the savings draft is retired.
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", sav.id)!.status).toBe("OUTDATED");
    const stale = await a.post(`/api/proposals/${sav.id}/approve`, { digest: sav.digest, actionIds: sav.actions.map((x: any) => x.id) });
    expect(stale.status).toBe(409);

    const act = bonds.actions[0];
    expect(act.display.title).toBe("Move 29.99 RON from Daily account to Titluri de stat (simulated)");
    expect(act.display.lines.find((l: any) => l.label === "To").value).toBe("Titluri de stat (simulated) (opens with this transfer)");
    expect(act.display.lines.find((l: any) => l.label === "Simulation").value).toMatch(/No bond is bought/);
    expect(JSON.parse(stack.q1<any>("SELECT spec_json FROM proposal_actions WHERE id=?", act.id)!.spec_json).params).toMatchObject({
      fromAccountId: k.daily,
      toAccountId: k.bonds,
      amountMinor: 2999,
      mode: "EXACT",
      purpose: "PUT_TO_WORK_BONDS",
      openPocket: { name: "Titluri de stat (simulated)", kind: "HOLDING" },
    });
    expect(stack.q("SELECT id FROM accounts WHERE id=?", k.bonds)).toHaveLength(0); // not opened before approval

    expect((await runTransfer(a, bonds)).status).toBe("CONFIRMED");
    expect(balance(stack, k.daily)).toBe(before.daily - 2999);
    expect(balance(stack, k.bonds)).toBe(2999);
    expect(funds(stack, t, k.ctx)).toBe(before.funds);
    const holding = (await a.json("/api/home")).accounts.find((x: any) => x.id === k.bonds);
    expect(holding).toMatchObject({ name: "Titluri de stat (simulated)", kind: "HOLDING", balanceMinor: 2999, rateNote: "6.00% a year, fixed for 12 months, simulated" });
    expect((await putToWork(a, stop.receiptId, "savings")).status).toBe(409);
    expect((await putToWork(a, stop.receiptId, "bonds")).status).toBe(409);
  }, 120_000);

  it("another customer cannot see or use the offer", async () => {
    const a = await stack.login("alex");
    const stop = await confirmedStop(a, "A15", "stop-dasheats");
    const other = await stack.login("alex");
    expect((await other.get(`/api/receipts/${stop.receiptId}`)).status).toBe(404);
    expect((await putToWork(other, stop.receiptId, "savings")).status).toBe(404);
    expect(stack.q("SELECT id FROM proposal_actions WHERE tenant_id=? AND operation='INTERNAL_TRANSFER'", other.tenantId)).toHaveLength(0);
    expect(stack.q("SELECT id FROM proposal_actions WHERE tenant_id=? AND operation='INTERNAL_TRANSFER'", a.tenantId)).toHaveLength(0);
  }, 120_000);
});
