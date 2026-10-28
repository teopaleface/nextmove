import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../../db/connection";
import { sha256Hex } from "../../canonical";
import { nowIso } from "../../clock";
import { balanceOf, postCardOrTransfer } from "../../bank/ledger";
import { notify } from "../../agent/events";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { HttpError, type Session } from "../../auth/session";
import { formatMoney } from "../../../shared/money";
import { formatDay, toMs } from "../../../shared/time";
import type { ExtActionContext } from "../types";
import { iso, stopReceipts, type StopView } from "./stop-receipts";
import {
  approveDispute,
  assessPostCancellationCharge,
  markSubmitted,
  openDispute,
  prepareDisputePacket,
  recordBankCredit,
  recordNetworkDecision,
  type Assessment,
  type CardTransaction,
  type DisputeCase,
  type DisputeEffect,
  type DisputePacket,
  type MerchantCredit,
  type Transition,
} from "../../../../extensions/src/cancellation-guarantee/index.ts";
import { endingInForce } from "../../../../extensions/src/shared/receipts.ts";

// E1 bank side. Every decision comes from the module (assess, prepare, approve, submit, credit, network decision);
// this adapter maps bank rows into its types, persists its state and executes its effects. POST_CREDIT and
// REVERSE_CREDIT are the only money movers: balanced postings keyed by the module's event id, never above the
// disputed amount (module check, then the ext_dispute_case CHECK).

export const MAX_SIMULATED_CHARGES = 3;
const money = (m: number) => formatMoney(m, "RON");

export function cardAccount(db: DatabaseSync, tenantId: string, contextId: string) {
  return one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", tenantId, contextId);
}

function toCardTx(view: StopView, t: any): CardTransaction {
  const d = json<any>(t.data_json, {})?.extCg ?? {};
  return {
    txId: t.id,
    scope: view.scope,
    cardId: t.account_id,
    merchantId: t.merchant_id,
    ...(d.subscriptionId ? { subscriptionId: String(d.subscriptionId) } : {}),
    amountMinor: Math.abs(t.amount_minor),
    currency: t.currency,
    status: t.status === "POSTED" ? "POSTED" : t.status === "PENDING" ? "PENDING" : "REVERSED",
    authorizedAt: iso(d.authorizedAt ?? t.booked_at),
    ...(t.status === "POSTED" ? { postedAt: iso(t.booked_at) } : {}),
    ...(d.servicePeriodStart ? { servicePeriodStart: iso(d.servicePeriodStart) } : {}),
    recurring: d.recurring === true,
  };
}

export interface ChargeView {
  txn: any;
  tx: CardTransaction;
  assessment: Assessment;
  packet: DisputePacket | null;
  dispute: any | null;
}

/** Assess every card debit in this context at a merchant where a confirmed stop exists. */
export function assessCharges(db: DatabaseSync, tenantId: string, contextId: string, onlyTxId?: string): { view: StopView; charges: ChargeView[] } {
  const view = stopReceipts(db, tenantId, contextId);
  const merchants = [...new Set(view.stops.map((s) => s.sub.merchant_id as string))];
  if (!merchants.length) return { view, charges: [] };
  const txns = all<any>(
    db,
    `SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND direction='DEBIT' AND merchant_id IN (${merchants.map(() => "?").join(",")}) ${onlyTxId ? "AND id=?" : ""} ORDER BY booked_at`,
    tenantId, contextId, ...merchants, ...(onlyTxId ? [onlyTxId] : []),
  );
  const disputes = all<any>(db, "SELECT * FROM ext_dispute_case WHERE tenant_id=? AND context_id=?", tenantId, contextId);
  const disputed = new Set(disputes.map((d) => d.tx_id as string));
  const credits: MerchantCredit[] = all<any>(db, "SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND direction='CREDIT' AND status='POSTED' AND json_extract(data_json,'$.refundsTxId') IS NOT NULL", tenantId, contextId).map((c) => ({
    creditId: c.id, scope: view.scope, refundsTxId: String(json<any>(c.data_json, {}).refundsTxId), amountMinor: c.amount_minor, currency: c.currency, postedAt: iso(c.booked_at),
  }));
  const now = iso(nowIso(db, tenantId));
  const charges = txns.map((txn) => {
    const ctx = toCardTx(view, txn);
    const subsAt = all<any>(db, "SELECT id FROM subscriptions WHERE tenant_id=? AND context_id=? AND merchant_id=?", tenantId, contextId, txn.merchant_id).map((s) => s.id as string);
    const assessment = assessPostCancellationCharge({ tx: ctx, receipts: view.receipts, credits, disputedTxIds: disputed, subscriptionsAtMerchant: subsAt, now });
    let packet: DisputePacket | null = null;
    if (assessment.kind === "ELIGIBLE") {
      const receipt = view.receipts.find((r) => r.receiptId === assessment.receiptId)!;
      packet = prepareDisputePacket(assessment, ctx, receipt);
    }
    return { txn, tx: ctx, assessment, packet, dispute: disputes.find((d) => d.tx_id === txn.id) ?? null };
  });
  return { view, charges };
}

