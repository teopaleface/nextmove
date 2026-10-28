import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../../db/connection";
import { sha256Hex } from "../../canonical";
import { FIXTURE_INSTANT, nowIso } from "../../clock";
import { notify } from "../../agent/events";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { HttpError, type Session } from "../../auth/session";
import { toLocalIso } from "../../../shared/time";
import type { ExtActionContext } from "../types";
import {
  answerUpdaterInquiry,
  approveReissuePlan,
  planReissue,
  type CardOnFile,
  type Choice,
  type ReissueEffect,
  type ReissuePlan,
  type ReissueReason,
} from "../../../../extensions/src/card-reissue/index.ts";
import type { ApprovalGrant, Scope } from "../../../../extensions/src/shared/authority.ts";
import type { MerchantReceipt } from "../../../../extensions/src/shared/receipts.ts";

// E6 card reissue: bank-side adapter for extensions/src/card-reissue. When the customer's card is replaced, the
// customer approves one exact KEEP/DROP list per merchant holding the card on file; the bank then answers merchants'
// card-updater inquiries from that recorded list only. With no approved list, nothing is shared (fail closed).
// Cards are named by an opaque reference and their last 4 digits; no full card number exists anywhere here.

export const REASONS: ReissueReason[] = ["EXPIRY", "LOST", "STOLEN", "COMPROMISED", "CUSTOMER_REQUEST"];
export const MAX_INQUIRIES = 200;
const DAY = 86_400_000;

/** Fictional merchants holding Alex's daily debit card. Lingora has no linked subscription; ReelBox was cancelled earlier. */
const ON_FILE: { m: string; name: string; kind: "PAN" | "NETWORK_TOKEN"; updater: 0 | 1 }[] = [
  { m: "streamly", name: "Streamly", kind: "PAN", updater: 1 },
  { m: "studyplus", name: "StudyPlus", kind: "PAN", updater: 1 },
  { m: "cloudbox", name: "CloudBox", kind: "PAN", updater: 1 },
  { m: "fitflow", name: "FitFlow", kind: "PAN", updater: 1 },
  { m: "dasheats", name: "DashEats Plus", kind: "NETWORK_TOKEN", updater: 0 },
  { m: "pulsegym", name: "PulseGym", kind: "PAN", updater: 0 },
  { m: "mobilenet", name: "MobileNet", kind: "PAN", updater: 1 },
  { m: "safetrip", name: "SafeTrip", kind: "PAN", updater: 1 },
  { m: "lingora", name: "Lingora", kind: "PAN", updater: 1 },
  { m: "reelbox", name: "ReelBox", kind: "PAN", updater: 1 },
];

export function seedCardReissue(db: DatabaseSync, tenantId: string) {
  const ctx = one<any>(db, "SELECT id FROM contexts WHERE tenant_id=? AND kind='PERSONAL' LIMIT 1", tenantId)?.id;
  const acct = ctx ? cardAccount(db, tenantId, ctx) : null;
  if (!ctx || !acct) return;
  const base = Date.parse(FIXTURE_INSTANT);
  for (const [i, c] of ON_FILE.entries()) {
    const token = c.kind === "NETWORK_TOKEN" ? `ntok_${sha256Hex(`${tenantId}:${c.m}:token`).slice(0, 12)}` : null;
    run(db, "INSERT OR IGNORE INTO ext_card_on_file(tenant_id, context_id, account_id, merchant_id, merchant_name, brand_id, credential_kind, token_ref, token_status, participates_in_updater, added_at) VALUES (?,?,?,?,?,NULL,?,?,?,?,?)",
      tenantId, ctx, acct.id, c.m, c.name, c.kind, token, token ? "ACTIVE" : null, c.updater, toLocalIso(base - (400 - i * 30) * DAY));
  }
  run(db, "INSERT OR IGNORE INTO ext_card_prior_ending(tenant_id, context_id, receipt_ref, merchant_id, subscription_ref, confirmed_at, access_until, verification) VALUES (?,?,?,?,?,?,?, 'INDEPENDENT_READ_BACK')",
    tenantId, ctx, `${tenantId}:prior-ending:reelbox`, "reelbox", `${tenantId}:ext-sub:reelbox`, toLocalIso(base - 62 * DAY), toLocalIso(base - 45 * DAY));
}

/* ----------------------------------------------------------------------------------------- reads */

export function cardAccount(db: DatabaseSync, tenantId: string, contextId: string) {
  return one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", tenantId, contextId);
}

export function cardLast4(acct: any): string {
  return String(JSON.parse(acct?.card_json ?? "{}").last4 ?? "").replace(/\D/g, "").slice(-4);
}

