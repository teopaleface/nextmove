import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { all, one, run, tx } from "../../db/connection";
import { HttpError } from "../../auth/session";
import { nowIso, nowMs } from "../../clock";
import { sha256Hex } from "../../canonical";
import { applyForecastEvent } from "../../bank/forecast";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, display, fmtWhen, forecastFor, inputOr, liveContract, maskAccount, money, spec, stopRenewalCandidate, subjectFields } from "../../capabilities/core";
import { toLocalIso } from "../../../shared/time";
import type { ExtensionModule, ExtActionContext } from "../types";
import { acceptOffer, compareOffer, type OfferFlag, type OfferTerms, type OfferVerdict, type PendingCancellation, type RetentionOffer, type SignedOffer } from "../../../../extensions/src/retention-offers/index.ts";
import { OFFER_MERCHANTS, REJECTION_TEXT, contextKind, deleteMerchantKeyFiles, merchantSigningKey, receiveOffer, reverify, signOffer } from "../retention-offers/bank";

// E3 Retention offers: a merchant that is a verified business client sends a signed offer to keep the customer.
// The bank verifies it against the merchant's public key and its own records, compares it honestly with the current
// price and with stopping, and shows the merchant's text only as quoted data. Accepting is an exact, approved
// EXT_ACCEPT_OFFER bound to the offer id, revision, digest, price and term; the worker re-verifies before it records it.

const KEY = "retention-offers";
const OP = "EXT_ACCEPT_OFFER";
const LABS_SUBS = new Set(["streamly", "cloudbox"]);
const VARIANTS = new Set(["valid", "tampered", "expired", "short"]);
const PLANS = new Set(["discount", "downgrade"]);
const HOUR = 3_600_000;

interface AcceptParams {
  offerId: string;
  revision: number;
  offerDigest: string;
  subscriptionId: string;
  promoMonthlyMinor: number;
  promoMonths: number;
  priceAfterMinor: number;
  lockInMonths: number;
  earlyExitFeeMinor: number;
  autoRenew: boolean;
  /** The one approved, not-yet-started renewal stop this acceptance may withdraw (bound by the approval digest). */
  withdrawStopActionId: string | null;
}

const VERDICT_TEXT: Record<OfferVerdict, string> = {
  INCOMPLETE: "Incomplete: the merchant left some terms unquantified, so it cannot be compared fairly.",
  LOSES_REQUIRED_BENEFIT: "It removes something you said you need.",
  NOT_CHEAPER_THAN_CURRENT: "Not cheaper than staying on your current plan over this period.",
  CHEAPER_THAN_CURRENT: "Cheaper than your current plan over this period.",
};

const FLAG_TEXT: Record<OfferFlag, string> = {
  MESSAGE_LOOKS_LIKE_INSTRUCTIONS: "The merchant's message contains text that reads like instructions. NextMove ignores it; only the signed terms count, and nothing is accepted without your approval.",
  MESSAGE_CONTAINS_LINK: "The merchant's message contains a link. NextMove does not open it.",
  CREDIT_NOT_CASH: "The discount is paid as merchant credit: it cannot be withdrawn and is lost if you leave.",
};

const BENEFIT_LABEL: Record<string, string> = { offlinePlayback: "Offline playback", tvAccess: "TV access", streaming: "Streaming", storage: "Storage" };
const benefitLabel = (b: string) => BENEFIT_LABEL[b] ?? b.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).slice(0, 40);

function termsLine(t: OfferTerms) {
  const after = t.autoRenew ? `, then ${money(t.priceAfterMinor)}/month` : ", then it ends";
  return `${money(t.promoMonthlyMinor)}/month for ${t.promoMonths} month${t.promoMonths === 1 ? "" : "s"}${after}`;
}

function inFlightStop(db: DatabaseSync, tenantId: string, contextId: string, subId: string) {
  return one<any>(db, "SELECT * FROM proposal_actions WHERE tenant_id=? AND context_id=? AND subject_ref=? AND operation='STOP_RENEWAL' AND status IN ('APPROVED','EXECUTING','PENDING','UNKNOWN') ORDER BY updated_at DESC LIMIT 1", tenantId, contextId, subId);
}

