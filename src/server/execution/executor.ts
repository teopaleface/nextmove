import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { opaqueId, sha256Hex, shortId } from "../canonical";
import { nowIso, nowMs } from "../clock";
import { toLocalIso, toMs } from "../../shared/time";
import { authorizeDispatch, invalidateForSubject } from "../authority/authority";
import type { ActionSpec } from "../authority/actions";
import { MerchantClient, NetworkUncertainError, EgressError, delegatedToken } from "../merchant-client";
import { browserStopRenewal } from "./browser";
import { recordConfirmed, recordSettled } from "./effects";
import { reconcileInternalTransfer, runInternalTransfer, transferWait } from "./internal-transfer";
import { SHIELD_OPERATIONS, runShieldDecision } from "../bank/trial-shield";
import { balanceOf } from "../bank/ledger";
import { extPreDispatch, runExtOperation } from "../extensions/registry";
import { enqueueJob, finishJob, renewLease, type Job } from "./jobs";
import { taskEvent, taskIdForAction, type EvidenceLevel } from "../agent/events";
import type { MerchantContractView, OperationResponse } from "../../shared/merchant-contract";
import { formatMoney } from "../../shared/money";

// One durable action attempt: persisted before any external effect, authorized at the final dispatch gate under
// the worker's fence, independently read back, and closed with a receipt or an explicit non-success status.

/** Demo-time offsets for reconciliation checks after an unknown outcome: five checks inside 24 hours. */
export const RECONCILE_SCHEDULE_MIN = [5, 30, 120, 390, 1440];
/** Provider error codes that mean the request was rejected before anything changed (only trusted on a 4xx). */
const DEFINITIVE_REFUSALS = new Set(["VALIDATION", "NOT_FOUND", "NOT_SUPPORTED", "IDEMPOTENCY_CONFLICT", "BAD_SIGNATURE", "UNAUTHENTICATED"]);
const PENDING_RECHECK_MIN = 12 * 60;

export interface WorkerCtx {
  workerId: string;
  log: (m: string) => void;
}

function verifyState(op: string, spec: ActionSpec, c: MerchantContractView | undefined): string | null {
  if (!c) return "contract not readable";
  switch (op) {
    case "STOP_RENEWAL":
      return c.autoRenew ? "provider still shows renewal on" : null;
    case "CHANGE_PLAN":
      return c.planId === spec.params.planId ? null : `provider shows plan ${c.planId}`;
    case "PAUSE":
      return (c.pending as any)?.pause ? null : "no pause recorded";
    case "CHANGE_BILLING_DATE":
      return (c.details as any)?.billingDay === Number(spec.params.billingDay) ? null : "billing day not updated";
    case "CHANGE_BILLING_PERIOD":
      return c.billingPeriod === "ANNUAL" ? null : "billing period not updated";
    case "REDUCE_SEATS": {
      const seats: any[] = (c.details as any)?.seats ?? [];
      const ids = (spec.params.seatIds as string[]) ?? [];
      return ids.every((id) => seats.find((s) => s.seatId === id)?.removedFrom) ? null : "seats not scheduled for removal";
    }
    case "START_MIGRATION":
      return (c.details as any)?.migration ? null : "no migration recorded";
    default:
      return null;
  }
}

function attemptIds(action: any, grantId: string) {
  return { correlationId: opaqueId("corr", 12), idempotencyKey: `idem_${sha256Hex(`${action.logical_key}:${grantId}`).slice(0, 40)}` };
}

