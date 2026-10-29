import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../../db/connection";
import { HttpError, type Session } from "../../auth/session";
import { nowIso } from "../../clock";
import { sha256Hex } from "../../canonical";
import { applyForecastEvent } from "../../bank/forecast";
import { balanceOf, postCardOrTransfer } from "../../bank/ledger";
import { notify } from "../../agent/events";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, display, fmtWhen, forecastFor, inputOr, liveContract, maskAccount, money, spec, stopRenewalCandidate, subjectFields } from "../../capabilities/core";
import type { ExtensionModule, ExtActionContext } from "../types";
import { activatePriceCeiling, answerPriceRise, createPriceCeiling, decideAuthorization, priceRiseManifest, type PriceCeiling } from "../../../../extensions/src/price-consent-gate/index.ts";
import type { CustomerContext, Scope } from "../../../../extensions/src/shared/authority.ts";

// E5 Price consent gate: the customer approves a price ceiling for a subscription. When the merchant later asks for
// more on the card without the customer present, the bank soft-declines before any money moves and asks. Accepting
// the new price is its own exact approval; declining a card payment never ends the contract, so stopping renewal is
// always offered next to it.

const KEY = "price-gate";
const OP_SET = "EXT_SET_PRICE_CEILING";
const OP_ACCEPT = "EXT_ACCEPT_PRICE";
const MAX_MINOR = 1_000_000;
const INITIATORS = new Set(["MERCHANT", "CUSTOMER"]);

interface SetParams { ceilingId: string; subscriptionId: string; merchantIds: string[]; currency: string; approvedMinor: number; manifestDigest: string }
interface AcceptParams { ceilingId: string; subscriptionId: string; fromMinor: number; toMinor: number; currency: string; riseKey: string; manifestDigest: string }

const kindOf = (db: DatabaseSync, contextId: string): CustomerContext => (one<any>(db, "SELECT kind FROM contexts WHERE id=?", contextId)?.kind === "BUSINESS" ? "BUSINESS" : "PERSONAL");
const scopeOf = (db: DatabaseSync, tenantId: string, contextId: string): Scope => ({ ownerId: tenantId, contextId: kindOf(db, contextId) });

function toCeiling(db: DatabaseSync, r: any): PriceCeiling {
  return {
    ceilingId: r.ceiling_id,
    terms: { scope: scopeOf(db, r.tenant_id, r.context_id), subscriptionId: r.subscription_id, merchantIds: JSON.parse(r.merchant_ids_json), currency: r.currency, approvedMinor: r.approved_minor },
    manifestDigest: r.manifest_digest,
    status: r.status,
    ...(r.grant_id ? { grantId: r.grant_id } : {}),
    ...(r.rejected_minor != null ? { rejected: { amountMinor: r.rejected_minor, currency: r.rejected_currency } } : {}),
  };
}

const liveCeiling = (db: DatabaseSync, tenantId: string, contextId: string, subId: string) =>
  one<any>(db, "SELECT * FROM ext_price_ceiling WHERE tenant_id=? AND context_id=? AND subscription_id=? AND status IN ('ACTIVE','PAUSED')", tenantId, contextId, subId);

function grantFor(db: DatabaseSync, action: any, attemptId: string, scope: Scope, manifestDigest: string) {
  const g = one<any>(db, "SELECT g.* FROM grants g JOIN attempts a ON a.grant_id=g.id WHERE a.id=? AND g.action_id=? AND g.tenant_id=?", attemptId, action.id, action.tenant_id);
  return g ? { grantId: g.id as string, ...scope, manifestDigest, issuedAt: g.issued_at as string, expiresAt: g.expires_at as string } : null;
}

/* ------------------------------------------------------------------------------------------ capability */