/* ------------------------------------------------------------------------------------- persistence */

function caseOf(row: any): DisputeCase {
  const manifest = JSON.parse(row.manifest_json);
  return {
    packet: { packetId: row.packet_id, manifest, manifestDigest: row.manifest_digest },
    state: row.state,
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.network_ref ? { networkRef: row.network_ref } : {}),
    creditedMinor: row.credited_minor,
    provisionalMinor: row.provisional_minor,
    appliedEventIds: JSON.parse(row.applied_events_json),
  };
}

function save(db: DatabaseSync, tenantId: string, c: DisputeCase, at: string) {
  run(
    db,
    "UPDATE ext_dispute_case SET state=?, grant_id=?, network_ref=?, credited_minor=?, provisional_minor=?, applied_events_json=?, updated_at=? WHERE packet_id=? AND tenant_id=?",
    c.state, c.grantId ?? null, c.networkRef ?? null, c.creditedMinor, c.provisionalMinor, JSON.stringify(c.appliedEventIds), at, c.packet.packetId, tenantId,
  );
}

const NOTICE: Record<string, (r: any) => { title: string; body: string }> = {
  DISPUTE_FILED: (r) => ({ title: `${r.merchant_name} charge disputed`, body: `We filed a dispute for the ${money(r.disputable_minor)} ${r.merchant_name} took after your confirmed stop.` }),
  PROVISIONAL_CREDIT_POSTED: (r) => ({ title: `${money(r.disputable_minor)} credited while the dispute runs`, body: `A provisional credit for the ${r.merchant_name} charge is in your account. It is reversed only if the card network rules for ${r.merchant_name}.` }),
  DISPUTE_WON: (r) => ({ title: `${r.merchant_name} dispute won`, body: `The card network ruled for you. The ${money(r.disputable_minor)} credit is final.` }),
  DISPUTE_LOST: (r) => ({ title: `${r.merchant_name} dispute lost`, body: `The card network ruled for ${r.merchant_name}.${r.provisional_minor > 0 ? ` The ${money(r.provisional_minor)} provisional credit was reversed.` : ""}` }),
  MERCHANT_REFUNDED: (r) => ({ title: `${r.merchant_name} refunded the charge`, body: "The dispute is closed." }),
  DEADLINE_MISSED: (r) => ({ title: `${r.merchant_name} dispute window passed`, body: "The dispute could not be filed in time. We'll review it manually." }),
};

/** Execute the module's effects inside the caller's transaction. Each money effect is keyed by its event id. */
function applyEffects(db: DatabaseSync, row: any, effects: readonly DisputeEffect[], at: string) {
  const t = row.tenant_id;
  for (const e of effects) {
    if (e.type === "POST_CREDIT" || e.type === "REVERSE_CREDIT") {
      if (e.currency !== "RON" || !Number.isSafeInteger(e.amountMinor) || e.amountMinor <= 0 || e.amountMinor > row.disputable_minor) throw new Error("dispute credit out of bounds");
      const reverse = e.type === "REVERSE_CREDIT";
      const src = `ext-cg:${reverse ? "reverse" : "credit"}:${e.eventId}`;
      postCardOrTransfer(db, {
        tenantId: t, contextId: row.context_id, accountId: row.account_id, sourceEventId: src, amountMinor: reverse ? -e.amountMinor : e.amountMinor,
        merchantName: reverse ? `${row.merchant_name} dispute: credit reversed` : `${row.merchant_name} dispute: ${e.type === "POST_CREDIT" && e.provisional ? "provisional" : "final"} credit`,
        category: "Dispute", reference: row.network_ref ?? row.packet_id, bookedAt: at, note: `Charge taken after a confirmed stop (dispute ${row.packet_id})`, data: { extCgCredit: { packetId: row.packet_id, eventId: e.eventId } },
      });
      run(db, "INSERT OR IGNORE INTO ext_dispute_event(event_id, tenant_id, packet_id, kind, amount_minor, ledger_source_id, applied_at) VALUES (?,?,?,?,?,?,?)",
        reverse ? `${e.eventId}:reverse` : e.eventId, t, row.packet_id, reverse ? "CREDIT_REVERSED" : e.provisional ? "BANK_CREDIT_PROVISIONAL" : "BANK_CREDIT_FINAL", e.amountMinor, src, at);
    } else if (e.type === "NOTIFY_CUSTOMER") {
      const n = NOTICE[e.message]?.(row);
      if (n) notify(db, { tenantId: t, contextId: row.context_id, ...n, link: "/capabilities/E1", dedupeKey: `ntf:ext-cg:${row.packet_id}:${e.message}` });
    }
    // SUBMIT_TO_NETWORK is answered by markSubmitted in the same step; WITHDRAW / FLAG need a merchant refund event, not simulated here.
  }
}

