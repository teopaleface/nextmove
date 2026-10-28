import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, funds, startStack, type Api, type Stack } from "./harness";

// T4 Trial Shield end to end through the production router and a real worker: card checks become watches, the
// first full charge is held (never posted), and each customer decision is an exact proposal with a receipt.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const attempt = async (a: Api, merchantId: string) => {
  const r = await a.post("/api/labs/card-attempt", { merchantId });
  if (r.status !== 200) throw new Error(`card-attempt ${merchantId} -> ${r.status} ${r.text}`);
  return r.json as { decision: string; amountMinor: number; transactionId: string | null; reference: string };
};
const watch = (t: string, m: string) => JSON.parse(stack.q1<any>("SELECT condition_json FROM watches WHERE id=?", `${t}:watch:trial_shield:${m}`)!.condition_json);
const txn = (id: string) => stack.q1<any>("SELECT * FROM transactions WHERE id=?", id)!;

describe("T4 detection and the hold", () => {
  it("creates one watch per card-check merchant and leaves every existing number unchanged", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.blocks.find((b: any) => b.kind === "table").rows.map((r: any) => r.cells[0])).toEqual(["LinguaLeap", "Snapwise Pro", "FitFlow"]);
    expect(t4.candidates).toEqual([]);
    expect(t4.numbers).toMatchObject({ watching: 3, held: 0, heldMinor: 0 });
    const t2 = await a.json("/api/capabilities/T2");
    expect(t2.numbers).toMatchObject({ baselineMinor: 24200, afterMinor: 16300 });
    expect(funds(stack, t, `${t}:personal`)).toBe(11_000_000);
    const fit = t4.blocks.filter((b: any) => b.kind === "note").map((b: any) => b.text).join(" ");
    expect(fit).toContain("FitFlow is a trial you told us about");
  });

  it("holds Snapwise Pro's first charge: pending, not posted, alert on Home, forecast conditional", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = balance(stack, `${t}:daily`);
    const r = await attempt(a, "snapwise");
    expect(r).toMatchObject({ decision: "HOLD", amountMinor: 12000 });
    const held = txn(r.transactionId!);
    expect(held).toMatchObject({ status: "PENDING", entry_id: null, amount_minor: -12000 });
    expect(balance(stack, `${t}:daily`)).toBe(daily);
    const home = await a.json("/api/home");
    expect(home.findings.find((f: any) => f.kind === "TRIAL_SHIELD_HOLD")).toMatchObject({ task_kind: "T4", title: "Snapwise Pro tried to take 120.00 RON" });
    expect(home.upcoming.windowTotalMinor).toBe(24200);
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.headline).toContain("Snapwise Pro tried to take 120.00 RON");
    expect(t4.candidates.map((c: any) => c.key).sort()).toEqual(["allow-snapwise", "block-snapwise"]);
    expect(t4.candidates.every((c: any) => !c.defaultSelected)).toBe(true);
    // A retry while held is declined and logged, never a second hold.
    expect((await attempt(a, "snapwise")).decision).toBe("DECLINE_ALREADY_HELD");
    expect(stack.q("SELECT id FROM transactions WHERE tenant_id=? AND merchant_id='snapwise' AND status='PENDING'", t)).toHaveLength(1);
  });
});

describe("T4 decisions", () => {
  it("block: hold released, avoided charge (no credit), receipt, retry declined", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = balance(stack, `${t}:daily`);
    const r = await attempt(a, "snapwise");
    const p = await stack.propose(a, "T4", ["block-snapwise"]);
    expect(p.actions[0].operation).toBe("MERCHANT_BLOCK");
    await stack.approve(a, p);
    const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"]);
    expect(done.status).toBe("CONFIRMED");
    expect(txn(r.transactionId!)).toMatchObject({ status: "RELEASED", entry_id: null });
    expect(balance(stack, `${t}:daily`)).toBe(daily);
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id LIKE 'shield%'", t)).toHaveLength(0);
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", p.actions[0].id)!;
    expect(JSON.parse(receipt.money_effect_json)).toMatchObject({ forecastChangeMinor: -12000, details: { avoidedMinor: 12000, releasedMinor: 12000 } });
    expect(stack.q1<any>("SELECT status FROM forecast_items WHERE tenant_id=? AND dataset='shield'", t)!.status).toBe("REMOVED");
    expect(watch(t, "snapwise").state).toBe("BLOCKED");

    const retry = await attempt(a, "snapwise");
    expect(retry.decision).toBe("DECLINE_BLOCKED");
    expect(watch(t, "snapwise").attempts.map((x: any) => x.outcome)).toEqual(["HELD", "RELEASED_BY_BLOCK", "DECLINED_BLOCKED"]);
    expect(balance(stack, `${t}:daily`)).toBe(daily);
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.numbers.avoidedMinor).toBe(12000); // the retry is not counted again
    expect(t4.done.href).toBe(`/receipts/${receipt.id}`);
    expect(t4.blocks.some((b: any) => b.kind === "note" && b.text.startsWith("Follow-up idea: move the 120.00 RON"))).toBe(true);
  });

  it("allow: a different amount is shown next to the advertised price, then posts once as a normal debit", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = balance(stack, `${t}:daily`);
    const r = await attempt(a, "lingualeap");
    expect(r.amountMinor).toBe(5900);
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.blocks.some((b: any) => b.kind === "note" && b.tone === "warn" && b.text.includes("59.00 RON") && b.text.includes("49.00 RON"))).toBe(true);
    const p = await stack.propose(a, "T4", ["allow-lingualeap"]);
    await stack.approve(a, p);
    expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"])).status).toBe("CONFIRMED");
    expect(txn(r.transactionId!)).toMatchObject({ status: "POSTED", amount_minor: -5900 });
    expect(balance(stack, `${t}:daily`)).toBe(daily - 5900);
    expect(watch(t, "lingualeap").state).toBe("ALLOWED");
    // Once allowed, later charges go through as usual.
    const next = await attempt(a, "lingualeap");
    expect(next.decision).toBe("APPROVE");
    expect(balance(stack, `${t}:daily`)).toBe(daily - 11800);
  });

  it("a stale proposal is outdated when its hold expires before approval", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = balance(stack, `${t}:daily`);
    await attempt(a, "snapwise");
    const p = await stack.propose(a, "T4", ["allow-snapwise"]);
    await stack.clock(a, 72 * 60);
    await a.json("/api/capabilities/T4"); // reading the shield applies the expiry
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("OUTDATED");
    const r = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(r.status).toBe(409);
    expect(balance(stack, `${t}:daily`)).toBe(daily);
  });
});

