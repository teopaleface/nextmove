import type { DatabaseSync } from "node:sqlite";
import { all, json, one } from "../../db/connection";
import { toLocalIso, toMs } from "../../../shared/time";
import type { MerchantReceipt } from "../../../../extensions/src/shared/receipts.ts";
import type { Scope } from "../../../../extensions/src/shared/authority.ts";

// The one place E1 (cancellation guarantee) and E8 (certificate) read "a confirmed stop". Core records it when a
// STOP_RENEWAL action is confirmed (execution/effects.ts recordConfirmed): a CONFIRMED receipts row for an action whose
// subject_ref is the subscription, and the subscription moves to RENEWAL_OFF. Only a receipt confirmed through an
// independent read-back of the provider's state counts as proof; anything else maps to MERCHANT_MESSAGE_ONLY.
// A subscription the bank later observed with renewal back on is mapped to a REACTIVATE receipt at that observation.
// Receipts are keyed on the bank's own receipt id: a merchant can reuse its confirmation number (issuer_reference)
// across subscriptions or customers, so that is carried only as merchantReference, for display.

export const iso = (v: string) => toLocalIso(toMs(v));

export function scopeOf(db: DatabaseSync, tenantId: string, contextId: string): Scope {
  const kind = one<any>(db, "SELECT kind FROM contexts WHERE id=? AND tenant_id=?", contextId, tenantId)?.kind;
  return { ownerId: tenantId, contextId: kind === "BUSINESS" ? "BUSINESS" : "PERSONAL" };
}

export interface StopRecord {
  receipt: MerchantReceipt;
  /** receipts.id, the same as receipt.receiptId. */
  bankReceiptId: string;
  /** The provider's confirmation number, shown to the customer; not unique. */
  reference: string;
  sub: any;
}

export interface StopView {
  scope: Scope;
  /** Every mapped receipt in this tenant and context, endings and reactivations, for the module's endingInForce. */
  receipts: MerchantReceipt[];
  stops: StopRecord[];
  subs: Map<string, any>;
}

export function stopReceipts(db: DatabaseSync, tenantId: string, contextId: string): StopView {
  const scope = scopeOf(db, tenantId, contextId);
  const rows = all<any>(
    db,
    `SELECT r.id AS rid, r.issuer_reference, r.access_until AS r_access_until, r.effective_at, r.terms_revision AS r_terms, r.verification_json, r.verified_at, s.*
       FROM receipts r
       JOIN proposal_actions a ON a.id=r.action_id AND a.tenant_id=r.tenant_id
       JOIN subscriptions s ON s.id=a.subject_ref AND s.tenant_id=r.tenant_id AND s.context_id=r.context_id
      WHERE r.tenant_id=? AND r.context_id=? AND r.operation='STOP_RENEWAL' AND r.status='CONFIRMED'
      ORDER BY r.verified_at`,
    tenantId,
    contextId,
  );
  const stops: StopRecord[] = [];
  const subs = new Map<string, any>();
  for (const r of rows) {
    const v = json<any>(r.verification_json, {});
    const receipt: MerchantReceipt = {
      receiptId: r.rid,
      merchantReference: r.issuer_reference,
      scope,
      merchantId: r.merchant_id,
      subscriptionId: r.id,
      subscriberAccountId: r.subscriber_account_id,
      operation: "STOP_RENEWAL_AT_PERIOD_END",
      state: "CONFIRMED",
      confirmedAt: iso(r.verified_at),
      accessUntil: iso(r.r_access_until ?? r.access_until ?? r.effective_at ?? r.verified_at),
      termsRevision: Number(r.r_terms ?? r.terms_revision ?? 1),
      verification: String(v.method ?? "").startsWith("independent read-back") ? "INDEPENDENT_READ_BACK" : "MERCHANT_MESSAGE_ONLY",
      evidenceRefs: [`receipt:${r.rid}`],
    };
    stops.push({ receipt, bankReceiptId: r.rid, reference: r.issuer_reference, sub: r });
    subs.set(r.id, r);
  }
  const receipts: MerchantReceipt[] = stops.map((s) => s.receipt);
  for (const sub of subs.values()) {
    if (["RENEWAL_OFF", "CANCELLED"].includes(sub.state)) continue;
    const last = stops.filter((s) => s.sub.id === sub.id).at(-1)!.receipt;
    const seen = sub.last_observed_at && toMs(sub.last_observed_at) > toMs(last.confirmedAt) ? iso(sub.last_observed_at) : null;
    if (!seen) continue;
    receipts.push({ ...last, receiptId: `observed:${sub.id}:${seen}`, operation: "REACTIVATE", confirmedAt: seen, evidenceRefs: [`subscription:${sub.id}`] });
  }
  return { scope, receipts, stops, subs };
}