async function analyzeE5(env: CapEnv): Promise<Analysis> {
  const { db, tenantId, contextId } = env;
  const subs = all<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='ui' AND state IN ('ACTIVE','TRIAL') ORDER BY merchant_name", tenantId, contextId);
  const blocks: Block[] = [];
  const candidates: Candidate[] = [];
  const numbers: Record<string, number> = {};
  const scope = scopeOf(db, tenantId, contextId);
  const wanted = String(inputOr(env, "subscription", ""));
  const sub = subs.find((s) => s.id === wanted) ?? subs.find((s) => liveCeiling(db, tenantId, contextId, s.id)) ?? subs.find((s) => s.merchant_id === "streamly") ?? subs[0];

  const live = all<any>(db, "SELECT c.*, s.merchant_name FROM ext_price_ceiling c JOIN subscriptions s ON s.id=c.subscription_id AND s.tenant_id=c.tenant_id WHERE c.tenant_id=? AND c.context_id=? AND c.status IN ('ACTIVE','PAUSED') ORDER BY s.merchant_name", tenantId, contextId);
  if (live.length) blocks.push({ kind: "table", title: "Price ceilings in force", columns: ["Subscription", "Most a merchant may take without asking", "State"], rows: live.map((c) => ({ cells: [c.merchant_name, money(c.approved_minor), c.status === "ACTIVE" ? "On" : "Paused"] })) });

  const notices = all<any>(db, "SELECT n.*, s.merchant_name FROM ext_price_rise_notice n JOIN subscriptions s ON s.id=n.subscription_id AND s.tenant_id=n.tenant_id WHERE n.tenant_id=? AND n.context_id=? AND n.status='OPEN' ORDER BY n.created_at DESC", tenantId, contextId);
  for (const n of notices) {
    const d = one<any>(db, "SELECT declines FROM ext_price_gate_decline WHERE tenant_id=? AND rise_key=?", tenantId, n.rise_key);
    blocks.push({ kind: "status", title: `${n.merchant_name} asked for ${money(n.requested_minor)} instead of ${money(n.current_minor)}`, state: "DECLINED", detail: `Declined ${d?.declines ?? 1} time${(d?.declines ?? 1) === 1 ? "" : "s"}; nothing left your account. The ${n.merchant_name} contract is not cancelled by this: accept the new price or stop renewal.` });
  }

  const log = all<any>(db, "SELECT a.*, s.merchant_name FROM ext_price_gate_auth a JOIN subscriptions s ON s.id=a.subscription_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.context_id=? ORDER BY a.at DESC, a.auth_id LIMIT 8", tenantId, contextId);
  if (log.length) {
    blocks.push({
      kind: "table",
      title: "Recent card charges the gate checked",
      columns: ["When", "Merchant", "Amount", "Outcome"],
      rows: log.map((a) => ({ cells: [fmtWhen(a.at), a.merchant_name, money(a.amount_minor), a.decision === "APPROVE" ? (a.transaction_id ? "Paid" : "Allowed") : `Declined (${String(a.reason).toLowerCase().replace(/_/g, " ")})`], tone: a.decision === "APPROVE" ? ("neutral" as const) : ("warn" as const) })),
    });
  }

  if (sub) {
    const cur = liveCeiling(db, tenantId, contextId, sub.id);
    const raw = Number(inputOr(env, "ceilingMinor", cur?.approved_minor ?? sub.amount_minor));
    const ceilingMinor = Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_MINOR ? raw : sub.amount_minor;
    numbers.ceilingMinor = ceilingMinor;
    numbers.currentPriceMinor = sub.amount_minor;
    const draft = createPriceCeiling({ scope, subscriptionId: sub.id, merchantIds: [sub.merchant_id], currency: "RON", approvedMinor: ceilingMinor });
    const same = cur && cur.status === "ACTIVE" && cur.approved_minor === ceilingMinor;
    const params: SetParams = { ceilingId: draft.ceilingId, subscriptionId: sub.id, merchantIds: [...draft.terms.merchantIds], currency: "RON", approvedMinor: ceilingMinor, manifestDigest: draft.manifestDigest };
    const next = forecastFor(env, sub.id)[0];
    candidates.push({
      key: `set-ceiling-${sub.merchant_id}`,
      defaultSelected: true,
      available: !same,
      unavailableReason: same ? "This ceiling is already on" : undefined,
      spec: spec({
        operation: OP_SET,
        route: "BANK_INTERNAL",
        capability: "E5",
        ...subjectFields(sub),
        params: params as unknown as Record<string, unknown>,
        display: display(
          `${cur ? "Change" : "Set"} a ${money(ceilingMinor)} price ceiling for ${sub.merchant_name}`,
          `Card charges ${sub.merchant_name} starts without you above ${money(ceilingMinor)} are declined until you agree.`,
          [
            { label: "Subscription", value: `${sub.merchant_name} · ${sub.plan_name} · ${maskAccount(sub.subscriber_account_id)}` },
            { label: "Current price", value: `${money(sub.amount_minor)}/month` },
            { label: "Ceiling", value: money(ceilingMinor) },
            ...(cur ? [{ label: "Replaces", value: `${money(cur.approved_minor)} ceiling` }] : []),
            { label: "Next charge", value: next ? `${money(-next.amount_minor)} on ${fmtWhen(next.due_at)}` : "None in this window" },
            { label: "Applies to", value: "Charges the merchant starts. Payments you make yourself are not blocked." },
          ],
          "Money in your accounts does not change. A declined card payment does not cancel the contract: the merchant may still consider the amount owed, so stop renewal if you want to leave.",
          "Turn on ceiling",
        ),
      }),
    });

    const notice = notices.find((n) => n.subscription_id === sub.id);
    if (notice && cur) {
      const ceiling = toCeiling(db, cur);
      const ok = cur.status === "ACTIVE" && cur.ceiling_id === notice.ceiling_id && notice.requested_minor > cur.approved_minor;
      const m = priceRiseManifest(ceiling, notice.requested_minor, notice.currency);
      const ap: AcceptParams = { ceilingId: cur.ceiling_id, subscriptionId: sub.id, fromMinor: cur.approved_minor, toMinor: notice.requested_minor, currency: notice.currency, riseKey: notice.rise_key, manifestDigest: m.manifestDigest };
      candidates.push({
        key: `accept-price-${sub.merchant_id}`,
        defaultSelected: false,
        available: ok,
        unavailableReason: ok ? undefined : "The ceiling changed since this price was asked for",
        spec: spec({
          operation: OP_ACCEPT,
          route: "BANK_INTERNAL",
          capability: "E5",
          ...subjectFields(sub),
          params: ap as unknown as Record<string, unknown>,
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: notice.requested_minor, feesMinor: 0, forecastChangeMinor: next ? notice.requested_minor - cur.approved_minor : 0 },
          display: display(
            `Accept ${sub.merchant_name}'s new price of ${money(notice.requested_minor)}`,
            `Raise the ceiling from ${money(cur.approved_minor)} to ${money(notice.requested_minor)} so ${sub.merchant_name}'s next attempt goes through.`,
            [
              { label: "Subscription", value: `${sub.merchant_name} · ${maskAccount(sub.subscriber_account_id)}` },
              { label: "Price asked", value: `${money(notice.requested_minor)} (was ${money(cur.approved_minor)})` },
              { label: "New ceiling", value: money(notice.requested_minor) },
              { label: "Next charge", value: next ? `Up to ${money(notice.requested_minor)} on ${fmtWhen(next.due_at)}` : "When the merchant retries" },
            ],
            "Nothing is charged by this approval itself. The merchant takes the payment when it retries.",
            "Accept new price",
          ),
        }),
      });
      const c = await liveContract(env, sub);
      if (c.contract) candidates.push(stopRenewalCandidate(env, "E5", sub, c.contract, { key: `stop-${sub.merchant_id}`, defaultSelected: false, reason: `Leave ${sub.merchant_name} instead of paying the higher price; access continues until the paid period ends.` }));
      else blocks.push({ kind: "note", tone: "info", text: `${sub.merchant_name} could not be reached to prepare a renewal stop. Try again shortly.` });
    }
  }
  blocks.push({ kind: "note", tone: "info", text: "The bank can decline a card payment; it cannot cancel a contract. Declining keeps your money in place while you decide, and stopping renewal is the way to leave." });

  const labsSub = sub ? sub.id.split(":").pop() : null;
  const charge = (action: string, label: string, amountMinor: number, initiator: string) => ({ action, label, endpoint: "/labs/ext", body: { module: KEY, action: "merchant_charge", body: { subscription: labsSub, amountMinor, initiator } } });
  const cur = sub ? liveCeiling(db, tenantId, contextId, sub.id) : null;
  const notice = sub ? notices.find((n) => n.subscription_id === sub.id) : null;
  return {
    capability: "E5",
    title: "Price consent gate",
    contextId,
    headline: notices.length ? `${notices[0].merchant_name} tried to charge ${money(notices[0].requested_minor)} instead of ${money(notices[0].current_minor)}. The bank declined it, so nothing left your account. Accept the new price or stop renewal` : live.length ? `${live.length} price ceiling${live.length === 1 ? "" : "s"} on` : "No price ceilings yet",
    summary: "Set the most a subscription may take without asking. In this demo the ceiling is checked on the simulated merchant charges sent from this page: a higher charge is declined before any money moves.",
    evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_EVENT", "DETERMINISTIC_CALCULATION"],
    blocks,
    inputs: [
      { key: "subscription", label: "Subscription", type: "select", value: sub?.id ?? "", options: subs.map((s) => ({ value: s.id, label: `${s.merchant_name} · ${money(s.amount_minor)}` })) },
      { key: "ceilingMinor", label: "Price ceiling", type: "money", value: numbers.ceilingMinor ?? null, min: 0, max: MAX_MINOR },
    ],
    candidates,
    numbers,
    labs: sub
      ? [
          charge("charge-rise", `${sub.merchant_name} charges ${money((cur?.approved_minor ?? sub.amount_minor) + 1000)} (merchant-initiated)`, (cur?.approved_minor ?? sub.amount_minor) + 1000, "MERCHANT"),
          ...(notice ? [charge("charge-retry", `${sub.merchant_name} retries ${money(notice.requested_minor)}`, notice.requested_minor, "MERCHANT")] : []),
          charge("charge-same", `${sub.merchant_name} charges ${money(cur?.approved_minor ?? sub.amount_minor)} (merchant-initiated)`, cur?.approved_minor ?? sub.amount_minor, "MERCHANT"),
        ]
      : [],
  };
}