export async function runActionJob(db: DatabaseSync, job: Job, ctx: WorkerCtx): Promise<void> {
  const action = one<any>(db, "SELECT * FROM proposal_actions WHERE id=?", job.ref_id);
  if (!action) return void finishJob(db, job, ctx.workerId, { status: "FAILED", error: "action missing" });
  const spec = json<ActionSpec>(action.spec_json);
  const t = action.tenant_id;
  const taskId = taskIdForAction(db, action.id);

  // Never dispatch again while an earlier attempt may have reached the merchant.
  const open = one<any>(db, "SELECT * FROM attempts WHERE action_id=? AND status IN ('DISPATCH_AUTHORIZED','SENT','UNKNOWN','PENDING') ORDER BY started_at DESC LIMIT 1", action.id);
  if (open) {
    if (open.status === "DISPATCH_AUTHORIZED" || open.status === "SENT") {
      tx(db, () => {
        run(db, "UPDATE attempts SET status='UNKNOWN', next_reconcile_at=? WHERE id=?", nowIso(db, t), open.id);
        recordSettled(db, action.id, open.id, "UNKNOWN", { reason: "A previous worker stopped after dispatch; reconciling before any retry" });
      });
    }
    scheduleReconcile(db, open.id, 0);
    return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  }
  if (["CONFIRMED", "REFUSED", "TERMS_CHANGED", "REVOKED", "EXPIRED", "NO_CHANGE", "BLOCKED", "OUTDATED"].includes(action.status)) return void finishJob(db, job, ctx.workerId, { status: "DONE" });

  const grant = one<any>(db, "SELECT * FROM grants WHERE action_id=?", action.id);
  if (!grant || grant.status !== "ACTIVE") {
    const status = grant?.status === "EXPIRED" ? "EXPIRED" : grant?.status === "INVALIDATED" ? "OUTDATED" : "REVOKED";
    tx(db, () => recordSettled(db, action.id, null, status, { reason: grant?.invalid_reason ?? `approval ${String(grant?.status ?? "missing").toLowerCase()}` }));
    return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  }

  // Dependencies (replacement activation, verified migration) must be satisfied before this action may start.
  for (const depId of spec.dependsOn) {
    const dep = one<any>(db, "SELECT status, spec_json, subject_ref FROM proposal_actions WHERE id=?", depId);
    if (!dep) continue;
    if (["REFUSED", "TERMS_CHANGED", "REVOKED", "EXPIRED", "BLOCKED", "OUTDATED", "NOT_STARTED"].includes(dep.status)) {
      tx(db, () => recordSettled(db, action.id, null, "BLOCKED", { reason: "A required earlier step did not complete, so this step was not started", dependency: depId }));
      return void finishJob(db, job, ctx.workerId, { status: "DONE" });
    }
    const depSpec = json<ActionSpec>(dep.spec_json);
    let satisfied = dep.status === "CONFIRMED" || dep.status === "NO_CHANGE";
    if (satisfied && depSpec.operation === "START_MIGRATION") {
      const sub = one<any>(db, "SELECT data_json FROM subscriptions WHERE id=?", dep.subject_ref);
      satisfied = json<any>(sub?.data_json, {})?.migration?.state === "VERIFIED";
    }
    if (!satisfied) {
      if (job.attempts === 1) taskEvent(db, { taskId, tenantId: t, kind: "waiting", label: `${spec.display.title}: waiting for ${depSpec.display.title.toLowerCase()} to be verified`, evidence: "BANK_RECORD" });
      return void finishJob(db, job, ctx.workerId, { status: "QUEUED", availableAt: new Date(Date.now() + 2000).toISOString() });
    }
  }

  // A scheduled internal transfer waits for its approved demo-time date before any attempt exists.
  if (spec.operation === "INTERNAL_TRANSFER") {
    const wait = transferWait(db, action, spec);
    if (wait) return void finishJob(db, job, ctx.workerId, { status: "QUEUED", availableAt: wait.availableAt });
  }
  // A conditional action held by an extension (an exit plan's stop) waits or closes here; it can never skip the gate.
  const held = await extPreDispatch({ db, action, spec, grant });
  if (held && "wait" in held) return void finishJob(db, job, ctx.workerId, { status: "QUEUED", availableAt: held.wait });
  if (held) {
    tx(db, () => recordSettled(db, action.id, null, held.settle, { reason: held.reason, ...(held.detail ?? {}) }));
    return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  }

  const ids = attemptIds(action, grant.id);
  const attemptId = shortId("att");
  run(
    db,
    `INSERT INTO attempts(id, action_id, logical_key, grant_id, tenant_id, job_id, fence, route, status, idempotency_key, correlation_id, started_at)
     VALUES (?,?,?,?,?,?,?,?, 'CLAIMED', ?,?,?)`,
    attemptId, action.id, action.logical_key, grant.id, t, job.id, job.fence, spec.route, ids.idempotencyKey, ids.correlationId, new Date().toISOString(),
  );
  const authorize = async () => {
    const r = authorizeDispatch(db, { tenantId: t, attemptId, jobId: job.id, fence: job.fence, workerId: ctx.workerId });
    return r.ok ? ({ ok: true } as const) : ({ ok: false, reason: r.reason } as const);
  };
  const keepAlive = setInterval(() => renewLease(db, job, ctx.workerId), 5_000);
  try {
    if (spec.route === "PARTNER_API") await runPartnerApi(db, action, spec, attemptId, ids, authorize, ctx);
    else if (spec.route === "ISOLATED_BROWSER") await runBrowser(db, action, spec, attemptId, ids, authorize, ctx);
    else if (spec.operation.startsWith("EXT_") && spec.route !== "BANK_INTERNAL") tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "Extension steps run only inside the bank; nothing was sent" }));
    else if (spec.route === "BANK_INTERNAL") await runBankInternal(db, action, spec, attemptId, authorize);
    else tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "Preparation-only actions are not executed" }));
  } catch (e: any) {
    ctx.log(`[worker] action ${action.id} error: ${String(e?.message ?? e).slice(0, 200)}`);
    const a = one<any>(db, "SELECT status FROM attempts WHERE id=?", attemptId);
    if (a?.status === "DISPATCH_AUTHORIZED" || a?.status === "SENT") {
      tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: "Unexpected error after dispatch; reconciling" }));
      scheduleReconcile(db, attemptId, 0);
    } else if (a?.status === "CLAIMED") {
      run(db, "UPDATE attempts SET status='FAILED_BEFORE_SEND', finished_at=?, outcome_json=? WHERE id=?", new Date().toISOString(), JSON.stringify({ reason: String(e?.message ?? e).slice(0, 200) }), attemptId);
      clearInterval(keepAlive);
      if (job.attempts < 4) return void finishJob(db, job, ctx.workerId, { status: "QUEUED", availableAt: new Date(Date.now() + 3000 * job.attempts).toISOString(), error: "retry before send" });
      tx(db, () => recordSettled(db, action.id, null, "BLOCKED", { reason: "The provider could not be reached; nothing was sent" }));
    }
  } finally {
    clearInterval(keepAlive);
  }
  finishJob(db, job, ctx.workerId, { status: "DONE" });
}