/* -------------------------------------------------------------------------------------- operation */

export const DISPUTE_REASON: Record<string, string> = {
  REVERSED: "the charge was reversed",
  ZERO_AMOUNT: "the charge is zero",
  NO_CONFIRMED_CANCELLATION: "no confirmed stop covers this charge",
  MERCHANT_MISMATCH: "the stop was confirmed by a different merchant",
  AUTHORIZED_BEFORE_CANCELLATION: "the charge was authorised before the stop was confirmed",
  ALREADY_DISPUTED: "this charge is already disputed",
  FULLY_REFUNDED: "the merchant already refunded it",
  PENDING_AUTHORIZATION: "the charge is still pending; we check again in 24 hours",
  AMBIGUOUS_SUBSCRIPTION: "more than one subscription at this merchant could match",
  UNKNOWN_SERVICE_PERIOD: "the charge falls inside the paid period and has no service period",
  SERVICE_PERIOD_OVERLAPS_PAID_ACCESS: "the charge pays for time you had already paid for",
  NOT_MARKED_RECURRING: "the card network did not mark it as a recurring charge",
  WEAK_PROOF: "the stop was not confirmed by an independent read-back",
  WINDOW_EXPIRED: "the dispute window has passed",
  CREDIT_CURRENCY_MISMATCH: "a linked refund is in another currency",
};

/** EXT_FILE_DISPUTE: re-assess the charge from current records, check the approved packet, file, credit. One transaction. */
export function fileDispute(c: ExtActionContext) {
  tx(c.db, () => fileDisputeTx(c));
}

