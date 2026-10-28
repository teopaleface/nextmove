import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { shortId } from "../canonical";
import { nowIso } from "../clock";
import { HttpError, type Session } from "../auth/session";
import { createProposal, approveProposal, revokeMandate } from "../authority/authority";
import { addForecastItem } from "../bank/forecast";
import { accountsFor } from "../bank/ledger";
import { MerchantClient } from "../merchant-client";
import { enqueueJob, finishJob, renewLease, type Job } from "../execution/jobs";
import { taskEvent, setBlock, setTaskState } from "../agent/events";
import { refreshBatchStatus } from "../execution/effects";
import { canonicalKey } from "../../shared/ids";
import { inWindow } from "../../shared/time";
import { directory, display, fixture, fmtWhen, money, spec } from "./core";
import { currentRevisionLookup } from "./registry";
import type { WorkerCtx } from "../execution/executor";

// The independent 200-subscription scenario. The bank only knows recurring card payments at first; durable
// inspection reads each provider (or finds there is no connector), classifies it from what the provider returns,
// and proposes a fixed, inspectable list. Expected counters in the fixture are never read here.

export const BULK_WINDOW = () => {
  const f = fixture("demo/bulk-cancellations.json").forecastWindow;
  return { startInclusive: f.startInclusive as string, endExclusive: f.endExclusive as string };
};

export function startBulkReview(db: DatabaseSync, session: Session) {
  return tx(db, () => {
    const existing = one<any>(db, "SELECT * FROM batches WHERE tenant_id=? AND context_id=? AND status NOT IN ('COMPLETED','STOPPED') ORDER BY created_at DESC LIMIT 1", session.tenantId, session.contextId);
    if (existing) return { batchId: existing.id, taskId: existing.task_id, existing: true };
    const count = one<any>(db, "SELECT COUNT(*) n FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='bulk'", session.tenantId, session.contextId)?.n ?? 0;
    if (!count) throw new HttpError(404, "NOT_FOUND", "No recurring payments to review in this context");
    const now = new Date().toISOString();
    const taskId = shortId("task");
    const batchId = shortId("bat");
    run(db, "INSERT INTO tasks(id, tenant_id, context_id, user_id, kind, title, state, subject_ref, planner_mode, request_text, created_at, updated_at) VALUES (?,?,?,?, 'BATCH', ?, 'RUNNING', ?, 'DETERMINISTIC', ?, ?, ?)", taskId, session.tenantId, session.contextId, session.userId, `Review ${count} recurring payments`, batchId, "Review all recurring payments and stop the ones I no longer need", now, now);
    const w = BULK_WINDOW();
    run(db, "INSERT INTO batches(id, tenant_id, context_id, task_id, status, window_start, window_end, created_at, updated_at) VALUES (?,?,?,?, 'INSPECTING', ?, ?, ?, ?)", batchId, session.tenantId, session.contextId, taskId, w.startInclusive, w.endExclusive, now, now);
    run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES (?,?,?)", `batch:${batchId}:funds`, JSON.stringify({ before: accountsFor(db, session.tenantId, session.contextId).reduce((s, a) => s + a.balanceMinor, 0) }), now);
    enqueueJob(db, { tenantId: session.tenantId, kind: "INSPECT_BATCH", refId: batchId, route: null, priority: 4, userKey: `${session.tenantId}|${session.userId}` });
    taskEvent(db, { taskId, tenantId: session.tenantId, kind: "start", label: `Inspecting ${count} recurring payments with each provider`, evidence: "BANK_RECORD" });
    return { batchId, taskId, existing: false };
  });
}

type Review = { status: "READY" | "ALREADY_OFF" | "NEEDS_AUTH" | "FIXED_COMMITMENT" | "PROTECTED_OR_SHARED" | "UNSUPPORTED"; detail: Record<string, unknown>; route: string | null };