type Authorize = () => Promise<{ ok: true } | { ok: false; reason: string }>;

function gateDenied(db: DatabaseSync, actionId: string, attemptId: string, reason: string) {
  // ALREADY_EXECUTED: when the other in-flight attempt belongs to this same action, that attempt settles the action
  // (reconciliation); when it belongs to a different approval of the same change, this action is closed unsent.
  const sameAction = reason === "ALREADY_EXECUTED" && Boolean(one<any>(db, `SELECT 1 FROM attempts WHERE action_id=? AND id != ? AND status IN ('DISPATCH_AUTHORIZED','SENT','CONFIRMED','PENDING','UNKNOWN')`, actionId, attemptId));
  // LEASE_LOST: this worker's job was recovered by another; that worker owns the action now, so only close this attempt.
  const status = reason === "LEASE_LOST" ? null : reason === "MANDATE_REVOKED" || reason === "EPOCH_CHANGED" ? "REVOKED" : reason === "GRANT_EXPIRED" ? "EXPIRED" : reason === "ALREADY_EXECUTED" ? (sameAction ? null : "NOT_STARTED") : "BLOCKED";
  tx(db, () => {
    run(db, "UPDATE attempts SET status='NOT_DISPATCHED', finished_at=?, outcome_json=? WHERE id=?", new Date().toISOString(), JSON.stringify({ gate: reason }), attemptId);
    if (status) recordSettled(db, actionId, null, status, { reason: gateReasonText(reason) });
    // A lost lease not yet recovered goes back to the queue under this fence, so the approval is retried, never stranded.
    if (reason === "LEASE_LOST") {
      const a = one<any>(db, "SELECT job_id, fence FROM attempts WHERE id=?", attemptId);
      if (a) run(db, "UPDATE jobs SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND fence=? AND status='LEASED'", new Date().toISOString(), a.job_id, a.fence);
    }
  });
}

function gateReasonText(r: string) {
  return (
    {
      MANDATE_REVOKED: "You stopped this approval before the step started",
      EPOCH_CHANGED: "You stopped this approval before the step started",
      GRANT_EXPIRED: "The approval expired before the step started",
      FEATURE_DISABLED: "Execution is disabled in this environment",
      DIGEST_MISMATCH: "The action no longer matches what you approved",
      LEASE_LOST: "Another worker took over this step",
      GRANT_NOT_ACTIVE: "The approval is no longer active",
      ALREADY_EXECUTED: "The same change was already sent under another approval; this one was not sent",
    } as Record<string, string>
  )[r] ?? r;
}

/* ---------------------------------------------------------------------------------- partner API adapter */

async function runPartnerApi(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, ids: { correlationId: string; idempotencyKey: string }, authorize: Authorize, ctx: WorkerCtx) {
  const client = new MerchantClient(db, action.tenant_id);
  const m = spec.merchantId!;
  const acct = spec.subscriberAccountId!;
  // Read-only pre-check of current provider state; changed terms or an expired session stop before dispatch.
  if (spec.contractId && spec.operation !== "ACTIVATE_OFFER") {
    const r = await client.getContract(m, acct, spec.contractId);
    if (r.status === 401) return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "The provider session expired; sign in on the provider's own page", code: "AUTH_EXPIRED" }));
    if (r.status !== 200 || !r.contract) throw new Error(`pre-check read failed (${r.status})`);
    if (spec.termsRevision != null && r.contract.termsRevision !== spec.termsRevision) return termsChanged(db, action, spec, attemptId, r.contract.termsRevision, false);
    if (spec.operation === "STOP_RENEWAL" && !r.contract.autoRenew) return void tx(db, () => recordSettled(db, action.id, attemptId, "NO_CHANGE", { reason: "Renewal was already off at the provider" }));
  } else if (spec.operation === "ACTIVATE_OFFER") {
    const o = await client.getOffer(m, acct, String(spec.params.offerId));
    if (o.status === 401) return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "The provider session expired", code: "AUTH_EXPIRED" }));
    if (o.offer && o.offer.revision !== Number(spec.params.offerRevision)) return termsChanged(db, action, spec, attemptId, o.offer.revision, false);
  } else {
    const a = await client.getAccount(m, acct);
    if (a.status === 401) return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "The provider session expired", code: "AUTH_EXPIRED" }));
  }
  const gate = await authorize();
  if (!gate.ok) return gateDenied(db, action.id, attemptId, gate.reason);
  run(db, "UPDATE attempts SET status='SENT' WHERE id=?", attemptId);
  let resp: { status: number; response: OperationResponse };
  try {
    resp = await client.operate(m, acct, spec.contractId, { operation: spec.operation as any, expectedTermsRevision: spec.termsRevision, params: spec.params }, ids);
  } catch (e) {
    if (e instanceof NetworkUncertainError || !(e instanceof EgressError)) {
      tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: "No answer after the request was sent; checking with the provider before anything else" }));
      scheduleReconcile(db, attemptId, RECONCILE_SCHEDULE_MIN[0]);
      return;
    }
    throw e;
  }
  await handleApiResponse(db, client, action, spec, attemptId, ids.correlationId, resp, "API");
}