/** An approved stop that has not started can still be withdrawn; anything further along must be reconciled first. */
function stopState(db: DatabaseSync, stop: any): PendingCancellation["state"] {
  if (stop.status === "UNKNOWN") return "UNKNOWN";
  if (stop.status !== "APPROVED") return "IN_FLIGHT";
  const started = one<any>(db, "SELECT 1 FROM attempts WHERE action_id=? AND status NOT IN ('NOT_DISPATCHED')", stop.id);
  if (started) return "IN_FLIGHT";
  const job = one<any>(db, "SELECT status FROM jobs WHERE kind='ACTION' AND ref_id=? ORDER BY created_at DESC LIMIT 1", stop.id);
  if (!job || job.status === "QUEUED") return "APPROVED";
  // An exit plan's stop is leased on every poll while it waits for its condition. Until the plan decides to stop
  // (STOP_REQUESTED), nothing can be sent, and the hold re-checks the approval before deciding, so it can still be withdrawn.
  const plan = one<any>(db, "SELECT status FROM ext_exit_plan WHERE tenant_id=? AND action_id=?", stop.tenant_id, stop.id);
  return plan && ["ACTIVE", "ASKED"].includes(plan.status) ? "APPROVED" : "IN_FLIGHT";
}

/* ------------------------------------------------------------------------------------------ capability */

