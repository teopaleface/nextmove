import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, type Stack, type WorkerProc, fixture, funds, startStack, waitFor } from "./harness";

// The independent 200-subscription scenario, run by two worker processes against one database while a second
// isolated tenant runs five of its own items at the same time. Then the response-loss items are reconciled past
// the 6 h read lag and the manual-review items past 48 h. Assertions read persisted rows: the bank's batch_items,
// actions, attempts, grants, dispatch journal, receipts, forecast and ledger, and the merchant's own requests.

const BULK = fixture("demo/bulk-cancellations.json");
const RECORDS: any[] = BULK.records;
const EXPECTED = BULK.expectedSummary;
const READY = RECORDS.filter((r) => r.inspectionStatus === "READY");
const RECORD = new Map<string, any>(RECORDS.map((r) => [r.id, r]));
const idsWith = (outcome: string) => READY.filter((r) => r.expectedOutcomeAfterFirstPass === outcome).map((r) => r.id as string);
const B_ITEMS = ["sub-001", "sub-002", "sub-003", "sub-004", "sub-005"];

// Per expected batch outcome: the action and attempt status behind it, and whether it passed the dispatch gate.
const BEHIND: Record<string, { action: string; attempt: string; dispatched: boolean; merchant: string | null }> = {
  CONFIRMED: { action: "CONFIRMED", attempt: "CONFIRMED", dispatched: true, merchant: "CONFIRMED" },
  WAITING_EXTERNAL: { action: "PENDING", attempt: "PENDING", dispatched: true, merchant: "PENDING_REVIEW" },
  OUTCOME_UNKNOWN: { action: "UNKNOWN", attempt: "UNKNOWN", dispatched: true, merchant: "CONFIRMED" },
  NEEDS_AUTH: { action: "BLOCKED", attempt: "BLOCKED", dispatched: false, merchant: null },
  TERMS_CHANGED: { action: "TERMS_CHANGED", attempt: "TERMS_CHANGED", dispatched: false, merchant: null },
};

let stack: Stack;
let workers: WorkerProc[];
let A: Api; // the full 200-item batch
let B: Api; // a second isolated tenant, five items, running at the same time
let batchA = "";
let batchB = "";
let ctxA = "";
let fundsBefore = 0;
let ledgerBefore = 0;

const local = (subscriptionId: string) => subscriptionId.split(":").pop()!; // "<tenant>:bulk:sub-118" -> "sub-118"
const countBy = (rows: any[], key: string) => rows.reduce((m: Record<string, number>, r) => ((m[r[key] ?? "NONE"] = (m[r[key] ?? "NONE"] ?? 0) + 1), m), {});

function items(batchId: string) {
  return stack.q<any>(
    "SELECT bi.*, s.merchant_id, s.subscriber_account_id, s.contract_id, s.state AS sub_state FROM batch_items bi JOIN subscriptions s ON s.id=bi.subscription_id WHERE bi.batch_id=? ORDER BY bi.ordinal",
    batchId,
  );
}

function avoidedMinor(batchId: string) {
  const b = stack.q1<any>("SELECT window_start, window_end FROM batches WHERE id=?", batchId)!;
  return stack.q1<any>(
    `SELECT COALESCE(SUM(-f.amount_minor),0) s FROM forecast_items f JOIN batch_items bi ON bi.subscription_id=f.subscription_id
     WHERE bi.batch_id=? AND f.status='REMOVED' AND f.due_at >= ? AND f.due_at < ?
       AND EXISTS (SELECT 1 FROM forecast_events e WHERE e.tenant_id=f.tenant_id AND e.forecast_item_id=f.id AND e.id LIKE 'rcp:%')`,
    batchId, b.window_start, b.window_end,
  )!.s as number;
}

/** What the fixture says those subscriptions would have been charged inside the window. */
function fixtureCharges(ids: string[]) {
  const w = BULK.forecastWindow;
  return ids.map((id) => RECORD.get(id)).filter((r) => Date.parse(r.nextChargeAt) >= Date.parse(w.startInclusive) && Date.parse(r.nextChargeAt) < Date.parse(w.endExclusive)).reduce((s, r) => s + r.nextChargeMinor, 0);
}

const ledgerCount = (t: string) => stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=?", t)!.n as number;
const mutations = (t: string, contractId: string) => stack.mq<any>("SELECT * FROM m_requests WHERE tenant_id=? AND contract_id=? AND operation='STOP_RENEWAL'", t, contractId);