async function handleApiResponse(db: DatabaseSync, client: MerchantClient, action: any, spec: ActionSpec, attemptId: string, correlationId: string, resp: { status: number; response: OperationResponse }, channel: "API" | "WEB") {
  const r = resp.response as any;
  if (r?.error === "TERMS_CHANGED") return termsChanged(db, action, spec, attemptId, r.currentRevision ?? null, true);
  if (r?.error === "AUTH_EXPIRED" || resp.status === 401) return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "The provider session expired; sign in on the provider's own page", code: "AUTH_EXPIRED" }));
  // Only the provider's own definitive 4xx answers are refusals. A 5xx, a body that is not JSON (a gateway page, a
  // truncated reply) or an empty answer may follow a commit: the outcome is unknown and is read back, never resent.
  if (r?.error && resp.status >= 400 && resp.status < 500 && DEFINITIVE_REFUSALS.has(r.error)) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: r.message ?? r.error, code: r.error }));
  if (!r || typeof r !== "object" || r.error) {
    tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: "No clear answer after the request was sent; checking with the provider before anything else", code: r?.error ?? `HTTP_${resp.status}` }));
    scheduleNextCheck(db, attemptId);
    return;
  }
  if (r.status === "PENDING_REVIEW") {
    tx(db, () => recordSettled(db, action.id, attemptId, "PENDING", { reason: "The provider is reviewing the request", requestId: r.request?.requestId }));
    scheduleReconcile(db, attemptId, PENDING_RECHECK_MIN);
    return;
  }
  if (r.status === "REFUSED") return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: r.reason }));
  if (r.status === "CONFIRMED") return verifyAndConfirm(db, client, action, spec, attemptId, correlationId, channel, "response");
  tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: "Unrecognised provider answer" }));
  scheduleReconcile(db, attemptId, RECONCILE_SCHEDULE_MIN[0]);
}

/** Independent read-back: the request by correlation id and the contract state must both show the effect. */
async function verifyAndConfirm(db: DatabaseSync, client: MerchantClient, action: any, spec: ActionSpec, attemptId: string, correlationId: string, channel: "API" | "WEB", via: string): Promise<boolean> {
  const m = spec.merchantId!;
  const acct = spec.subscriberAccountId!;
  const reqs = await client.findRequests(m, acct, correlationId);
  const req = reqs.requests?.find((x) => x.correlationId === correlationId);
  if (!req) {
    tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: "The provider's records do not show the request yet; checking again before anything else" }));
    scheduleNextCheck(db, attemptId);
    return false;
  }
  if (req.status === "PENDING_REVIEW") {
    tx(db, () => recordSettled(db, action.id, attemptId, "PENDING", { reason: "The provider is reviewing the request", requestId: req.requestId }));
    scheduleReconcile(db, attemptId, PENDING_RECHECK_MIN);
    return false;
  }
  if (req.status === "REFUSED" || !req.receipt) {
    tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: req.reason ?? "Refused" }));
    return false;
  }
  const checks = [`request ${req.requestId} confirmed with correlation ${correlationId.slice(0, 10)}…`, `receipt ${req.receipt.reference}`];
  if (spec.contractId && spec.operation !== "ACTIVATE_OFFER") {
    const c = await client.getContract(m, acct, spec.contractId);
    const problem = verifyState(spec.operation, spec, c.contract);
    if (problem) {
      tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: `Receipt seen but ${problem}; checking again` }));
      scheduleNextCheck(db, attemptId);
      return false;
    }
    checks.push(`contract state verified (terms revision ${c.contract!.termsRevision})`);
  }
  // An order charged above the approved maximum is not a success: no receipt and no booking are written, and the
  // attempt and the action both stay UNKNOWN with the merchant's reference so the customer can take it up with them.
  if (spec.operation === "PLACE_ORDER") {
    const charge = Number((req.receipt.details as any)?.cardChargeMinor ?? 0);
    const max = one<any>(db, "SELECT max_debit_minor FROM grants WHERE action_id=?", action.id)?.max_debit_minor;
    if (!Number.isSafeInteger(charge) || charge < 0 || (charge > 0 && (max == null || charge > max))) {
      const who = spec.merchantName ?? m;
      tx(db, () =>
        recordSettled(db, action.id, attemptId, "UNKNOWN", {
          reason: `${who} placed order ${req.receipt!.reference} but reported a card charge of ${Number.isSafeInteger(charge) ? formatMoney(charge) : "an unreadable amount"}, more than the ${formatMoney(Number(max ?? 0))} you approved. The bank did not book that charge and this is not counted as done; check the order with ${who}.`,
          code: "CHARGE_ABOVE_APPROVED",
          reference: req.receipt!.reference,
          cardChargeMinor: Number.isSafeInteger(charge) ? charge : null,
          approvedMaxDebitMinor: max ?? null,
        }),
      );
      return false;
    }
  }
  tx(db, () =>
    recordConfirmed(db, action.id, attemptId, {
      issuer: m,
      reference: req.receipt!.reference,
      effectiveAt: req.receipt!.effectiveAt,
      accessUntil: req.receipt!.accessUntil,
      termsRevision: req.receipt!.termsRevision,
      details: req.receipt!.details as any,
      channel,
      verification: { method: `independent read-back after ${via}`, checks },
      evidence: channel === "WEB" ? "SIMULATED_MERCHANT_BROWSER" : "SIMULATED_MERCHANT_API",
    }),
  );
  return true;
}