async function analyzeE3(env: CapEnv): Promise<Analysis> {
  const { db, tenantId, contextId } = env;
  const rows = all<any>(db, "SELECT * FROM ext_retention_offer WHERE tenant_id=? AND context_id=? ORDER BY received_at DESC, offer_id LIMIT 30", tenantId, contextId);
  const horizon = Math.min(24, Math.max(1, Math.round(Number(inputOr(env, "horizonMonths", 12))) || 12));
  const need = String(inputOr(env, "need", ""));
  const blocks: Block[] = [];
  const candidates: Candidate[] = [];
  const numbers: Record<string, number> = {};
  let benefitOptions: string[] = [];
  let live = 0;
  let firstVerdict = "";

  const accepted = rows.filter((r) => r.status === "ACCEPTED");
  for (const r of accepted.slice(0, 3)) {
    const o = (JSON.parse(r.signed_json) as SignedOffer).offer;
    const acc = one<any>(db, "SELECT * FROM ext_offer_acceptance WHERE tenant_id=? AND offer_id=?", tenantId, r.offer_id);
    blocks.push({ kind: "status", title: `Offer accepted · ${o.merchantId === "streamly" ? "Streamly" : o.merchantId}`, state: "CONFIRMED", detail: `${termsLine(o.terms)}. Reference ${acc?.reference ?? "—"}. The bank keeps the signed offer as proof of these terms.` });
  }

  for (const r of rows.filter((x) => x.status === "VERIFIED")) {
    const signed = JSON.parse(r.signed_json) as SignedOffer;
    const o = signed.offer;
    const sub = one<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND contract_id=? AND merchant_id=?", tenantId, contextId, o.subscriptionId, o.merchantId);
    if (!sub) continue;
    const v = reverify(db, r, env.now);
    if (!v.ok) {
      blocks.push({ kind: "status", title: `${sub.merchant_name} offer no longer valid`, state: "CLOSED", detail: REJECTION_TEXT[v.reason] ?? v.reason });
      continue;
    }
    live++;
    const benefits = Object.keys(JSON.parse(sub.benefits_json ?? "{}") ?? {}).filter((b) => /^[A-Za-z]{1,40}$/.test(b));
    benefitOptions = [...new Set([...benefitOptions, ...benefits])];
    const required = need && benefits.includes(need) ? [need] : [];
    const cmp = compareOffer(v.offer, { monthlyMinor: sub.amount_minor, currency: "RON", requiredBenefits: required }, horizon);
    const t = v.offer.terms;
    const tone = cmp.verdict === "CHEAPER_THAN_CURRENT" ? "good" : "warn";
    numbers[`offer_${sub.merchant_id}_total`] = cmp.offerTotalMinor;
    numbers[`keep_${sub.merchant_id}_total`] = cmp.keepCurrentTotalMinor;
    if (!firstVerdict) firstVerdict = `${sub.merchant_name} offers ${termsLine(t)}. ${VERDICT_TEXT[cmp.verdict].replace(/\.$/, "")}`;
    blocks.push({
      kind: "table",
      title: `${sub.merchant_name}: your options over the next ${horizon} month${horizon === 1 ? "" : "s"}`,
      columns: ["Option", "You pay"],
      rows: [
        { cells: ["Stop renewal", `${money(cmp.cancelTotalMinor)} from the next renewal on`] },
        { cells: [`Keep your current plan (${money(sub.amount_minor)}/month)`, money(cmp.keepCurrentTotalMinor)] },
        { cells: [`Accept the offer (${termsLine(t)})`, money(cmp.offerTotalMinor)], highlight: true, tone },
        { cells: ["Accept, then leave as early as the offer allows", money(cmp.committedMinimumMinor)] },
      ],
      note: `${VERDICT_TEXT[cmp.verdict]}${t.lockInMonths > horizon ? ` Includes the ${money(t.earlyExitFeeMinor)} early-exit fee because the lock-in runs past this period.` : ""} Offer valid until ${fmtWhen(o.expiresAt)}.`,
    });
    blocks.push({
      kind: "facts",
      title: "Signed terms",
      items: [
        { label: "Price", value: termsLine(t), provenance: "Signed by the merchant, verified by NextMove" },
        { label: "Lock-in", value: t.lockInMonths ? `${t.lockInMonths} months; leaving earlier costs ${money(t.earlyExitFeeMinor)}` : "None", provenance: "Signed by the merchant, verified by NextMove" },
        { label: "Removed from your plan", value: t.removedBenefits.length ? t.removedBenefits.map(benefitLabel).join(", ") : "Nothing", provenance: "Signed by the merchant, verified by NextMove" },
        { label: "Discount form", value: t.benefitForm === "ACCOUNT_CREDIT" ? "Merchant credit" : "Lower price", provenance: "Signed by the merchant, verified by NextMove" },
        ...(t.unquantifiedTerms.length ? [{ label: "Terms without numbers", value: t.unquantifiedTerms.map((x) => `“${String(x).slice(0, 80)}”`).join("; "), provenance: "From the merchant (untrusted, shown as written)" }] : []),
        ...(o.message ? [{ label: "Merchant's message", value: `“${String(o.message).slice(0, 280)}”`, provenance: "From the merchant (untrusted, shown as written)" }] : []),
      ],
    });
    if (cmp.lostBenefits.length) blocks.push({ kind: "note", tone: "warn", text: `This offer removes ${cmp.lostBenefits.map(benefitLabel).join(", ")}, which you said you need.` });
    for (const f of v.flags) blocks.push({ kind: "note", tone: "warn", text: FLAG_TEXT[f] });

    const stop = inFlightStop(db, tenantId, contextId, sub.id);
    const stopSt = stop ? stopState(db, stop) : null;
    const done = one<any>(db, "SELECT 1 FROM ext_offer_acceptance WHERE tenant_id=? AND offer_id=?", tenantId, o.offerId);
    const next = forecastFor(env, sub.id)[0];
    const params: AcceptParams = {
      offerId: o.offerId, revision: o.revision, offerDigest: v.offerDigest, subscriptionId: o.subscriptionId,
      promoMonthlyMinor: t.promoMonthlyMinor, promoMonths: t.promoMonths, priceAfterMinor: t.priceAfterMinor, lockInMonths: t.lockInMonths, earlyExitFeeMinor: t.earlyExitFeeMinor, autoRenew: t.autoRenew,
      withdrawStopActionId: stop && stopSt === "APPROVED" ? stop.id : null,
    };
    const unavailable = done ? "This offer was already accepted" : !["ACTIVE", "TRIAL"].includes(sub.state) ? "Renewal is already off; accepting would need a new subscription" : stopSt && stopSt !== "APPROVED" ? "A renewal stop is already under way; wait for its outcome" : undefined;
    candidates.push({
      key: `accept-${sha256Hex(o.offerId).slice(0, 10)}`,
      defaultSelected: false,
      available: !unavailable,
      unavailableReason: unavailable,
      spec: spec({
        operation: OP,
        route: "BANK_INTERNAL",
        capability: "E3",
        ...subjectFields(sub),
        params: params as unknown as Record<string, unknown>,
        money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: t.promoMonthlyMinor, feesMinor: 0, forecastChangeMinor: next ? t.promoMonthlyMinor - sub.amount_minor : 0 },
        consequences: { effectiveAt: sub.next_charge_at, accessUntil: null, lostBenefits: t.removedBenefits.map(benefitLabel), dataEffect: null, remainingObligations: t.lockInMonths ? `${t.lockInMonths}-month lock-in; leaving earlier costs ${money(t.earlyExitFeeMinor)}` : null },
        display: display(
          `Accept ${sub.merchant_name}'s offer`,
          `Stay on ${termsLine(t)}.`,
          [
            { label: "Provider", value: `${sub.merchant_name} · ${maskAccount(sub.subscriber_account_id)}` },
            { label: "Offer", value: termsLine(t) },
            { label: "Lock-in", value: t.lockInMonths ? `${t.lockInMonths} months; leaving earlier costs ${money(t.earlyExitFeeMinor)}` : "None" },
            { label: "Removed", value: t.removedBenefits.length ? t.removedBenefits.map(benefitLabel).join(", ") : "Nothing" },
            { label: "Next charge", value: next ? `${money(t.promoMonthlyMinor)} instead of ${money(sub.amount_minor)} on ${fmtWhen(next.due_at)}` : "No charge in this window" },
            { label: "Offer valid until", value: fmtWhen(o.expiresAt) },
            { label: "Offer", value: `${o.offerId} · revision ${o.revision}` },
          ],
          `${stopSt === "APPROVED" ? `Accepting also withdraws the renewal stop you approved${one(db, "SELECT 1 FROM ext_exit_plan WHERE tenant_id=? AND action_id=?", tenantId, stop.id) ? " (your exit plan)" : ""}, before it starts. ` : ""}The bank keeps the merchant's signed offer as proof of these terms. If the offer expires, changes or fails verification before this runs, nothing is accepted. In this demo the merchant side is simulated.`,
          "Accept offer",
        ),
      }),
    });
    if (!stop) {
      const c = await liveContract(env, sub);
      if (c.contract) candidates.push(stopRenewalCandidate(env, "E3", sub, c.contract, { key: `stop-${sub.merchant_id}`, defaultSelected: false, reason: `Stop ${sub.merchant_name} instead of taking the offer; access continues until the paid period ends.` }));
      else blocks.push({ kind: "note", tone: "info", text: `${sub.merchant_name} could not be reached to prepare a renewal stop. Try again shortly.` });
    } else if (stopSt === "APPROVED") blocks.push({ kind: "note", tone: "info", text: `You already approved stopping ${sub.merchant_name}. That stop keeps running unless you accept this offer first.` });
  }

  const refused = rows.filter((r) => r.status === "REJECTED");
  if (refused.length) {
    blocks.push({
      kind: "table",
      title: "Offers NextMove refused",
      columns: ["Received", "Merchant", "Why"],
      rows: refused.slice(0, 8).map((r) => ({ cells: [fmtWhen(r.received_at), r.merchant_id === "streamly" ? "Streamly" : r.merchant_id === "cloudbox" ? "CloudBox" : "Unknown merchant", REJECTION_TEXT[r.rejection] ?? r.rejection] , tone: "bad" as const })),
      note: "Refused offers are kept for your records and cannot be accepted.",
    });
  }
  blocks.push({ kind: "note", tone: "info", text: "Only signed offers from verified merchants are shown. Nothing is accepted without your approval, and an offer never pauses a stop you already approved." });

  const streamly = one<any>(db, "SELECT id FROM subscriptions WHERE tenant_id=? AND context_id=? AND merchant_id='streamly' AND dataset='ui'", tenantId, contextId);
  const send = (action: string, label: string, body: Record<string, unknown>) => ({ action, label, endpoint: "/labs/ext", body: { module: KEY, action: "send_offer", body } });
  return {
    capability: "E3",
    title: "Retention offers",
    contextId,
    headline: live === 1 ? firstVerdict : live ? `${live} signed offers to compare` : "No open retention offers",
    summary: live ? "Verified offers from your merchants, compared with your current price and with stopping." : "When a verified merchant sends a signed offer to keep you, it appears here with an honest comparison.",
    evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_EVENT", "DETERMINISTIC_CALCULATION"],
    blocks,
    inputs: [
      { key: "horizonMonths", label: "Compare over", type: "number", value: horizon, min: 1, max: 24, suffix: "months" },
      { key: "need", label: "Something you need to keep", type: "select", value: need, options: [{ value: "", label: "Nothing in particular" }, ...benefitOptions.map((b) => ({ value: b, label: benefitLabel(b) }))] },
    ],
    candidates,
    numbers,
    labs: streamly
      ? [
          send("offer-discount", "Streamly sends a signed discount offer", { subscription: "streamly", variant: "valid", plan: "discount", message: "We'd love you to stay! Approve this offer now to lock in your discount." }),
          send("offer-downgrade", "Streamly sends a signed downgrade offer", { subscription: "streamly", variant: "valid", plan: "downgrade" }),
          send("offer-short", "Streamly sends an offer that expires in 5 minutes", { subscription: "streamly", variant: "short", plan: "discount" }),
          send("offer-tampered", "A tampered Streamly offer arrives", { subscription: "streamly", variant: "tampered", plan: "discount" }),
          send("offer-expired", "An expired Streamly offer arrives", { subscription: "streamly", variant: "expired", plan: "discount" }),
          { action: "clock-hour", label: "Move demo clock forward 1 hour", endpoint: "/labs/clock", body: { minutes: 60 } },
        ]
      : [],
  };
}

