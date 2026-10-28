import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startStack, waitFor, type Api, type Stack } from "./harness";
import { RULES, PENALTIES, capacity, resetRateLimits } from "../../src/server/api/rate-limit";

// Request limits through the real router at their real size (scale 1): per account, per IP, global ceilings that
// rotating X-Forwarded-For cannot pass, penalty budgets for probing and id-guessing, live-view caps, open-task caps,
// the per-tenant upload quota and the daily live-model budget. Every refusal is 429 {error, message} with
// Retry-After, and a refused request creates nothing.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

/** Real limits from here on; sign-ins made before this ran at the suite's relaxed scale. */
function strict(scale = "1") {
  stack.setEnv({ NEXTMOVE_RATE_LIMIT_SCALE: scale });
  resetRateLimits();
}
beforeEach(() => {
  stack.setEnv({ NEXTMOVE_RATE_LIMIT_SCALE: "1000", NEXTMOVE_TRUSTED_PROXY_HOPS: "0" });
  resetRateLimits();
});

const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });
const tasks = (a: Api) => stack.q1<any>("SELECT COUNT(*) n FROM tasks WHERE tenant_id=?", a.tenantId)!.n;

function expect429(r: { status: number; json: any; headers: Record<string, any> }, code = "RATE_LIMITED") {
  expect(r.status).toBe(429);
  expect(Object.keys(r.json).sort()).toEqual(["error", "message"]);
  expect(r.json.error).toBe(code);
  const wait = Number(r.headers["retry-after"]);
  expect(Number.isInteger(wait) && wait >= 1).toBe(true);
}

describe("per account and per IP", () => {
  it("agent requests: the account budget refuses the next one, creates nothing, and leaves another account on the same IP alone", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    strict();
    const n = capacity(RULES.agent[1]);
    for (let i = 0; i < n; i++) expect((await a.post("/api/tasks", { text: `request ${i}` }, from("198.51.100.1"))).status).toBe(200);
    const before = tasks(a);
    const r = await a.post("/api/tasks", { text: "one too many" }, from("198.51.100.1"));
    expect429(r);
    expect(tasks(a)).toBe(before);
    // Another address does not reset the account's budget.
    expect429(await a.post("/api/tasks", { text: "from elsewhere" }, from("198.51.100.99")));
    // Another account on the same address still has its own.
    expect((await b.post("/api/tasks", { text: "mine" }, from("198.51.100.1"))).status).toBe(200);
  });

  it("approvals have their own small budget, charged even when the id does not exist", async () => {
    const a = await stack.login("alex");
    strict();
    const n = capacity(RULES.money[1]);
    for (let i = 0; i < n; i++) expect((await a.post(`/api/proposals/prop_missing${i}/approve`, { actionIds: [], digest: "x" }, from("198.51.100.2"))).status).not.toBe(429);
    expect429(await a.post("/api/proposals/prop_missing/approve", { actionIds: [], digest: "x" }, from("198.51.100.2")));
    // Reading is a different budget and still works.
    expect((await a.get("/api/home", from("198.51.100.2"))).status).toBe(200);
  });

  it("sign-ins per IP: direct mode trusts the rightmost X-Forwarded-For entry; behind a proxy, a forged left entry changes nothing", async () => {
    strict();
    const n = capacity(RULES.session[0]);
    const signIn = (xff: string) => stack.api().post("/api/session/demo", { customer: "alex" }, from(xff));
    for (let i = 0; i < n; i++) expect((await signIn("198.51.100.3")).status).toBe(200);
    expect429(await signIn("198.51.100.3"));
    // Behind one trusted proxy the proxy's appended entry is the client: rotating the forged entry buys nothing.
    stack.setEnv({ NEXTMOVE_TRUSTED_PROXY_HOPS: "1" });
    for (let i = 0; i < 5; i++) expect429(await signIn(`6.6.6.${i}, 198.51.100.3`));
    // A different real client behind the same proxy is unaffected.
    expect((await signIn("6.6.6.1, 198.51.100.4")).status).toBe(200);
  });

  it("isolated demo copies have a tighter budget of their own", async () => {
    strict();
    const n = capacity(RULES.isolated[0]);
    for (let i = 0; i < n; i++) expect((await stack.api().post("/api/session/demo", { customer: "laziz", isolated: true }, from(`198.51.100.5`))).status).toBe(200);
    // The sign-in budget (30 per 10 minutes) is not spent yet, but the isolated one (20 an hour) is.
    const before = stack.q1<any>("SELECT COUNT(*) n FROM tenants")!.n;
    expect429(await stack.api().post("/api/session/demo", { customer: "laziz", isolated: true }, from("198.51.100.5")));
    expect(stack.q1<any>("SELECT COUNT(*) n FROM tenants")!.n).toBe(before);
    // A plain sign-in from the same address still works.
    expect((await stack.api().post("/api/session/demo", { customer: "laziz" }, from("198.51.100.5"))).status).toBe(200);
  });
});

