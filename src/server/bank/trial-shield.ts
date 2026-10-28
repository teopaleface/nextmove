import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { sha256Hex } from "../canonical";
import { nowIso, nowMs } from "../clock";
import { applyForecastEvent } from "./forecast";
import { balanceOf, clearingAccountId, post, postCardOrTransfer } from "./ledger";
import { notify } from "../agent/events";
import { invalidateForSubject } from "../authority/authority";
import { recordConfirmed, recordSettled } from "../execution/effects";
import type { ActionSpec } from "../authority/actions";
import { formatMoney } from "../../shared/money";
import { formatDay, toLocalIso, toMs } from "../../shared/time";

// Trial Shield (T4): a bank-side safety net for free trials the customer forgot or never told us about.
// A merchant that starts a trial usually checks the card with a 0.00 or 1.00 RON authorisation it then reverses.
// The bank sees that check, watches the merchant, and holds the first full charge the merchant starts on its own.
// A held authorisation is never posted: the booked balance does not change until the customer allows it.
// Blocking card payments here is a card-issuer rule in this demo bank; it does not cancel the merchant contract.

export const TRIAL_SHIELD_KIND = "TRIAL_SHIELD";
export const SHIELD_PERMISSION_SOURCE = "NextMove Trial Shield";
/** Safe default: an undecided hold is declined after this long. No money leaves; a retry is held again. */
export const HOLD_HOURS = 72;
/** Card checks are 0.00 or 1.00 RON authorisations; anything above is a real charge attempt. */
export const CARD_CHECK_MAX_MINOR = 100;
const HOUR = 3_600_000;

/** Fictional merchants seen only through card activity, with their public list price in this demo world. */
export const SHIELD_CATALOG: Record<string, { merchantName: string; category: string; advertisedMinor: number; attemptMinor: number }> = {
  snapwise: { merchantName: "Snapwise Pro", category: "Photo app", advertisedMinor: 12000, attemptMinor: 12000 },
  lingualeap: { merchantName: "LinguaLeap", category: "Language app", advertisedMinor: 4900, attemptMinor: 5900 },
};

export type ShieldState = "WATCHING" | "HELD" | "BLOCKED" | "ALLOWED";
export type AttemptOutcome = "HELD" | "DECLINED_BLOCKED" | "DECLINED_ALREADY_HELD" | "DECLINED_CARD_FROZEN" | "DECLINED_INSUFFICIENT_FUNDS" | "APPROVED" | "EXPIRED_DECLINED" | "RELEASED_BY_BLOCK" | "POSTED_BY_ALLOW";

export interface ShieldHold {
  transactionId: string;
  forecastItemId: string | null;
  amountMinor: number;
  reference: string;
  heldAt: string;
  expiresAt: string;
}

export interface ShieldCondition {
  merchantId: string;
  merchantName: string;
  category: string;
  rule: "HOLD_FIRST_FULL_CHARGE";
  check: { transactionId: string; amountMinor: number; at: string };
  advertisedMinor: number | null;
  advertisedSource: "LINKED_SUBSCRIPTION" | "CATALOG" | null;
  linkedSubscriptionId: string | null;
  attemptMinor: number | null;
  state: ShieldState;
  hold: ShieldHold | null;
  decidedAt?: string | null;
  avoidedMinor: number;
  attempts: { at: string; amountMinor: number; outcome: AttemptOutcome; reference: string }[];
}

export interface ShieldWatch {
  id: string;
  tenantId: string;
  contextId: string;
  subjectRef: string;
  c: ShieldCondition;
}

/* ------------------------------------------------------------------------------------- pure rules */

export interface CardActivity {
  id: string;
  merchantId: string | null;
  merchantName: string;
  amountMinor: number;
  status: string;
  bookedAt: string;
}

export interface CardCheck {
  transactionId: string;
  merchantId: string;
  merchantName: string;
  amountMinor: number;
  at: string;
}

/**
 * Find card checks: a 0.00 or 1.00 RON authorisation the merchant reversed, from a merchant that had no settled
 * charge on this card before it. One check per merchant (the earliest); a later real charge is what the shield holds.
 */