export const E3: CapabilityDef = {
  id: "E3",
  title: "Retention offers",
  short: "Compare a merchant's offer to stay, honestly",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["retention offer", "offer to stay", "discount to stay", "keep me", "counter offer", "retention", "save offer"],
  analyze: analyzeE3,
};

/* ------------------------------------------------------------------------------------------ operation */

const sameTerms = (t: OfferTerms, p: AcceptParams) =>
  t.promoMonthlyMinor === p.promoMonthlyMinor && t.promoMonths === p.promoMonths && t.priceAfterMinor === p.priceAfterMinor && t.lockInMonths === p.lockInMonths && t.earlyExitFeeMinor === p.earlyExitFeeMinor && t.autoRenew === p.autoRenew;

function acceptOfferOp({ db, action, spec: s, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctx = action.context_id;
  const p = s.params as unknown as AcceptParams;
  tx(db, () => {
    const refuse = (status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) => recordSettled(db, action.id, attemptId, status, { reason });
    const now = nowIso(db, t);
    const row = one<any>(db, "SELECT * FROM ext_retention_offer WHERE tenant_id=? AND context_id=? AND offer_id=? AND revision=?", t, ctx, String(p?.offerId ?? ""), Number(p?.revision));
    if (!row) return refuse("REFUSED", "This offer is not on record for you; nothing was accepted");
    if (one(db, "SELECT 1 FROM ext_offer_acceptance WHERE tenant_id=? AND offer_id=?", t, row.offer_id)) return refuse("NO_CHANGE", "This offer was already accepted");
    if (row.status !== "VERIFIED") return refuse("REFUSED", "This offer did not pass verification; nothing was accepted");
    const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", s.subjectRef, t, ctx);
    if (!sub || sub.contract_id !== row.subscription_id || sub.merchant_id !== row.merchant_id) return refuse("REFUSED", "The subscription no longer matches this offer; nothing was accepted");
    if (!["ACTIVE", "TRIAL"].includes(sub.state)) return refuse("REFUSED", "Renewal is already off; nothing was accepted");
    const v = reverify(db, row, now);
    if (!v.ok) return refuse("REFUSED", `${REJECTION_TEXT[v.reason] ?? v.reason}; nothing was accepted`);
    if (v.offerDigest !== p.offerDigest || v.offerDigest !== row.offer_digest || !sameTerms(v.offer.terms, p)) return refuse("REFUSED", "The offer differs from what you approved; nothing was accepted");
    const g = one<any>(db, "SELECT g.* FROM grants g JOIN attempts a ON a.grant_id=g.id WHERE a.id=? AND g.action_id=? AND g.tenant_id=?", attemptId, action.id, t);
    if (!g) return refuse("BLOCKED", "No approval found for this step; nothing was accepted");
    const stop = inFlightStop(db, t, ctx, sub.id);
    // Only the stop shown at approval may be withdrawn; a stop approved later is never cancelled by this acceptance.
    if (stop && stop.id !== p.withdrawStopActionId) return refuse("REFUSED", "A renewal stop you approved after this offer is pending; nothing was accepted");
    const stopGrant = stop ? one<any>(db, "SELECT expires_at FROM grants WHERE action_id=? ORDER BY issued_at DESC LIMIT 1", stop.id) : null;
    const cancellation: PendingCancellation | undefined = stop ? { subscriptionId: row.subscription_id, state: stopState(db, stop), mustCompleteBefore: stopGrant?.expires_at ?? sub.next_charge_at ?? v.offer.expiresAt } : undefined;
    const acceptedKeys = new Set(all<any>(db, "SELECT idempotency_key FROM ext_offer_acceptance WHERE tenant_id=?", t).map((r) => r.idempotency_key as string));
    const grant = { grantId: g.id, ownerId: t, contextId: contextKind(db, ctx), manifestDigest: p.offerDigest, issuedAt: g.issued_at, expiresAt: g.expires_at };
    let r: ReturnType<typeof acceptOffer>;
    try {
      r = acceptOffer(v, grant, { now, cancellation, acceptedKeys });
    } catch {
      return refuse("REFUSED", "The approval could not be checked; nothing was accepted");
    }
    if (!r.ok) return refuse(r.reason === "ALREADY_ACCEPTED" ? "NO_CHANGE" : "REFUSED", r.reason === "CANCELLATION_IN_FLIGHT" ? "A renewal stop is already under way; nothing was accepted" : r.reason === "OFFER_EXPIRED" ? "The offer expired; nothing was accepted" : `The approval does not cover this offer (${r.reason.toLowerCase().replace(/_/g, " ")}); nothing was accepted`);
    const reference = `NMO-${sha256Hex(action.logical_key).slice(0, 10).toUpperCase()}`;
    let withdrew: string | null = null;
    for (const e of r.effects) {
      if (e.type === "WITHDRAW_CANCELLATION" && stop) {
        run(db, "UPDATE grants SET status='INVALIDATED', invalid_reason=? WHERE action_id=? AND status='ACTIVE'", `withdrawn: retention offer accepted (${reference})`, stop.id);
        run(db, "UPDATE jobs SET status='DONE', last_error='WITHDRAWN', updated_at=? WHERE kind='ACTION' AND ref_id=? AND status='QUEUED'", new Date().toISOString(), stop.id);
        recordSettled(db, stop.id, null, "REVOKED", { reason: `Withdrawn before it started: you accepted ${sub.merchant_name}'s offer (${reference})` });
        run(db, "UPDATE ext_exit_plan SET status='VOID', updated_at=? WHERE tenant_id=? AND action_id=? AND status IN ('ACTIVE','ASKED')", now, t, stop.id);
        withdrew = stop.id;
      }
      if (e.type === "ACCEPT_OFFER") {
        run(db, "INSERT INTO ext_offer_acceptance(tenant_id, context_id, idempotency_key, offer_id, revision, offer_digest, action_id, reference, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)", t, ctx, e.idempotencyKey, e.offerId, e.revision, e.offerDigest, action.id, reference, now);
        run(db, "UPDATE ext_retention_offer SET status='ACCEPTED' WHERE tenant_id=? AND offer_id=? AND revision=?", t, e.offerId, e.revision);
      }
    }
    const next = one<any>(db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", t, ctx, sub.id);
    if (next && v.offer.terms.promoMonths > 0) {
      applyForecastEvent(db, { sourceEventId: `ext:offer:${reference}`, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { amountMinor: -v.offer.terms.promoMonthlyMinor, label: `${sub.merchant_name} (retention offer)` }, reason: `Accepted ${sub.merchant_name} retention offer (${reference})` });
    }
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: sub.next_charge_at ?? now,
      accessUntil: null,
      termsRevision: null,
      details: { offerId: v.offer.offerId, revision: v.offer.revision, offerDigest: v.offerDigest, terms: v.offer.terms, withdrewStop: withdrew },
      channel: "BANK",
      verification: { method: "SIGNED_OFFER", checks: ["Ed25519 signature against the merchant's registered public key", "merchant verified and enrolled", "subscription is yours", "offer not expired", "terms and digest equal what you approved"] },
      evidence: "BANK_RECORD",
    });
  });
}