export const E5: CapabilityDef = {
  id: "E5",
  title: "Price consent gate",
  short: "Higher subscription charges wait for your yes",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["price rise", "price increase", "price ceiling", "charged more", "price went up", "price gate", "consent", "raise my price", "without asking", "ask me first", "higher charge", "higher subscription charge"],
  analyze: analyzeE5,
};

/* ------------------------------------------------------------------------------------------ operations */

function setCeilingOp({ db, action, spec: s, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctx = action.context_id;
  const p = s.params as unknown as SetParams;
  tx(db, () => {
    const refuse = (status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) => recordSettled(db, action.id, attemptId, status, { reason });
    const now = nowIso(db, t);
    const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", s.subjectRef, t, ctx);
    if (!sub || sub.id !== p?.subscriptionId || !["ACTIVE", "TRIAL"].includes(sub.state)) return refuse("REFUSED", "The subscription is no longer active; nothing was changed");
    if (!Array.isArray(p.merchantIds) || p.merchantIds.length !== 1 || p.merchantIds[0] !== sub.merchant_id || p.currency !== "RON") return refuse("REFUSED", "The ceiling no longer matches this subscription; nothing was changed");
    const scope = scopeOf(db, t, ctx);
    let draft: PriceCeiling;
    try {
      draft = createPriceCeiling({ scope, subscriptionId: sub.id, merchantIds: p.merchantIds, currency: p.currency, approvedMinor: p.approvedMinor });
    } catch {
      return refuse("REFUSED", "The ceiling is not valid; nothing was changed");
    }
    if (draft.manifestDigest !== p.manifestDigest || draft.ceilingId !== p.ceilingId) return refuse("REFUSED", "The ceiling differs from what you approved; nothing was changed");
    const cur = liveCeiling(db, t, ctx, sub.id);
    if (cur && cur.status === "ACTIVE" && cur.approved_minor === p.approvedMinor && cur.currency === p.currency) return refuse("NO_CHANGE", "This ceiling is already on");
    const grant = grantFor(db, action, attemptId, scope, p.manifestDigest);
    if (!grant) return refuse("BLOCKED", "No approval found for this step; nothing was changed");
    const r = activatePriceCeiling(draft, grant, now);
    if (!r.ok) return refuse("REFUSED", `The approval does not cover this ceiling (${r.reason.toLowerCase().replace(/_/g, " ")}); nothing was changed`);
    if (cur) run(db, "UPDATE ext_price_ceiling SET status='REVOKED', updated_at=? WHERE tenant_id=? AND ceiling_id=?", now, t, cur.ceiling_id);
    const c = r.ceiling;
    run(
      db,
      `INSERT INTO ext_price_ceiling(tenant_id, ceiling_id, context_id, subscription_id, merchant_ids_json, currency, approved_minor, manifest_digest, status, grant_id, rejected_minor, rejected_currency, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', ?, NULL, NULL, ?)
       ON CONFLICT(tenant_id, ceiling_id) DO UPDATE SET status='ACTIVE', approved_minor=excluded.approved_minor, manifest_digest=excluded.manifest_digest, grant_id=excluded.grant_id, rejected_minor=NULL, rejected_currency=NULL, updated_at=excluded.updated_at`,
      t, c.ceilingId, ctx, sub.id, JSON.stringify(c.terms.merchantIds), c.terms.currency, c.terms.approvedMinor, c.manifestDigest, c.grantId ?? grant.grantId, now,
    );
    // A new ceiling that already covers a declined price answers that request; one that still falls short leaves it open.
    run(db, "UPDATE ext_price_rise_notice SET status='ACCEPTED', answered_at=? WHERE tenant_id=? AND context_id=? AND subscription_id=? AND status='OPEN' AND currency=? AND requested_minor <= ?", now, t, ctx, sub.id, c.terms.currency, c.terms.approvedMinor);
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference: `NMP-${sha256Hex(action.logical_key).slice(0, 10).toUpperCase()}`,
      effectiveAt: now,
      accessUntil: null,
      termsRevision: null,
      details: { ceilingId: c.ceilingId, subscriptionId: sub.id, approvedMinor: c.terms.approvedMinor, currency: c.terms.currency, replaced: cur?.ceiling_id ?? null },
      channel: "BANK",
      verification: { method: "BANK_CARD_CONTROL", checks: ["subscription active and yours", "ceiling equals what you approved", "approval grant matches the ceiling digest"] },
      evidence: "BANK_RECORD",
    });
  });
}

