import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, funds, startStack, waitFor, type Api, type Stack } from "./harness";

// Cash autopilot: O7 bill vault and O8 overdraft shield over the INTERNAL_TRANSFER action. Each test uses its own
// isolated Alex tenant. Money moves only through proposal → approval → dispatch gate → ledger posting → receipt.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

const ids = (t: string) => ({ daily: `${t}:daily`, savings: `${t}:savings`, vault: `${t}:vault`, ctx: `${t}:personal` });
const entriesFor = (actionId: string) => {
  const a = stack.action(actionId);
  return stack.q<any>("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", a.tenant_id, `transfer:${a.logical_key}`);
};
const analyze = async (a: Api, cap: string, inputs: Record<string, unknown> = {}) => {
  const r = await a.post(`/api/capabilities/${cap}`, { inputs });
  if (r.status !== 200) throw new Error(`${cap} -> ${r.status} ${r.text}`);
  return r.json;
};
const labsBank = (a: Api, action: string) => a.ok("/api/labs/bank", { action });

describe("O7 bill vault", () => {
  it("salary lands → park 1,613 RON with two scheduled returns; each return runs on its demo date with its own receipt", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const k = ids(t);
    const before = funds(stack, t, k.ctx);

    const waiting = await analyze(a, "O7");
    expect(waiting.candidates).toHaveLength(0);
    expect(waiting.numbers.previewParkMinor).toBe(161300);

    const sal = await labsBank(a, "salary_arrives");
    expect(sal.salaryAt).toBe("2026-11-10T08:00:00+02:00");
    expect(funds(stack, t, k.ctx)).toBe(before + 320000);

    const o7 = await analyze(a, "O7");
    expect(o7.numbers.parkMinor).toBe(161300);
    expect(o7.numbers.interestMinor).toBe(124);
    expect(o7.candidates.map((c: any) => c.key)).toEqual(["park", "return-1", "return-2"]);
    expect(o7.candidates[1].spec.params).toMatchObject({ executeAt: "2026-11-24T08:00:00+02:00", amountMinor: 145000, mode: "UP_TO", returnEarlyBelowMinor: 0 });
    expect(o7.candidates[2].spec.params).toMatchObject({ executeAt: "2026-11-25T08:00:00+02:00", amountMinor: 16300 });

    const p = await stack.propose(a, "O7", ["park", "return-1", "return-2"]);
    const approval = await stack.approve(a, p);
    // Scheduled legs keep their grant past their own date; the park uses the normal approval window.
    const grantOf = (id: string) => approval.grants.find((g) => g.actionId === id)!.expiresAt;
    expect(Date.parse(grantOf(p.actions[1].id))).toBeGreaterThan(Date.parse("2026-11-24T08:00:00+02:00"));
    expect(Date.parse(grantOf(p.actions[0].id))).toBeLessThan(Date.parse("2026-11-11T08:00:00+02:00"));

    const w = await stack.worker();
    try {
      await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"]);
      expect(stack.action(p.actions[0].id).status).toBe("CONFIRMED");
      expect(balance(stack, k.vault)).toBe(161300);
      expect(balance(stack, k.daily)).toBe(1248000 + 320000 - 161300);
      expect(entriesFor(p.actions[0].id)).toHaveLength(1);
      // The returns wait for their dates: no attempt exists yet.
      await new Promise((r) => setTimeout(r, 1500));
      expect(stack.action(p.actions[1].id).status).toBe("APPROVED");
      expect(stack.attempts(p.actions[1].id)).toHaveLength(0);
      expect(stack.q<any>("SELECT amount_minor, due_at FROM forecast_items WHERE tenant_id=? AND dataset='autopilot' AND status='SCHEDULED' ORDER BY due_at", t)).toEqual([
        { amount_minor: 145000, due_at: "2026-11-24T08:00:00+02:00" },
        { amount_minor: 16300, due_at: "2026-11-25T08:00:00+02:00" },
      ]);

      // Re-running the confirmed park's job posts nothing new.
      stack.exec("UPDATE jobs SET status='QUEUED', available_at=? WHERE kind='ACTION' AND ref_id=?", new Date().toISOString(), p.actions[0].id);
      await waitFor(() => stack.q1<any>("SELECT status FROM jobs WHERE kind='ACTION' AND ref_id=?", p.actions[0].id)!.status === "DONE", { label: "park job re-run" });
      expect(entriesFor(p.actions[0].id)).toHaveLength(1);
      expect(stack.q("SELECT id FROM receipts WHERE action_id=?", p.actions[0].id)).toHaveLength(1);

      await labsBank(a, "next_return");
      await stack.waitAction(p.actions[1].id, ["CONFIRMED", "NO_CHANGE", "REFUSED", "EXPIRED"]);
      expect(stack.action(p.actions[1].id).status).toBe("CONFIRMED");
      expect(stack.action(p.actions[2].id).status).toBe("APPROVED");
      expect(balance(stack, k.vault)).toBe(16300);

      await labsBank(a, "next_return");
      await stack.waitAction(p.actions[2].id, ["CONFIRMED", "NO_CHANGE", "REFUSED", "EXPIRED"]);
      expect(balance(stack, k.vault)).toBe(0);
      expect(balance(stack, k.daily)).toBe(1248000 + 320000);
      expect(funds(stack, t, k.ctx)).toBe(before + 320000);
      expect(stack.q("SELECT id FROM forecast_items WHERE tenant_id=? AND dataset='autopilot' AND status='SCHEDULED'", t)).toHaveLength(0);
      expect(stack.q("SELECT id FROM receipts WHERE tenant_id=? AND operation='INTERNAL_TRANSFER'", t)).toHaveLength(3);
      const integrity = stack.q("SELECT e.id FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id WHERE e.tenant_id=? GROUP BY e.id HAVING SUM(l.amount_minor) != 0", t);
      expect(integrity).toHaveLength(0);

      const done = await analyze(a, "O7");
      expect(done.done?.label).toBe("Bill vault cycle finished");
    } finally {
      await w.stop();
    }
  });

  it("a park approved without its returns moves nothing", async () => {
    const a = await stack.login("alex");
    const k = ids(a.tenantId);
    await labsBank(a, "salary_arrives");
    const p = await stack.propose(a, "O7", ["park", "return-1", "return-2"]);
    await stack.approve(a, p, [p.actions[0].id]);
    const w = await stack.worker();
    try {
      const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"]);
      expect(done.status).toBe("REFUSED");
      expect(JSON.parse(done.result_json).reason).toMatch(/returns were not approved/);
      expect(entriesFor(p.actions[0].id)).toHaveLength(0);
      expect(stack.q1("SELECT id FROM accounts WHERE id=?", k.vault)).toBeUndefined();
    } finally {
      await w.stop();
    }
  });

  it("early return: if Daily drops below 0 before the date, the approved return runs at once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const k = ids(t);
    await labsBank(a, "salary_arrives");
    const p = await stack.propose(a, "O7", ["park", "return-1", "return-2"]);
    await stack.approve(a, p);
    const w = await stack.worker();
    try {
      await stack.waitAction(p.actions[0].id, ["CONFIRMED"]);
      // An outside debit (card payment) takes Daily below zero.
      const spend = balance(stack, k.daily) + 5000;
      stack.exec("INSERT INTO ledger_entries(id, tenant_id, source_event_id, kind, description, posted_at, created_at) VALUES (?,?,?,?,?,?,?)", `je_test_${t}`, t, `test:spend:${t}`, "DEBIT", "Test card spend", "2026-11-12T10:00:00+02:00", new Date().toISOString());
      stack.exec("INSERT INTO ledger_lines(entry_id, account_id, amount_minor, currency) VALUES (?,?,?, 'RON'), (?,?,?, 'RON')", `je_test_${t}`, k.daily, -spend, `je_test_${t}`, `${t}:clearing`, spend);
      expect(balance(stack, k.daily)).toBe(-5000);
      const r1 = await stack.waitAction(p.actions[1].id, ["CONFIRMED", "NO_CHANGE", "REFUSED"]);
      expect(r1.status).toBe("CONFIRMED");
      expect(JSON.parse(r1.result_json).details.early).toBe(true);
      expect(balance(stack, k.daily)).toBe(-5000 + 145000);
    } finally {
      await w.stop();
    }
  });
});