function termsChanged(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, currentRevision: number | null, dispatched: boolean) {
  tx(db, () => {
    // Invalidate before settling: this action's own unconsumed grant and its proposal belong to the changed subject too.
    invalidateForSubject(db, action.tenant_id, { canonicalKey: action.canonical_key ?? undefined }, `terms changed to revision ${currentRevision}`);
    recordSettled(db, action.id, attemptId, "TERMS_CHANGED", { reason: `Terms changed from revision ${spec.termsRevision} to ${currentRevision ?? "a newer revision"}; ${dispatched ? "the provider rejected the change" : "nothing was sent"}`, currentRevision });
    if (spec.subjectRef) run(db, "UPDATE subscriptions SET observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", currentRevision, nowIso(db, action.tenant_id), spec.subjectRef);
  });
}

/* ------------------------------------------------------------------------------------ browser adapter */

async function runBrowser(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, ids: { correlationId: string }, authorize: Authorize, ctx: WorkerCtx) {
  if (spec.operation !== "STOP_RENEWAL") return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "No supported web procedure for this operation" }));
  const taskId = taskIdForAction(db, action.id);
  const token = delegatedToken(db, action.tenant_id, spec.merchantId!, spec.subscriberAccountId!);
  const runResult = await browserStopRenewal({
    attemptId,
    merchantId: spec.merchantId!,
    contractId: spec.contractId!,
    approvedTermsRevision: spec.termsRevision!,
    correlationId: ids.correlationId,
    delegatedToken: token,
    authorize,
    onStep: (s) => taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "browser", label: s.label, evidence: "SIMULATED_MERCHANT_BROWSER", payload: { attemptId, screenshot: s.screenshot, url: s.url } }),
  });
  run(db, "UPDATE attempts SET evidence_json=? WHERE id=?", JSON.stringify({ steps: runResult.steps, blockedRequests: runResult.blockedRequests, untrustedContentIgnored: runResult.untrustedContentIgnored }), attemptId);
  if (runResult.dispatched) run(db, "UPDATE attempts SET status='SENT' WHERE id=? AND status='DISPATCH_AUTHORIZED'", attemptId);
  const o = runResult.outcome;
  const client = new MerchantClient(db, action.tenant_id);
  switch (o.kind) {
    case "CONFIRMED":
      await verifyAndConfirm(db, client, action, spec, attemptId, ids.correlationId, "WEB", "the provider page");
      return;
    case "ALREADY_OFF":
      return void tx(db, () => recordSettled(db, action.id, attemptId, "NO_CHANGE", { reason: "Renewal was already off at the provider" }));
    case "PENDING":
      tx(db, () => recordSettled(db, action.id, attemptId, "PENDING", { reason: "The provider is reviewing the request" }));
      scheduleReconcile(db, attemptId, PENDING_RECHECK_MIN);
      return;
    case "REFUSED":
      return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: o.reason }));
    case "TERMS_CHANGED":
      return termsChanged(db, action, spec, attemptId, o.currentRevision, o.dispatched);
    case "AUTH_REQUIRED":
      return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "The provider asks the account holder to sign in on its own page; NextMove does not sign in for you", code: "AUTH_EXPIRED" }));
    case "GATE_DENIED":
      return gateDenied(db, action.id, attemptId, o.reason);
    case "UNKNOWN":
      tx(db, () => recordSettled(db, action.id, attemptId, "UNKNOWN", { reason: `${o.detail}. The change may have been made; checking with the provider before anything else` }));
      scheduleReconcile(db, attemptId, RECONCILE_SCHEDULE_MIN[0]);
      return;
    case "FAILED_BEFORE_SEND":
      ctx.log(`[worker] browser ${spec.merchantId} failed before send: ${o.detail}`);
      run(db, "UPDATE attempts SET status='FAILED_BEFORE_SEND', finished_at=?, outcome_json=? WHERE id=?", new Date().toISOString(), JSON.stringify({ reason: o.detail }), attemptId);
      tx(db, () => recordSettled(db, action.id, null, "BLOCKED", { reason: `Nothing was sent: ${o.detail}` }));
      return;
  }
}

/* -------------------------------------------------------------------------------- bank-internal adapter */

async function runBankInternal(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, authorize: Authorize) {
  if (spec.operation === "INTERNAL_TRANSFER") return runInternalTransfer(db, action, spec, attemptId, authorize, (reason) => gateDenied(db, action.id, attemptId, reason));
  const gate = await authorize();
  if (!gate.ok) return gateDenied(db, action.id, attemptId, gate.reason);
  // Fenced: the whole bank step commits (as a savepoint of this transaction) only while the attempt still holds its
  // dispatch authorization. Once recovery has marked it UNKNOWN, reconciliation owns it, and a stalled worker's late
  // commit is dropped, so "nothing in the bank's records" stays true. Every handler below is synchronous.
  let pending: Promise<void> | undefined;
  const live = tx(db, () => {
    if (!one(db, "SELECT 1 FROM attempts WHERE id=? AND status IN ('DISPATCH_AUTHORIZED','SENT')", attemptId)) return false;
    if (spec.operation.startsWith("EXT_")) pending = runExtOperation({ db, action, spec, attemptId });
    else bankInternalStep(db, action, spec, attemptId);
    return true;
  });
  if (!live) return;
  await pending;
}