describe("global ceilings", () => {
  it("rotating forged addresses cannot pass the global sign-in ceiling", async () => {
    strict("0.1");
    const ceiling = capacity(RULES.session[1], 0.1);
    for (let i = 0; i < ceiling; i++) expect((await stack.api().post("/api/session/demo", { customer: "alex" }, from(`203.0.113.${i}`))).status).toBe(200);
    expect429(await stack.api().post("/api/session/demo", { customer: "alex" }, from("192.0.2.77")));
    expect429(await stack.api().post("/api/session/demo", { customer: "alex" }, from("2001:db8::1")));
  });
});

describe("penalties", () => {
  it("failed sign-ins, CSRF refusals and unknown routes from one IP lock that IP out, even with a valid session", async () => {
    const a = await stack.login("alex");
    strict();
    const ip = from("198.51.100.6");
    let spent = 0;
    while (spent < PENALTIES.probe.n) {
      const kind = spent % 3;
      const r =
        kind === 0 ? await stack.api().get("/api/home", { headers: { ...ip.headers, cookie: "nm_session=forged" } }) :
        kind === 1 ? await a.post("/api/preferences", { key: "simple_mode", value: true }, { ...ip, csrf: "wrong" }) :
        await stack.api().get(`/api/wp-admin/${spent}`, ip);
      expect([401, 403, 404]).toContain(r.status);
      spent++;
    }
    expect429(await a.get("/api/home", ip));
    expect429(await stack.api().post("/api/session/demo", { customer: "alex" }, ip));
    // Only that address.
    expect((await a.get("/api/home", from("198.51.100.7"))).status).toBe(200);
  });

  it("guessing ids: an account that keeps asking for things that do not exist is slowed on id routes only", async () => {
    const a = await stack.login("alex");
    strict();
    for (let i = 0; i < PENALTIES.miss.n; i++) {
      const r = await a.get(`/api/proposals/prop_guess${i}`, from(`198.51.100.${(i % 200) + 10}`));
      expect([404, 429]).toContain(r.status);
      if (r.status === 429) throw new Error(`refused early at ${i}: ${r.text}`);
    }
    const r = await a.get("/api/proposals/prop_guess_more", from("198.51.100.250"));
    expect429(r);
    expect(r.json.message).toMatch(/do not exist/);
    expect((await a.get("/api/home")).status).toBe(200);
    // Another account is unaffected.
    const b = await stack.login("alex");
    expect((await b.get("/api/proposals/prop_guess_x")).status).toBe(404);
  });
});

describe("open work", () => {
  it("live views: four per account at once, the fifth refused, a slot freed when one closes", async () => {
    const a = await stack.login("alex");
    const { taskId } = await a.ok("/api/tasks", { text: "What can I save on?" });
    strict();
    const open = () => {
      const ac = new AbortController();
      const p = fetch(`${stack.bankUrl}/api/tasks/${taskId}/stream`, { headers: { cookie: a.cookie, "x-forwarded-for": "198.51.100.8" }, signal: ac.signal });
      return { ac, p };
    };
    const held = [open(), open(), open(), open()];
    for (const h of held) expect((await h.p).status).toBe(200);
    const fifth = await fetch(`${stack.bankUrl}/api/tasks/${taskId}/stream`, { headers: { cookie: a.cookie } });
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).error).toBe("TOO_MANY_STREAMS");
    held[0].ac.abort();
    await waitFor(async () => {
      const r = await fetch(`${stack.bankUrl}/api/tasks/${taskId}/stream`, { headers: { cookie: a.cookie } });
      if (r.status !== 200) return false;
      await r.body?.cancel();
      return true;
    }, { timeout: 5000, label: "slot released" });
    for (const h of held.slice(1)) h.ac.abort();
  });

  it("at most ten open requests per account; stopping one makes room", async () => {
    const a = await stack.login("alex");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await a.ok("/api/tasks", { text: `queued ${i}` })).taskId);
    const r = await a.post("/api/tasks", { text: "eleventh" });
    expect429(r, "TOO_MANY_OPEN_TASKS");
    await a.ok(`/api/tasks/${ids[0]}/stop`);
    expect((await a.post("/api/tasks", { text: "now there is room" })).status).toBe(200);
  });

  it("uploads stop at the per-tenant quota", async () => {
    const a = await stack.login("alex");
    const sess = stack.q1<any>("SELECT active_context_id context_id, user_id FROM sessions WHERE csrf_token=?", a.csrf)!;
    for (let i = 0; i < 200; i++) stack.db.prepare("INSERT INTO uploads(id, tenant_id, context_id, user_id, task_id, mime, bytes, width, height, sha256, storage_name, label, created_at) VALUES (?,?,?,?,NULL,'image/png',10,1,1,'x',?,NULL,?)").run(`upl_quota${i}`, a.tenantId, sess.context_id, sess.user_id, `upl_quota${i}.bin`, new Date().toISOString());
    const r = await a.post("/api/uploads/sample", { name: "screen-time" });
    expect(r.status).toBe(413);
    expect(r.json.error).toBe("QUOTA");
  });
});