describe("O7 re-plan", () => {
  it("rent goes up after parking → the change is shown with a park-the-extra proposal; approved returns stay as approved", async () => {
    const a = await stack.login("alex");
    await labsBank(a, "salary_arrives");
    const p = await stack.propose(a, "O7", ["park", "return-1", "return-2"]);
    await stack.approve(a, p);
    const w = await stack.worker();
    try {
      await stack.waitAction(p.actions[0].id, ["CONFIRMED"]);
      await labsBank(a, "rent_up");
      const o7 = await analyze(a, "O7");
      expect(o7.numbers.changedBills).toBe(1);
      expect(o7.blocks.some((b: any) => b.kind === "note" && /changed from 1,450\.00 RON to 1,550\.00 RON/.test(b.text))).toBe(true);
      expect(o7.candidates.map((c: any) => c.key)).toEqual(["park-extra", "return-extra", "return-all"]);
      expect(o7.candidates[0].spec.params).toMatchObject({ amountMinor: 10000, purpose: "VAULT_PARK" });
      expect(o7.candidates[1].spec.params).toMatchObject({ amountMinor: 10000, executeAt: "2026-11-24T08:00:00+02:00" });
      expect(stack.action(p.actions[1].id).status).toBe("APPROVED");
      expect(JSON.parse(stack.action(p.actions[1].id).spec_json).params.amountMinor).toBe(145000);
    } finally {
      await w.stop();
    }
  });
});