function bankInternalStep(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string) {
  if (SHIELD_OPERATIONS.has(spec.operation)) return runShieldDecision(db, action, spec, attemptId);
  if (spec.operation === "CARD_FREEZE") {
    const acct = one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=? AND context_id=?", spec.params.accountId, action.tenant_id, action.context_id);
    const card = acct?.card_json ? JSON.parse(acct.card_json) : null;
    if (!card) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "This account has no card" }));
    const target = spec.params.targetStatus === "FROZEN" ? "FROZEN" : "ACTIVE";
    if (card.status === target) return void tx(db, () => recordSettled(db, action.id, attemptId, "NO_CHANGE", { reason: `The card is already ${target === "FROZEN" ? "frozen" : "active"}` }));
    const reference = `NMC-${sha256Hex(`${action.logical_key}:${attemptId}`).slice(0, 8).toUpperCase()}`;
    tx(db, () =>
      recordConfirmed(db, action.id, attemptId, {
        issuer: "nextmove-bank",
        reference,
        effectiveAt: nowIso(db, action.tenant_id),
        accessUntil: null,
        termsRevision: null,
        details: { accountId: acct.id, cardLast4: card.last4, from: card.status, to: target },
        channel: "BANK",
        verification: { method: "card status read back from the bank record", checks: ["card belongs to the approved account", `status ${card.status} → ${target}`] },
        evidence: "BANK_RECORD",
      }),
    );
    return;
  }
  // Only the two money operations with a ledger effect in recordConfirmed fall through here; anything else fails closed.
  if (spec.operation !== "PAYMENT" && spec.operation !== "OWNER_TRANSFER") return void tx(db, () => recordSettled(db, action.id, attemptId, "BLOCKED", { reason: "This operation has no bank-internal handler" }));
  const amount = Number(spec.params.amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "The approved amount is not a positive whole number of bani" }));
  // A payment debits the approving context's own account; the owner transfer deliberately crosses contexts within the tenant.
  const from = spec.operation === "PAYMENT"
    ? one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=? AND context_id=?", spec.params.fromAccountId, action.tenant_id, action.context_id)
    : one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=?", spec.params.fromAccountId, action.tenant_id);
  if (!from) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "Source account not found" }));
  if (balanceOf(db, from.id) < amount) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "Insufficient funds in the source account" }));
  if (amount > spec.money.maxDebitMinor) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "Amount exceeds the approved maximum" }));
  const reference = `NMB-${sha256Hex(action.logical_key).slice(0, 8).toUpperCase()}`;
  tx(db, () =>
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: nowIso(db, action.tenant_id),
      accessUntil: null,
      termsRevision: null,
      details: { amountMinor: amount, from: spec.params.fromAccountId, to: spec.params.toAccountId ?? spec.merchantName },
      channel: "BANK",
      verification: { method: "balanced ledger posting", checks: ["entry balanced", "unique source event", "funds conserved across contexts"] },
      evidence: "BANK_LEDGER_POSTING",
    }),
  );
}

/* ------------------------------------------------------------------------------------- reconciliation */

export function scheduleReconcile(db: DatabaseSync, attemptId: string, minutesFromNow: number) {
  const a = one<any>(db, "SELECT tenant_id FROM attempts WHERE id=?", attemptId);
  if (!a) return;
  run(db, "UPDATE attempts SET next_reconcile_at=? WHERE id=?", toLocalIso(nowMs(db, a.tenant_id) + minutesFromNow * 60_000), attemptId);
}

function scheduleNextCheck(db: DatabaseSync, attemptId: string) {
  const a = one<any>(db, "SELECT reconcile_checks, dispatched_at, started_at, tenant_id FROM attempts WHERE id=?", attemptId)!;
  const n = a.reconcile_checks;
  if (n >= RECONCILE_SCHEDULE_MIN.length) {
    run(db, "UPDATE attempts SET next_reconcile_at=NULL WHERE id=?", attemptId);
    return;
  }
  const base = toMs(nowIso(db, a.tenant_id));
  const prev = n === 0 ? 0 : RECONCILE_SCHEDULE_MIN[n - 1];
  run(db, "UPDATE attempts SET next_reconcile_at=? WHERE id=?", toLocalIso(base + (RECONCILE_SCHEDULE_MIN[n] - prev) * 60_000), attemptId);
}

/** Enqueue reconciliation jobs whose demo-time check is due. */
export function enqueueDueReconciliations(db: DatabaseSync): number {
  let n = 0;
  for (const a of all<any>(db, "SELECT a.id, a.tenant_id, a.next_reconcile_at, a.route, pa.merchant_id, pa.spec_json FROM attempts a JOIN proposal_actions pa ON pa.id=a.action_id WHERE a.status IN ('UNKNOWN','PENDING') AND a.next_reconcile_at IS NOT NULL")) {
    if (toMs(a.next_reconcile_at) > nowMs(db, a.tenant_id)) continue;
    const spec = json<ActionSpec>(a.spec_json);
    enqueueJob(db, { tenantId: a.tenant_id, kind: "RECONCILE", refId: a.id, route: "PARTNER_API", priority: 2, concurrencyKey: `${spec.merchantId}|${spec.subscriberAccountId}`, userKey: `${a.tenant_id}|reconcile`, requeue: true });
    n++;
  }
  return n;
}

