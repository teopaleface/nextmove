import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { nowMs } from "../clock";
import { MerchantClient } from "../merchant-client";
import { invalidateForSubject } from "../authority/authority";
import { notify } from "../agent/events";
import { detectPriceChanges, reviewLicenses } from "../finance/capabilities";
import { fixture } from "../capabilities/core";
import { formatMoney } from "../../shared/money";
import { toLocalIso } from "../../shared/time";
import { checkShieldWatch } from "../bank/trial-shield";

// Durable monitoring. Each watch has its own explicit permission and consent revision; checks are leased so two
// workers never evaluate the same watch at once, and findings are deduplicated by a stable key.

const HOUR = 3_600_000;

function finding(db: DatabaseSync, w: any, key: string, kind: string, title: string, body: string, taskKind: string, priority: number, data: object = {}) {
  const id = `${w.tenant_id}:finding:${key}`;
  const r = run(
    db,
    "INSERT OR IGNORE INTO findings(id, tenant_id, context_id, watch_id, dedupe_key, kind, title, body, subject_ref, task_kind, priority, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, w.tenant_id, w.context_id, w.id, id, kind, title, body, w.subject_ref, taskKind, priority, JSON.stringify(data), toLocalIso(nowMs(db, w.tenant_id)),
  );
  if (Number(r.changes) === 1) notify(db, { tenantId: w.tenant_id, contextId: w.context_id, title, body, link: `/capabilities/${taskKind}`, findingId: id, dedupeKey: `ntf:${id}` });
  return Number(r.changes) === 1;
}

function permitted(db: DatabaseSync, w: any) {
  const p = one<any>(db, "SELECT COUNT(*) n FROM permissions WHERE tenant_id=? AND context_id=? AND kind='MONITOR' AND status='ACTIVE'", w.tenant_id, w.context_id);
  return (p?.n ?? 0) > 0;
}

export async function runDueWatches(db: DatabaseSync, workerId: string, limit = 10): Promise<number> {
  const claimed = tx(db, () => {
    const rows = all<any>(db, "SELECT * FROM watches WHERE status='ACTIVE' AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY next_check_at LIMIT 100", new Date().toISOString());
    const due = rows.filter((w) => Date.parse(w.next_check_at) <= nowMs(db, w.tenant_id)).slice(0, limit);
    for (const w of due) run(db, "UPDATE watches SET lease_owner=?, lease_expires_at=? WHERE id=?", workerId, new Date(Date.now() + 30_000).toISOString(), w.id);
    return due;
  });
  for (const w of claimed) {
    let next = nowMs(db, w.tenant_id) + 6 * HOUR;
    let result = "checked";
    try {
      if (!permitted(db, w)) {
        run(db, "UPDATE watches SET status='REVOKED', lease_owner=NULL, lease_expires_at=NULL, last_result='Monitoring permission revoked' WHERE id=?", w.id);
        continue;
      }
      const r = await check(db, w);
      next = r.next ?? next;
      result = r.result;
      if (r.done) {
        run(db, "UPDATE watches SET status='DONE', last_checked_at=?, last_result=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?", toLocalIso(nowMs(db, w.tenant_id)), result, w.id);
        continue;
      }
    } catch (e: any) {
      result = `check failed: ${String(e?.message ?? e).slice(0, 120)}`;
      next = nowMs(db, w.tenant_id) + HOUR;
    }
    run(db, "UPDATE watches SET next_check_at=?, last_checked_at=?, last_result=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND lease_owner=?", toLocalIso(next), toLocalIso(nowMs(db, w.tenant_id)), result, w.id, workerId);
  }
  return claimed.length;
}