export function detectCardChecks(txns: CardActivity[]): CardCheck[] {
  const sorted = [...txns].sort((a, b) => toMs(a.bookedAt) - toMs(b.bookedAt));
  const charged = new Set<string>();
  const out = new Map<string, CardCheck>();
  for (const t of sorted) {
    if (!t.merchantId) continue;
    if (t.status === "POSTED" && t.amountMinor < 0) charged.add(t.merchantId);
    const isCheck = t.status === "RELEASED" && t.amountMinor <= 0 && -t.amountMinor <= CARD_CHECK_MAX_MINOR;
    if (isCheck && !charged.has(t.merchantId) && !out.has(t.merchantId)) out.set(t.merchantId, { transactionId: t.id, merchantId: t.merchantId, merchantName: t.merchantName, amountMinor: Math.abs(t.amountMinor), at: t.bookedAt });
  }
  return [...out.values()];
}

/** What the bank does with a merchant-initiated charge from a watched merchant. */
export function decideAttempt(state: ShieldState, cardFrozen = false): "HOLD" | "DECLINE_BLOCKED" | "DECLINE_ALREADY_HELD" | "DECLINE_CARD_FROZEN" | "APPROVE" {
  if (cardFrozen) return "DECLINE_CARD_FROZEN";
  switch (state) {
    case "BLOCKED":
      return "DECLINE_BLOCKED";
    case "HELD":
      return "DECLINE_ALREADY_HELD";
    case "ALLOWED":
      return "APPROVE";
    default:
      return "HOLD";
  }
}

export function holdExpiresAt(heldAtMs: number): string {
  return toLocalIso(heldAtMs + HOLD_HOURS * HOUR);
}

export function holdExpired(hold: Pick<ShieldHold, "expiresAt"> | null, atMs: number): boolean {
  return Boolean(hold) && atMs >= toMs(hold!.expiresAt);
}

/* ----------------------------------------------------------------------------------- persistence */

function watchId(tenantId: string, merchantId: string) {
  return `${tenantId}:watch:trial_shield:${merchantId}`;
}

function toWatch(row: any): ShieldWatch {
  return { id: row.id, tenantId: row.tenant_id, contextId: row.context_id, subjectRef: row.subject_ref, c: json<ShieldCondition>(row.condition_json) };
}

function save(db: DatabaseSync, w: ShieldWatch, lastResult: string) {
  run(db, "UPDATE watches SET condition_json=?, last_result=?, last_checked_at=?, next_check_at=? WHERE id=? AND tenant_id=?", JSON.stringify(w.c), lastResult, nowIso(db, w.tenantId), nextCheckAt(db, w), w.id, w.tenantId);
}

function nextCheckAt(db: DatabaseSync, w: ShieldWatch) {
  const now = nowMs(db, w.tenantId);
  const due = w.c.hold ? Math.min(toMs(w.c.hold.expiresAt), now + 6 * HOUR) : now + 6 * HOUR;
  return toLocalIso(Math.max(due, now));
}

export function shieldPermitted(db: DatabaseSync, tenantId: string, contextId: string) {
  return Boolean(one(db, "SELECT 1 FROM permissions WHERE tenant_id=? AND context_id=? AND kind='MONITOR' AND source=? AND status='ACTIVE'", tenantId, contextId, SHIELD_PERMISSION_SOURCE));
}

export function shieldWatches(db: DatabaseSync, tenantId: string, contextId: string): ShieldWatch[] {
  return all<any>(db, "SELECT * FROM watches WHERE tenant_id=? AND context_id=? AND kind=? ORDER BY created_at, id", tenantId, contextId, TRIAL_SHIELD_KIND).map(toWatch);
}

export function shieldWatch(db: DatabaseSync, tenantId: string, contextId: string, merchantId: string): ShieldWatch | null {
  const row = one<any>(db, "SELECT * FROM watches WHERE id=? AND tenant_id=? AND context_id=? AND kind=?", watchId(tenantId, merchantId), tenantId, contextId, TRIAL_SHIELD_KIND);
  return row ? toWatch(row) : null;
}

function cardAccount(db: DatabaseSync, tenantId: string, contextId: string) {
  return one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", tenantId, contextId);
}

