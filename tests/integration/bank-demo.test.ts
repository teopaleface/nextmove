import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, type Stack, startStack } from "./harness";

// The real-operation-disabled bank demo: analyses run, execution is unavailable everywhere it is checked
// (analysis, propose, approve, and the worker's dispatch gate), and Labs controls are off.

const EXECUTABLE = new Set(["PARTNER_API", "ISOLATED_BROWSER", "BANK_INTERNAL"]);
const DISABLED_REASON = "Execution is disabled in this environment (real-operation-disabled bank demo)";

let stack: Stack;
let a: Api;

beforeAll(async () => {
  stack = await startStack({ mode: "bank-demo" });
  await stack.worker(); // inherits NEXTMOVE_MODE=bank-demo
  a = await stack.login("alex");
}, 120_000);

afterAll(async () => {
  await stack?.teardown();
});

/** Run fn while only the in-process bank believes it is in labs mode; the worker process stays in bank-demo. */
async function asLabs<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NEXTMOVE_MODE;
  process.env.NEXTMOVE_MODE = "labs";
  try {
    return await fn();
  } finally {
    process.env.NEXTMOVE_MODE = prev;
  }
}

describe("15. bank-demo mode", () => {
  it("analyses work; executable candidates are unavailable; propose is refused; Labs endpoints are 403", async () => {
    const s = await a.json("/api/session");
    expect(s.mode).toBe("bank-demo");
    expect(s.features.features).toMatchObject({ "execution.merchant": false, "execution.bank_internal": false, "preparation.local": true, monitoring: true });

    // Same analyses, same numbers as in labs mode; every candidate labs would offer is unavailable here with
    // the bank-demo reason, and candidates unavailable for a domain reason keep that reason.
    let disabledByMode = 0;
    for (const cap of ["A6", "T2", "A7", "A1", "A4", "A3"]) {
      const r = await a.get(`/api/capabilities/${cap}`);
      expect([cap, r.status]).toEqual([cap, 200]);
      expect([cap, r.json.capability, Boolean(r.json.headline)]).toEqual([cap, cap, true]);
      const labs = await asLabs(() => a.json(`/api/capabilities/${cap}`));
      expect([cap, r.json.headline, r.json.numbers]).toEqual([cap, labs.headline, labs.numbers]);
      const inLabs = new Map<string, any>(labs.candidates.map((c: any) => [c.key, c]));
      for (const c of r.json.candidates) {
        const l = inLabs.get(c.key);
        if (EXECUTABLE.has(c.spec.route)) expect([cap, c.key, c.available]).toEqual([cap, c.key, false]);
        if (l.available && EXECUTABLE.has(c.spec.route)) {
          disabledByMode++;
          expect([cap, c.key, c.unavailableReason]).toEqual([cap, c.key, DISABLED_REASON]);
        } else {
          expect([cap, c.key, c.available, c.unavailableReason]).toEqual([cap, c.key, l.available, l.unavailableReason]);
        }
      }
    }
    expect(disabledByMode).toBeGreaterThanOrEqual(5);

    const proposalsBefore = stack.q("SELECT id FROM proposals WHERE tenant_id=?", a.tenantId).length;
    for (const [cap, keys] of [["A6", ["pause"]], ["T2", ["stop-fitflow"]], ["A7", ["follow-up"]]] as const) {
      const r = await a.post(`/api/capabilities/${cap}/propose`, { keys });
      expect([cap, r.status, r.json.error]).toEqual([cap, 409, "NOT_AVAILABLE"]);
    }
    expect(stack.q("SELECT id FROM proposals WHERE tenant_id=?", a.tenantId)).toHaveLength(proposalsBefore);

    const clockBefore = stack.q1<any>("SELECT * FROM demo_clocks WHERE tenant_id=?", a.tenantId) ?? null;
    for (const [p, body] of [
      ["/api/labs/clock", { minutes: 600 }],
      ["/api/labs/merchant", { action: "fault", body: { contractId: `${a.tenantId}:streamly-standard`, kind: "MANUAL_REVIEW", params: {} } }],
      ["/api/labs/merchant", { action: "set_cancellation_mode", body: { merchantId: "fitflow", mode: "refuse" } }],
      ["/api/labs/reset", {}],
    ] as const) {
      const r = await a.post(p, body);
      expect([p, r.status, r.json.error]).toEqual([p, 403, "LABS_DISABLED"]);
    }
    expect(stack.q1<any>("SELECT * FROM demo_clocks WHERE tenant_id=?", a.tenantId) ?? null).toEqual(clockBefore);
    expect(stack.mq("SELECT kind FROM m_faults WHERE tenant_id=? AND contract_id=?", a.tenantId, `${a.tenantId}:streamly-standard`)).toHaveLength(0);
    expect(JSON.parse(stack.mq1<any>("SELECT policy_json FROM m_merchants WHERE tenant_id=? AND id='fitflow'", a.tenantId)!.policy_json).cancellationMode).not.toBe("refuse");
    expect((await a.json("/api/session")).authenticated).toBe(true); // the reset did not replace the session
  });

  it("approve is 403 FEATURE_DISABLED; a job forced into the queue is refused by the worker at its dispatch gate", async () => {
    // Proposals can only be prepared while the bank is in labs mode; the approval then happens in bank-demo.
    const pause = await asLabs(() => stack.propose(a, "A6", ["pause"]));
    const web = await asLabs(() => stack.propose(a, "T2", ["stop-fitflow"]));
    for (const p of [pause, web]) {
      const r = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] });
      expect([r.status, r.json.error]).toEqual([403, "FEATURE_DISABLED"]);
      expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("READY");
      expect(stack.q("SELECT id FROM mandates WHERE proposal_id=?", p.id)).toHaveLength(0);
      expect(stack.q("SELECT id FROM grants WHERE action_id=?", p.actions[0].id)).toHaveLength(0);
      expect(stack.q("SELECT id FROM jobs WHERE ref_id=?", p.actions[0].id)).toHaveLength(0);
    }

    // Provider-side and bank-side state of both subjects, to compare after the worker ran.
    const contracts = [`${a.tenantId}:fitflow-premium`, `${a.tenantId}:streamly-standard`];
    const merchantState = () => contracts.map((id) => stack.mq1<any>("SELECT id, state, auto_renew, plan_id, price_minor, next_charge_at, access_until, terms_revision, pending_json, details_json FROM m_contracts WHERE tenant_id=? AND id=?", a.tenantId, id));
    const bankState = () => stack.q<any>("SELECT id, state, plan_name, amount_minor, next_charge_at, access_until, data_json FROM subscriptions WHERE id IN (?,?) ORDER BY id", `${a.tenantId}:sub:fitflow`, `${a.tenantId}:sub:streamly`);
    const forecastState = () => stack.q<any>("SELECT id, status, amount_minor, due_at FROM forecast_items WHERE subscription_id IN (?,?) ORDER BY id", `${a.tenantId}:sub:fitflow`, `${a.tenantId}:sub:streamly`);
    const before = { merchant: merchantState(), bank: bankState(), forecast: forecastState() };
    expect(before.merchant.every(Boolean)).toBe(true);
    expect(before.bank).toHaveLength(2);

    // Force both into the queue through the real approval code (bank briefly in labs mode). The worker process
    // never left bank-demo, so its own gate must refuse: one for the partner API, one for the isolated browser.
    await asLabs(async () => {
      await stack.approve(a, pause);
      await stack.approve(a, web);
    });
    for (const p of [pause, web]) await stack.waitAction(p.actions[0].id, ["BLOCKED"], 60_000);
    for (const p of [pause, web]) {
      const actionId = p.actions[0].id;
      const atts = stack.attempts(actionId);
      expect(atts.map((x) => x.status)).toEqual(["NOT_DISPATCHED"]);
      expect(JSON.parse(atts[0].outcome_json).gate).toBe("FEATURE_DISABLED");
      expect(atts[0].dispatched_at).toBeNull();
      expect(stack.q("SELECT attempt_id FROM dispatch_journal WHERE attempt_id=?", atts[0].id)).toHaveLength(0);
      // Never consumed; the refused action's unused grant is closed (fail closed), so it cannot be used later.
      expect(stack.q1<any>("SELECT status, consumed_by_attempt FROM grants WHERE action_id=?", actionId)).toEqual({ status: "INVALIDATED", consumed_by_attempt: null });
      expect(JSON.parse(stack.action(actionId).result_json).reason).toBe("Execution is disabled in this environment");
      expect(stack.q1<any>("SELECT status FROM jobs WHERE ref_id=?", actionId)!.status).toBe("DONE");
      expect(stack.q("SELECT id FROM receipts WHERE action_id=?", actionId)).toHaveLength(0);
    }
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
    expect(merchantState()).toEqual(before.merchant);
    expect(merchantState()[0]!.auto_renew).toBe(1);
    expect(bankState()).toEqual(before.bank);
    expect(forecastState()).toEqual(before.forecast);
  }, 90_000);
});
