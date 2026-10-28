import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run } from "../db/connection";
import { shortId } from "../canonical";
import { nowIso } from "../clock";
import { applyForecastEvent } from "../bank/forecast";
import { postCardOrTransfer, postInternalTransfer } from "../bank/ledger";
import { notify, taskEvent, taskIdForAction, type EvidenceLevel } from "../agent/events";
import { formatMoney } from "../../shared/money";
import { formatDay } from "../../shared/time";
import type { ActionSpec } from "../authority/actions";
import { applyInternalTransferEffects } from "./internal-transfer-effects";

// Applying a verified outcome. Everything here runs inside the caller's transaction and is keyed by a unique
// authoritative source (receipt or bank entry), so a repeated confirmation, reconciliation or event is a no-op.

export interface ConfirmedResult {
  issuer: string;
  reference: string;
  effectiveAt: string | null;
  accessUntil: string | null;
  termsRevision: number | null;
  details: Record<string, any>;
  channel: "API" | "WEB" | "BANK";
  verification: { method: string; checks: string[] };
  evidence: EvidenceLevel;
}

export type SettledStatus = "CONFIRMED" | "PENDING" | "REFUSED" | "UNKNOWN" | "BLOCKED" | "TERMS_CHANGED" | "REVOKED" | "EXPIRED" | "NO_CHANGE" | "NOT_STARTED" | "OUTDATED";

const BATCH_OUTCOME: Record<string, string> = {
  CONFIRMED: "CONFIRMED",
  PENDING: "WAITING_EXTERNAL",
  REFUSED: "REFUSED",
  UNKNOWN: "OUTCOME_UNKNOWN",
  BLOCKED: "NEEDS_AUTH",
  TERMS_CHANGED: "TERMS_CHANGED",
  REVOKED: "NOT_STARTED",
  EXPIRED: "NOT_STARTED",
  NOT_STARTED: "NOT_STARTED",
  OUTDATED: "TERMS_CHANGED",
  NO_CHANGE: "ALREADY_OFF",
};

export function recordConfirmed(db: DatabaseSync, actionId: string, attemptId: string | null, res: ConfirmedResult): { receiptId: string; duplicate: boolean } {
  const action = one<any>(db, "SELECT * FROM proposal_actions WHERE id=?", actionId)!;
  const spec = json<ActionSpec>(action.spec_json);
  const t = action.tenant_id;
  const existing = one<any>(db, "SELECT id FROM receipts WHERE tenant_id=? AND issuer=? AND issuer_reference=?", action.tenant_id, res.issuer, res.reference);
  const at = nowIso(db, t);
  let receiptId = existing?.id as string | undefined;
  if (!receiptId) {
    receiptId = shortId("rcp");
    run(
      db,
      `INSERT INTO receipts(id, tenant_id, context_id, action_id, attempt_id, issuer, issuer_reference, operation, status, effective_at, access_until, terms_revision, money_effect_json, verification_json, verified_at)
       VALUES (?,?,?,?,?,?,?,?, 'CONFIRMED', ?,?,?,?,?,?)`,
      receiptId, t, action.context_id, actionId, attemptId, res.issuer, res.reference, spec.operation, res.effectiveAt, res.accessUntil, res.termsRevision,
      JSON.stringify({ forecastChangeMinor: spec.money.forecastChangeMinor, details: res.details }), JSON.stringify({ ...res.verification, channel: res.channel, evidence: res.evidence }), at,
    );
  }
  if (attemptId) run(db, "UPDATE attempts SET status='CONFIRMED', finished_at=?, outcome_json=?, next_reconcile_at=NULL WHERE id=?", new Date().toISOString(), JSON.stringify({ reference: res.reference, details: res.details }), attemptId);
  const already = action.status === "CONFIRMED";
  run(db, "UPDATE proposal_actions SET status='CONFIRMED', result_json=?, updated_at=? WHERE id=?", JSON.stringify({ receiptId, reference: res.reference, effectiveAt: res.effectiveAt, accessUntil: res.accessUntil, details: res.details }), at, actionId);
  if (!existing && !already) applyEffects(db, action, spec, receiptId, res);
  syncBatchItem(db, actionId);
  if (!existing && !already) {
    const taskId = taskIdForAction(db, actionId);
    taskEvent(db, { taskId, tenantId: t, kind: "receipt", label: `${spec.merchantName ?? "NextMove"} confirmed: ${spec.display.title} (ref ${res.reference})`, evidence: res.evidence, payload: { receiptId, actionId, verification: res.verification } });
    if (!one(db, "SELECT 1 FROM batch_items WHERE action_id=?", actionId)) {
      notify(db, { tenantId: t, contextId: action.context_id, title: `${spec.display.title}: confirmed`, body: `${spec.merchantName ?? "NextMove"} reference ${res.reference}.`, link: `/receipts/${receiptId}`, dedupeKey: `ntf:rcp:${receiptId}` });
    }
  }
  return { receiptId, duplicate: Boolean(existing) };
}