/** Create one watch per merchant card check found in this context's card activity. Idempotent. */
export function ensureShieldWatches(db: DatabaseSync, tenantId: string, contextId: string): number {
  if (!shieldPermitted(db, tenantId, contextId)) return 0;
  const acct = cardAccount(db, tenantId, contextId);
  if (!acct) return 0;
  const txns = all<any>(db, "SELECT id, merchant_id, merchant_name, amount_minor, status, booked_at FROM transactions WHERE tenant_id=? AND context_id=? AND account_id=?", tenantId, contextId, acct.id).map((t) => ({ id: t.id, merchantId: t.merchant_id, merchantName: t.merchant_name, amountMinor: t.amount_minor, status: t.status, bookedAt: t.booked_at }));
  let created = 0;
  return tx(db, () => {
    for (const check of detectCardChecks(txns)) {
      const id = watchId(tenantId, check.merchantId);
      if (one(db, "SELECT 1 FROM watches WHERE id=?", id)) continue;
      const sub = one<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND merchant_id=? AND dataset='ui'", tenantId, contextId, check.merchantId);
      const cat = SHIELD_CATALOG[check.merchantId];
      const c: ShieldCondition = {
        merchantId: check.merchantId,
        merchantName: check.merchantName,
        category: cat?.category ?? "Subscriptions",
        rule: "HOLD_FIRST_FULL_CHARGE",
        check: { transactionId: check.transactionId, amountMinor: check.amountMinor, at: check.at },
        advertisedMinor: sub ? sub.amount_minor : cat?.advertisedMinor ?? null,
        advertisedSource: sub ? "LINKED_SUBSCRIPTION" : cat ? "CATALOG" : null,
        linkedSubscriptionId: sub?.id ?? null,
        attemptMinor: sub ? sub.amount_minor : cat?.attemptMinor ?? null,
        state: "WATCHING",
        hold: null,
        avoidedMinor: 0,
        attempts: [],
      };
      run(
        db,
        "INSERT INTO watches(id, tenant_id, context_id, kind, subject_ref, label, condition_json, status, consent_revision, next_check_at, created_at) VALUES (?,?,?,?,?,?,?, 'ACTIVE', 1, ?, ?)",
        id, tenantId, contextId, TRIAL_SHIELD_KIND, `${tenantId}:shield:${check.merchantId}`, `${check.merchantName}: trial under watch`, JSON.stringify(c), toLocalIso(nowMs(db, tenantId) + 6 * HOUR), check.at,
      );
      created++;
    }
    return created;
  });
}

/* ------------------------------------------------------------------------------- card authorisation */

export interface AttemptResult {
  decision: ReturnType<typeof decideAttempt> | "CARD_CHECK";
  merchantName: string;
  amountMinor: number;
  reference: string;
  transactionId: string | null;
  message: string;
}

const money = (m: number) => formatMoney(m, "RON");

/**
 * The simulated card network asks the bank to authorise a charge the merchant started on its own.
 * Only watched merchants reach this path in the demo; the bank answers hold, decline or approve.
 */