function acceptPriceOp({ db, action, spec: s, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctx = action.context_id;
  const p = s.params as unknown as AcceptParams;
  tx(db, () => {
    const refuse = (status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) => recordSettled(db, action.id, attemptId, status, { reason });
    const now = nowIso(db, t);
    const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", s.subjectRef, t, ctx);
    if (!sub || sub.id !== p?.subscriptionId || !["ACTIVE", "TRIAL"].includes(sub.state)) return refuse("REFUSED", "The subscription is no longer active; nothing was changed");
    const notice = one<any>(db, "SELECT * FROM ext_price_rise_notice WHERE tenant_id=? AND context_id=? AND rise_key=?", t, ctx, String(p.riseKey ?? ""));
    if (!notice || notice.subscription_id !== sub.id || notice.requested_minor !== p.toMinor || notice.currency !== p.currency) return refuse("REFUSED", "This price request is not on record; nothing was changed");
    if (notice.status === "ACCEPTED") return refuse("NO_CHANGE", "You already accepted this price");
    const cur = liveCeiling(db, t, ctx, sub.id);
    if (!cur || cur.status !== "ACTIVE" || cur.ceiling_id !== p.ceilingId || cur.approved_minor !== p.fromMinor || cur.currency !== p.currency) return refuse("REFUSED", "The price ceiling changed since you approved; nothing was changed");
    const ceiling = toCeiling(db, cur);
    if (priceRiseManifest(ceiling, p.toMinor, p.currency).manifestDigest !== p.manifestDigest) return refuse("REFUSED", "The price differs from what you approved; nothing was changed");
    const grant = grantFor(db, action, attemptId, ceiling.terms.scope, p.manifestDigest);
    if (!grant) return refuse("BLOCKED", "No approval found for this step; nothing was changed");
    const r = answerPriceRise(ceiling, { newMinor: p.toMinor, currency: p.currency }, { kind: "ACCEPT", grant }, now);
    if (!r.ok) return refuse(r.reason === "NOT_A_RISE" ? "NO_CHANGE" : "REFUSED", r.reason === "NOT_A_RISE" ? "The ceiling already covers this price" : `The approval does not cover this price (${r.reason.toLowerCase().replace(/_/g, " ")}); nothing was changed`);
    const c = r.ceiling;
    run(db, "UPDATE ext_price_ceiling SET approved_minor=?, currency=?, manifest_digest=?, grant_id=?, rejected_minor=NULL, rejected_currency=NULL, updated_at=? WHERE tenant_id=? AND ceiling_id=?", c.terms.approvedMinor, c.terms.currency, c.manifestDigest, c.grantId ?? grant.grantId, now, t, cur.ceiling_id);
    run(db, "UPDATE ext_price_rise_notice SET status='ACCEPTED', answered_at=? WHERE tenant_id=? AND rise_key=?", now, t, notice.rise_key);
    const reference = `NMR-${sha256Hex(action.logical_key).slice(0, 10).toUpperCase()}`;
    const next = one<any>(db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", t, ctx, sub.id);
    if (next) applyForecastEvent(db, { sourceEventId: `ext:pricegate:${reference}`, tenantId: t, kind: "CHANGE", itemId: next.id, changes: { amountMinor: -p.toMinor }, reason: `Accepted ${sub.merchant_name} price of ${money(p.toMinor)} (${reference})` });
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: now,
      accessUntil: null,
      termsRevision: null,
      details: { ceilingId: cur.ceiling_id, fromMinor: p.fromMinor, toMinor: p.toMinor, currency: p.currency },
      channel: "BANK",
      verification: { method: "BANK_CARD_CONTROL", checks: ["price request on record", "ceiling unchanged since approval", "approval grant matches the price-rise digest"] },
      evidence: "BANK_RECORD",
    });
  });
}