export async function runInspectBatchJob(db: DatabaseSync, job: Job, ctx: WorkerCtx) {
  const batch = one<any>(db, "SELECT * FROM batches WHERE id=?", job.ref_id);
  if (!batch || batch.status !== "INSPECTING") return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  const t = batch.tenant_id;
  const dir = directory(db, t);
  const subs = all<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='bulk' ORDER BY id", t, batch.context_id);
  const done = new Set(all<any>(db, "SELECT subscription_id FROM batch_items WHERE batch_id=?", batch.id).map((r) => r.subscription_id));
  const client = new MerchantClient(db, t);
  const keepAlive = setInterval(() => renewLease(db, job, ctx.workerId), 5_000);
  const w = BULK_WINDOW();
  let processed = done.size;
  const queue = subs.filter((s) => !done.has(s.id));
  const inspectOne = async (s: any) => {
    const d = dir.find((x) => x.id === s.merchant_id);
    let review: Review;
    let contract: any = null;
    if (!d || d.connector === "NONE" || !d.readApi) {
      review = { status: "UNSUPPORTED", detail: { reason: "No partner connector or supported web procedure", manualRoute: d?.manualRoute ?? null, merchantName: d?.name ?? s.merchant_name }, route: null };
    } else {
      const r = await client.listContracts(s.merchant_id, s.subscriber_account_id).catch((e) => ({ status: 0, error: String(e?.message ?? e) }) as any);
      if (r.status === 401) review = { status: "NEEDS_AUTH", detail: { reason: "The provider session expired; the account holder must sign in on the provider's page", merchantName: d.name }, route: d.connector };
      else if (r.status !== 200 || !r.contracts?.length) review = { status: "UNSUPPORTED", detail: { reason: `Provider read failed (${r.status})`, merchantName: d.name }, route: null };
      else {
        contract = r.contracts[0];
        const minTerm = contract.minimumTermUntil && Date.parse(contract.minimumTermUntil) > Date.parse(nowIso(db, t));
        if (!contract.autoRenew) review = { status: "ALREADY_OFF", detail: { accessUntil: contract.accessUntil, merchantName: d.name }, route: d.connector };
        else if (contract.ownerKind !== "SELF" || contract.shared) review = { status: "PROTECTED_OR_SHARED", detail: { reason: contract.protectedReason ?? "Shared or managed by someone else", merchantName: d.name }, route: d.connector };
        else if (minTerm && (contract.exitFeeMinor == null || contract.exitFeeMinor > 0)) review = { status: "FIXED_COMMITMENT", detail: { minimumTermUntil: contract.minimumTermUntil, exitFeeMinor: contract.exitFeeMinor, reason: contract.exitFeeMinor == null ? "Minimum term; exit fee unknown" : "Minimum term with an exit fee", merchantName: d.name }, route: d.connector };
        else if (!d.operations.includes("STOP_RENEWAL")) review = { status: "UNSUPPORTED", detail: { reason: "Provider does not support turning renewal off through NextMove", merchantName: d.name }, route: null };
        else review = { status: "READY", detail: { nextChargeAt: contract.nextChargeAt, priceMinor: contract.priceMinor, accessUntil: contract.accessUntil, termsRevision: contract.termsRevision, exitFeeMinor: contract.exitFeeMinor ?? 0, merchantName: d.name }, route: d.connector };
      }
    }
    tx(db, () => {
      if (contract) {
        run(
          db,
          "UPDATE subscriptions SET merchant_name=?, contract_id=?, canonical_key=?, plan_name=?, amount_minor=?, state=?, next_charge_at=?, access_until=?, terms_revision=?, observed_revision=?, last_observed_at=? WHERE id=?",
          String(review.detail.merchantName ?? s.merchant_name), contract.contractId, canonicalKey(s.merchant_id, s.subscriber_account_id, contract.contractId), contract.planName, contract.priceMinor,
          contract.autoRenew ? "ACTIVE" : "RENEWAL_OFF", contract.nextChargeAt, contract.accessUntil, contract.termsRevision, contract.termsRevision, nowIso(db, t), s.id,
        );
        const has = one(db, "SELECT id FROM forecast_items WHERE subscription_id=? AND status='SCHEDULED'", s.id);
        if (!has && contract.autoRenew && contract.nextChargeAt && inWindow(contract.nextChargeAt, w.startInclusive, w.endExclusive)) {
          addForecastItem(db, { tenantId: t, contextId: batch.context_id, dataset: "bulk", subscriptionId: s.id, kind: "RENEWAL", label: `${review.detail.merchantName} renewal`, amountMinor: -contract.priceMinor, dueAt: contract.nextChargeAt, source: `provider-read:${s.merchant_id}` });
        }
      } else if (review.detail.merchantName) {
        run(db, "UPDATE subscriptions SET merchant_name=?, last_observed_at=? WHERE id=?", String(review.detail.merchantName), nowIso(db, t), s.id);
      }
      run(
        db,
        "INSERT OR IGNORE INTO batch_items(id, batch_id, tenant_id, subscription_id, ordinal, review_status, review_detail_json, route, selected, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        shortId("bi"), batch.id, t, s.id, subs.indexOf(s), review.status, JSON.stringify(review.detail), review.route, review.status === "READY" ? 1 : 0, new Date().toISOString(),
      );
    });
    processed++;
    if (processed % 25 === 0 || processed === subs.length) taskEvent(db, { taskId: batch.task_id, tenantId: t, kind: "progress", label: `Inspected ${processed} of ${subs.length}`, evidence: "SIMULATED_MERCHANT_API" });
  };
  try {
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length) await inspectOne(queue.shift());
    });
    await Promise.all(workers);
    buildBatchProposal(db, batch.id);
  } finally {
    clearInterval(keepAlive);
  }
  finishJob(db, job, ctx.workerId, { status: "DONE" });
}