describe("O8 overdraft shield", () => {
  it("unexpected bill → exact top-up from Savings; repeated approval and job re-run move money once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const k = ids(t);
    const before = funds(stack, t, k.ctx);
    const calm = await analyze(a, "O8");
    expect(calm.numbers.needMinor).toBe(0);

    await labsBank(a, "unexpected_bill");
    await labsBank(a, "unexpected_bill"); // same day: not added twice
    expect(stack.q("SELECT id FROM forecast_items WHERE tenant_id=? AND source LIKE 'labs:bill:%'", t)).toHaveLength(1);
    const o8 = await analyze(a, "O8");
    // 2,814 RON: the dental bill plus the PulseGym renewal (A17 fixture) that also falls inside the horizon.
    expect(o8.numbers.lowestMinor).toBe(-281400);
    expect(o8.numbers.needMinor).toBe(281400);
    expect(o8.numbers.overdraftAvoidedMinor).toBeGreaterThan(2500);
    expect(o8.candidates).toHaveLength(1);
    expect(o8.candidates[0].spec.params).toMatchObject({ fromAccountId: k.savings, toAccountId: k.daily, amountMinor: 281400, mode: "EXACT", purpose: "SHIELD_TOP_UP" });

    const p = await stack.propose(a, "O8", ["top-up-1"]);
    const first = await stack.approve(a, p);
    const again = await stack.approve(a, p);
    expect(again.alreadyApproved).toBe(true);
    expect(again.mandateId).toBe(first.mandateId);
    expect(stack.q("SELECT id FROM grants WHERE action_id=?", p.actions[0].id)).toHaveLength(1);

    const w = await stack.worker();
    try {
      const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"]);
      expect(done.status).toBe("CONFIRMED");
      expect(balance(stack, k.daily)).toBe(1248000 + 281400);
      expect(balance(stack, k.savings)).toBe(9752000 - 281400);
      expect(funds(stack, t, k.ctx)).toBe(before);
      stack.exec("UPDATE jobs SET status='QUEUED', available_at=? WHERE kind='ACTION' AND ref_id=?", new Date().toISOString(), p.actions[0].id);
      await waitFor(() => stack.q1<any>("SELECT status FROM jobs WHERE kind='ACTION' AND ref_id=?", p.actions[0].id)!.status === "DONE", { label: "job re-run" });
      expect(entriesFor(p.actions[0].id)).toHaveLength(1);
      expect(stack.attempts(p.actions[0].id).filter((x) => x.status === "CONFIRMED")).toHaveLength(1);
    } finally {
      await w.stop();
    }
    const after = await analyze(a, "O8");
    expect(after.numbers.needMinor).toBe(0);
    expect(after.candidates).toHaveLength(0);
  });

  it("pocket insufficient → partial top-up with the shortfall stated, never a silent failure", async () => {
    const a = await stack.login("alex");
    await labsBank(a, "unexpected_bill");
    const o8 = await analyze(a, "O8", { savingsKeepMinor: 9700000 });
    expect(o8.numbers.coveredMinor).toBe(52000);
    expect(o8.numbers.shortfallMinor).toBe(229400);
    expect(o8.candidates[0].spec.params.amountMinor).toBe(52000);
    const note = o8.blocks.find((b: any) => b.kind === "note" && b.tone === "warn");
    expect(note.text).toMatch(/still 2,294\.00 RON short/);
  });
});

describe("agent, simulated planner", () => {
  it("“an unexpected bill will put me into overdraft” → O8 analysed and the exact top-up prepared for approval", async () => {
    const a = await stack.login("alex");
    await labsBank(a, "unexpected_bill");
    const task = await a.ok("/api/tasks", { text: "An unexpected bill will put me into overdraft. Can you top up?" });
    const taskId = task.id ?? task.taskId;
    const w = await stack.worker({ env: { NEXTMOVE_PLANNER: "simulated" } });
    try {
      const t = await waitFor(() => {
        const row = stack.q1<any>("SELECT state, planner_mode FROM tasks WHERE id=?", taskId);
        return row && ["NEEDS_APPROVAL", "DONE", "FAILED"].includes(row.state) ? row : null;
      }, { label: "agent task" });
      expect(t.state).toBe("NEEDS_APPROVAL");
      const pa = stack.q1<any>("SELECT spec_json, status FROM proposal_actions WHERE tenant_id=? AND operation='INTERNAL_TRANSFER'", a.tenantId)!;
      expect(pa.status).toBe("PROPOSED");
      expect(JSON.parse(pa.spec_json)).toMatchObject({ capability: "O8", params: { amountMinor: 281400, purpose: "SHIELD_TOP_UP" } });
    } finally {
      await w.stop();
    }
  });
});

