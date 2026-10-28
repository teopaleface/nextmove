import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./harness";

// Regressions found by the second full audit: a bill freed after its payment draft expires, and capability inputs
// that are not numbers falling back to defaults instead of producing NaN plans or a server error.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

describe("payment drafts", () => {
  it("an expired draft no longer blocks paying the same bill", async () => {
    const a = await stack.login("alex");
    const pp = await a.json("/api/payments/payees");
    const bill = pp.payees[0];
    const from = pp.accounts[0];
    const d1 = await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    // While the draft can still be approved, a second one is refused.
    expect((await a.post("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id })).status).toBe(409);
    await stack.clock(a, 60);
    // Approving after expiry is refused and closes the draft's actions.
    expect((await a.post(`/api/proposals/${d1.id}/approve`, { digest: d1.digest, actionIds: d1.actions.map((x: any) => x.id) })).status).toBe(409);
    expect(stack.q("SELECT status FROM proposal_actions WHERE proposal_id=?", d1.id).map((r: any) => r.status)).toEqual(["EXPIRED"]);
    const after = await a.json("/api/payments/payees");
    expect(after.payees.find((p: any) => p.forecastItemId === bill.forecastItemId).draftPending).toBe(false);
    expect((await a.post("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id })).status).toBe(200);
  });

  it("an untouched draft past its window stops blocking too", async () => {
    const a = await stack.login("alex");
    const pp = await a.json("/api/payments/payees");
    const bill = pp.payees[1] ?? pp.payees[0];
    const from = pp.accounts[0];
    await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    await stack.clock(a, 60);
    expect((await a.post("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id })).status).toBe(200);
  });
});

describe("capability inputs", () => {
  it("ignores text in number fields instead of planning with NaN", async () => {
    const a = await stack.login("alex");
    for (const inputs of [{ dailyFloorMinor: "abc" }, { savingsKeepMinor: "abc" }, { dailyFloorMinor: "abc", savingsKeepMinor: "1e999" }]) {
      const r = await a.post("/api/capabilities/O8", { inputs });
      expect(r.status, JSON.stringify(inputs)).toBe(200);
      expect(r.text).not.toContain("NaN");
      for (const c of r.json.candidates ?? []) for (const leg of c.spec?.params?.legs ?? []) expect(Number.isSafeInteger(leg.amountMinor)).toBe(true);
    }
    const o7 = await a.post("/api/capabilities/O7", { inputs: { keepInDailyMinor: "abc", minDaysAway: "x" } });
    expect(o7.status).toBe(200);
    expect(o7.text).not.toContain("NaN");
  });
});

describe("agent tasks", () => {
  it("a stopped task closes its open question and refuses a late answer", async () => {
    const a = await stack.login("alex");
    const task = await a.ok("/api/tasks", { text: "Which subscriptions should I keep?" });
    stack.exec(
      "INSERT INTO task_questions(id, task_id, tenant_id, question_key, text, options_json, status, created_at) VALUES ('q-audit', ?, ?, 'audit', 'Keep it?', ?, 'OPEN', ?)",
      task.taskId, a.tenantId, JSON.stringify(["yes", "no"]), new Date().toISOString(),
    );
    expect((await a.post(`/api/tasks/${task.taskId}/stop`, {})).status).toBe(200);
    expect(stack.q1<any>("SELECT status FROM task_questions WHERE id='q-audit'")!.status).toBe("CLOSED");
    const late = await a.post(`/api/tasks/${task.taskId}/answer`, { questionId: "q-audit", answer: "yes" });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("TASK_CLOSED");
    expect(stack.q1<any>("SELECT state FROM tasks WHERE id=?", task.taskId)!.state).toBe("STOPPED");
  });
});