export async function runReconcileJob(db: DatabaseSync, job: Job, ctx: WorkerCtx): Promise<void> {
  const attempt = one<any>(db, "SELECT * FROM attempts WHERE id=?", job.ref_id);
  if (!attempt || !["UNKNOWN", "PENDING"].includes(attempt.status)) return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  const action = one<any>(db, "SELECT * FROM proposal_actions WHERE id=?", attempt.action_id)!;
  const spec = json<ActionSpec>(action.spec_json);
  const client = new MerchantClient(db, action.tenant_id);
  run(db, "UPDATE attempts SET reconcile_checks=reconcile_checks+1, next_reconcile_at=NULL WHERE id=?", attempt.id);
  const checkNo = attempt.reconcile_checks + 1;
  const taskId = taskIdForAction(db, action.id);
  // A bank-internal step is reconciled against the bank's own records only; the merchant never saw it.
  if (spec.route === "BANK_INTERNAL") {
    try {
      if (spec.operation === "INTERNAL_TRANSFER") reconcileInternalTransfer(db, attempt, action, spec, checkNo);
      else reconcileBankInternal(db, attempt, action, spec, checkNo);
    } catch (e: any) {
      ctx.log(`[worker] reconcile ${attempt.id} error ${String(e?.message ?? e).slice(0, 160)}`);
      scheduleNextCheck(db, attempt.id);
    }
    return void finishJob(db, job, ctx.workerId, { status: "DONE" });
  }
  try {
    const reqs = await client.findRequests(spec.merchantId!, spec.subscriberAccountId!, attempt.correlation_id);
    if (reqs.status === 401) {
      taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: provider session expired; outcome still unknown`, evidence: "SIMULATED_MERCHANT_API" });
      if (attempt.status === "UNKNOWN") scheduleNextCheck(db, attempt.id);
      return void finishJob(db, job, ctx.workerId, { status: "DONE" });
    }
    const req = reqs.requests?.find((x) => x.correlationId === attempt.correlation_id);
    if (req) {
      taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: provider shows the request as ${req.status.replace(/_/g, " ").toLowerCase()}`, evidence: "SIMULATED_MERCHANT_API" });
      if (req.status === "PENDING_REVIEW") {
        if (attempt.status !== "PENDING") tx(db, () => recordSettled(db, action.id, attempt.id, "PENDING", { reason: "The provider received the request and is reviewing it" }));
        scheduleReconcile(db, attempt.id, PENDING_RECHECK_MIN);
      } else {
        await verifyAndConfirm(db, client, action, spec, attempt.id, attempt.correlation_id, attempt.route === "ISOLATED_BROWSER" ? "WEB" : "API", `reconciliation check ${checkNo}`);
      }
      return void finishJob(db, job, ctx.workerId, { status: "DONE" });
    }
    // Not visible. An API request with an idempotency key may be replayed safely (the provider deduplicates),
    // but only while the approval was not stopped. Website requests are never resubmitted automatically.
    const mandate = one<any>(db, "SELECT m.status FROM grants g JOIN mandates m ON m.id=g.mandate_id WHERE g.id=?", attempt.grant_id);
    if (attempt.route === "PARTNER_API" && attempt.status === "UNKNOWN" && mandate?.status === "ACTIVE") {
      taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: not visible; replaying the same request with the same idempotency key`, evidence: "SIMULATED_MERCHANT_API" });
      const resp = await client.operate(spec.merchantId!, spec.subscriberAccountId!, spec.contractId, { operation: spec.operation as any, expectedTermsRevision: spec.termsRevision, params: spec.params }, { correlationId: attempt.correlation_id, idempotencyKey: attempt.idempotency_key });
      await handleApiResponse(db, client, action, spec, attempt.id, attempt.correlation_id, resp, "API");
      return void finishJob(db, job, ctx.workerId, { status: "DONE" });
    }
    taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo} of ${RECONCILE_SCHEDULE_MIN.length}: the provider does not show a result yet; not resubmitting`, evidence: attempt.route === "ISOLATED_BROWSER" ? "SIMULATED_MERCHANT_BROWSER" : "SIMULATED_MERCHANT_API" });
    if (attempt.status === "UNKNOWN") {
      scheduleNextCheck(db, attempt.id);
      if (checkNo >= RECONCILE_SCHEDULE_MIN.length) run(db, "UPDATE proposal_actions SET result_json=json_set(COALESCE(result_json,'{}'), '$.reason', ?) WHERE id=?", "Still unknown after 5 checks in 24 hours. Check with the provider; NextMove will not resubmit.", action.id);
    } else scheduleReconcile(db, attempt.id, PENDING_RECHECK_MIN);
  } catch (e: any) {
    ctx.log(`[worker] reconcile ${attempt.id} error ${String(e?.message ?? e).slice(0, 160)}`);
    if (attempt.status === "UNKNOWN") scheduleNextCheck(db, attempt.id);
  }
  finishJob(db, job, ctx.workerId, { status: "DONE" });
}