function buildBatchProposal(db: DatabaseSync, batchId: string) {
  const batch = one<any>(db, "SELECT * FROM batches WHERE id=?", batchId)!;
  const items = all<any>(db, "SELECT bi.*, s.* , bi.id AS item_id FROM batch_items bi JOIN subscriptions s ON s.id=bi.subscription_id WHERE bi.batch_id=? AND bi.review_status='READY' ORDER BY bi.ordinal", batchId);
  const ctx = one<any>(db, "SELECT user_id FROM contexts WHERE id=?", batch.context_id)!;
  const actions = items.map((it) => {
    const d = json<any>(it.review_detail_json, {});
    const fc = one<any>(db, "SELECT * FROM forecast_items WHERE subscription_id=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", it.subscription_id);
    return {
      key: it.item_id,
      spec: spec({
        operation: "STOP_RENEWAL",
        route: it.route as any,
        capability: "BATCH",
        merchantId: it.merchant_id,
        merchantName: d.merchantName,
        subscriberAccountId: it.subscriber_account_id,
        contractId: it.contract_id,
        canonicalKey: it.canonical_key,
        subjectRef: it.subscription_id,
        termsRevision: d.termsRevision,
        money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: fc ? fc.amount_minor : 0 },
        consequences: { effectiveAt: null, accessUntil: d.accessUntil ?? null, lostBenefits: [], dataEffect: null, remainingObligations: null },
        display: display(`Turn off ${d.merchantName} renewal`, `${money(d.priceMinor)} due ${fmtWhen(d.nextChargeAt)} would not be charged.`, [
          { label: "Route", value: it.route === "ISOLATED_BROWSER" ? "Provider website" : "Partner API" },
          { label: "Terms", value: `Revision ${d.termsRevision}` },
          { label: "Fee", value: money(d.exitFeeMinor ?? 0) },
        ], "Stops renewal at the end of the paid period."),
      }),
    };
  });
  tx(db, () => {
    const p = actions.length ? createProposal(db, { tenantId: batch.tenant_id, contextId: batch.context_id, actorUserId: ctx.user_id, taskId: batch.task_id, batchId, scope: "BATCH", actions }) : null;
    if (p) {
      for (const a of all<any>(db, "SELECT id, subject_ref FROM proposal_actions WHERE proposal_id=?", p.id)) run(db, "UPDATE batch_items SET action_id=? WHERE batch_id=? AND subscription_id=?", a.id, batchId, a.subject_ref);
    }
    run(db, "UPDATE batches SET status='REVIEW', proposal_id=?, updated_at=? WHERE id=?", p?.id ?? null, new Date().toISOString(), batchId);
    setTaskState(db, batch.task_id, "NEEDS_APPROVAL", `${actions.length} ready to stop; ${all<any>(db, "SELECT 1 FROM batch_items WHERE batch_id=? AND review_status != 'READY'", batchId).length} stay outside this approval`);
    setBlock(db, batch.task_id, "batch", 0, "batch", { batchId, proposalId: p?.id ?? null });
    taskEvent(db, { taskId: batch.task_id, tenantId: batch.tenant_id, kind: "proposal", label: `Ready for review: ${actions.length} renewals can be turned off`, evidence: "DETERMINISTIC_CALCULATION" });
  });
}