function fileDisputeTx({ db, action, spec, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctxId = action.context_id;
  const settle = (status: "REFUSED" | "NO_CHANGE", reason: string) => void tx(db, () => recordSettled(db, action.id, attemptId, status, { reason }));
  const reference = `NMD-${sha256Hex(action.logical_key).slice(0, 10).toUpperCase()}`;
  const confirm = (row: any) =>
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: row.created_at,
      accessUntil: null,
      termsRevision: null,
      details: { packetId: row.packet_id, merchantName: row.merchant_name, disputedTransactionId: row.tx_id, disputedMinor: row.disputable_minor, provisionalCreditMinor: row.provisional_minor, networkRef: row.network_ref, cancellationReceipt: row.receipt_id },
      channel: "BANK",
      verification: { method: "module assessment re-run on current bank records; balanced provisional credit", checks: [`stop ${row.receipt_id} confirmed before the charge`, `packet digest ${row.manifest_digest.slice(0, 12)}… matches the approval`, "credit not above the disputed amount", "unique source event"] },
      evidence: "BANK_LEDGER_POSTING",
    });

  const mine = one<any>(db, "SELECT * FROM ext_dispute_case WHERE action_id=? AND tenant_id=?", action.id, t);
  if (mine) return void tx(db, () => confirm(mine)); // replay of a filed dispute: same receipt, nothing posted again
  const txId = String(spec.params.txId ?? "");
  const txn = one<any>(db, "SELECT id FROM transactions WHERE id=? AND tenant_id=? AND context_id=?", txId, t, ctxId);
  if (!txn) return settle("REFUSED", "The disputed charge was not found in this account");
  if (one(db, "SELECT 1 FROM ext_dispute_case WHERE tenant_id=? AND tx_id=?", t, txId)) return settle("NO_CHANGE", "This charge is already disputed");
  const c = assessCharges(db, t, ctxId, txId).charges[0];
  if (!c || c.assessment.kind !== "ELIGIBLE" || !c.packet) return settle("REFUSED", `Nothing was filed: ${c ? DISPUTE_REASON[(c.assessment as { reason?: string }).reason ?? ""] ?? c.assessment.kind : "the charge is no longer covered"}`);
  const packet = c.packet;
  if (packet.manifestDigest !== spec.params.manifestDigest || packet.manifest.amountMinor !== Number(spec.params.amountMinor) || packet.packetId !== spec.params.packetId) return settle("REFUSED", "The charge or the stop changed since you approved; nothing was filed. Review it again.");
  const grant = one<any>(db, "SELECT * FROM grants WHERE action_id=? AND tenant_id=? AND context_id=?", action.id, t, ctxId);
  if (!grant || grant.spec_digest !== action.spec_digest) return settle("REFUSED", "No matching approval for this dispute");
  const now = iso(nowIso(db, t));
  const approved = approveDispute(openDispute(packet), { grantId: grant.id, ownerId: t, contextId: packet.manifest.scope.contextId, manifestDigest: String(spec.params.manifestDigest), issuedAt: iso(grant.issued_at), expiresAt: iso(grant.expires_at) }, now);
  if (!approved.ok) return settle("REFUSED", `Nothing was filed (${approved.reason.toLowerCase().replace(/_/g, " ")})`);
  // The simulated card network accepts the submission at once; its reference is derived from the packet.
  const submitted = markSubmitted(approved.next, `NET-${sha256Hex(packet.packetId).slice(0, 10).toUpperCase()}`, now);
  if (!submitted.ok) return settle("REFUSED", `Nothing was filed (${submitted.reason.toLowerCase().replace(/_/g, " ")})`);
  const credit = recordBankCredit(submitted.next, { eventId: `${packet.packetId}:provisional`, kind: "PROVISIONAL", amountMinor: packet.manifest.amountMinor, currency: packet.manifest.currency });
  if (!credit.ok) return settle("REFUSED", `Nothing was filed (${credit.reason.toLowerCase().replace(/_/g, " ")})`);
  tx(db, () => {
    const at = nowIso(db, t);
    run(
      db,
      `INSERT INTO ext_dispute_case(packet_id, tenant_id, context_id, action_id, tx_id, account_id, subscription_id, receipt_id, merchant_id, merchant_name, manifest_json, manifest_digest, currency, disputable_minor, state, grant_id, deadline, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PREPARED', NULL, ?,?,?)`,
      packet.packetId, t, ctxId, action.id, txId, c.txn.account_id, packet.manifest.subscriptionId, packet.manifest.receiptId, packet.manifest.merchantId, c.txn.merchant_name,
      JSON.stringify(packet.manifest), packet.manifestDigest, packet.manifest.currency, packet.manifest.amountMinor, packet.manifest.deadline, at, at,
    );
    save(db, t, credit.next, at);
    const row = one<any>(db, "SELECT * FROM ext_dispute_case WHERE packet_id=?", packet.packetId);
    applyEffects(db, row, [...approved.effects, ...submitted.effects, ...credit.effects], at);
    run(db, "UPDATE findings SET resolved_at=? WHERE tenant_id=? AND subject_ref=? AND resolved_at IS NULL", at, t, txId);
    confirm(one<any>(db, "SELECT * FROM ext_dispute_case WHERE packet_id=?", packet.packetId));
  });
}