export function recordSettled(db: DatabaseSync, actionId: string, attemptId: string | null, status: Exclude<SettledStatus, "CONFIRMED">, detail: Record<string, unknown>) {
  const action = one<any>(db, "SELECT * FROM proposal_actions WHERE id=?", actionId)!;
  if (action.status === "CONFIRMED") return;
  const at = nowIso(db, action.tenant_id);
  if (attemptId) {
    const attemptStatus = status === "NO_CHANGE" ? "CONFIRMED" : status === "REVOKED" || status === "EXPIRED" || status === "NOT_STARTED" ? "NOT_DISPATCHED" : status;
    run(db, "UPDATE attempts SET status=?, finished_at=CASE WHEN ? IN ('UNKNOWN','PENDING') THEN finished_at ELSE ? END, outcome_json=? WHERE id=?", attemptStatus, status, new Date().toISOString(), JSON.stringify(detail), attemptId);
  }
  run(db, "UPDATE proposal_actions SET status=?, result_json=?, updated_at=? WHERE id=?", status, JSON.stringify(detail), at, actionId);
  // An action settled before its dispatch (sign-in needed, refused at the pre-check, already in place) closes its
  // unused grant: a later attempt needs a fresh approval, and Stop must not count it as revoked work.
  if (status === "BLOCKED" || status === "REFUSED" || status === "NO_CHANGE" || status === "NOT_STARTED") {
    run(db, "UPDATE grants SET status='INVALIDATED', invalid_reason=? WHERE action_id=? AND status='ACTIVE'", `settled ${status.toLowerCase().replace(/_/g, " ")} before dispatch`, actionId);
  }
  syncBatchItem(db, actionId);
  const spec = json<ActionSpec>(action.spec_json);
  const taskId = taskIdForAction(db, actionId);
  const label: Record<string, string> = {
    PENDING: "waiting for the provider",
    REFUSED: "refused by the provider",
    UNKNOWN: "outcome unknown: checking with the provider before anything else",
    BLOCKED: "needs you: sign in on the provider page",
    TERMS_CHANGED: "terms changed: nothing was sent",
    REVOKED: "stopped before it started",
    EXPIRED: "approval expired before it started",
    NO_CHANGE: "already in the requested state",
    NOT_STARTED: "not started",
    OUTDATED: "needs a fresh check",
  };
  taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "attempt", label: `${spec.display.title}: ${label[status] ?? status.toLowerCase()}`, evidence: spec.route === "ISOLATED_BROWSER" ? "SIMULATED_MERCHANT_BROWSER" : spec.route === "PARTNER_API" ? "SIMULATED_MERCHANT_API" : "BANK_RECORD", payload: { actionId, status, ...detail } });
}

export function syncBatchItem(db: DatabaseSync, actionId: string) {
  const item = one<any>(db, "SELECT * FROM batch_items WHERE action_id=?", actionId);
  if (!item) return;
  const a = one<any>(db, "SELECT status, result_json FROM proposal_actions WHERE id=?", actionId)!;
  const outcome = BATCH_OUTCOME[a.status] ?? (a.status === "APPROVED" || a.status === "EXECUTING" ? "IN_PROGRESS" : a.status);
  const result = json<any>(a.result_json, {});
  run(
    db,
    "UPDATE batch_items SET outcome=?, outcome_detail=?, receipt_id=COALESCE(?, receipt_id), forecast_applied=CASE WHEN ?='CONFIRMED' THEN 1 ELSE forecast_applied END, updated_at=? WHERE id=?",
    outcome, result?.reason ?? result?.detail ?? null, result?.receiptId ?? null, a.status, new Date().toISOString(), item.id,
  );
  refreshBatchStatus(db, item.batch_id);
}