export function approveBatch(db: DatabaseSync, session: Session, batchId: string, digest: string, actionIds: string[]) {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=? AND tenant_id=?", batchId, session.tenantId);
  if (!b) throw new HttpError(404, "NOT_FOUND", "Not found");
  if (!b.proposal_id) throw new HttpError(409, "NOT_READY", "Inspection is still running");
  const res = approveProposal(db, session, { proposalId: b.proposal_id, digest, actionIds }, currentRevisionLookup(db, session.tenantId));
  // A replayed approval (double submit, retry) returns the existing mandate and must not reset item outcomes or
  // move a stopped / finished batch back to RUNNING: its jobs are already done and nothing would settle them again.
  if (res.alreadyApproved) return res;
  tx(db, () => {
    const selected = new Set(actionIds);
    for (const it of all<any>(db, "SELECT id, action_id FROM batch_items WHERE batch_id=? AND action_id IS NOT NULL", batchId)) {
      run(db, "UPDATE batch_items SET selected=?, outcome=CASE WHEN ? THEN 'IN_PROGRESS' ELSE 'NOT_SELECTED' END, updated_at=? WHERE id=?", selected.has(it.action_id) ? 1 : 0, selected.has(it.action_id) ? 1 : 0, new Date().toISOString(), it.id);
    }
    run(db, "UPDATE batches SET status='RUNNING', updated_at=? WHERE id=?", new Date().toISOString(), batchId);
    setTaskState(db, b.task_id, "RUNNING", `${actionIds.length} approved; working through them`);
    taskEvent(db, { taskId: b.task_id, tenantId: session.tenantId, kind: "approval", label: `You approved ${actionIds.length} exact actions (start window 60 minutes)`, evidence: "CUSTOMER_APPROVAL" });
  });
  return res;
}

export function stopBatch(db: DatabaseSync, session: Session, batchId: string) {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=? AND tenant_id=?", batchId, session.tenantId);
  if (!b) throw new HttpError(404, "NOT_FOUND", "Not found");
  const m = b.proposal_id ? one<any>(db, "SELECT id FROM mandates WHERE proposal_id=?", b.proposal_id) : null;
  if (!m) throw new HttpError(409, "NOT_APPROVED", "Nothing has been approved");
  const r = revokeMandate(db, session.tenantId, m.id, "you");
  tx(db, () => {
    for (const it of all<any>(db, "SELECT bi.id, a.status FROM batch_items bi JOIN proposal_actions a ON a.id=bi.action_id WHERE bi.batch_id=? AND bi.selected=1", batchId)) {
      if (a_status_not_started(it.status)) run(db, "UPDATE batch_items SET outcome='NOT_STARTED', outcome_detail='Stopped before it started', updated_at=? WHERE id=?", new Date().toISOString(), it.id);
    }
    run(db, "UPDATE batches SET status='STOPPED', stopped_at=?, updated_at=? WHERE id=?", new Date().toISOString(), new Date().toISOString(), batchId);
    taskEvent(db, { taskId: b.task_id, tenantId: session.tenantId, kind: "stop", label: `You pressed Stop: ${r.revoked} not started; ${r.alreadyStarted} already started may finish`, evidence: "CUSTOMER_APPROVAL" });
  });
  return r;
}

function a_status_not_started(s: string) {
  return s === "REVOKED" || s === "NOT_STARTED";
}