async function check(db: DatabaseSync, w: any): Promise<{ result: string; next?: number; done?: boolean }> {
  const c = json<any>(w.condition_json, {});
  const now = nowMs(db, w.tenant_id);
  const client = new MerchantClient(db, w.tenant_id);
  switch (w.kind) {
    case "TRIAL_CONVERSION": {
      const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", w.subject_ref, w.tenant_id, w.context_id);
      if (!sub) return { result: "Subscription not found in this context" };
      if (!sub) return { result: "subscription missing", done: true };
      const r = await client.getContract(sub.merchant_id, sub.subscriber_account_id, sub.contract_id);
      if (!r.contract) return { result: `Provider could not be read (${r.status})` };
      if (!r.contract.autoRenew) return { result: "Renewal off: nothing will be charged", done: true };
      const at = Date.parse(r.contract.nextChargeAt ?? c.conversionAt);
      const hours = (at - now) / HOUR;
      for (const th of [...(c.thresholdsHours ?? [48, 24])].sort((a: number, b: number) => b - a)) {
        if (hours <= th && hours > 0) finding(db, w, `trial:${sub.id}:${th}h`, "TRIAL_CONVERSION", `${sub.merchant_name} trial becomes paid in ${Math.max(1, Math.round(hours))} hours`, `${formatMoney(r.contract.priceMinor)} will be charged unless renewal is turned off. Access stays until the trial ends.`, "T2", th === 24 ? 1 : 2, { thresholdHours: th });
      }
      const nextThreshold = [...(c.thresholdsHours ?? [48, 24])].map((h: number) => at - h * HOUR).filter((x: number) => x > now).sort((a: number, b: number) => a - b)[0];
      return { result: `Trial becomes paid in ${Math.max(0, Math.round(hours))} hours`, next: Math.min(nextThreshold ?? now + 6 * HOUR, now + 6 * HOUR) };
    }
    case "OFFER_TERMS": {
      const acct = one<any>(db, "SELECT subscriber_account_id FROM merchant_links WHERE tenant_id=? AND context_id=? AND merchant_id=?", w.tenant_id, w.context_id, c.merchantId);
      if (!acct) return { result: "No linked account with this provider in this context" };
      const o = await client.getOffer(c.merchantId, acct.subscriber_account_id, c.offerId);
      if (!o.offer) return { result: `Offer could not be read (${o.status})` };
      if (o.offer.revision > (c.knownRevision ?? 1)) {
        const inv = invalidateForSubject(db, w.tenant_id, { offerId: c.offerId }, `offer terms changed to revision ${o.offer.revision}`);
        run(db, "UPDATE watches SET condition_json=json_set(condition_json,'$.knownRevision',?) WHERE id=?", o.offer.revision, w.id);
        finding(db, w, `offer:${c.offerId}:rev${o.offer.revision}`, "OFFER_TERMS_CHANGED", "Student bundle terms changed", `The provider published revision ${o.offer.revision}. Any unexecuted approval on the old terms was cancelled.`, "T3", 2, { invalidated: inv });
        return { result: `New terms published (revision ${o.offer.revision})` };
      }
      return { result: `Terms unchanged (revision ${o.offer.revision})` };
    }
    case "PRICE_CHANGE": {
      const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=?", w.subject_ref);
      const r = await client.getContract(sub.merchant_id, sub.subscriber_account_id, sub.contract_id);
      const charges = all<any>(db, "SELECT id, amount_minor, booked_at FROM transactions WHERE tenant_id=? AND context_id=? AND merchant_name=? AND status='POSTED' AND amount_minor<0 ORDER BY booked_at", w.tenant_id, w.context_id, sub.merchant_name).map((t) => ({ id: t.id, amountMinor: -t.amount_minor, bookedAt: t.booked_at }));
      const f = detectPriceChanges({ contractKey: sub.canonical_key, charges, notices: (r.contract?.details as any)?.priceHistory ?? [] });
      for (const x of f.findings) finding(db, w, x.dedupeKey, "PRICE_INCREASE", `${sub.merchant_name} price went up`, `${formatMoney(x.fromMinor)} → ${formatMoney(x.toMinor)} per month${x.explanation === "MERCHANT_NOTICE" ? " (the provider sent a notice)" : " without a notice"}.`, "A4", 3, { fromMinor: x.fromMinor, toMinor: x.toMinor });
      return { result: f.findings.length ? `${f.findings.length} price change${f.findings.length === 1 ? "" : "s"} found` : "No price change", next: now + 24 * HOUR };
    }
    case "REFUND_DUE": {
      const rec = one<any>(db, "SELECT * FROM recoveries WHERE id=?", w.subject_ref);
      if (!rec || rec.state === "CREDITED") return { result: "Credited", done: true };
      if (rec.expected_by && now > Date.parse(rec.expected_by)) finding(db, w, `refund:${rec.id}:overdue`, "REFUND_OVERDUE", `${rec.merchant_name} refund is late`, `${formatMoney(rec.amount_minor)} was expected by ${new Date(rec.expected_by).toLocaleDateString("en-GB", { timeZone: "Europe/Bucharest" })}. You can send a follow-up.`, "A7", 2);
      return { result: rec.state === "AWAITING_CREDIT" || rec.state === "MERCHANT_ACCEPTED" ? "Accepted, credit not received yet" : rec.state === "SUBMITTED" ? "Requested, no answer yet" : rec.state.charAt(0) + rec.state.slice(1).toLowerCase().replace(/_/g, " "), next: rec.expected_by && now < Date.parse(rec.expected_by) ? Math.min(Date.parse(rec.expected_by) + 60_000, now + 12 * HOUR) : now + 12 * HOUR };
    }
    case "CREDIT_EXPIRY": {
      const exp = Date.parse(c.expiresAt);
      const days = (exp - now) / (24 * HOUR);
      if (days < 0) return { result: "Expired", done: true };
      if (days <= (c.warnDays ?? 21)) finding(db, w, `credit:${w.subject_ref}:warn`, "CREDIT_EXPIRING", `${formatMoney(c.amountMinor)} credit expires in ${Math.ceil(days)} days`, "It matches a book on your wishlist. Using it is optional.", "A12", 3);
      return { result: `${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"} left`, next: now + 24 * HOUR };
    }
    case "TRIAL_SHIELD":
      return checkShieldWatch(db, w);
    case "SEAT_USAGE": {
      const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=?", w.subject_ref);
      const r = await client.getContract(sub.merchant_id, sub.subscriber_account_id, sub.contract_id);
      const d: any = r.contract?.details;
      if (!d) return { result: `Provider could not be read (${r.status})` };
      const rev = reviewLicenses({ seats: d.seats.filter((s: any) => !s.removedFrom), seatPriceMinor: d.seatPriceMinor, minimumSeats: d.minimumSeats, inactivityThresholdDays: fixture("demo/capability-scenarios.json").lazizBusiness.teamDesk.inactivityThresholdDays, asOf: toLocalIso(now).slice(0, 10) });
      if (rev.candidateSeatIds.length) finding(db, w, `seats:${sub.id}:${rev.candidateSeatIds.join(",")}`, "UNUSED_SEATS", `${rev.candidateSeatIds.length} TeamDesk seats look unused`, `Removing them would lower the next invoice from ${formatMoney(rev.invoiceBeforeMinor)} to ${formatMoney(rev.invoiceAfterMinor)}.`, "A13", 3);
      return { result: `${rev.candidateSeatIds.length} unused seat${rev.candidateSeatIds.length === 1 ? "" : "s"}`, next: now + 24 * HOUR };
    }
  }
  return { result: "unknown watch kind", done: true };
}