export function refreshBatchStatus(db: DatabaseSync, batchId: string) {
  const b = one<any>(db, "SELECT * FROM batches WHERE id=?", batchId);
  if (!b || !["APPROVED", "RUNNING", "NEEDS_ATTENTION", "STOPPED", "COMPLETED"].includes(b.status)) return;
  const rows = all<any>(db, "SELECT outcome FROM batch_items WHERE batch_id=? AND selected=1", batchId);
  const open = rows.filter((r) => r.outcome === "IN_PROGRESS" || r.outcome == null).length;
  const attention = rows.filter((r) => ["OUTCOME_UNKNOWN", "NEEDS_AUTH", "TERMS_CHANGED", "REFUSED", "WAITING_EXTERNAL"].includes(r.outcome)).length;
  let status = b.status;
  if (b.status === "STOPPED") status = "STOPPED";
  else if (open > 0) status = "RUNNING";
  else status = attention > 0 ? "NEEDS_ATTENTION" : "COMPLETED";
  if (status !== b.status) run(db, "UPDATE batches SET status=?, updated_at=? WHERE id=?", status, new Date().toISOString(), batchId);
}

/* ------------------------------------------------------------------------------------------ effects */

function itemsFor(db: DatabaseSync, tenantId: string, subscriptionId: string) {
  return all<any>(db, "SELECT * FROM forecast_items WHERE tenant_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at", tenantId, subscriptionId);
}