export function batchSummary(db: DatabaseSync, session: Session, batchId: string) {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=? AND tenant_id=?", batchId, session.tenantId);
  if (!b) throw new HttpError(404, "NOT_FOUND", "Not found");
  const ctx = one<any>(db, "SELECT user_id FROM contexts WHERE id=?", b.context_id);
  if (!ctx || ctx.user_id !== session.userId) throw new HttpError(404, "NOT_FOUND", "Not found");
  refreshBatchStatus(db, batchId);
  const items = all<any>(
    db,
    `SELECT bi.*, s.merchant_id, s.merchant_name, s.amount_minor AS sub_amount, s.next_charge_at, a.status AS action_status, a.result_json, r.issuer_reference
     FROM batch_items bi JOIN subscriptions s ON s.id=bi.subscription_id LEFT JOIN proposal_actions a ON a.id=bi.action_id LEFT JOIN receipts r ON r.id=bi.receipt_id
     WHERE bi.batch_id=? ORDER BY bi.ordinal`,
    batchId,
  );
  const count = (f: (x: any) => boolean) => items.filter(f).length;
  const by = (key: string, rows: any[]) => rows.reduce((m: Record<string, number>, r) => ((m[r[key] ?? "NONE"] = (m[r[key] ?? "NONE"] ?? 0) + 1), m), {});
  const approved = items.filter((i) => i.selected === 1 && i.action_id);
  // Avoided future charges are read from persisted forecast removals caused by verified receipts in the window.
  const avoided = one<any>(
    db,
    `SELECT COALESCE(SUM(-f.amount_minor),0) s FROM forecast_items f JOIN batch_items bi ON bi.subscription_id=f.subscription_id
     WHERE bi.batch_id=? AND f.status='REMOVED' AND f.due_at >= ? AND f.due_at < ? AND EXISTS (SELECT 1 FROM forecast_events e WHERE e.tenant_id=f.tenant_id AND e.forecast_item_id=f.id AND e.id LIKE 'rcp:%')`,
    batchId, b.window_start, b.window_end,
  )?.s ?? 0;
  const potential = approved.reduce((s, i) => {
    const f = one<any>(db, "SELECT amount_minor FROM forecast_items WHERE subscription_id=? AND due_at >= ? AND due_at < ? ORDER BY due_at LIMIT 1", i.subscription_id, b.window_start, b.window_end);
    return s + (f ? -f.amount_minor : 0);
  }, 0);
  // First renewal inside the window per subscription, so the review can total exactly what a selection would avoid.
  const windowCharge = new Map(
    all<any>(
      db,
      `SELECT f.subscription_id sid, -f.amount_minor m FROM forecast_items f
       WHERE f.subscription_id IN (SELECT subscription_id FROM batch_items WHERE batch_id=?) AND f.due_at >= ? AND f.due_at < ?
         AND f.due_at = (SELECT MIN(f2.due_at) FROM forecast_items f2 WHERE f2.subscription_id=f.subscription_id AND f2.due_at >= ? AND f2.due_at < ?)`,
      batchId, b.window_start, b.window_end, b.window_start, b.window_end,
    ).map((r) => [r.sid, r.m]),
  );
  const funds = json<any>(one<any>(db, "SELECT value_json FROM system_status WHERE key=?", `batch:${batchId}:funds`)?.value_json, {});
  const fundsNow = accountsFor(db, session.tenantId, b.context_id).reduce((s, a) => s + a.balanceMinor, 0);
  const proposal = b.proposal_id ? one<any>(db, "SELECT digest, status FROM proposals WHERE id=?", b.proposal_id) : null;
  const mandate = b.proposal_id ? one<any>(db, "SELECT id, status, start_expires_at FROM mandates WHERE proposal_id=?", b.proposal_id) : null;
  return {
    id: b.id,
    status: b.status,
    taskId: b.task_id,
    proposalId: b.proposal_id,
    proposalDigest: proposal?.digest ?? null,
    proposalStatus: proposal?.status ?? null,
    mandate,
    window: { startInclusive: b.window_start, endExclusive: b.window_end },
    inventory: items.length,
    reviewCounts: by("review_status", items),
    approvedCount: approved.length,
    excludedCount: items.length - count((i) => i.review_status === "READY"),
    approvedRoutes: by("route", approved),
    outcomes: by("outcome", approved),
    avoidedFutureChargesMinor: avoided,
    approvedPotentialMinor: potential,
    fundsBeforeMinor: funds.before ?? null,
    fundsNowMinor: fundsNow,
    cashRefundedMinor: 0,
    items: items.map((i) => ({
      id: i.id,
      subscriptionId: i.subscription_id,
      merchantId: i.merchant_id,
      merchantName: i.merchant_name,
      amountMinor: i.sub_amount,
      windowChargeMinor: windowCharge.get(i.subscription_id) ?? 0,
      nextChargeAt: i.next_charge_at,
      reviewStatus: i.review_status,
      reviewDetail: json(i.review_detail_json, {}),
      route: i.route,
      selected: i.selected === 1,
      actionId: i.action_id,
      outcome: i.outcome,
      outcomeDetail: i.outcome_detail ?? json<any>(i.result_json, {})?.reason ?? null,
      receipt: i.issuer_reference,
    })),
  };
}