/* ------------------------------------------------------------------------------------------ labs: merchant card charge */

function merchantCharge({ db, session, body }: { db: DatabaseSync; session: Session; body: Record<string, unknown> }) {
  const subRef = String(body.subscription ?? "");
  const amountMinor = Number(body.amountMinor);
  const initiator = String(body.initiator ?? "MERCHANT");
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_MINOR) throw new HttpError(400, "BAD_AMOUNT", "amountMinor must be an integer from 1 to 1000000");
  if (!INITIATORS.has(initiator)) throw new HttpError(400, "BAD_INITIATOR", "initiator must be MERCHANT or CUSTOMER");
  let subId: string;
  if (/^[a-z0-9-]{1,40}$/.test(subRef)) subId = `${session.tenantId}:sub:${subRef}`;
  else if (/^[A-Za-z0-9:._-]{1,120}$/.test(subRef)) subId = subRef;
  else throw new HttpError(400, "BAD_SUBSCRIPTION", "Unknown subscription");
  const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", subId, session.tenantId, session.contextId);
  if (!sub) throw new HttpError(404, "NOT_FOUND", "Subscription not found in this context");
  return tx(db, () => {
    const t = session.tenantId;
    const ctx = session.contextId;
    const at = nowIso(db, t);
    const n = (one<any>(db, "SELECT COUNT(*) AS n FROM ext_price_gate_auth WHERE tenant_id=?", t)?.n ?? 0) + 1;
    const authId = `PG-${sha256Hex(`${t}:${sub.id}:${n}`).slice(0, 10).toUpperCase()}`;
    const ceilings = all<any>(db, "SELECT * FROM ext_price_ceiling WHERE tenant_id=? AND context_id=? AND status IN ('ACTIVE','PAUSED')", t, ctx).map((r) => toCeiling(db, r));
    const notifiedKeys = new Set(all<any>(db, "SELECT rise_key FROM ext_price_rise_notice WHERE tenant_id=?", t).map((r) => r.rise_key as string));
    const declinesByKey = new Map(all<any>(db, "SELECT rise_key, declines FROM ext_price_gate_decline WHERE tenant_id=?", t).map((r) => [r.rise_key as string, r.declines as number]));
    const d = decideAuthorization(
      { authId, scope: scopeOf(db, t, ctx), merchantId: sub.merchant_id, amountMinor, currency: "RON", billingAmountMinor: amountMinor, billingCurrency: "RON", initiator: initiator as "MERCHANT" | "CUSTOMER", receivedAt: at },
      { ceilings, notifiedKeys, declinesByKey },
    );
    const logAuth = (decision: "APPROVE" | "DECLINE", reason: string, extra: { advice?: string | null; riseKey?: string | null; transactionId?: string | null } = {}) =>
      run(db, "INSERT INTO ext_price_gate_auth(tenant_id, auth_id, context_id, subscription_id, merchant_id, amount_minor, currency, initiator, decision, reason, advice, rise_key, transaction_id, at) VALUES (?,?,?,?,?,?, 'RON', ?,?,?,?,?,?,?)",
        t, authId, ctx, sub.id, sub.merchant_id, amountMinor, initiator, decision, reason, extra.advice ?? null, extra.riseKey ?? null, extra.transactionId ?? null, at);

    if (d.action === "DECLINE") {
      run(db, "INSERT INTO ext_price_gate_decline(tenant_id, rise_key, declines, last_at) VALUES (?,?,1,?) ON CONFLICT(tenant_id, rise_key) DO UPDATE SET declines=declines+1, last_at=excluded.last_at", t, d.key, at);
      for (const e of d.effects) {
        if (e.type !== "NOTIFY_PRICE_RISE") continue;
        const ceilingId = e.ceilingIds.find((id) => ceilings.some((c) => c.ceilingId === id && c.terms.subscriptionId === sub.id)) ?? e.ceilingIds[0];
        run(db, "INSERT OR IGNORE INTO ext_price_rise_notice(tenant_id, rise_key, context_id, subscription_id, ceiling_id, current_minor, requested_minor, currency, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?)", t, e.key, ctx, sub.id, ceilingId, e.currentMinor, e.requestedMinor, e.currency, at);
        const title = `${sub.merchant_name} asked for ${money(e.requestedMinor)}`;
        const text = `That is above the ${money(e.currentMinor)} you approved, so the payment was declined and nothing left your account. Your ${sub.merchant_name} contract is not cancelled: accept the new price or stop renewal.`;
        const findingId = `${t}:finding:pricegate:${sha256Hex(e.key).slice(0, 16)}`;
        run(
          db,
          "INSERT OR IGNORE INTO findings(id, tenant_id, context_id, watch_id, dedupe_key, kind, title, body, subject_ref, task_kind, priority, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          findingId, t, ctx, null, findingId, "PRICE_RISE_DECLINED", title, text, sub.id, "E5", 0, JSON.stringify({ merchantId: sub.merchant_id, currentMinor: e.currentMinor, requestedMinor: e.requestedMinor, riseKey: e.key }), at,
        );
        notify(db, { tenantId: t, contextId: ctx, title, body: text, link: "/capabilities/E5", findingId, dedupeKey: `ntf:pricegate:${t}:${sha256Hex(e.key).slice(0, 16)}` });
      }
      logAuth("DECLINE", d.reason, { advice: d.advice, riseKey: d.key });
      return { decision: "DECLINE", reason: d.reason, advice: d.advice, authId, transactionId: null, message: `Declined ${money(amountMinor)} from ${sub.merchant_name}: above your approved price. Nothing was taken.` };
    }

    // The gate allows it; the card still applies its own checks before money moves.
    const acct = one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", t, ctx);
    const card = acct?.card_json ? JSON.parse(acct.card_json) : null;
    if (!acct || card?.status === "FROZEN") {
      logAuth("DECLINE", "CARD_FROZEN");
      return { decision: "DECLINE", reason: "CARD_FROZEN", advice: null, authId, transactionId: null, message: "Declined: the card is frozen." };
    }
    if (balanceOf(db, acct.id) < amountMinor) {
      logAuth("DECLINE", "INSUFFICIENT_FUNDS");
      return { decision: "DECLINE", reason: "INSUFFICIENT_FUNDS", advice: null, authId, transactionId: null, message: "Declined: not enough money in the account." };
    }
    const r = postCardOrTransfer(db, { tenantId: t, contextId: ctx, accountId: acct.id, sourceEventId: `pricegate:${authId}`, amountMinor: -amountMinor, merchantName: sub.merchant_name, merchantId: sub.merchant_id, category: "Subscriptions", reference: authId, bookedAt: at, note: d.reason === "WITHIN_CEILING" ? "Within the price you approved" : d.reason === "CUSTOMER_PRESENT" ? "You made this payment yourself" : null, data: { authId, priceGate: d.reason } });
    const next = one<any>(db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", t, ctx, sub.id);
    if (next && initiator === "MERCHANT") applyForecastEvent(db, { sourceEventId: `pricegate:settle:${authId}`, tenantId: t, kind: "SETTLE", itemId: next.id, reason: `${sub.merchant_name} charged ${money(amountMinor)} (${authId})` });
    logAuth("APPROVE", d.reason, { transactionId: r.transactionId });
    return { decision: "APPROVE", reason: d.reason, advice: null, authId, transactionId: r.transactionId, message: `Paid ${money(amountMinor)} to ${sub.merchant_name}.` };
  });
}

/* ------------------------------------------------------------------------------------------ module */

export const priceGate: ExtensionModule = {
  key: KEY,
  capabilities: [E5],
  operations: { [OP_SET]: setCeilingOp, [OP_ACCEPT]: acceptPriceOp },
  labs: { merchant_charge: merchantCharge },
};