export function cardAttempt(db: DatabaseSync, input: { tenantId: string; contextId: string; merchantId: string; amountMinor?: number | null }): AttemptResult | null {
  sweepExpiredHolds(db, input.tenantId, input.contextId);
  return tx(db, () => {
    const w = shieldWatch(db, input.tenantId, input.contextId, input.merchantId);
    if (!w) return null;
    const c = w.c;
    const amount = Math.round(Number(input.amountMinor ?? c.attemptMinor ?? c.advertisedMinor ?? 0));
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    const at = nowIso(db, w.tenantId);
    const reference = `AUTH-${sha256Hex(`${w.id}:${c.attempts.length}`).slice(0, 8).toUpperCase()}`;
    if (amount <= CARD_CHECK_MAX_MINOR) return { decision: "CARD_CHECK", merchantName: c.merchantName, amountMinor: amount, reference, transactionId: null, message: "Card check approved and reversed; no money moves." };
    const acct = cardAccount(db, w.tenantId, w.contextId);
    const card = acct?.card_json ? JSON.parse(acct.card_json) : null;
    const decision = decideAttempt(c.state, card?.status === "FROZEN");
    const log = (outcome: AttemptOutcome) => c.attempts.push({ at, amountMinor: amount, outcome, reference });
    let transactionId: string | null = null;
    let message = "";
    switch (decision) {
      case "HOLD": {
        const heldAt = nowMs(db, w.tenantId);
        const expiresAt = holdExpiresAt(heldAt);
        transactionId = `${w.tenantId}:shield-hold:${c.merchantId}:${c.attempts.length + 1}`;
        run(
          db,
          `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, card_last4, booked_at, note, data_json)
           VALUES (?,?,?,?,NULL,'PENDING','DEBIT',?, 'RON', ?,?,?,?,?,?,?,?)`,
          transactionId, w.tenantId, w.contextId, acct.id, -amount, c.merchantId, c.merchantName, c.category, reference, card?.last4 ?? null, at,
          "Held by Trial Shield: first charge after a card check. Not taken from your account.",
          JSON.stringify({ authId: reference, trialShield: { watchId: w.id, expiresAt, advertisedMinor: c.advertisedMinor } }),
        );
        const src = `shield-hold:${transactionId}`;
        applyForecastEvent(db, {
          sourceEventId: src, tenantId: w.tenantId, kind: "ADD", reason: `Trial Shield held ${c.merchantName} (${reference})`,
          add: { tenantId: w.tenantId, contextId: w.contextId, dataset: "shield", kind: "HELD_CHARGE", label: `${c.merchantName} charge on hold`, amountMinor: -amount, dueAt: at, condition: `Charged only if you allow it. Declined automatically on ${formatDay(expiresAt)}.`, source: src, data: { transactionId } },
        });
        const fc = one<any>(db, "SELECT forecast_item_id FROM forecast_events WHERE tenant_id=? AND id=?", w.tenantId, src);
        c.hold = { transactionId, forecastItemId: fc?.forecast_item_id ?? null, amountMinor: amount, reference, heldAt: at, expiresAt };
        c.state = "HELD";
        log("HELD");
        const title = `${c.merchantName} tried to take ${money(amount)}`;
        const body = `A free trial likely ended. We held the payment, so nothing has left your account. Decide by ${formatDay(expiresAt)}.`;
        const findingId = `${w.tenantId}:finding:shield:${transactionId}`;
        run(
          db,
          "INSERT OR IGNORE INTO findings(id, tenant_id, context_id, watch_id, dedupe_key, kind, title, body, subject_ref, task_kind, priority, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          findingId, w.tenantId, w.contextId, w.id, findingId, "TRIAL_SHIELD_HOLD", title, body, transactionId, "T4", 0,
          JSON.stringify({ merchantId: c.merchantId, amountMinor: amount, advertisedMinor: c.advertisedMinor, expiresAt }), at,
        );
        notify(db, { tenantId: w.tenantId, contextId: w.contextId, title, body, link: "/capabilities/T4", findingId, dedupeKey: `ntf:shield:${transactionId}` });
        message = `Held ${money(amount)} from ${c.merchantName}. Nothing was taken.`;
        break;
      }
      case "DECLINE_BLOCKED":
        log("DECLINED_BLOCKED");
        notify(db, { tenantId: w.tenantId, contextId: w.contextId, title: `${c.merchantName} tried again: declined`, body: `You blocked ${c.merchantName} card payments. The ${money(amount)} attempt was declined and nothing left your account.`, link: "/capabilities/T4", dedupeKey: `ntf:shield:${reference}` });
        message = `Declined: you blocked ${c.merchantName}.`;
        break;
      case "DECLINE_ALREADY_HELD":
        log("DECLINED_ALREADY_HELD");
        message = `Declined: a ${c.merchantName} charge is already on hold for your decision.`;
        break;
      case "DECLINE_CARD_FROZEN":
        log("DECLINED_CARD_FROZEN");
        message = "Declined: the card is frozen.";
        break;
      case "APPROVE": {
        if (balanceOf(db, acct.id) < amount) {
          log("DECLINED_INSUFFICIENT_FUNDS");
          message = "Declined: not enough money in the account.";
          break;
        }
        const r = postCardOrTransfer(db, { tenantId: w.tenantId, contextId: w.contextId, accountId: acct.id, sourceEventId: `shield:${reference}`, amountMinor: -amount, merchantName: c.merchantName, merchantId: c.merchantId, category: c.category, reference, bookedAt: at, note: "You allowed this merchant after a trial" });
        transactionId = r.transactionId;
        log("APPROVED");
        message = `Approved: you allowed ${c.merchantName}.`;
        break;
      }
    }
    save(db, w, message);
    return { decision, merchantName: c.merchantName, amountMinor: amount, reference, transactionId, message };
  });
}

/**
 * Safe default for undecided holds: after HOLD_HOURS the bank declines the charge. The hold is released, nothing is
 * posted, and the watch goes back to watching so a retry is held again. A decision already approved and running wins.
 */