export const cardRef = (accountId: string, last4: string) => `card_${sha256Hex(`${accountId}:${last4}`).slice(0, 12)}`;

export function scopeOf(db: DatabaseSync, tenantId: string, contextId: string): Scope {
  const kind = one<any>(db, "SELECT kind FROM contexts WHERE id=? AND tenant_id=?", contextId, tenantId)?.kind;
  return { ownerId: tenantId, contextId: kind === "BUSINESS" ? "BUSINESS" : "PERSONAL" };
}

export function latestReissue(db: DatabaseSync, tenantId: string, contextId: string) {
  return one<any>(db, "SELECT * FROM ext_card_reissue WHERE tenant_id=? AND context_id=? ORDER BY started_at DESC, reissue_id DESC LIMIT 1", tenantId, contextId);
}

export function onFileRows(db: DatabaseSync, tenantId: string, contextId: string, accountId: string) {
  return all<any>(db, "SELECT * FROM ext_card_on_file WHERE tenant_id=? AND context_id=? AND account_id=? ORDER BY merchant_name", tenantId, contextId, accountId);
}

/** Map the bank's cards-on-file rows and linked subscriptions onto the module's input type. */
export function cardsOnFile(db: DatabaseSync, tenantId: string, contextId: string, accountId: string): CardOnFile[] {
  const prior = all<any>(db, "SELECT merchant_id, subscription_ref FROM ext_card_prior_ending WHERE tenant_id=? AND context_id=?", tenantId, contextId);
  return onFileRows(db, tenantId, contextId, accountId).map((r) => {
    const subs = all<any>(db, "SELECT id FROM subscriptions WHERE tenant_id=? AND context_id=? AND merchant_id=? AND dataset IN ('ui','hidden','bills') ORDER BY id", tenantId, contextId, r.merchant_id).map((s) => s.id as string);
    const ids = [...subs, ...prior.filter((p) => p.merchant_id === r.merchant_id).map((p) => p.subscription_ref as string)];
    return {
      merchantId: r.merchant_id,
      ...(r.brand_id ? { brandId: r.brand_id } : {}),
      credential: r.credential_kind === "NETWORK_TOKEN" ? { kind: "NETWORK_TOKEN" as const, tokenId: r.token_ref } : { kind: "PAN" as const },
      participatesInUpdater: r.participates_in_updater === 1,
      subscriptionIds: ids,
    };
  });
}

/** Confirmed stop-renewal receipts (core) plus seeded earlier endings. Only an independent read-back counts as proof. */
export function endingReceipts(db: DatabaseSync, tenantId: string, contextId: string): MerchantReceipt[] {
  const scope = scopeOf(db, tenantId, contextId);
  const core = all<any>(db, `SELECT r.id, r.issuer_reference, r.access_until, r.verified_at, r.terms_revision, r.verification_json, a.subject_ref, a.merchant_id, a.spec_json
    FROM receipts r JOIN proposal_actions a ON a.id=r.action_id WHERE r.tenant_id=? AND r.context_id=? AND r.operation='STOP_RENEWAL' AND r.status='CONFIRMED'`, tenantId, contextId).map((r): MerchantReceipt => ({
    receiptId: r.id,
    scope,
    merchantId: r.merchant_id,
    subscriptionId: r.subject_ref,
    subscriberAccountId: json<any>(r.spec_json, {}).subscriberAccountId ?? "",
    operation: "STOP_RENEWAL_AT_PERIOD_END",
    state: "CONFIRMED",
    confirmedAt: r.verified_at,
    accessUntil: r.access_until ?? r.verified_at,
    termsRevision: r.terms_revision ?? 1,
    verification: String(json<any>(r.verification_json, {}).method ?? "").startsWith("independent read-back") ? "INDEPENDENT_READ_BACK" : "MERCHANT_MESSAGE_ONLY",
    evidenceRefs: [r.issuer_reference],
  }));
  const prior = all<any>(db, "SELECT * FROM ext_card_prior_ending WHERE tenant_id=? AND context_id=?", tenantId, contextId).map((r): MerchantReceipt => ({
    receiptId: r.receipt_ref, scope, merchantId: r.merchant_id, subscriptionId: r.subscription_ref, subscriberAccountId: "", operation: "STOP_RENEWAL_AT_PERIOD_END", state: "CONFIRMED",
    confirmedAt: r.confirmed_at, accessUntil: r.access_until, termsRevision: 1, verification: r.verification, evidenceRefs: [r.receipt_ref],
  }));
  return [...core, ...prior];
}