/* ------------------------------------------------------------------------------------------ exceptions */

/** Ask for an immediate provider read-back of items whose outcome is unknown or waiting. Never resubmits. */
export function recheckBatch(db: DatabaseSync, session: Session, batchId: string, requestReconcileNow: (db: DatabaseSync, tenantId: string, actionId: string) => boolean) {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=? AND tenant_id=? AND context_id=?", batchId, session.tenantId, session.contextId);
  if (!b) throw new HttpError(404, "NOT_FOUND", "Not found");
  let scheduled = 0;
  for (const it of all<any>(db, "SELECT action_id FROM batch_items WHERE batch_id=? AND outcome IN ('OUTCOME_UNKNOWN','WAITING_EXTERNAL') AND action_id IS NOT NULL", batchId)) {
    if (requestReconcileNow(db, session.tenantId, it.action_id)) scheduled++;
  }
  if (scheduled) taskEvent(db, { taskId: b.task_id, tenantId: session.tenantId, kind: "recheck", label: `Asked ${scheduled} provider${scheduled === 1 ? "" : "s"} for the current status (nothing resubmitted)`, evidence: "SIMULATED_MERCHANT_API" });
  return { scheduled };
}

/**
 * Items that stopped because the provider's terms changed, or because the provider session lapsed, need a fresh
 * read and a fresh approval. This reads each provider again and prepares a new proposal for the items that are now
 * ready; the original approval is never reused.
 */