/**
 * Reconcile an UNKNOWN bank-internal attempt other than a transfer (the worker stopped between the gate and the
 * commit, or the step threw). Each such step writes its change and its receipt in one fenced transaction, so the
 * bank's own records answer the question: the action's receipt, cross-checked against the record the step changes,
 * means it happened; neither means the transaction rolled back and nothing changed. A disagreement stays UNKNOWN.
 */
function reconcileBankInternal(db: DatabaseSync, attempt: any, action: any, spec: ActionSpec, checkNo: number) {
  const t = action.tenant_id;
  const taskId = taskIdForAction(db, action.id);
  const receipt = one<any>(db, "SELECT * FROM receipts WHERE tenant_id=? AND (action_id=? OR attempt_id=?) AND status='CONFIRMED' ORDER BY verified_at LIMIT 1", t, action.id, attempt.id);
  const effect = bankEffectRecord(db, action, spec, attempt, Boolean(receipt));
  if (receipt && effect?.found !== false) {
    taskEvent(db, { taskId, tenantId: t, kind: "reconcile", label: `Check ${checkNo}: the bank's records show this step (ref ${receipt.issuer_reference}); recording it`, evidence: "BANK_RECORD" });
    const ver = json<any>(receipt.verification_json, {});
    tx(db, () =>
      recordConfirmed(db, action.id, attempt.id, {
        issuer: receipt.issuer,
        reference: receipt.issuer_reference,
        effectiveAt: receipt.effective_at,
        accessUntil: receipt.access_until,
        termsRevision: receipt.terms_revision,
        details: json<any>(receipt.money_effect_json, {})?.details ?? {},
        channel: "BANK",
        verification: { method: `bank record read back (reconciliation check ${checkNo})`, checks: [`receipt ${receipt.issuer_reference} for this action`, ...(effect ? [effect.label] : [])] },
        evidence: (ver.evidence ?? "BANK_RECORD") as EvidenceLevel,
      }),
    );
    return;
  }
  if (!receipt && !effect?.found) {
    taskEvent(db, { taskId, tenantId: t, kind: "reconcile", label: `Check ${checkNo}: the bank has no record of this step; it was rolled back and nothing changed`, evidence: "BANK_RECORD" });
    tx(db, () => recordSettled(db, action.id, attempt.id, "BLOCKED", { reason: "The bank step stopped before it was recorded, so nothing was changed. Approve it again to retry." }));
    return;
  }
  taskEvent(db, { taskId, tenantId: t, kind: "reconcile", label: `Check ${checkNo} of ${RECONCILE_SCHEDULE_MIN.length}: the bank's records disagree (${receipt ? `receipt ${receipt.issuer_reference}, ${effect!.label}` : `${effect!.label}, no receipt`}); outcome still unknown`, evidence: "BANK_RECORD" });
  scheduleNextCheck(db, attempt.id);
  if (checkNo >= RECONCILE_SCHEDULE_MIN.length) run(db, "UPDATE proposal_actions SET result_json=json_set(COALESCE(result_json,'{}'), '$.reason', ?) WHERE id=?", "Still unknown after 5 checks: the bank's records disagree about this step. NextMove will not retry it; contact the bank.", action.id);
}

/**
 * The record a bank-internal step changes, read independently of its receipt. Null when the receipt itself is that
 * record (a Trial Shield block, an extension step) or, for a card, once a receipt exists (the card may have changed since).
 */
function bankEffectRecord(db: DatabaseSync, action: any, spec: ActionSpec, attempt: any, hasReceipt: boolean): { found: boolean; label: string } | null {
  const posting = (sourceEventId: string) => {
    const e = one<any>(db, "SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", action.tenant_id, sourceEventId);
    return { found: Boolean(e), label: e ? `ledger entry ${e.id}` : "no ledger posting" };
  };
  switch (spec.operation) {
    case "PAYMENT":
      return posting(`payment:${action.logical_key}`);
    case "OWNER_TRANSFER":
      return posting(`transfer:${action.logical_key}`);
    case "HOLD_ALLOW":
      return posting(`shield-allow:${spec.subjectRef}`);
    case "CARD_FREEZE": {
      if (hasReceipt) return null;
      const card = json<any>(one<any>(db, "SELECT card_json FROM accounts WHERE id=? AND tenant_id=?", spec.params.accountId, action.tenant_id)?.card_json, null);
      const reference = `NMC-${sha256Hex(`${action.logical_key}:${attempt.id}`).slice(0, 8).toUpperCase()}`;
      const found = card?.statusReference === reference;
      return { found, label: found ? `card status set under ${reference}` : "card status not changed by this step" };
    }
    default:
      return null;
  }
}

/** Manual "check again" from the exception screen: an immediate extra read, never a resubmission. */
export function requestReconcileNow(db: DatabaseSync, tenantId: string, actionId: string): boolean {
  const a = one<any>(db, "SELECT id FROM attempts WHERE tenant_id=? AND action_id=? AND status IN ('UNKNOWN','PENDING') ORDER BY started_at DESC LIMIT 1", tenantId, actionId);
  if (!a) return false;
  run(db, "UPDATE attempts SET next_reconcile_at=?, reconcile_checks=MIN(reconcile_checks, ?) WHERE id=?", nowIso(db, tenantId), RECONCILE_SCHEDULE_MIN.length - 1, a.id);
  return true;
}