describe("T4 edge cases", () => {
  it("no decision for 72 h: declined by default, nothing posted, a retry is held again", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = balance(stack, `${t}:daily`);
    const first = await attempt(a, "snapwise");
    await stack.clock(a, 72 * 60 - 1);
    expect((await a.json("/api/capabilities/T4")).numbers.held).toBe(1);
    await stack.clock(a, 2);
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.numbers.held).toBe(0);
    expect(t4.candidates).toEqual([]);
    expect(txn(first.transactionId!).status).toBe("RELEASED");
    expect(balance(stack, `${t}:daily`)).toBe(daily);
    expect(stack.q1<any>("SELECT resolved_at FROM findings WHERE subject_ref=?", first.transactionId)!.resolved_at).not.toBeNull();
    const again = await attempt(a, "snapwise");
    expect(again.decision).toBe("HOLD");
    expect(again.transactionId).not.toBe(first.transactionId);
  });

  it("FitFlow renewal already off via T2: says no hold is needed and offers no simulation", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    stack.exec("UPDATE subscriptions SET state='RENEWAL_OFF' WHERE id=?", `${t}:sub:fitflow`);
    const t4 = await a.json("/api/capabilities/T4");
    expect(t4.blocks.find((b: any) => b.kind === "table").rows.find((r: any) => r.cells[0] === "FitFlow").cells[2]).toBe("No hold needed (T2)");
    expect(t4.blocks.some((b: any) => b.kind === "note" && b.text.startsWith("FitFlow: no hold needed"))).toBe(true);
    expect(t4.labs.some((l: any) => l.label.startsWith("FitFlow"))).toBe(false);
  });

  it("is tenant-scoped and refuses unknown merchants; labs is required", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    const r = await attempt(a, "snapwise");
    expect(stack.q1<any>("SELECT tenant_id FROM transactions WHERE id=?", r.transactionId)!.tenant_id).toBe(a.tenantId);
    expect((await b.json("/api/capabilities/T4")).numbers.held).toBe(0);
    expect((await a.post("/api/labs/card-attempt", { merchantId: "studiomart" })).status).toBe(404);
    expect((await b.get(`/api/transactions/${encodeURIComponent(r.transactionId!)}`)).status).toBe(404);
    const l = await stack.login("laziz");
    expect((await l.get("/api/capabilities/T4")).status).toBe(404);
  });

  it("the agent routes the suggestion to T4 and does not choose for the customer", async () => {
    const a = await stack.login("alex");
    await attempt(a, "snapwise");
    const task = await a.ok("/api/tasks", { text: "Did anything try to charge me after a free trial?" });
    const done = await (async () => {
      for (let i = 0; i < 120; i++) {
        const tk = stack.q1<any>("SELECT * FROM tasks WHERE id=?", task.taskId)!;
        if (["DONE", "FAILED", "NEEDS_APPROVAL", "WAITING_USER"].includes(tk.state)) return tk;
        await new Promise((res) => setTimeout(res, 500));
      }
      return stack.q1<any>("SELECT * FROM tasks WHERE id=?", task.taskId)!;
    })();
    expect(stack.q1<any>("SELECT block_key FROM task_blocks WHERE task_id=? AND block_key='analysis:T4'", task.taskId)).toBeTruthy();
    const events = stack.q<any>("SELECT label FROM task_events WHERE task_id=?", task.taskId).map((e) => e.label).join("\n");
    expect(events).toContain("Snapwise Pro tried to take 120.00 RON");
    expect(stack.q("SELECT id FROM proposals WHERE task_id=?", task.taskId)).toHaveLength(0);
    expect(done.state).not.toBe("FAILED");
  });
});
