import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { hmacHex, safeEqual, shortId } from "../canonical";
import { localSecrets } from "../config";
import { nowIso } from "../clock";
import { applyForecastEvent } from "../bank/forecast";
import { postCardOrTransfer } from "../bank/ledger";
import { invalidateForSubject } from "../authority/authority";
import { notify, taskEvent } from "../agent/events";
import { scheduleReconcile } from "./executor";
import { formatMoney } from "../../shared/money";
import { formatDay } from "../../shared/time";
import type { MerchantEvent } from "../../shared/merchant-contract";

// Signed provider / payment-network events. Stored once per (issuer, event id), then applied exactly once.
// Accepted refunds or promises never change cash; only a unique credit transfer posts money.

const KINDS = new Set(["request.resolved", "offer.terms_changed", "refund.accepted", "claim.updated", "counterparty.reply", "credit_transfer", "migration.completed", "contract.updated"]);

export function verifyInboxSignature(raw: string, signature: string | null): boolean {
  if (!signature) return false;
  return safeEqual(signature, `sha256=${hmacHex(localSecrets().partnerHmacKey, raw)}`);
}

export function storeInboxEvent(db: DatabaseSync, raw: string): { ok: boolean; duplicate?: boolean; error?: string; issuer?: string; eventId?: string } {
  let ev: MerchantEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!ev || typeof ev.eventId !== "string" || typeof ev.issuer !== "string" || typeof ev.tenantId !== "string" || !KINDS.has(ev.kind)) return { ok: false, error: "invalid event" };
  if (!one(db, "SELECT id FROM tenants WHERE id=?", ev.tenantId)) return { ok: true, duplicate: true }; // unknown/removed tenant: acknowledge, ignore
  const r = run(db, "INSERT OR IGNORE INTO inbox_events(issuer, event_id, tenant_id, kind, payload_json, received_at) VALUES (?,?,?,?,?,?)", ev.issuer, ev.eventId, ev.tenantId, ev.kind, raw, new Date().toISOString());
  return { ok: true, duplicate: Number(r.changes) === 0, issuer: ev.issuer, eventId: ev.eventId };
}

export function applyPendingInbox(db: DatabaseSync, limit = 50): number {
  let n = 0;
  for (const row of all<any>(db, "SELECT * FROM inbox_events WHERE applied_at IS NULL ORDER BY received_at LIMIT ?", limit)) {
    try {
      tx(db, () => {
        const fresh = one<any>(db, "SELECT applied_at FROM inbox_events WHERE tenant_id=? AND issuer=? AND event_id=?", row.tenant_id, row.issuer, row.event_id);
        if (fresh?.applied_at) return;
        const result = applyEvent(db, JSON.parse(row.payload_json));
        run(db, "UPDATE inbox_events SET applied_at=?, result=? WHERE tenant_id=? AND issuer=? AND event_id=?", new Date().toISOString(), result.slice(0, 300), row.tenant_id, row.issuer, row.event_id);
      });
      n++;
    } catch (e: any) {
      run(db, "UPDATE inbox_events SET result=? WHERE tenant_id=? AND issuer=? AND event_id=?", `error: ${String(e?.message ?? e).slice(0, 200)}`, row.tenant_id, row.issuer, row.event_id);
    }
  }
  return n;
}