/** Samples leased jobs while the batch runs: per-key serialization and lane limits across both worker processes. */
function startSampler() {
  const s = { samples: 0, maxPerKey: 0, maxApiPerUser: 0, maxBrowserPerUser: 0, maxApiGlobal: 0, maxBrowserGlobal: 0, owners: new Set<string>(), keyClash: [] as string[] };
  const timer = setInterval(() => {
    let rows: any[];
    try {
      rows = stack.q<any>("SELECT kind, route, concurrency_key, user_key, lease_owner FROM jobs WHERE status='LEASED' AND lease_expires_at > ? AND kind IN ('ACTION','RECONCILE')", new Date().toISOString());
    } catch {
      return; // a busy read is skipped, never treated as a sample
    }
    s.samples++;
    const perKey = new Map<string, number>();
    const perUser = new Map<string, number>();
    const perLane = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of rows) {
      if (r.lease_owner) s.owners.add(r.lease_owner);
      const lane = r.route === "ISOLATED_BROWSER" ? "BROWSER" : "API";
      if (r.concurrency_key) bump(perKey, r.concurrency_key);
      bump(perUser, `${lane}|${r.user_key}`);
      bump(perLane, lane);
    }
    for (const [k, n] of perKey) if (n > 1) s.keyClash.push(k);
    s.maxPerKey = Math.max(s.maxPerKey, ...perKey.values(), 0);
    for (const [k, n] of perUser) {
      if (k.startsWith("API|")) s.maxApiPerUser = Math.max(s.maxApiPerUser, n);
      else s.maxBrowserPerUser = Math.max(s.maxBrowserPerUser, n);
    }
    s.maxApiGlobal = Math.max(s.maxApiGlobal, perLane.get("API") ?? 0);
    s.maxBrowserGlobal = Math.max(s.maxBrowserGlobal, perLane.get("BROWSER") ?? 0);
  }, 20);
  return { s, stop: () => clearInterval(timer) };
}

async function reviewReady(api: Api, batchId: string) {
  return waitFor(async () => {
    const s = await api.json(`/api/batches/${batchId}`);
    return s.status === "REVIEW" && s.proposalId ? s : null;
  }, { timeout: 90_000, interval: 250, label: `batch ${batchId} review`, onTimeout: () => stack.workerLogs() });
}

beforeAll(async () => {
  stack = await startStack();
  workers = [await stack.worker(), await stack.worker()];
  A = await stack.login("alex");
  B = await stack.login("alex");
  ctxA = stack.q1<any>("SELECT active_context_id FROM sessions WHERE csrf_token=?", A.csrf)!.active_context_id;
}, 120_000);

afterAll(async () => {
  await stack?.teardown();
});