export function buildPlan(db: DatabaseSync, reissue: any, choices: Record<string, Choice>, now: string): { plan: ReissuePlan; merchants: CardOnFile[] } {
  const merchants = cardsOnFile(db, reissue.tenant_id, reissue.context_id, reissue.account_id);
  const plan = planReissue({
    scope: scopeOf(db, reissue.tenant_id, reissue.context_id),
    oldCardId: reissue.old_card_ref,
    newCardId: reissue.new_card_ref,
    reason: reissue.reason,
    merchants,
    receipts: endingReceipts(db, reissue.tenant_id, reissue.context_id),
    choices: new Map(Object.entries(choices).sort(([a], [b]) => (a < b ? -1 : 1))),
    now,
  });
  return { plan, merchants };
}

export function approvedPlan(db: DatabaseSync, tenantId: string, reissueId: string) {
  return one<any>(db, "SELECT * FROM ext_reissue_plan WHERE tenant_id=? AND reissue_id=?", tenantId, reissueId);
}

/* ------------------------------------------------------------------------------------- operation */

const sameSet = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && [...a].map(String).sort().join("\n") === [...b].sort().join("\n");

/** EXT_APPLY_REISSUE_PLAN, after the dispatch gate: recompute the plan from current state and record it only if it is exactly what was approved. */
export function applyReissuePlan({ db, action, spec, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctx = action.context_id;
  const p = spec.params as Record<string, any>;
  const settle = (status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) => void tx(db, () => recordSettled(db, action.id, attemptId, status, { reason }));
  const reference = `NMR-${sha256Hex(`reissue:${action.logical_key}`).slice(0, 10).toUpperCase()}`;
  const reissue = one<any>(db, "SELECT * FROM ext_card_reissue WHERE tenant_id=? AND context_id=? AND reissue_id=?", t, ctx, String(p.reissueId ?? ""));
  if (!reissue || reissue.reissue_id !== spec.subjectRef) return settle("REFUSED", "No card replacement was found in this context; nothing was recorded");

  const existing = approvedPlan(db, t, reissue.reissue_id);
  if (existing) {
    // Replay of the same approved action: settle again on the same receipt, change nothing.
    if (existing.reference === reference) return void tx(db, () => recordConfirmed(db, action.id, attemptId, confirmation(json(existing.plan_json), json(existing.effects_json), reissue, reference, existing.approved_at)));
    return settle("NO_CHANGE", "A merchant list for this card replacement is already recorded; nothing was changed");
  }
  if (reissue.status !== "STARTED" || reissue.old_card_ref !== p.oldCardRef || reissue.new_card_ref !== p.newCardRef || reissue.reason !== p.reason) return settle("REFUSED", "The card replacement changed after you approved; nothing was recorded");

  const choices: Record<string, Choice> = {};
  for (const [k, v] of Object.entries((p.choices ?? {}) as Record<string, unknown>)) {
    if (v !== "KEEP" && v !== "DROP") return settle("REFUSED", "The approved choices are not valid; nothing was recorded");
    choices[k] = v;
  }
  const now = nowIso(db, t);
  let built: ReturnType<typeof buildPlan>;
  try {
    built = buildPlan(db, reissue, choices, now);
  } catch {
    return settle("REFUSED", "The merchants holding this card changed after you approved; nothing was recorded. Review the new list.");
  }
  const { plan, merchants } = built;
  const keep = plan.decisions.filter((d) => d.decision === "KEEP").map((d) => d.merchantId);
  const drop = plan.decisions.filter((d) => d.decision === "DROP").map((d) => d.merchantId);
  if (plan.manifestDigest !== p.manifestDigest || plan.planId !== p.planId || !sameSet(p.keep, keep) || !sameSet(p.drop, drop)) {
    return settle("REFUSED", "Cards on file or cancellations changed after you approved, so the list is no longer the one you saw. Nothing was recorded; review the new list.");
  }
  const g = one<any>(db, "SELECT * FROM grants WHERE action_id=? AND tenant_id=?", action.id, t);
  if (!g) return settle("REFUSED", "No approval was found for this list; nothing was recorded");
  const grant: ApprovalGrant = { grantId: g.id, ...scopeOf(db, t, ctx), manifestDigest: String(p.manifestDigest), issuedAt: g.issued_at, expiresAt: g.expires_at, ...(g.status === "REVOKED" ? { revokedAt: now } : {}) };
  const approved = approveReissuePlan(plan, merchants, grant, now);
  if (!approved.ok) return settle("REFUSED", `The approval does not cover this list (${approved.reason.toLowerCase().replace(/_/g, " ")}); nothing was recorded`);

  tx(db, () => {
    const r = recordConfirmed(db, action.id, attemptId, confirmation(plan, approved.effects, reissue, reference, now));
    if (r.duplicate) return;
    run(db, "INSERT INTO ext_reissue_plan(tenant_id, context_id, plan_id, reissue_id, old_card_id, new_card_id, reason, manifest_digest, plan_json, effects_json, action_id, grant_id, reference, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      t, ctx, plan.planId, reissue.reissue_id, plan.oldCardId, plan.newCardId, plan.reason, plan.manifestDigest, JSON.stringify(plan), JSON.stringify(approved.effects), action.id, g.id, reference, now);
    for (const d of plan.decisions) run(db, "INSERT INTO ext_reissue_decision(tenant_id, plan_id, merchant_id, group_key, decision, basis) VALUES (?,?,?,?,?,?)", t, plan.planId, d.merchantId, d.groupKey, d.decision, d.basis);
    for (const e of approved.effects) if (e.type === "SUSPEND_TOKEN") run(db, "UPDATE ext_card_on_file SET token_status='SUSPENDED' WHERE tenant_id=? AND context_id=? AND merchant_id=? AND token_ref=?", t, ctx, e.merchantId, e.tokenId);
    run(db, "UPDATE ext_card_reissue SET status='PLAN_APPROVED', plan_id=? WHERE tenant_id=? AND reissue_id=? AND status='STARTED'", plan.planId, t, reissue.reissue_id);
  });
}

function confirmation(plan: ReissuePlan, effects: readonly ReissueEffect[], reissue: any, reference: string, at: string) {
  const keep = plan.decisions.filter((d) => d.decision === "KEEP").map((d) => d.merchantId);
  const drop = plan.decisions.filter((d) => d.decision === "DROP").map((d) => d.merchantId);
  return {
    issuer: "nextmove-bank",
    reference,
    effectiveAt: at,
    accessUntil: null,
    termsRevision: null,
    details: {
      planId: plan.planId,
      manifestDigest: plan.manifestDigest,
      oldCardLast4: reissue.old_last4,
      newCardLast4: reissue.new_last4,
      reason: plan.reason,
      keep,
      drop,
      tokensSuspended: effects.filter((e) => e.type === "SUSPEND_TOKEN").map((e) => e.merchantId),
      manualUpdate: effects.filter((e) => e.type === "TELL_CUSTOMER_TO_UPDATE").map((e) => e.merchantId),
    },
    channel: "BANK" as const,
    verification: { method: "merchant list recomputed from current cards on file and read back from the bank record", checks: [`${keep.length} merchants get the new card`, `${drop.length} merchants get no update`, "list matches the approved manifest digest"] },
    evidence: "BANK_RECORD" as const,
  };
}

/* ------------------------------------------------------------------------------------------ labs */

function asReason(v: unknown): ReissueReason {
  const r = v === undefined ? "EXPIRY" : v;
  if (typeof r !== "string" || !(REASONS as string[]).includes(r)) throw new HttpError(400, "BAD_INPUT", "reason must be one of EXPIRY, LOST, STOLEN, COMPROMISED, CUSTOMER_REQUEST");
  return r as ReissueReason;
}

/** Labs: the card is being replaced (expiry, loss...). Starts one bounded replacement per card; repeating it is a no-op. */
export function labsStartReissue(db: DatabaseSync, session: Session, body: Record<string, unknown>) {
  const reason = asReason(body.reason);
  const t = session.tenantId;
  const ctx = session.contextId;
  if (session.contextKind !== "PERSONAL") throw new HttpError(409, "WRONG_CONTEXT", "Switch to the personal context");
  const acct = cardAccount(db, t, ctx);
  const last4 = cardLast4(acct);
  if (!acct || last4.length !== 4) throw new HttpError(404, "NOT_FOUND", "No card in this context");
  const oldRef = cardRef(acct.id, last4);
  return tx(db, () => {
    const existing = one<any>(db, "SELECT * FROM ext_card_reissue WHERE tenant_id=? AND context_id=? AND old_card_ref=?", t, ctx, oldRef);
    if (existing) return { started: false, alreadyStarted: true, reissueId: existing.reissue_id, reason: existing.reason, oldCardLast4: existing.old_last4, newCardLast4: existing.new_last4 };
    const reissueId = `${t}:reissue:${oldRef}`;
    const h = sha256Hex(`${reissueId}:new`);
    let newLast4 = String(parseInt(h.slice(0, 8), 16) % 10_000).padStart(4, "0");
    if (newLast4 === last4) newLast4 = String((Number(newLast4) + 1) % 10_000).padStart(4, "0");
    const at = nowIso(db, t);
    run(db, "INSERT INTO ext_card_reissue(tenant_id, context_id, reissue_id, account_id, old_card_ref, old_last4, new_card_ref, new_last4, reason, status, plan_id, started_at) VALUES (?,?,?,?,?,?,?,?,?, 'STARTED', NULL, ?)",
      t, ctx, reissueId, acct.id, oldRef, last4, `card_${h.slice(8, 20)}`, newLast4, reason, at);
    notify(db, { tenantId: t, contextId: ctx, title: `Your card •••• ${last4} is being replaced`, body: `Choose which merchants get the new card •••• ${newLast4}. Until you approve a list, no merchant gets it from us.`, link: "/capabilities/E6", dedupeKey: `ntf:reissue:${reissueId}` });
    return { started: true, alreadyStarted: false, reissueId, reason, oldCardLast4: last4, newCardLast4: newLast4 };
  });
}

/** Labs: a merchant's card-updater inquiry arrives from the network. Answered only from the recorded plan. */
export function labsUpdaterInquiry(db: DatabaseSync, session: Session, body: Record<string, unknown>) {
  const merchantId = body.merchantId;
  if (typeof merchantId !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(merchantId)) throw new HttpError(400, "BAD_INPUT", "merchantId must be a short merchant id");
  const t = session.tenantId;
  const ctx = session.contextId;
  const reissue = latestReissue(db, t, ctx);
  if (!reissue) throw new HttpError(409, "NO_REISSUE", "No card replacement is in progress here");
  const onFile = one<any>(db, "SELECT merchant_name FROM ext_card_on_file WHERE tenant_id=? AND context_id=? AND account_id=? AND merchant_id=?", t, ctx, reissue.account_id, merchantId);
  if (!onFile) throw new HttpError(404, "NOT_FOUND", "This merchant does not hold the card on file");
  return tx(db, () => {
    const n = one<any>(db, "SELECT COUNT(*) n FROM ext_updater_inquiry WHERE tenant_id=? AND reissue_id=?", t, reissue.reissue_id)?.n ?? 0;
    if (n >= MAX_INQUIRIES) throw new HttpError(429, "TOO_MANY", "Too many simulated inquiries for this card");
    const at = nowIso(db, t);
    const row = approvedPlan(db, t, reissue.reissue_id);
    const inquiryId = `${reissue.reissue_id}:inq:${n + 1}`;
    if (!row) {
      run(db, "INSERT INTO ext_updater_inquiry(tenant_id, context_id, inquiry_id, reissue_id, plan_id, merchant_id, answer, signal, received_at) VALUES (?,?,?,?,NULL,?, 'WITHHOLD', 'NO_APPROVED_PLAN', ?)", t, ctx, inquiryId, reissue.reissue_id, merchantId, at);
      return { inquiryId, merchantName: onFile.merchant_name, answer: "WITHHOLD", signal: "NO_APPROVED_PLAN", message: `No list approved yet, so ${onFile.merchant_name} gets nothing from us.` };
    }
    const plan = json<ReissuePlan>(row.plan_json);
    const ans = answerUpdaterInquiry(plan, { merchantId, oldCardId: reissue.old_card_ref, receivedAt: at });
    const signal = ans.answer === "WITHHOLD" ? ans.signal ?? null : null;
    run(db, "INSERT INTO ext_updater_inquiry(tenant_id, context_id, inquiry_id, reissue_id, plan_id, merchant_id, answer, signal, received_at) VALUES (?,?,?,?,?,?,?,?,?)", t, ctx, inquiryId, reissue.reissue_id, row.plan_id, merchantId, ans.answer, signal, at);
    if (signal === "REQUEST_AFTER_CANCELLATION") {
      notify(db, { tenantId: t, contextId: ctx, title: `${onFile.merchant_name} asked for your new card`, body: `You cancelled ${onFile.merchant_name} and the cancellation was verified, so we did not pass on the new card. Keep this in mind if ${onFile.merchant_name} charges you again.`, link: "/capabilities/E6", dedupeKey: `ntf:reissue-inq:${reissue.reissue_id}:${merchantId}` });
    }
    if (ans.answer === "PROVIDE") return { inquiryId, merchantName: onFile.merchant_name, answer: "PROVIDE", newCard: { ref: reissue.new_card_ref, last4: reissue.new_last4 }, message: `${onFile.merchant_name} received the new card reference (•••• ${reissue.new_last4}).` };
    return { inquiryId, merchantName: onFile.merchant_name, answer: "WITHHOLD", signal, message: `${onFile.merchant_name} got no update.` };
  });
}