export function sweepExpiredHolds(db: DatabaseSync, tenantId: string, contextId?: string): number {
  const now = nowMs(db, tenantId);
  const rows = all<any>(db, `SELECT * FROM watches WHERE tenant_id=? ${contextId ? "AND context_id=?" : ""} AND kind=?`, ...(contextId ? [tenantId, contextId, TRIAL_SHIELD_KIND] : [tenantId, TRIAL_SHIELD_KIND])).map(toWatch);
  let n = 0;
  for (const w of rows) {
    const hold = w.c.hold;
    if (w.c.state !== "HELD" || !holdExpired(hold, now)) continue;
    const running = one(db, "SELECT 1 FROM proposal_actions WHERE tenant_id=? AND subject_ref=? AND status IN ('APPROVED','EXECUTING','PENDING','UNKNOWN')", tenantId, hold!.transactionId);
    if (running) continue;
    tx(db, () => {
      const at = nowIso(db, tenantId);
      run(db, "UPDATE transactions SET status='RELEASED', note=? WHERE id=? AND tenant_id=? AND status='PENDING'", `Hold expired after ${HOLD_HOURS} h without a decision: declined, nothing was charged.`, hold!.transactionId, tenantId);
      if (hold!.forecastItemId) applyForecastEvent(db, { sourceEventId: `shield-expiry:${hold!.transactionId}`, tenantId, kind: "REMOVE", itemId: hold!.forecastItemId, reason: "Hold expired: declined by default" });
      run(db, "UPDATE findings SET resolved_at=? WHERE tenant_id=? AND subject_ref=? AND resolved_at IS NULL", at, tenantId, hold!.transactionId);
      w.c.attempts.push({ at, amountMinor: hold!.amountMinor, outcome: "EXPIRED_DECLINED", reference: hold!.reference });
      w.c.state = "WATCHING";
      w.c.hold = null;
      notify(db, { tenantId, contextId: w.contextId, title: `${w.c.merchantName} charge declined`, body: `You didn't decide within ${HOLD_HOURS} hours, so we declined the ${money(hold!.amountMinor)} charge. Nothing left your account. If ${w.c.merchantName} tries again, we'll hold it and ask you.`, link: "/capabilities/T4", dedupeKey: `ntf:shield-expiry:${hold!.transactionId}` });
      save(db, w, "hold expired: declined by default");
    });
    invalidateForSubject(db, tenantId, { subjectRef: hold!.transactionId }, "the hold expired and was declined");
    n++;
  }
  return n;
}

/** Worker check for TRIAL_SHIELD watches: enforce hold expiry; the watch itself stays active. */
export function checkShieldWatch(db: DatabaseSync, w: any): { result: string; next?: number } {
  sweepExpiredHolds(db, w.tenant_id, w.context_id);
  const fresh = one<any>(db, "SELECT * FROM watches WHERE id=?", w.id);
  const c = json<ShieldCondition>(fresh?.condition_json ?? w.condition_json);
  const now = nowMs(db, w.tenant_id);
  return { result: c.state === "HELD" ? `holding ${money(c.hold!.amountMinor)} until ${formatDay(c.hold!.expiresAt)}` : c.state.toLowerCase(), next: c.hold ? Math.min(toMs(c.hold.expiresAt), now + 6 * HOUR) : now + 6 * HOUR };
}

/* ------------------------------------------------------------------------------------ decisions */

export const SHIELD_OPERATIONS = new Set(["MERCHANT_BLOCK", "HOLD_ALLOW"]);

/** Execute an approved Trial Shield decision after the dispatch gate. Runs entirely inside the bank. */
export function runShieldDecision(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string) {
  // One transaction from read to write, so a card attempt committed meanwhile cannot be overwritten by a stale watch.
  return tx(db, () => decideShield(db, action, spec, attemptId));
}