function applyEvent(db: DatabaseSync, ev: MerchantEvent): string {
  const t = ev.tenantId;
  const d = ev.data as any;
  const at = nowIso(db, t);
  switch (ev.kind) {
    case "request.resolved": {
      const a = d.correlationId ? one<any>(db, "SELECT id FROM attempts WHERE tenant_id=? AND correlation_id=?", t, d.correlationId) : null;
      if (!a) return "no matching attempt";
      scheduleReconcile(db, a.id, 0);
      return `reconcile scheduled for ${a.id}`;
    }
    case "offer.terms_changed": {
      const watch = one<any>(db, "SELECT * FROM watches WHERE tenant_id=? AND kind='OFFER_TERMS' AND status='ACTIVE' AND json_extract(condition_json,'$.offerId')=?", t, d.offerId);
      const inv = invalidateForSubject(db, t, { offerId: String(d.offerId) }, `offer terms changed to revision ${d.revision}`);
      run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES (?,?,?)", `offer:${t}:${d.offerId}`, JSON.stringify({ revision: d.revision, changes: d.changes }), new Date().toISOString());
      if (watch) {
        run(db, "UPDATE watches SET condition_json=json_set(condition_json,'$.knownRevision',?), last_checked_at=?, last_result=? WHERE id=?", d.revision, at, `terms revision ${d.revision}`, watch.id);
        const fid = `${t}:finding:offer:${d.offerId}:rev${d.revision}`;
        run(
          db,
          "INSERT OR IGNORE INTO findings(id, tenant_id, context_id, watch_id, dedupe_key, kind, title, body, subject_ref, task_kind, priority, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          fid, t, watch.context_id, watch.id, fid, "OFFER_TERMS_CHANGED", "Student bundle terms changed",
          `The provider published revision ${d.revision}. ${inv.grantsInvalidated || inv.proposals.length ? "Your earlier plan needs a fresh check; nothing was started on the old terms." : "Any plan will use the new terms."}`,
          watch.subject_ref, "T3", 2, JSON.stringify({ changes: d.changes, invalidated: inv }), at,
        );
        notify(db, { tenantId: t, contextId: watch.context_id, title: "Offer terms changed", body: `Student bundle terms are now revision ${d.revision}. Re-check before approving.`, link: "/agent", findingId: fid, dedupeKey: `ntf:${fid}` });
      }
      return `invalidated ${inv.proposals.length} proposal(s), ${inv.grantsInvalidated} grant(s)`;
    }
    case "refund.accepted":
    case "claim.updated": {
      const rec =
        one<any>(db, "SELECT * FROM recoveries WHERE tenant_id=? AND json_extract(data_json,'$.caseId')=?", t, d.caseId ?? "") ??
        one<any>(db, "SELECT * FROM recoveries WHERE tenant_id=? AND reference=?", t, d.reference ?? "");
      if (!rec) return "no matching recovery";
      if (rec.state === "CREDITED") return "already credited";
      const timeline = [...json<any[]>(rec.timeline_json, []), { at, state: "MERCHANT_ACCEPTED", label: `${rec.merchant_name} accepted (${d.reference ?? d.caseId}); credit expected by ${d.payoutExpectedAt ? formatDay(d.payoutExpectedAt) : "a later date"}. Not yet money in your account.` }];
      run(db, "UPDATE recoveries SET state='AWAITING_CREDIT', reference=COALESCE(?, reference), expected_by=COALESCE(?, expected_by), timeline_json=?, updated_at=? WHERE id=?", d.reference ?? null, d.payoutExpectedAt ?? null, JSON.stringify(timeline), at, rec.id);
      notify(db, { tenantId: t, contextId: rec.context_id, title: `${rec.merchant_name} accepted your claim`, body: `${formatMoney(rec.amount_minor ?? 0)} is expected; it is not money in your account until the credit arrives.`, link: "/activity", dedupeKey: `ntf:claim:${ev.eventId}` });
      return "recovery accepted (no cash change)";
    }
    case "counterparty.reply": {
      const rec = one<any>(db, "SELECT * FROM business_records WHERE tenant_id=? AND kind='RECEIVABLES'", t);
      if (!rec) return "no receivables";
      const data = json<any>(rec.data_json, {});
      const inv = (data.invoices ?? []).find((i: any) => i.invoiceNumber === d.invoiceNumber || i.counterpartyId === d.counterparty);
      if (!inv) return "no matching invoice";
      inv.promises = (d.promise ?? []).map((p: any) => ({ day: Number(p.day), amountMinor: Number(p.amountMinor), status: "PROMISED" }));
      inv.status = "PROMISED";
      inv.reply = { text: String(d.text ?? "").slice(0, 500), receivedAt: at, untrusted: true };
      run(db, "UPDATE business_records SET data_json=?, revision=revision+1, updated_at=? WHERE id=?", JSON.stringify(data), new Date().toISOString(), rec.id);
      for (const p of inv.promises) {
        applyForecastEvent(db, {
          sourceEventId: `promise:${ev.issuer}:${ev.eventId}:${p.day}`,
          tenantId: t,
          kind: "ADD",
          add: { tenantId: t, contextId: rec.context_id, dataset: "bills", kind: "RECEIVABLE", label: `${inv.customer} promised payment (day ${p.day})`, amountMinor: p.amountMinor, dueAt: `2026-11-${String(p.day).padStart(2, "0")}T12:00:00+02:00`, condition: "Promised by the customer; not received", source: `promise:${ev.eventId}` },
          reason: "Counterparty promise (conditional)",
        });
      }
      notify(db, { tenantId: t, contextId: rec.context_id, title: `${inv.customer} replied`, body: "They promised a partial payment. The plan shows it as promised, not received.", link: "/goals/business", dedupeKey: `ntf:reply:${ev.eventId}` });
      return "promise recorded (conditional)";
    }
    case "credit_transfer": {
      if (ev.issuer !== "payment-network") return "ignored: credits only come from the payment network";
      const amount = Number(d.amountMinor);
      if (!Number.isSafeInteger(amount) || amount <= 0) return "ignored: invalid amount";
      const rec = d.caseId ? one<any>(db, "SELECT * FROM recoveries WHERE tenant_id=? AND (json_extract(data_json,'$.caseId')=? OR reference=?)", t, d.caseId, d.reference ?? "") : d.reference ? one<any>(db, "SELECT * FROM recoveries WHERE tenant_id=? AND reference=?", t, d.reference) : null;
      if (rec) {
        const acct = one<any>(db, "SELECT id FROM accounts WHERE tenant_id=? AND context_id=? AND kind='CURRENT' ORDER BY ordinal LIMIT 1", t, rec.context_id);
        const posted = postCardOrTransfer(db, { tenantId: t, contextId: rec.context_id, accountId: acct.id, sourceEventId: `credit:${d.transferId}`, amountMinor: amount, merchantName: rec.merchant_name, merchantId: rec.merchant_id, category: "Refund", reference: d.reference ?? d.transferId, bookedAt: at, note: `Credit for ${rec.kind.toLowerCase().replace(/_/g, " ")}` });
        if (!posted.duplicate) {
          const timeline = [...json<any[]>(rec.timeline_json, []), { at, state: "CREDITED", label: `${formatMoney(amount)} credited to your account` }];
          run(db, "UPDATE recoveries SET state='CREDITED', credit_transaction_id=?, timeline_json=?, updated_at=? WHERE id=?", posted.transactionId, JSON.stringify(timeline), at, rec.id);
          run(db, "UPDATE watches SET status='DONE', last_result='credited' WHERE tenant_id=? AND subject_ref=?", t, rec.id);
          notify(db, { tenantId: t, contextId: rec.context_id, title: "Money received", body: `${rec.merchant_name} credited ${formatMoney(amount)}.`, link: "/activity", dedupeKey: `ntf:credit:${d.transferId}` });
        }
        return posted.duplicate ? "duplicate credit ignored" : "recovery credited";
      }
      const recv = one<any>(db, "SELECT * FROM business_records WHERE tenant_id=? AND kind='RECEIVABLES'", t);
      const data = recv ? json<any>(recv.data_json, {}) : null;
      const inv = data?.invoices?.find((i: any) => i.counterpartyId === d.payer && (!d.reference || i.invoiceNumber === d.reference || i.number === d.reference));
      if (recv && inv) {
        const acct = one<any>(db, "SELECT id FROM accounts WHERE tenant_id=? AND context_id=? AND kind='BUSINESS_CURRENT' LIMIT 1", t, recv.context_id);
        const posted = postCardOrTransfer(db, { tenantId: t, contextId: recv.context_id, accountId: acct.id, sourceEventId: `credit:${d.transferId}`, amountMinor: amount, merchantName: inv.customer, merchantId: d.payer, category: "Customer payment", reference: d.reference ?? d.transferId, bookedAt: at, note: `Payment for ${inv.invoiceNumber}` });
        if (!posted.duplicate) {
          inv.paidMinor = (inv.paidMinor ?? 0) + amount;
          inv.status = inv.paidMinor >= inv.amountMinor ? "PAID" : "PARTIALLY_PAID";
          const promise = (inv.promises ?? []).find((p: any) => p.status === "PROMISED" && p.amountMinor === amount);
          if (promise) promise.status = "RECEIVED";
          run(db, "UPDATE business_records SET data_json=?, revision=revision+1, updated_at=? WHERE id=?", JSON.stringify(data), new Date().toISOString(), recv.id);
          const item = promise ? one<any>(db, "SELECT id FROM forecast_items WHERE tenant_id=? AND kind='RECEIVABLE' AND status='SCHEDULED' AND amount_minor=? AND label LIKE ? ORDER BY due_at LIMIT 1", t, amount, `${inv.customer}%`) : null;
          if (item) applyForecastEvent(db, { sourceEventId: `credit:${d.transferId}:settle`, tenantId: t, kind: "SETTLE", itemId: item.id, reason: "Payment received" });
          notify(db, { tenantId: t, contextId: recv.context_id, title: "Customer payment received", body: `${inv.customer} paid ${formatMoney(amount)} for ${inv.invoiceNumber}.`, link: "/goals/business", dedupeKey: `ntf:credit:${d.transferId}` });
          const task = one<any>(db, "SELECT id FROM tasks WHERE tenant_id=? AND kind='O4' ORDER BY created_at DESC LIMIT 1", t);
          taskEvent(db, { taskId: task?.id ?? null, tenantId: t, kind: "credit", label: `Bank credit received: ${formatMoney(amount)} from ${inv.customer}`, evidence: "BANK_LEDGER_POSTING" });
        }
        return posted.duplicate ? "duplicate credit ignored" : "receivable credited";
      }
      return "no matching recovery or receivable";
    }
    case "migration.completed": {
      const sub = one<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND contract_id=?", t, d.contractId);
      if (!sub) return "no subscription";
      const data = json<any>(sub.data_json, {});
      data.migration = { ...(data.migration ?? {}), state: "VERIFIED", gb: d.gb, destination: d.destination, verifiedAt: at };
      run(db, "UPDATE subscriptions SET data_json=? WHERE id=?", JSON.stringify(data), sub.id);
      return "migration verified";
    }
    case "contract.updated": {
      if (ev.resourceVersion != null) run(db, "UPDATE subscriptions SET last_observed_at=? WHERE tenant_id=? AND contract_id=?", at, t, d.contractId ?? "");
      return "noted";
    }
  }
  return "ignored";
}

export function inboxEventId() {
  return shortId("evt");
}