describe("internal transfer: outcome unknown", () => {
  /** Reproduce a worker that passed the dispatch gate and died before the posting committed. */
  function crashAfterGate(actionId: string) {
    const action = stack.action(actionId);
    const grant = stack.q1<any>("SELECT * FROM grants WHERE action_id=?", actionId)!;
    const job = stack.q1<any>("SELECT * FROM jobs WHERE kind='ACTION' AND ref_id=?", actionId)!;
    const att = `att_crash_${actionId}`;
    const now = new Date().toISOString();
    stack.exec("INSERT INTO attempts(id, action_id, logical_key, grant_id, tenant_id, job_id, fence, route, status, idempotency_key, correlation_id, started_at, dispatched_at) VALUES (?,?,?,?,?,?,?,?, 'DISPATCH_AUTHORIZED', ?,?,?,?)", att, actionId, action.logical_key, grant.id, action.tenant_id, job.id, job.fence, "BANK_INTERNAL", `idem_${att}`, `corr_${att}`, now, now);
    stack.exec("INSERT INTO dispatch_journal(attempt_id, grant_id, fence, epoch, authorized_at) VALUES (?,?,?,?,?)", att, grant.id, job.fence, 0, now);
    stack.exec("UPDATE grants SET status='CONSUMED', consumed_by_attempt=? WHERE id=?", att, grant.id);
    stack.exec("UPDATE proposal_actions SET status='EXECUTING' WHERE id=?", actionId);
    return att;
  }

  async function shieldApproved() {
    const a = await stack.login("alex");
    await labsBank(a, "unexpected_bill");
    const p = await stack.propose(a, "O8", ["top-up-1"]);
    const approval = await stack.approve(a, p);
    return { a, t: a.tenantId, id: p.actions[0].id, mandateId: approval.mandateId };
  }

  it("not in the ledger, approval active → reconciliation completes it once", async () => {
    const { t, id } = await shieldApproved();
    const att = crashAfterGate(id);
    const w = await stack.worker();
    try {
      const done = await stack.waitAction(id, ["CONFIRMED", "REVOKED", "REFUSED"]);
      expect(done.status).toBe("CONFIRMED");
      expect(entriesFor(id)).toHaveLength(1);
      expect(balance(stack, `${t}:daily`)).toBe(1248000 + 281400);
      const attempt = stack.q1<any>("SELECT status, reconcile_checks FROM attempts WHERE id=?", att)!;
      expect(attempt.status).toBe("CONFIRMED");
      expect(attempt.reconcile_checks).toBeGreaterThanOrEqual(1);
      expect(stack.attempts(id)).toHaveLength(1); // no second dispatch
    } finally {
      await w.stop();
    }
  });

  it("already posted but no receipt → reconciliation records the receipt without posting again", async () => {
    const { t, id } = await shieldApproved();
    crashAfterGate(id);
    const action = stack.action(id);
    const je = `je_pre_${id}`;
    stack.exec("INSERT INTO ledger_entries(id, tenant_id, source_event_id, kind, description, posted_at, created_at) VALUES (?,?,?,?,?,?,?)", je, t, `transfer:${action.logical_key}`, "INTERNAL_TRANSFER", "Overdraft shield", "2026-10-28T09:45:00+02:00", new Date().toISOString());
    stack.exec("INSERT INTO ledger_lines(entry_id, account_id, amount_minor, currency) VALUES (?,?,?, 'RON'), (?,?,?, 'RON')", je, `${t}:savings`, -281400, je, `${t}:daily`, 281400);
    const w = await stack.worker();
    try {
      const done = await stack.waitAction(id, ["CONFIRMED", "REVOKED", "REFUSED"]);
      expect(done.status).toBe("CONFIRMED");
      expect(entriesFor(id).map((e) => e.id)).toEqual([je]);
      expect(balance(stack, `${t}:daily`)).toBe(1248000 + 281400);
      expect(stack.q("SELECT id FROM receipts WHERE action_id=?", id)).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });

  it("not in the ledger and the approval was stopped → nothing moves", async () => {
    const { a, t, id, mandateId } = await shieldApproved();
    crashAfterGate(id);
    const r = await a.post(`/api/mandates/${mandateId}/stop`, {});
    expect(r.status).toBe(200);
    const w = await stack.worker();
    try {
      const done = await stack.waitAction(id, ["CONFIRMED", "REVOKED", "REFUSED"]);
      expect(done.status).toBe("REVOKED");
      expect(entriesFor(id)).toHaveLength(0);
      expect(balance(stack, `${t}:daily`)).toBe(1248000);
    } finally {
      await w.stop();
    }
  });
});