/* ------------------------------------------------------------------------------------------ labs: simulated merchant */

function round100(n: number) {
  return Math.max(100, Math.round(n / 100) * 100);
}

function sendOffer({ db, session, body }: { db: DatabaseSync; session: any; body: Record<string, unknown> }) {
  const subRef = String(body.subscription ?? "");
  const variant = String(body.variant ?? "valid");
  const plan = String(body.plan ?? "discount");
  if (!VARIANTS.has(variant)) throw new HttpError(400, "BAD_VARIANT", "variant must be valid, tampered, expired or short");
  if (!PLANS.has(plan)) throw new HttpError(400, "BAD_PLAN", "plan must be discount or downgrade");
  if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 280)) throw new HttpError(400, "BAD_MESSAGE", "message must be text up to 280 characters");
  let sub: any;
  if (/^[a-z0-9-]{1,40}$/.test(subRef)) {
    if (!LABS_SUBS.has(subRef)) throw new HttpError(400, "BAD_SUBSCRIPTION", "This simulated merchant cannot send offers");
    sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", `${session.tenantId}:sub:${subRef}`, session.tenantId, session.contextId);
  } else if (/^[A-Za-z0-9:._-]{1,120}$/.test(subRef)) {
    sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", subRef, session.tenantId, session.contextId);
    if (sub && !LABS_SUBS.has(sub.merchant_id)) throw new HttpError(400, "BAD_SUBSCRIPTION", "This simulated merchant cannot send offers");
  } else throw new HttpError(400, "BAD_SUBSCRIPTION", "Unknown subscription");
  if (!sub) throw new HttpError(404, "NOT_FOUND", "Subscription not found in this context");
  return tx(db, () => {
    const now = nowMs(db, session.tenantId);
    const at = nowIso(db, session.tenantId);
    const key = merchantSigningKey(db, session.tenantId, sub.merchant_id, at);
    const benefits = Object.keys(JSON.parse(sub.benefits_json ?? "{}") ?? {});
    const current = sub.amount_minor as number;
    const terms: OfferTerms =
      plan === "discount"
        ? { currency: "RON", promoMonthlyMinor: round100(current * 0.6), promoMonths: 3, priceAfterMinor: current, autoRenew: true, lockInMonths: 3, earlyExitFeeMinor: 2000, benefitForm: "PRICE_REDUCTION", removedBenefits: [], unquantifiedTerms: [] }
        : { currency: "RON", promoMonthlyMinor: round100(current * 0.7), promoMonths: 12, priceAfterMinor: round100(current * 0.7), autoRenew: true, lockInMonths: 0, earlyExitFeeMinor: 0, benefitForm: "PRICE_REDUCTION", removedBenefits: benefits.slice(0, 1), unquantifiedTerms: [] };
    const [issued, expires] = variant === "expired" ? [now - 50 * HOUR, now - 2 * HOUR] : variant === "short" ? [now, now + 5 * 60_000] : [now, now + 48 * HOUR];
    const offer: RetentionOffer = {
      offerId: `off_${randomBytes(8).toString("hex")}`,
      revision: 1,
      merchantId: sub.merchant_id,
      subscriptionId: sub.contract_id,
      subscriberAccountId: sub.subscriber_account_id,
      issuedAt: toLocalIso(issued),
      expiresAt: toLocalIso(expires),
      terms,
      ...(typeof body.message === "string" && body.message ? { message: body.message } : {}),
    };
    let signed = signOffer(offer, key);
    // Changed in transit after signing: the bank must refuse it.
    if (variant === "tampered") signed = { ...signed, offer: { ...offer, terms: { ...terms, promoMonthlyMinor: Math.max(0, terms.promoMonthlyMinor - 1000) } } };
    const { row, duplicate } = receiveOffer(db, session.tenantId, signed, at);
    return { ok: true, offerId: row.offer_id, status: row.status, rejection: row.rejection, duplicate, keyId: key.keyId };
  });
}

/* ------------------------------------------------------------------------------------------ module */

export const retentionOffers: ExtensionModule = {
  key: KEY,
  capabilities: [E3],
  operations: { [OP]: acceptOfferOp },
  // The bank's registry of business clients allowed to send offers; no offers or keys are seeded.
  seed: (db, { tenantId, customer }) => {
    if (customer !== "alex") return;
    for (const m of OFFER_MERCHANTS) run(db, "INSERT OR IGNORE INTO ext_offer_merchant(tenant_id, merchant_id, verified, offers_enabled) VALUES (?,?,?,?)", tenantId, m.merchantId, m.verified ? 1 : 0, m.offersEnabled ? 1 : 0);
  },
  // A file removed here while the reset rolls back is harmless: merchantSigningKey rotates a key whose private half is gone.
  reset: (_db, tenantId) => deleteMerchantKeyFiles(tenantId),
  labs: { send_offer: sendOffer },
};