describe("200-item batch: two workers, a second tenant at the same time", () => {
  it("10. inspection classifies all 200 from provider reads; excluded items are not in the proposal and cannot be approved", async () => {
    fundsBefore = funds(stack, A.tenantId, ctxA);
    ledgerBefore = ledgerCount(A.tenantId);
    expect(fundsBefore).toBe(EXPECTED.balanceBeforeMinor);

    batchA = (await A.ok("/api/batches")).batchId;
    batchB = (await B.ok("/api/batches")).batchId;
    const [sa] = await Promise.all([reviewReady(A, batchA), reviewReady(B, batchB)]);

    const rows = items(batchA);
    expect(rows).toHaveLength(EXPECTED.inventoryCount);
    expect(countBy(rows, "review_status")).toEqual(EXPECTED.reviewCounts);
    for (const r of rows) expect([local(r.subscription_id), r.review_status]).toEqual([local(r.subscription_id), RECORD.get(local(r.subscription_id)).inspectionStatus]);

    const proposal = stack.q1<any>("SELECT * FROM proposals WHERE id=?", sa.proposalId)!;
    expect(proposal).toMatchObject({ status: "READY", scope: "BATCH", digest: sa.proposalDigest });
    const actions = stack.q<any>("SELECT id, subject_ref, route FROM proposal_actions WHERE proposal_id=?", proposal.id);
    expect(actions).toHaveLength(EXPECTED.approvedCount);
    expect(new Set(actions.map((x) => local(x.subject_ref)))).toEqual(new Set(READY.map((r) => r.id)));
    expect(JSON.parse(proposal.manifest_json).actions).toHaveLength(EXPECTED.approvedCount);

    const excluded = rows.filter((r) => r.review_status !== "READY");
    expect(excluded).toHaveLength(EXPECTED.excludedCount);
    for (const r of excluded) {
      expect([local(r.subscription_id), r.selected, r.action_id]).toEqual([local(r.subscription_id), 0, null]);
      expect(proposal.manifest_json.includes(r.subscription_id)).toBe(false);
    }
    const guarded = excluded.filter((r) => r.review_status === "PROTECTED_OR_SHARED" || r.review_status === "FIXED_COMMITMENT");
    expect(guarded).toHaveLength(EXPECTED.reviewCounts.PROTECTED_OR_SHARED + EXPECTED.reviewCounts.FIXED_COMMITMENT);

    // Sending ids for protected / fixed-commitment items (their batch item ids, subscription ids, or alone) is refused.
    const readyIds = rows.filter((r) => r.review_status === "READY").map((r) => r.action_id);
    for (const actionIds of [[...readyIds, ...guarded.map((g) => g.id)], [...readyIds, ...guarded.map((g) => g.subscription_id)], guarded.map((g) => g.id), [readyIds[0], guarded[0].id]]) {
      const r = await A.post(`/api/batches/${batchA}/approve`, { digest: sa.proposalDigest, actionIds });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("BAD_SELECTION");
    }
    const single = await A.post(`/api/proposals/${proposal.id}/approve`, { digest: proposal.digest, actionIds: readyIds });
    expect(single.status).toBe(409);
    expect(single.json.error).toBe("USE_BATCH");

    expect(stack.q("SELECT id FROM mandates WHERE proposal_id=?", proposal.id)).toHaveLength(0);
    expect(stack.q("SELECT g.id FROM grants g JOIN proposal_actions pa ON pa.id=g.action_id WHERE pa.proposal_id=?", proposal.id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM jobs WHERE kind='ACTION' AND tenant_id=?", A.tenantId)).toHaveLength(0);
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", proposal.id)!.status).toBe("READY");
    expect(stack.q1<any>("SELECT status FROM batches WHERE id=?", batchA)!.status).toBe("REVIEW");
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", A.tenantId)).toHaveLength(0);
  }, 150_000);

  it("12 + 14. all 120 READY approved with the returned digest; two workers reach NEEDS_ATTENTION with the expected persisted totals", async () => {
    const sa = await A.json(`/api/batches/${batchA}`);
    const sb = await B.json(`/api/batches/${batchB}`);
    const readyA = sa.items.filter((i: any) => i.reviewStatus === "READY").map((i: any) => i.actionId);
    const readyB = sb.items.filter((i: any) => i.reviewStatus === "READY" && B_ITEMS.includes(local(i.subscriptionId))).map((i: any) => i.actionId);
    expect(readyA).toHaveLength(120);
    expect(readyB).toHaveLength(5);

    const sampler = startSampler();
    const started = Date.now();
    const [ra, rb] = await Promise.all([
      A.post(`/api/batches/${batchA}/approve`, { digest: sa.proposalDigest, actionIds: readyA }),
      B.post(`/api/batches/${batchB}/approve`, { digest: sb.proposalDigest, actionIds: readyB }),
    ]);
    expect([ra.status, ra.json.grants, ra.json.alreadyApproved]).toEqual([200, 120, false]);
    expect([rb.status, rb.json.grants]).toEqual([200, 5]);
    const progress = () => JSON.stringify(countBy(stack.q<any>("SELECT outcome FROM batch_items WHERE batch_id=? AND selected=1", batchA), "outcome"));
    try {
      await waitFor(() => stack.q1<any>("SELECT status FROM batches WHERE id=?", batchA)!.status === "NEEDS_ATTENTION", { timeout: 200_000, interval: 250, label: "batch A NEEDS_ATTENTION", onTimeout: () => `${progress()}\n${stack.workerLogs()}` });
      await waitFor(() => stack.q1<any>("SELECT status FROM batches WHERE id=?", batchB)!.status === "COMPLETED", { timeout: 60_000, label: "batch B COMPLETED" });
    } finally {
      sampler.stop();
    }
    const runSeconds = (Date.now() - started) / 1000;

    /* ---- 12: totals from persisted batch_items, cross-checked item by item against actions, attempts, receipts */
    const rows = items(batchA);
    const approved = rows.filter((r) => r.selected === 1 && r.action_id);
    expect(approved).toHaveLength(EXPECTED.approvedCount);
    expect(countBy(approved, "route")).toEqual(EXPECTED.approvedRoutes);
    expect(countBy(approved, "outcome")).toEqual(EXPECTED.approvedOutcomes);
    const mandateA = stack.q1<any>("SELECT * FROM mandates WHERE proposal_id=?", sa.proposalId)!;
    expect(mandateA).toMatchObject({ status: "ACTIVE", scope: "BATCH", revocation_epoch: 0 });

    for (const r of approved) {
      const sub = local(r.subscription_id);
      const rec = RECORD.get(sub);
      const want = BEHIND[rec.expectedOutcomeAfterFirstPass];
      expect([sub, r.outcome, r.route]).toEqual([sub, rec.expectedOutcomeAfterFirstPass, rec.expectedRoute]);
      expect([sub, stack.action(r.action_id).status]).toEqual([sub, want.action]);
      const atts = stack.attempts(r.action_id);
      expect([sub, atts.length, atts[0]?.status]).toEqual([sub, 1, want.attempt]);
      const att = atts[0];
      const journal = stack.q<any>("SELECT * FROM dispatch_journal WHERE attempt_id=?", att.id);
      expect([sub, journal.length, Boolean(att.dispatched_at)]).toEqual([sub, want.dispatched ? 1 : 0, want.dispatched]);
      const grant = stack.q1<any>("SELECT * FROM grants WHERE action_id=?", r.action_id)!;
      expect(grant.mandate_id).toBe(mandateA.id);
      if (want.dispatched) expect([sub, grant.status, grant.consumed_by_attempt, journal[0].grant_id]).toEqual([sub, "CONSUMED", att.id, grant.id]);
      else expect([sub, grant.status === "CONSUMED", grant.consumed_by_attempt]).toEqual([sub, false, null]);
      if (rec.expectedOutcomeAfterFirstPass === "TERMS_CHANGED") expect(grant.status).toBe("INVALIDATED");

      const reqs = mutations(A.tenantId, r.contract_id);
      if (want.merchant) {
        expect([sub, reqs.length, reqs[0].status, reqs[0].correlation_id, reqs[0].channel]).toEqual([sub, 1, want.merchant, att.correlation_id, r.route === "ISOLATED_BROWSER" ? "WEB" : "API"]);
      } else {
        expect([sub, reqs.length]).toEqual([sub, 0]);
      }
      const receipts = stack.q<any>("SELECT * FROM receipts WHERE action_id=?", r.action_id);
      if (r.outcome === "CONFIRMED") {
        expect([sub, receipts.length, r.receipt_id]).toEqual([sub, 1, receipts[0].id]);
        expect(receipts[0]).toMatchObject({ tenant_id: A.tenantId, context_id: ctxA, attempt_id: att.id, issuer: r.merchant_id, issuer_reference: reqs[0].receipt_ref, operation: "STOP_RENEWAL" });
        expect([sub, r.sub_state]).toEqual([sub, "RENEWAL_OFF"]);
        const fc = stack.q<any>("SELECT id, status FROM forecast_items WHERE subscription_id=?", r.subscription_id);
        expect(fc.map((f) => f.status)).toEqual(["REMOVED"]);
        expect(stack.q("SELECT id FROM forecast_events WHERE tenant_id=? AND forecast_item_id=?", A.tenantId, fc[0].id)).toHaveLength(1);
        expect(stack.mq1<any>("SELECT auto_renew FROM m_contracts WHERE tenant_id=? AND id=?", A.tenantId, r.contract_id)!.auto_renew).toBe(0);
      } else {
        expect([sub, receipts.length, r.receipt_id]).toEqual([sub, 0, null]);
        expect([sub, r.sub_state]).toEqual([sub, "ACTIVE"]);
        expect(stack.q<any>("SELECT status FROM forecast_items WHERE subscription_id=?", r.subscription_id).map((f) => f.status)).toEqual(["SCHEDULED"]);
      }
    }
    // Items outside the approval: never touched at the provider, renewal still on, forecast still scheduled.
    for (const r of rows.filter((x) => x.review_status !== "READY")) {
      expect([local(r.subscription_id), r.selected, r.action_id, r.outcome, r.receipt_id]).toEqual([local(r.subscription_id), 0, null, null, null]);
      expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND contract_id=?", A.tenantId, r.contract_id)).toHaveLength(0);
    }
    for (const r of rows.filter((x) => x.review_status === "PROTECTED_OR_SHARED" || x.review_status === "FIXED_COMMITMENT")) {
      expect(stack.mq1<any>("SELECT auto_renew FROM m_contracts WHERE tenant_id=? AND id=?", A.tenantId, r.contract_id)!.auto_renew).toBe(1);
    }

    // Avoided future charges: persisted forecast removals caused by verified receipts, inside the window.
    const avoided = avoidedMinor(batchA);
    expect(avoided).toBe(EXPECTED.confirmedAvoidedFutureChargesMinor);
    expect(avoided).toBe(fixtureCharges(idsWith("CONFIRMED")));
    // Cash: nothing moved. Funds before and after, and not one ledger posting for this tenant.
    expect(funds(stack, A.tenantId, ctxA)).toBe(EXPECTED.balanceAfterMinor);
    expect(fundsBefore).toBe(EXPECTED.balanceBeforeMinor);
    expect(ledgerCount(A.tenantId)).toBe(ledgerBefore);

    // The API summary the screen renders agrees with the persisted rows.
    const summary = await A.json(`/api/batches/${batchA}`);
    expect(summary).toMatchObject({
      status: EXPECTED.batchStatus,
      inventory: EXPECTED.inventoryCount,
      reviewCounts: EXPECTED.reviewCounts,
      approvedCount: EXPECTED.approvedCount,
      excludedCount: EXPECTED.excludedCount,
      approvedRoutes: EXPECTED.approvedRoutes,
      outcomes: EXPECTED.approvedOutcomes,
      avoidedFutureChargesMinor: EXPECTED.confirmedAvoidedFutureChargesMinor,
      fundsBeforeMinor: EXPECTED.balanceBeforeMinor,
      fundsNowMinor: EXPECTED.balanceAfterMinor,
      cashRefundedMinor: EXPECTED.cashRefundedMinor,
    });

    /* ---- tenant B ran at the same time: five confirmed, the rest never selected */
    const rowsB = items(batchB);
    expect(countBy(rowsB.filter((r) => r.selected === 1), "outcome")).toEqual({ CONFIRMED: 5 });
    expect(rowsB.filter((r) => r.selected === 1).map((r) => local(r.subscription_id)).sort()).toEqual(B_ITEMS);
    expect(countBy(rowsB.filter((r) => r.action_id && r.selected === 0), "outcome")).toEqual({ NOT_SELECTED: 115 });
    expect(stack.q("SELECT a.id FROM attempts a WHERE a.tenant_id=?", B.tenantId)).toHaveLength(5);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", B.tenantId)).toHaveLength(5);
    const propB = stack.q1<any>("SELECT proposal_id FROM batches WHERE id=?", batchB)!.proposal_id;
    expect(stack.q("SELECT id FROM proposal_actions WHERE proposal_id=? AND status='NOT_STARTED'", propB)).toHaveLength(115);
    expect(stack.q("SELECT g.id FROM grants g JOIN mandates m ON m.id=g.mandate_id WHERE m.proposal_id=?", propB)).toHaveLength(5);

    /* ---- 14: every grant consumed at most once; no action reached the merchant twice */
    const tenants = [A.tenantId, B.tenantId];
    expect(stack.q("SELECT grant_id FROM dispatch_journal GROUP BY grant_id HAVING COUNT(*) > 1")).toEqual([]);
    expect(stack.q("SELECT action_id FROM attempts WHERE dispatched_at IS NOT NULL GROUP BY action_id HAVING COUNT(*) > 1")).toEqual([]);
    expect(stack.q("SELECT action_id FROM attempts GROUP BY action_id HAVING COUNT(*) > 1")).toEqual([]);
    const consumed = stack.q<any>("SELECT g.id, g.consumed_by_attempt, j.attempt_id, j.epoch FROM grants g LEFT JOIN dispatch_journal j ON j.grant_id=g.id WHERE g.tenant_id IN (?,?) AND g.status='CONSUMED'", ...tenants);
    expect(consumed).toHaveLength(EXPECTED.approvedOutcomes.CONFIRMED + EXPECTED.approvedOutcomes.WAITING_EXTERNAL + EXPECTED.approvedOutcomes.OUTCOME_UNKNOWN + 5);
    for (const g of consumed) expect([g.attempt_id, g.epoch]).toEqual([g.consumed_by_attempt, 0]);
    expect(stack.q("SELECT j.attempt_id FROM dispatch_journal j JOIN grants g ON g.id=j.grant_id WHERE g.tenant_id IN (?,?) AND g.status != 'CONSUMED'", ...tenants)).toEqual([]);
    for (const t of tenants) {
      // Per merchant account at most one mutation reached the provider, and each belongs to a bank attempt of the same tenant.
      expect(stack.mq("SELECT merchant_id, account_id FROM m_requests WHERE tenant_id=? GROUP BY merchant_id, account_id HAVING COUNT(*) > 1", t)).toEqual([]);
      for (const m of stack.mq<any>("SELECT correlation_id FROM m_requests WHERE tenant_id=?", t)) {
        expect(stack.q1<any>("SELECT tenant_id FROM attempts WHERE correlation_id=?", m.correlation_id)?.tenant_id).toBe(t);
      }
    }
    // Mutations on one merchant account never overlapped: attempt windows per job concurrency key are disjoint.
    // (Keys are tenant-scoped and every bulk item is its own account; test 14b below forces real contention.)
    const windows = stack.q<any>(
      "SELECT j.concurrency_key k, a.started_at s, a.finished_at f, a.tenant_id t FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.tenant_id IN (?,?) AND j.kind='ACTION' AND a.finished_at IS NOT NULL ORDER BY j.concurrency_key, a.started_at",
      ...tenants,
    );
    let shared = 0;
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].k !== windows[i - 1].k) continue;
      shared++;
      expect(Date.parse(windows[i - 1].f)).toBeLessThanOrEqual(Date.parse(windows[i].s));
    }
    expect(sampler.s.samples).toBeGreaterThan(20);
    expect(sampler.s.keyClash).toEqual([]);
    expect(sampler.s.maxPerKey).toBeLessThanOrEqual(1);
    expect(sampler.s.maxApiPerUser).toBeLessThanOrEqual(4);
    expect(sampler.s.maxBrowserPerUser).toBeLessThanOrEqual(2);
    expect(sampler.s.maxApiGlobal).toBeLessThanOrEqual(8);
    expect(sampler.s.maxBrowserGlobal).toBeLessThanOrEqual(4);
    expect(sampler.s.maxApiGlobal).toBeGreaterThan(1); // the run really was concurrent
    // Both worker processes leased jobs from the same queue.
    for (const w of workers) expect([...sampler.s.owners].some((o) => o.startsWith(`w-${w.pid}-`))).toBe(true);
    expect(workers.every((w) => w.running)).toBe(true);

    /* ---- no receipt is linked across tenants, even though both merchant worlds issue the same references */
    const receipts = stack.q<any>("SELECT r.*, pa.tenant_id AS action_tenant, pa.context_id AS action_context, a.correlation_id FROM receipts r JOIN proposal_actions pa ON pa.id=r.action_id JOIN attempts a ON a.id=r.attempt_id WHERE r.tenant_id IN (?,?)", ...tenants);
    expect(receipts).toHaveLength(EXPECTED.approvedOutcomes.CONFIRMED + 5);
    for (const r of receipts) {
      expect([r.action_tenant, r.action_context]).toEqual([r.tenant_id, r.context_id]);
      const m = stack.mq1<any>("SELECT tenant_id, correlation_id, merchant_id FROM m_receipts WHERE tenant_id=? AND ref=?", r.tenant_id, r.issuer_reference)!;
      expect([m.correlation_id, m.merchant_id]).toEqual([r.correlation_id, r.issuer]);
    }
    for (const l of stack.q<any>("SELECT bi.tenant_id, bi.action_id, r.tenant_id AS rt, r.action_id AS ra FROM batch_items bi JOIN receipts r ON r.id=bi.receipt_id WHERE bi.batch_id IN (?,?)", batchA, batchB)) {
      expect([l.rt, l.ra]).toEqual([l.tenant_id, l.action_id]);
    }
    const collisions = stack.q<any>("SELECT ra.id a_id, rb.id b_id FROM receipts ra JOIN receipts rb ON rb.issuer=ra.issuer AND rb.issuer_reference=ra.issuer_reference WHERE ra.tenant_id=? AND rb.tenant_id=?", A.tenantId, B.tenantId);
    expect(collisions.length).toBeGreaterThanOrEqual(1);
    for (const c of collisions) expect(c.a_id).not.toBe(c.b_id);

    process.stdout.write(
      `[bulk] 125 items in ${runSeconds.toFixed(1)} s with 2 workers; sampled ${sampler.s.samples}x: max per key ${sampler.s.maxPerKey}, API per user ${sampler.s.maxApiPerUser}, browser per user ${sampler.s.maxBrowserPerUser}, API global ${sampler.s.maxApiGlobal}, browser global ${sampler.s.maxBrowserGlobal}; ${shared} shared-key pairs serialized; ${collisions.length} receipt references repeated across tenants\n`,
    );
  }, 300_000);

  it("14b. two approved changes on the same merchant account are serialized across the two workers", async () => {
    const c = await stack.login("alex");
    // Both target the StudyPlus account: switch to annual billing (A3) and the student verification (T3).
    const annual = await stack.propose(c, "A3", ["annual"], { horizonMonths: 24 });
    const verify = await stack.propose(c, "T3", ["verify-student"], { studentIdNumber: "S123456789012" });
    const ids = [annual.actions[0].id, verify.actions[0].id];
    const sampler = startSampler();
    try {
      // Back to back, so both jobs are queued before either worker's next claim.
      await Promise.all([stack.approve(c, annual), stack.approve(c, verify)]);
      for (const id of ids) await stack.waitAction(id, ["CONFIRMED"], 60_000);
    } finally {
      sampler.stop();
    }
    const jobs = stack.q<any>("SELECT id, ref_id, concurrency_key FROM jobs WHERE kind='ACTION' AND ref_id IN (?,?)", ...ids);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].concurrency_key).toBeTruthy();
    expect(jobs[0].concurrency_key).toBe(jobs[1].concurrency_key); // same merchant account
    const [first, second] = ids.map((id) => stack.attempts(id)).map((a) => {
      expect(a).toHaveLength(1);
      return a[0];
    }).sort((x, y) => Date.parse(x.started_at) - Date.parse(y.started_at));
    // The second change started only after the first one finished, whichever worker ran it.
    expect(Date.parse(first.finished_at)).toBeLessThanOrEqual(Date.parse(second.started_at));
    expect(sampler.s.keyClash).toEqual([]);
    const reqs = stack.mq<any>("SELECT operation, status FROM m_requests WHERE tenant_id=? ORDER BY created_at", c.tenantId);
    expect(reqs.map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(new Set(reqs.map((r) => r.operation))).toEqual(new Set(["CHANGE_BILLING_PERIOD", "VERIFY_ELIGIBILITY"]));
  }, 90_000);

  it("8. response lost after the provider committed: OUTCOME_UNKNOWN, one request, never retried; reconciled after the 6 h read lag", async () => {
    const unknown = items(batchA).filter((r) => idsWith("OUTCOME_UNKNOWN").includes(local(r.subscription_id)));
    expect(unknown).toHaveLength(3);
    const seen = new Map<string, { att: any; req: any }>();
    for (const r of unknown) {
      const sub = local(r.subscription_id);
      expect([sub, r.route, r.outcome, stack.action(r.action_id).status]).toEqual([sub, "ISOLATED_BROWSER", "OUTCOME_UNKNOWN", "UNKNOWN"]);
      const atts = stack.attempts(r.action_id);
      expect([sub, atts.length, atts[0].status, Boolean(atts[0].dispatched_at)]).toEqual([sub, 1, "UNKNOWN", true]);
      const reqs = stack.mq<any>("SELECT * FROM m_requests WHERE tenant_id=? AND correlation_id=?", A.tenantId, atts[0].correlation_id);
      // The provider committed the change; only the answer was lost.
      expect([sub, reqs.length, reqs[0].channel, reqs[0].status, reqs[0].contract_id]).toEqual([sub, 1, "WEB", "CONFIRMED", r.contract_id]);
      expect(mutations(A.tenantId, r.contract_id)).toHaveLength(1);
      expect(stack.q("SELECT id FROM receipts WHERE action_id=?", r.action_id)).toHaveLength(0);
      expect(stack.q<any>("SELECT status FROM forecast_items WHERE subscription_id=?", r.subscription_id).map((f) => f.status)).toEqual(["SCHEDULED"]);
      seen.set(r.action_id, { att: atts[0], req: reqs[0] });
    }

    const demoNow = await stack.clock(A, 365); // past the provider's 6 h read lag
    expect(demoNow).toBeTruthy();
    for (const r of unknown) await stack.waitAction(r.action_id, ["CONFIRMED"], 60_000);

    for (const r of unknown) {
      const sub = local(r.subscription_id);
      const { att, req } = seen.get(r.action_id)!;
      const atts = stack.attempts(r.action_id);
      expect([sub, atts.length, atts[0].id, atts[0].status]).toEqual([sub, 1, att.id, "CONFIRMED"]);
      expect(atts[0].reconcile_checks).toBeGreaterThanOrEqual(1);
      expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND correlation_id=?", A.tenantId, att.correlation_id)).toHaveLength(1);
      expect(mutations(A.tenantId, r.contract_id)).toHaveLength(1);
      expect(stack.q("SELECT attempt_id FROM dispatch_journal WHERE attempt_id=?", att.id)).toHaveLength(1);
      const rc = stack.q<any>("SELECT * FROM receipts WHERE action_id=?", r.action_id);
      expect([sub, rc.length]).toEqual([sub, 1]);
      expect(rc[0]).toMatchObject({ tenant_id: A.tenantId, attempt_id: att.id, issuer: r.merchant_id, issuer_reference: req.receipt_ref });
      expect(JSON.parse(rc[0].verification_json).channel).toBe("WEB");
      expect(stack.q1<any>("SELECT outcome, receipt_id FROM batch_items WHERE id=?", r.id)).toEqual({ outcome: "CONFIRMED", receipt_id: rc[0].id });
      expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", r.subscription_id)!.state).toBe("RENEWAL_OFF");
      const fc = stack.q<any>("SELECT id, status FROM forecast_items WHERE subscription_id=?", r.subscription_id);
      expect(fc.map((f) => f.status)).toEqual(["REMOVED"]);
      expect(stack.q("SELECT id FROM forecast_events WHERE tenant_id=? AND forecast_item_id=?", A.tenantId, fc[0].id)).toHaveLength(1);
    }
    expect(avoidedMinor(batchA)).toBe(fixtureCharges([...idsWith("CONFIRMED"), ...idsWith("OUTCOME_UNKNOWN")]));
    expect(funds(stack, A.tenantId, ctxA)).toBe(EXPECTED.balanceAfterMinor);
    expect(ledgerCount(A.tenantId)).toBe(ledgerBefore);
  }, 120_000);

  it("9. manual-review items wait at the provider until 48 h (re-checked, never resubmitted), then confirm", async () => {
    const waiting = items(batchA).filter((r) => idsWith("WAITING_EXTERNAL").includes(local(r.subscription_id)));
    expect(waiting).toHaveLength(8);
    expect(countBy(waiting, "route")).toEqual({ PARTNER_API: 5, ISOLATED_BROWSER: 3 });
    const attempt = (r: any) => stack.attempts(r.action_id)[0];
    const checks = new Map<string, number>();
    const assertStillWaiting = () => {
      for (const r of waiting) {
        const sub = local(r.subscription_id);
        const att = attempt(r);
        expect([sub, stack.q1<any>("SELECT outcome FROM batch_items WHERE id=?", r.id)!.outcome, stack.action(r.action_id).status, att.status]).toEqual([sub, "WAITING_EXTERNAL", "PENDING", "PENDING"]);
        expect(stack.attempts(r.action_id)).toHaveLength(1);
        const reqs = stack.mq<any>("SELECT * FROM m_requests WHERE tenant_id=? AND correlation_id=?", A.tenantId, att.correlation_id);
        expect([sub, reqs.length, reqs[0].status, reqs[0].channel]).toEqual([sub, 1, "PENDING_REVIEW", r.route === "ISOLATED_BROWSER" ? "WEB" : "API"]);
        expect(mutations(A.tenantId, r.contract_id)).toHaveLength(1);
        expect(stack.q("SELECT id FROM receipts WHERE action_id=?", r.action_id)).toHaveLength(0);
      }
    };
    assertStillWaiting();
    for (const r of waiting) checks.set(r.action_id, attempt(r).reconcile_checks);

    // About 46 h after the requests (the clock is already 6 h 05 m ahead): the 12-hourly re-check reads the
    // provider, which is still reviewing; nothing is resubmitted.
    await stack.clock(A, 2400);
    await waitFor(() => waiting.every((r) => {
      const a = attempt(r);
      return a.reconcile_checks > checks.get(r.action_id)! && a.next_reconcile_at;
    }), { timeout: 60_000, label: "12-hourly provider re-checks", onTimeout: () => stack.workerLogs() });
    assertStillWaiting();

    await stack.clock(A, 120); // past 48 h: the provider resolves its reviews and notifies the bank
    for (const r of waiting) await stack.waitAction(r.action_id, ["CONFIRMED"], 60_000);
    for (const r of waiting) {
      const sub = local(r.subscription_id);
      const atts = stack.attempts(r.action_id);
      expect([sub, atts.length, atts[0].status]).toEqual([sub, 1, "CONFIRMED"]);
      const reqs = stack.mq<any>("SELECT * FROM m_requests WHERE tenant_id=? AND correlation_id=?", A.tenantId, atts[0].correlation_id);
      expect([sub, reqs.length, reqs[0].status, Boolean(reqs[0].resolved_at)]).toEqual([sub, 1, "CONFIRMED", true]);
      expect(Date.parse(reqs[0].resolve_at) - Date.parse(reqs[0].created_at)).toBe(48 * 3_600_000);
      expect(mutations(A.tenantId, r.contract_id)).toHaveLength(1);
      const rc = stack.q<any>("SELECT * FROM receipts WHERE action_id=?", r.action_id);
      expect([sub, rc.length, rc[0]?.issuer_reference, rc[0]?.tenant_id]).toEqual([sub, 1, reqs[0].receipt_ref, A.tenantId]);
      expect(stack.q1<any>("SELECT outcome, receipt_id FROM batch_items WHERE id=?", r.id)).toEqual({ outcome: "CONFIRMED", receipt_id: rc[0].id });
      expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", r.subscription_id)!.state).toBe("RENEWAL_OFF");
    }

    // Final state: the 5 sign-ins and 4 changed terms still need the customer; everything else is confirmed once.
    const approved = items(batchA).filter((r) => r.selected === 1);
    expect(countBy(approved, "outcome")).toEqual({ CONFIRMED: 111, NEEDS_AUTH: 5, TERMS_CHANGED: 4 });
    expect(stack.q1<any>("SELECT status FROM batches WHERE id=?", batchA)!.status).toBe("NEEDS_ATTENTION");
    expect(stack.q<any>("SELECT id FROM receipts WHERE tenant_id=?", A.tenantId)).toHaveLength(111);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", A.tenantId)).toHaveLength(111);
    expect(stack.q("SELECT action_id FROM attempts WHERE tenant_id=? GROUP BY action_id HAVING COUNT(*) > 1", A.tenantId)).toEqual([]);
    expect(avoidedMinor(batchA)).toBe(fixtureCharges([...idsWith("CONFIRMED"), ...idsWith("OUTCOME_UNKNOWN"), ...idsWith("WAITING_EXTERNAL")]));
    expect(funds(stack, A.tenantId, ctxA)).toBe(EXPECTED.balanceAfterMinor);
    expect(ledgerCount(A.tenantId)).toBe(ledgerBefore);
  }, 180_000);
});