/* ------------------------------------------------------------------------------------------- labs */

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** Labs (a): the fictional merchant takes another card payment after the customer's confirmed stop. */
export function simulateChargeAfterStop(db: DatabaseSync, session: Session, body: Record<string, unknown>) {
  const t = session.tenantId;
  const ctxId = session.contextId;
  const subId = str(body.subscriptionId, 160);
  if (!subId) throw new HttpError(400, "BAD_INPUT", "subscriptionId is required");
  const view = stopReceipts(db, t, ctxId);
  const sub = view.subs.get(subId);
  const now = iso(nowIso(db, t));
  const ending = sub ? endingInForce(view.receipts, view.scope, subId, now) : undefined;
  if (!sub || !ending) throw new HttpError(404, "NOT_FOUND", "No confirmed stop for this subscription in this context");
  if (toMs(now) <= toMs(ending.confirmedAt)) throw new HttpError(409, "TOO_SOON", "The stop was confirmed this second; try again in a moment");
  const amount = body.amountMinor === undefined ? sub.amount_minor : Number(body.amountMinor);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > sub.amount_minor) throw new HttpError(400, "BAD_INPUT", `amountMinor must be 1..${sub.amount_minor}`);
  const acct = cardAccount(db, t, ctxId);
  if (!acct) throw new HttpError(409, "NO_CARD", "No card account in this context");
  // A frozen card declines every merchant charge, as the card network would.
  if (JSON.parse(acct.card_json ?? "null")?.status === "FROZEN") throw new HttpError(409, "DECLINED", "Declined: the card is frozen");
  return tx(db, () => {
    const n = (one<any>(db, "SELECT COUNT(*) n FROM transactions WHERE tenant_id=? AND context_id=? AND json_extract(data_json,'$.extCg.subscriptionId')=?", t, ctxId, subId)?.n ?? 0) as number;
    if (n >= MAX_SIMULATED_CHARGES) throw new HttpError(409, "LIMIT", `At most ${MAX_SIMULATED_CHARGES} simulated charges per subscription`);
    if (balanceOf(db, acct.id) < amount) throw new HttpError(409, "DECLINED", "Declined: not enough money on the card account");
    const at = nowIso(db, t);
    const servicePeriodStart = toMs(ending.accessUntil) > toMs(now) ? ending.accessUntil : now;
    const authRef = `AUTH-${sha256Hex(`${t}:${subId}:${n}`).slice(0, 8).toUpperCase()}`;
    const r = postCardOrTransfer(db, {
      tenantId: t, contextId: ctxId, accountId: acct.id, sourceEventId: `ext-cg:charge:${subId}:${n + 1}`, amountMinor: -amount, merchantName: sub.merchant_name, merchantId: sub.merchant_id,
      category: "Subscriptions", reference: authRef, bookedAt: at, note: `Recurring card charge for the period from ${formatDay(servicePeriodStart)} (simulated, Labs)`,
      data: { extCg: { subscriptionId: subId, authorizedAt: at, servicePeriodStart, recurring: true, simulated: true } },
    });
    const title = `${sub.merchant_name} charged ${money(amount)} after you stopped it`;
    const body = `${sub.merchant_name} confirmed your stop (ref ${ending.receiptId}) and charged the card anyway. Review the dispute in Cancellation guarantee.`;
    const findingId = `${t}:finding:ext-cg:${r.transactionId}`;
    run(db, "INSERT OR IGNORE INTO findings(id, tenant_id, context_id, watch_id, dedupe_key, kind, title, body, subject_ref, task_kind, priority, data_json, created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)",
      findingId, t, ctxId, findingId, "EXT_CHARGE_AFTER_STOP", title, body, r.transactionId, "E1", 0, JSON.stringify({ subscriptionId: subId, amountMinor: amount }), at);
    notify(db, { tenantId: t, contextId: ctxId, title, body, link: "/capabilities/E1", findingId, dedupeKey: `ntf:ext-cg:charge:${r.transactionId}` });
    return { transactionId: r.transactionId, amountMinor: amount, merchantName: sub.merchant_name, servicePeriodStart, reference: authRef };
  });
}

/** Labs (b): the simulated card network decides a filed dispute. One decision per dispute; a repeat is a no-op. */
export function simulateNetworkDecision(db: DatabaseSync, session: Session, body: Record<string, unknown>) {
  const t = session.tenantId;
  const packetId = str(body.disputeId, 64);
  const outcome = body.outcome === "WON" || body.outcome === "LOST" ? body.outcome : null;
  if (!packetId || !/^dsp_[0-9a-f]{24}$/.test(packetId) || !outcome) throw new HttpError(400, "BAD_INPUT", "disputeId and outcome (WON or LOST) are required");
  return tx(db, () => {
    const row = one<any>(db, "SELECT * FROM ext_dispute_case WHERE packet_id=? AND tenant_id=? AND context_id=?", packetId, t, session.contextId);
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such dispute here");
    const r: Transition = recordNetworkDecision(caseOf(row), { eventId: `${packetId}:network`, outcome });
    if (!r.ok) throw new HttpError(409, "INVALID_STATE", "This dispute cannot take a network decision now");
    if (r.duplicate) return { state: row.state, duplicate: true };
    const at = nowIso(db, t);
    save(db, t, r.next, at);
    run(db, "INSERT OR IGNORE INTO ext_dispute_event(event_id, tenant_id, packet_id, kind, amount_minor, ledger_source_id, applied_at) VALUES (?,?,?,?,?,NULL,?)", `${packetId}:network`, t, packetId, outcome === "WON" ? "NETWORK_WON" : "NETWORK_LOST", 0, at);
    applyEffects(db, { ...row, ...{ state: r.next.state } }, r.effects, at);
    return { state: r.next.state, duplicate: false };
  });
}