export async function reviseBatch(db: DatabaseSync, session: Session, batchId: string, outcome: "TERMS_CHANGED" | "NEEDS_AUTH") {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=? AND tenant_id=? AND context_id=?", batchId, session.tenantId, session.contextId);
  if (!b) throw new HttpError(404, "NOT_FOUND", "Not found");
  const items = all<any>(db, "SELECT bi.*, s.merchant_id, s.subscriber_account_id, s.merchant_name, s.terms_revision AS old_revision, s.amount_minor AS old_price FROM batch_items bi JOIN subscriptions s ON s.id=bi.subscription_id WHERE bi.batch_id=? AND bi.outcome=?", batchId, outcome);
  if (!items.length) throw new HttpError(409, "NOTHING_TO_REVISE", "No items need this follow-up");
  const client = new MerchantClient(db, session.tenantId);
  const ready: { key: string; spec: any }[] = [];
  const still: string[] = [];
  for (const it of items) {
    const r = await client.listContracts(it.merchant_id, it.subscriber_account_id).catch(() => ({ status: 0 }) as any);
    if (r.status === 401) {
      still.push(`${it.merchant_name}: the provider still asks the account holder to sign in`);
      continue;
    }
    const c = r.status === 200 ? r.contracts?.[0] : null;
    if (!c) {
      still.push(`${it.merchant_name}: provider read failed (${r.status})`);
      continue;
    }
    if (!c.autoRenew) {
      tx(db, () => run(db, "UPDATE batch_items SET outcome='ALREADY_OFF', outcome_detail='Renewal was already off when read again', updated_at=? WHERE id=?", new Date().toISOString(), it.id));
      continue;
    }
    if (c.exitFeeMinor && c.exitFeeMinor > 0) {
      still.push(`${it.merchant_name}: the new terms add a ${money(c.exitFeeMinor)} fee; review it on the provider's page`);
      continue;
    }
    tx(db, () =>
      run(db, "UPDATE subscriptions SET contract_id=?, plan_name=?, amount_minor=?, next_charge_at=?, access_until=?, terms_revision=?, observed_revision=?, last_observed_at=? WHERE id=?", c.contractId, c.planName, c.priceMinor, c.nextChargeAt, c.accessUntil, c.termsRevision, c.termsRevision, nowIso(db, session.tenantId), it.subscription_id),
    );
    const fc = one<any>(db, "SELECT * FROM forecast_items WHERE subscription_id=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", it.subscription_id);
    const changed = outcome === "TERMS_CHANGED" ? [{ label: "What changed", value: `Terms revision ${it.old_revision} → ${c.termsRevision}; price ${money(it.old_price)} → ${money(c.priceMinor)}` }] : [{ label: "Provider sign-in", value: "Renewed by the account holder" }];
    ready.push({
      key: it.id,
      spec: spec({
        operation: "STOP_RENEWAL",
        route: it.route as any,
        capability: "BATCH",
        merchantId: it.merchant_id,
        merchantName: it.merchant_name,
        subscriberAccountId: it.subscriber_account_id,
        contractId: c.contractId,
        canonicalKey: canonicalKey(it.merchant_id, it.subscriber_account_id, c.contractId),
        subjectRef: it.subscription_id,
        termsRevision: c.termsRevision,
        money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: fc ? fc.amount_minor : 0 },
        consequences: { effectiveAt: null, accessUntil: c.accessUntil ?? null, lostBenefits: [], dataEffect: null, remainingObligations: null },
        display: display(`Turn off ${it.merchant_name} renewal`, `${money(c.priceMinor)} due ${fmtWhen(c.nextChargeAt)} would not be charged.`, [
          ...changed,
          { label: "Route", value: it.route === "ISOLATED_BROWSER" ? "Provider website" : "Partner API" },
          { label: "Terms", value: `Revision ${c.termsRevision}` },
          { label: "Fee", value: money(c.exitFeeMinor ?? 0) },
        ], "Uses the provider's current terms. Your earlier approval does not cover this."),
      }),
    });
  }
  if (!ready.length) return { proposal: null, notReady: still };
  const ctx = one<any>(db, "SELECT user_id FROM contexts WHERE id=?", b.context_id)!;
  const p = createProposal(db, { tenantId: session.tenantId, contextId: b.context_id, actorUserId: ctx.user_id, taskId: b.task_id, scope: ready.length > 1 ? "BATCH" : "SINGLE", actions: ready });
  tx(db, () => {
    for (const it of items) if (ready.some((r) => r.key === it.id)) run(db, "UPDATE batch_items SET outcome_detail=?, updated_at=? WHERE id=?", `Fresh approval prepared (${p.id})`, new Date().toISOString(), it.id);
    const follow = json<string[]>(one<any>(db, "SELECT value_json FROM system_status WHERE key=?", `batch:${batchId}:followups`)?.value_json, []);
    run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES (?,?,?)", `batch:${batchId}:followups`, JSON.stringify([...follow, p.id]), new Date().toISOString());
    taskEvent(db, { taskId: b.task_id, tenantId: session.tenantId, kind: "proposal", label: `Prepared a fresh approval for ${ready.length} item${ready.length === 1 ? "" : "s"} after ${outcome === "TERMS_CHANGED" ? "the terms changed" : "the provider sign-in"}`, evidence: "SIMULATED_MERCHANT_API" });
  });
  return { proposal: { id: p.id }, notReady: still };
}

export function batchFollowUps(db: DatabaseSync, batchId: string) {
  return json<string[]>(one<any>(db, "SELECT value_json FROM system_status WHERE key=?", `batch:${batchId}:followups`)?.value_json, []);
}