describe("live-model budget", () => {
  it("counts only calls that reached the CLI, and a call with no reported cost at its per-call maximum", async () => {
    const { modelBudgetProblem } = await import("../../src/server/model/claude-cli");
    const add = (status: string, cost: number | null, tenant: string | null = null, error: string | null = null) =>
      stack.db.prepare("INSERT INTO model_calls(id, tenant_id, task_id, purpose, model, status, duration_ms, input_chars, image_count, output_chars, cost_usd, error, created_at) VALUES (?,?,NULL,'planner','m',?,1,1,0,1,?,?,?)").run(`mc_${Math.random().toString(36).slice(2)}`, tenant, status, cost, error, new Date().toISOString());
    stack.setEnv({ NEXTMOVE_MODEL_DAILY_CALLS: "4", NEXTMOVE_MODEL_DAILY_USD: "1", NEXTMOVE_MODEL_TENANT_DAILY_CALLS: "2", NEXTMOVE_MODEL_MAX_BUDGET_USD: "0.50" });
    try {
      stack.db.prepare("DELETE FROM model_calls").run();
      for (let i = 0; i < 10; i++) add("UNAVAILABLE", null);
      // Account-level refusals and errors the CLI reported as free reached no model: a capped account's burst of
      // refusals must not use up the day after the cap is lifted.
      for (let i = 0; i < 10; i++) add("ERROR", null, "t-a", "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage");
      for (let i = 0; i < 10; i++) add("ERROR", 0, "t-a", "model error");
      expect(modelBudgetProblem(stack.db)).toBeNull();
      expect(modelBudgetProblem(stack.db, "t-a")).toBeNull();
      add("OK", 0.1, "t-a");
      add("TIMEOUT", null, "t-a");
      expect(modelBudgetProblem(stack.db, "t-a")).toMatch(/for this customer/);
      expect(modelBudgetProblem(stack.db, "t-b")).toBeNull();
      // 0.1 + 0.5 (the timeout, at its maximum) + 0.5 = 1.1 >= 1 USD, before the call count (4) is reached.
      add("ERROR", null, "t-b");
      expect(modelBudgetProblem(stack.db, "t-c")).toMatch(/spend limit/);
      stack.setEnv({ NEXTMOVE_MODEL_DAILY_USD: "100" });
      expect(modelBudgetProblem(stack.db, "t-c")).toBeNull();
      add("OK", 0, "t-b");
      expect(modelBudgetProblem(stack.db, "t-c")).toMatch(/call limit/);
      // Yesterday's calls no longer count.
      stack.db.prepare("UPDATE model_calls SET created_at=?").run(new Date(Date.now() - 25 * 3_600_000).toISOString());
      expect(modelBudgetProblem(stack.db, "t-a")).toBeNull();
      // A broken setting fails closed.
      stack.setEnv({ NEXTMOVE_MODEL_DAILY_CALLS: "lots" });
      expect(modelBudgetProblem(stack.db)).toMatch(/invalid/);
    } finally {
      stack.setEnv({ NEXTMOVE_MODEL_DAILY_CALLS: "300", NEXTMOVE_MODEL_DAILY_USD: "15", NEXTMOVE_MODEL_TENANT_DAILY_CALLS: "60" });
      stack.db.prepare("DELETE FROM model_calls").run();
    }
  });

  it("a customer over the daily limit gets the deterministic planner, and the model is never started", async () => {
    const dir = path.join(stack.dataDir, "budget-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\necho started >> ${JSON.stringify(path.join(dir, "calls.log"))}\nexit 1\n`, { mode: 0o755 });
    const a = await stack.login("alex");
    const w = await stack.worker({ env: { NEXTMOVE_PLANNER: "auto", NEXTMOVE_CLAUDE_BIN: path.join(dir, "claude"), NEXTMOVE_MODEL_TENANT_DAILY_CALLS: "0" } });
    try {
      const { taskId } = await a.ok("/api/tasks", { text: "Is PulseGym worth it?" });
      await waitFor(async () => ["DONE", "NEEDS_APPROVAL", "WAITING_USER"].includes((await a.json(`/api/tasks/${taskId}`)).task.state), { timeout: 30_000, label: "task settles" });
      const labels = stack.q<any>("SELECT label FROM task_events WHERE task_id=?", taskId).map((e) => e.label);
      expect(labels.some((l) => /Daily live-model limit for this customer reached \(0\); continuing with the labelled deterministic planner/.test(l))).toBe(true);
      expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false);
      expect(stack.q1<any>("SELECT COUNT(*) n FROM model_calls WHERE task_id=?", taskId)!.n).toBe(0);
    } finally {
      await w.stop();
    }
  });
});

describe("health", () => {
  it("is limited per IP like everything else", async () => {
    strict();
    for (let i = 0; i < capacity(RULES.health[0]); i++) expect((await stack.api().get("/api/health", from("198.51.100.9"))).status).toBe(200);
    expect429(await stack.api().get("/api/health", from("198.51.100.9")));
    expect((await stack.api().get("/api/health", from("198.51.100.10"))).status).toBe(200);
  });
});