function applyEffects(db: DatabaseSync, action: any, spec: ActionSpec, receiptId: string, res: ConfirmedResult) {
  const t = action.tenant_id;
  const ctx = action.context_id;
  const src = `rcp:${res.issuer}:${res.reference}`;
  const at = nowIso(db, t);
  const d = res.details ?? {};
  const sub = spec.subjectRef ? one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=?", spec.subjectRef, t) : null;
  switch (spec.operation) {
    case "STOP_RENEWAL": {
      if (!sub) break;
      run(db, "UPDATE subscriptions SET state='RENEWAL_OFF', next_charge_at=NULL, access_until=COALESCE(?, access_until), terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", res.accessUntil, res.termsRevision, res.termsRevision, at, sub.id);
      for (const it of itemsFor(db, t, sub.id)) applyForecastEvent(db, { sourceEventId: `${src}:${it.id}`, tenantId: t, kind: "REMOVE", itemId: it.id, reason: `Renewal off confirmed by ${spec.merchantName} (${res.reference})` });
      break;
    }
    case "CHANGE_PLAN": {
      if (!sub) break;
      const price = Number(d.newPriceMinor);
      run(db, "UPDATE subscriptions SET plan_name=?, amount_minor=?, terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", String(d.toPlan ?? sub.plan_name), price, res.termsRevision, res.termsRevision, at, sub.id);
      const next = itemsFor(db, t, sub.id)[0];
      if (next) applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { amountMinor: -price, label: `${spec.merchantName} ${d.toPlan}` }, reason: `Plan change confirmed (${res.reference})` });
      break;
    }
    case "PAUSE": {
      if (!sub) break;
      const data = { ...json<any>(sub.data_json, {}), pause: { startsAt: res.effectiveAt, resumesAt: d.resumesAt, months: d.months, reference: res.reference } };
      run(db, "UPDATE subscriptions SET next_charge_at=?, data_json=?, terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", d.resumesAt, JSON.stringify(data), res.termsRevision, res.termsRevision, at, sub.id);
      const next = itemsFor(db, t, sub.id)[0];
      if (next) applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { dueAt: String(d.resumesAt), label: `${spec.merchantName} renewal after pause` }, reason: `Pause confirmed (${res.reference})` });
      break;
    }
    case "CHANGE_BILLING_DATE": {
      if (!sub) break;
      const data = { ...json<any>(sub.data_json, {}), billingDay: d.billingDay, prorationMinor: d.prorationMinor };
      run(db, "UPDATE subscriptions SET next_charge_at=?, data_json=?, terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", d.firstBillAt, JSON.stringify(data), res.termsRevision, res.termsRevision, at, sub.id);
      const next = itemsFor(db, t, sub.id)[0];
      if (next) applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { dueAt: String(d.firstBillAt), amountMinor: -Number(d.firstBillAmountMinor) }, reason: `Billing date change confirmed (${res.reference})` });
      break;
    }
    case "CHANGE_BILLING_PERIOD": {
      if (!sub) break;
      run(db, "UPDATE subscriptions SET billing_period='ANNUAL', amount_minor=?, terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", Number(d.annualChargeMinor), res.termsRevision, res.termsRevision, at, sub.id);
      const next = itemsFor(db, t, sub.id)[0];
      if (next) applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { amountMinor: -Number(d.annualChargeMinor), label: `${spec.merchantName} annual plan` }, reason: `Annual billing confirmed (${res.reference})` });
      break;
    }
    case "ACTIVATE_OFFER": {
      const newId = `${t}:sub:${spec.merchantId}-bundle`;
      if (!one(db, "SELECT id FROM subscriptions WHERE id=?", newId)) {
        run(
          db,
          `INSERT INTO subscriptions(id, tenant_id, context_id, dataset, category, merchant_id, merchant_name, subscriber_account_id, contract_id, canonical_key, plan_name, amount_minor, currency, billing_period, state, next_charge_at, access_until, terms_revision, observed_revision, last_observed_at, benefits_json, data_json)
           VALUES (?,?,?, 'ui', 'SUBSCRIPTION', ?,?,?,?,?,?,?, 'RON', 'MONTHLY', 'SCHEDULED', ?, NULL, ?, ?, ?, ?, ?)`,
          newId, t, ctx, spec.merchantId, spec.merchantName, spec.subscriberAccountId, String(d.contractId), `${spec.merchantId}|${spec.subscriberAccountId}|${d.contractId}`,
          String(spec.params.offerName ?? "Student bundle"), Number(d.monthlyMinor), d.firstChargeAt, res.termsRevision ?? 1, res.termsRevision ?? 1, at,
          JSON.stringify(spec.params.benefits ?? {}), JSON.stringify({ activatedBy: res.reference, offerId: spec.params.offerId }),
        );
      }
      applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "ADD", add: { tenantId: t, contextId: ctx, dataset: "ui", subscriptionId: newId, kind: "RENEWAL", label: `${spec.params.offerName ?? "Bundle"} first charge`, amountMinor: -Number(d.monthlyMinor), dueAt: String(d.firstChargeAt), source: src }, reason: `Offer activated (${res.reference})` });
      break;
    }
    case "VERIFY_ELIGIBILITY": {
      run(db, "INSERT INTO facts(id, tenant_id, context_id, task_id, key, value_json, provenance, source_ref, revision, created_at) VALUES (?,?,?,?,?,?, 'MERCHANT', ?, 1, ?)", shortId("fact"), t, ctx, taskIdForAction(db, action.id), "student_status", JSON.stringify({ status: d.studentVerification, validUntil: d.validUntil }), res.reference, at);
      break;
    }
    case "START_MIGRATION": {
      if (!sub) break;
      const data = { ...json<any>(sub.data_json, {}), migration: { state: "IN_PROGRESS", destination: d.destination, completesAt: d.completesAt, reference: res.reference } };
      run(db, "UPDATE subscriptions SET data_json=? WHERE id=?", JSON.stringify(data), sub.id);
      break;
    }
    case "REDUCE_SEATS": {
      if (!sub) break;
      const next = itemsFor(db, t, sub.id)[0];
      const data = { ...json<any>(sub.data_json, {}), seats: d.seatsAfter, removedSeatIds: d.removedSeatIds };
      run(db, "UPDATE subscriptions SET amount_minor=?, plan_name=?, data_json=?, terms_revision=COALESCE(?, terms_revision), observed_revision=COALESCE(?, observed_revision), last_observed_at=? WHERE id=?", Number(d.nextInvoiceMinor), `${String(sub.plan_name).split(",")[0]}, ${d.seatsAfter} seats`, JSON.stringify(data), res.termsRevision, res.termsRevision, at, sub.id);
      if (next) applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { amountMinor: -Number(d.nextInvoiceMinor) }, reason: `Seat reduction confirmed (${res.reference}); applies from the next invoice` });
      break;
    }
    case "SUBMIT_CLAIM": {
      const rec = one<any>(db, "SELECT * FROM recoveries WHERE id=? AND tenant_id=?", spec.subjectRef, t);
      if (!rec) break;
      const timeline = [...json<any[]>(rec.timeline_json, []), { at, state: "SUBMITTED", label: `Claim submitted to ${spec.merchantName} (case ${d.caseId})` }];
      run(db, "UPDATE recoveries SET state='SUBMITTED', reference=?, timeline_json=?, data_json=?, updated_at=? WHERE id=?", String(d.caseId), JSON.stringify(timeline), JSON.stringify({ ...json<any>(rec.data_json, {}), caseId: d.caseId, reviewExpectedBy: d.reviewExpectedBy }), at, rec.id);
      break;
    }
    case "PLACE_ORDER": {
      const charge = Number(d.cardChargeMinor ?? 0);
      const grant = one<any>(db, "SELECT max_debit_minor FROM grants WHERE action_id=?", action.id);
      if (charge > 0) {
        // verifyAndConfirm settles an over-approval charge before any receipt exists; reaching this means a caller
        // skipped that check, so the whole confirmation (receipt, attempt, action) rolls back instead of half-applying.
        if (!grant || charge > grant.max_debit_minor) throw new Error(`card charge ${charge} exceeds the approved maximum`);
        postCardOrTransfer(db, {
          tenantId: t, contextId: ctx, accountId: String(spec.params.debitAccountId), sourceEventId: `card:${res.issuer}:${res.reference}`, amountMinor: -charge,
          merchantName: spec.merchantName ?? res.issuer, merchantId: spec.merchantId, category: String(spec.params.category ?? "Shopping"), reference: res.reference, bookedAt: at,
          note: spec.params.creditId ? `Credit ${spec.params.creditId} applied: ${formatMoney(Number(spec.params.creditAppliedMinor))}` : null, data: { approvedMaxDebitMinor: grant.max_debit_minor },
        });
      }
      const benefit = Number(spec.params.benefitCreditMinor ?? 0);
      if (charge > 0 && benefit > 0 && benefit <= charge) {
        postCardOrTransfer(db, { tenantId: t, contextId: ctx, accountId: String(spec.params.debitAccountId), sourceEventId: `benefit:${res.issuer}:${res.reference}`, amountMinor: benefit, merchantName: "NextMove travel credit", category: "Card benefit", reference: res.reference, bookedAt: at, note: `${spec.params.benefitId} applied to ${spec.merchantName}` });
      }
      if (spec.params.creditId) run(db, "UPDATE watches SET status='DONE', last_result=? WHERE tenant_id=? AND kind='CREDIT_EXPIRY'", `Redeemed in order ${res.reference}`, t);
      for (const p of (spec.params.paymentSchedule as any[] | undefined) ?? []) {
        applyForecastEvent(db, { sourceEventId: `${src}:pay:${p.dueAt}`, tenantId: t, kind: "ADD", add: { tenantId: t, contextId: ctx, dataset: "bills", kind: "SUPPLIER_PAYMENT", label: `${spec.merchantName} payment (order ${res.reference})`, amountMinor: -Number(p.amountMinor), dueAt: String(p.dueAt), source: src }, reason: `Order confirmed (${res.reference})` });
      }
      if (spec.params.recordId) {
        const rec = one<any>(db, "SELECT * FROM business_records WHERE id=? AND tenant_id=?", spec.params.recordId, t);
        if (rec) run(db, "UPDATE business_records SET data_json=?, revision=revision+1, updated_at=? WHERE id=?", JSON.stringify({ ...json<any>(rec.data_json, {}), placedOrder: { reference: res.reference, supplier: spec.merchantName, at } }), new Date().toISOString(), rec.id);
      }
      break;
    }
    case "SCHEDULE_START": {
      applyForecastEvent(db, { sourceEventId: src, tenantId: t, kind: "ADD", add: { tenantId: t, contextId: ctx, dataset: "scenario", kind: "ORDER", label: `${spec.merchantName} month from ${formatDay(String(d.firstChargeAt))} (no auto-renew)`, amountMinor: -Number(d.priceMinor), dueAt: String(d.firstChargeAt), source: src }, reason: `Scheduled start confirmed (${res.reference})` });
      break;
    }
    case "SEND_MESSAGE":
    case "FOLLOW_UP": {
      if (spec.params.recordId) {
        const rec = one<any>(db, "SELECT * FROM business_records WHERE id=? AND tenant_id=?", spec.params.recordId, t);
        if (rec) {
          const data = json<any>(rec.data_json, {});
          for (const inv of data.invoices ?? []) if (inv.invoiceNumber === spec.params.invoiceNumber) inv.status = "REMINDER_SENT";
          run(db, "UPDATE business_records SET data_json=?, revision=revision+1, updated_at=? WHERE id=?", JSON.stringify(data), new Date().toISOString(), rec.id);
        }
      }
      if (spec.operation === "FOLLOW_UP" && spec.subjectRef) {
        const rec = one<any>(db, "SELECT * FROM recoveries WHERE id=? AND tenant_id=?", spec.subjectRef, t);
        if (rec) run(db, "UPDATE recoveries SET timeline_json=?, updated_at=? WHERE id=?", JSON.stringify([...json<any[]>(rec.timeline_json, []), { at, state: rec.state, label: `Follow-up sent to ${spec.merchantName}` }]), at, rec.id);
      }
      break;
    }
    case "OWNER_TRANSFER": {
      postInternalTransfer(db, { tenantId: t, sourceEventId: `transfer:${action.logical_key}`, fromAccountId: String(spec.params.fromAccountId), toAccountId: String(spec.params.toAccountId), amountMinor: Number(spec.params.amountMinor), description: String(spec.params.description ?? "Owner transfer"), bookedAt: at, reference: res.reference });
      if (spec.params.forecastItemId) applyForecastEvent(db, { sourceEventId: `${src}:settle`, tenantId: t, kind: "SETTLE", itemId: String(spec.params.forecastItemId), reason: `Transfer posted (${res.reference})` });
      break;
    }
    case "PAYMENT": {
      postCardOrTransfer(db, { tenantId: t, contextId: ctx, accountId: String(spec.params.fromAccountId), sourceEventId: `payment:${action.logical_key}`, amountMinor: -Number(spec.params.amountMinor), merchantName: spec.merchantName ?? "Payee", merchantId: spec.merchantId, category: String(spec.params.category ?? "Supplier"), reference: res.reference, bookedAt: at, note: String(spec.params.description ?? "") });
      if (spec.params.forecastItemId) applyForecastEvent(db, { sourceEventId: `${src}:settle`, tenantId: t, kind: "SETTLE", itemId: String(spec.params.forecastItemId), reason: `Payment posted (${res.reference})` });
      break;
    }
    case "INTERNAL_TRANSFER": {
      applyInternalTransferEffects(db, action, spec, src);
      break;
    }
    case "CARD_FREEZE": {
      const acct = one<any>(db, "SELECT card_json FROM accounts WHERE id=? AND tenant_id=?", spec.params.accountId, t);
      if (acct?.card_json) {
        const card = JSON.parse(acct.card_json);
        card.status = spec.params.targetStatus === "FROZEN" ? "FROZEN" : "ACTIVE";
        card.statusChangedAt = at;
        card.statusReference = res.reference;
        run(db, "UPDATE accounts SET card_json=? WHERE id=? AND tenant_id=?", JSON.stringify(card), spec.params.accountId, t);
      }
      break;
    }
    default:
      break;
  }
}