function decideShield(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string) {
  const t = action.tenant_id;
  const w = shieldWatch(db, t, action.context_id, String(spec.params.merchantId ?? ""));
  if (!w || w.id !== spec.params.watchId) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "This merchant is not under Trial Shield in this context" }));
  const txn = one<any>(db, "SELECT * FROM transactions WHERE id=? AND tenant_id=? AND context_id=?", spec.subjectRef, t, action.context_id);
  if (!txn) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "The held charge was not found" }));
  const amount = -txn.amount_minor;
  if (amount !== Number(spec.params.amountMinor)) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "The held amount no longer matches what you approved" }));
  const reference = `NMS-${sha256Hex(`${action.logical_key}:${attemptId}`).slice(0, 8).toUpperCase()}`;
  const at = nowIso(db, t);
  const c = w.c;

  if (spec.operation === "MERCHANT_BLOCK") {
    return void tx(db, () => {
      const wasPending = txn.status === "PENDING";
      if (wasPending) run(db, "UPDATE transactions SET status='RELEASED', note=? WHERE id=?", `Released: you blocked ${c.merchantName} card payments (${reference}). Nothing was charged.`, txn.id);
      const r = recordConfirmed(db, action.id, attemptId, {
        issuer: "nextmove-bank",
        reference,
        effectiveAt: at,
        accessUntil: null,
        termsRevision: null,
        details: { merchantName: c.merchantName, cardLast4: txn.card_last4, heldTransactionId: txn.id, releasedMinor: wasPending ? amount : 0, avoidedMinor: wasPending ? amount : 0, rule: "Decline merchant-initiated card payments from this merchant" },
        channel: "BANK",
        verification: { method: "card rule and hold read back from the bank record", checks: [wasPending ? `hold ${txn.reference} released, not posted` : "hold had already been released", `${c.merchantName} card payments now declined`, "booked balance unchanged"] },
        evidence: "BANK_RECORD",
      });
      if (r.duplicate) return;
      if (wasPending && c.hold?.forecastItemId) applyForecastEvent(db, { sourceEventId: `rcp:nextmove-bank:${reference}`, tenantId: t, kind: "REMOVE", itemId: c.hold.forecastItemId, reason: `Avoided: ${c.merchantName} blocked (${reference})` });
      run(db, "UPDATE findings SET resolved_at=? WHERE tenant_id=? AND subject_ref=? AND resolved_at IS NULL", at, t, txn.id);
      if (wasPending) c.attempts.push({ at, amountMinor: amount, outcome: "RELEASED_BY_BLOCK", reference });
      c.avoidedMinor += wasPending ? amount : 0;
      c.state = "BLOCKED";
      c.hold = null;
      c.decidedAt = at;
      save(db, w, `blocked by the customer (${reference})`);
    });
  }

  // HOLD_ALLOW: post the held authorisation as a normal debit.
  if (txn.status !== "PENDING") return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "This hold was already released, so there is nothing to allow. If the merchant tries again, you'll be asked again." }));
  if (amount > spec.money.maxDebitMinor) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "Amount exceeds the approved maximum" }));
  if (balanceOf(db, txn.account_id) < amount) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: "Not enough money in the account; the charge stays on hold" }));
  tx(db, () => {
    const { entryId } = post(db, { tenantId: t, sourceEventId: `shield-allow:${txn.id}`, kind: "DEBIT", description: c.merchantName, postedAt: at, lines: [{ accountId: txn.account_id, amountMinor: -amount }, { accountId: clearingAccountId(t), amountMinor: amount }] });
    run(db, "UPDATE transactions SET status='POSTED', entry_id=?, booked_at=?, note=? WHERE id=? AND status='PENDING'", entryId, at, `You allowed this charge after it was held (${reference}).`, txn.id);
    const r = recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: at,
      accessUntil: null,
      termsRevision: null,
      details: { merchantName: c.merchantName, cardLast4: txn.card_last4, heldTransactionId: txn.id, postedMinor: amount },
      channel: "BANK",
      verification: { method: "balanced ledger posting of the held authorisation", checks: ["entry balanced", "unique source event", `hold ${txn.reference} posted once`] },
      evidence: "BANK_LEDGER_POSTING",
    });
    if (r.duplicate) return;
    if (c.hold?.forecastItemId) applyForecastEvent(db, { sourceEventId: `rcp:nextmove-bank:${reference}`, tenantId: t, kind: "SETTLE", itemId: c.hold.forecastItemId, reason: `Allowed and posted (${reference})` });
    run(db, "UPDATE findings SET resolved_at=? WHERE tenant_id=? AND subject_ref=? AND resolved_at IS NULL", at, t, txn.id);
    c.attempts.push({ at, amountMinor: amount, outcome: "POSTED_BY_ALLOW", reference });
    c.state = "ALLOWED";
    c.hold = null;
    c.decidedAt = at;
    save(db, w, `allowed by the customer (${reference})`);
  });
}
