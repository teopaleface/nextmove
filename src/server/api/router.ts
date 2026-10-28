import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { bankDb, all, json, one, run, tx } from "../db/connection";
import { config, dataDir, repoRoot } from "../config";
import { shortId } from "../canonical";
import { nowIso, nowMs, advanceClock } from "../clock";
import {
  HttpError,
  SESSION_COOKIE,
  assertCsrf,
  assertOwned,
  clearSessionCookieHeader,
  contextsFor,
  createSession,
  readCookie,
  revokeSession,
  sessionCookieHeader,
  sessionFromToken,
  switchContext,
  type Session,
} from "../auth/session";
import { accountsFor, balanceOf } from "../bank/ledger";
import { SUBSCRIPTION_WINDOW, subscriptionWindowTotal } from "../bank/forecast";
import { approveProposal, declineProposal, revokeMandate } from "../authority/authority";
import { availabilityReport } from "../authority/features";
import { analyzeCapability, capabilitiesFor, currentRevisionLookup, proposeFromCapability, proposalView, customerOf } from "../capabilities/registry";
import { makeEnv } from "../capabilities/core";
import { comparison } from "../capabilities/alex-subscriptions";
import { verifyTravelBenefit } from "../capabilities/alex-money";
import { buildFundingPacket } from "../capabilities/laziz";
import { chooseReroute, resetRoute, setRoadblock } from "../capabilities/goal-route-actions";
import { AUTOPILOT_LABS, runAutopilotLabs } from "../capabilities/cash-autopilot";
import { approveBatch, batchFollowUps, batchSummary, recheckBatch, reviseBatch, startBulkReview, stopBatch } from "../capabilities/batch";
import { createAgentTask, answerQuestion, stopAgentTask } from "../agent/orchestrator";
import { cardDraft, paymentDraft, payees } from "../bank/payments";
import { saveUpload, readUpload } from "../evidence/uploads";
import { extractFromUpload, manualExtraction, confirmExtraction, DOC_KINDS, type DocKind } from "../evidence/vision";
import { storeInboxEvent, verifyInboxSignature, applyPendingInbox } from "../execution/inbox";
import { requestReconcileNow } from "../execution/executor";
import { workerStatus } from "../execution/jobs";
import { evidenceDir } from "../execution/browser";
import { lastModelStatus } from "../model/claude-cli";
import { cardAttempt } from "../bank/trial-shield";
import { seedTenant, tenantExists } from "../scenarios/seed";
import { merchantAdmin } from "../merchant-client";
import { formatMoney } from "../../shared/money";
import { inWindow } from "../../shared/time";
import { EXTENSIONS, runExtLabs } from "../extensions/registry";

// One server-side router for every /api route. The session (tenant, user, active context) is derived from the
// HttpOnly cookie on each request; mutations require same-origin and the per-session CSRF token. Object access
// across tenants returns 404.

interface Ctx {
  req: Request;
  url: URL;
  db: DatabaseSync;
  session: Session | null;
  params: Record<string, string>;
  body: () => Promise<any>;
}
type Handler = (c: Ctx) => Promise<unknown> | unknown;
interface Route {
  method: "GET" | "POST" | "DELETE";
  pattern: string;
  auth?: boolean;
  fn: Handler;
}

const routes: Route[] = [];
const get = (pattern: string, fn: Handler, auth = true) => routes.push({ method: "GET", pattern, fn, auth });
const post = (pattern: string, fn: Handler, auth = true) => routes.push({ method: "POST", pattern, fn, auth });

function s(c: Ctx): Session {
  if (!c.session) throw new HttpError(401, "UNAUTHENTICATED", "Sign in first");
  return c.session;
}

function requireLabs() {
  if (config.mode !== "labs") throw new HttpError(403, "LABS_DISABLED", "Labs controls are disabled in the bank demo");
}

let gitHash: string | null = null;
function buildHash() {
  if (gitHash) return gitHash;
  try {
    gitHash = execSync("git rev-parse --short HEAD", { cwd: repoRoot(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    gitHash = "unknown";
  }
  return gitHash;
}

/* ------------------------------------------------------------------------------------------- health */
get("/health", async ({ db }) => {
  const merchant = await merchantAdmin.health();
  const w = workerStatus(db);
  return { ok: true, bank: { ok: true, port: config.bankPort }, merchant: merchant ? { ok: true, ...merchant } : { ok: false }, worker: { live: w.live.length, pids: w.live.map((x) => x.pid) }, model: lastModelStatus(db), mode: config.mode, build: buildHash(), at: new Date().toISOString() };
}, false);

/* ------------------------------------------------------------------------------------------ session */
get("/session", ({ db, session }) => {
  if (!session) return { authenticated: false, mode: config.mode };
  const tenant = one<any>(db, "SELECT isolated, base_customer FROM tenants WHERE id=?", session.tenantId);
  return {
    authenticated: true,
    user: { displayName: session.displayName, initials: session.initials },
    customer: tenant?.base_customer,
    isolated: Boolean(tenant?.isolated),
    tenantRef: session.tenantId.slice(0, 12),
    context: contextsFor(db, session).find((x) => x.id === session.contextId),
    contexts: contextsFor(db, session),
    csrfToken: session.csrfToken,
    mode: config.mode,
    features: availabilityReport(),
    demoNow: nowIso(db, session.tenantId),
    model: lastModelStatus(db),
  };
}, false);

post("/session/demo", async ({ db, req, body }) => {
  // Login CSRF: only same-origin pages may start a demo session.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "CROSS_SITE", "Cross-site request refused");
  const b = await body();
  const customer = b?.customer === "laziz" ? "laziz" : b?.customer === "alex" ? "alex" : null;
  if (!customer) throw new HttpError(400, "BAD_CUSTOMER", "Choose a demo customer");
  let tenantId: string = customer;
  if (b?.isolated) {
    tenantId = `iso-${customer}-${shortId("t").slice(2, 10).toLowerCase()}`;
    await seedTenant(db, tenantId, customer, { isolated: true });
  } else if (!tenantExists(db, tenantId)) {
    await seedTenant(db, tenantId, customer);
  }
  const user = one<any>(db, "SELECT id FROM users WHERE tenant_id=? ORDER BY id LIMIT 1", tenantId)!;
  const { token, session } = createSession(db, tenantId, user.id);
  return new Response(JSON.stringify({ ok: true, displayName: session.displayName, csrfToken: session.csrfToken }), { status: 200, headers: { "content-type": "application/json", "set-cookie": sessionCookieHeader(token), "cache-control": "no-store" } });
}, false);

post("/session/logout", ({ db, session }) => {
  if (session) revokeSession(db, session);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": clearSessionCookieHeader() } });
});

post("/session/context", async (c) => {
  const b = await c.body();
  const next = switchContext(c.db, s(c), String(b?.contextId ?? ""));
  return { ok: true, context: contextsFor(c.db, next).find((x) => x.id === next.contextId) };
});

/* --------------------------------------------------------------------------------------------- home */
get("/home", async (c) => {
  const ses = s(c);
  const db = c.db;
  const ctx = contextsFor(db, ses).find((x) => x.id === ses.contextId)!;
  const accounts = accountsFor(db, ses.tenantId, ses.contextId);
  const items = all<any>(db, "SELECT f.*, s.merchant_name FROM forecast_items f LEFT JOIN subscriptions s ON s.id=f.subscription_id WHERE f.tenant_id=? AND f.context_id=? AND f.status='SCHEDULED' AND f.dataset != 'bulk' ORDER BY f.due_at LIMIT 8", ses.tenantId, ses.contextId).map((f) => ({ ...f, data_json: undefined }));
  const upcoming = ctx.kind === "PERSONAL" && customerOf(db, ses.tenantId) === "alex" ? subscriptionWindowTotal(db, ses.tenantId, ses.contextId) : null;
  const findings = all<any>(db, "SELECT * FROM findings WHERE tenant_id=? AND context_id=? AND resolved_at IS NULL ORDER BY priority, created_at DESC LIMIT 4", ses.tenantId, ses.contextId);
  const notifications = all<any>(db, "SELECT * FROM notifications WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 6", ses.tenantId, ses.contextId);
  const tasks = all<any>(db, "SELECT id, kind, title, state, summary, updated_at FROM tasks WHERE tenant_id=? AND context_id=? ORDER BY updated_at DESC LIMIT 3", ses.tenantId, ses.contextId);
  let opportunity: any = null;
  try {
    if (customerOf(db, ses.tenantId) === "alex" && ctx.kind === "PERSONAL") {
      const cmp = await comparison(makeEnv(db, ses));
      const opts = cmp.result.options.filter((o) => o.status !== "INCOMPATIBLE");
      if (cmp.result.potentialMinor > 0) opportunity = { title: `${formatMoney(cmp.result.potentialMinor, "RON", { whole: true })} could stay with you.`, body: `${opts.length} option${opts.length === 1 ? "" : "s"} for your next 30 days of subscriptions.`, href: "/capabilities/T2", cta: "Review my options" };
    } else if (ctx.kind === "BUSINESS") {
      opportunity = { title: "A 40,000 RON order is waiting.", body: "See the cash conditions before you accept it.", href: "/capabilities/O1", cta: "Check the order" };
    } else {
      opportunity = { title: "A bill may fail on 2 Nov.", body: "ElectraCasa is due before the owner transfer arrives.", href: "/capabilities/A11", cta: "Fix the date" };
    }
  } catch {
    opportunity = null;
  }
  const home = one<any>(db, "SELECT inputs_json FROM goals WHERE tenant_id=? AND context_id=? AND kind='HOME'", ses.tenantId, ses.contextId);
  const homeGoal = home ? (() => {
    const i = json<any>(home.inputs_json, {});
    const target = i.transactionCostsMinor == null ? null : i.downPaymentMinor + i.transactionCostsMinor + i.protectedReserveMinor;
    const liquid = accounts.reduce((t, a) => t + a.balanceMinor, 0);
    return { liquidMinor: liquid, targetMinor: target, contributions: target ? Math.ceil(Math.max(0, target - liquid) / i.monthlyContributionMinor) : null };
  })() : null;
  return { greeting: ses.displayName, context: ctx, accounts, totalMinor: accounts.reduce((t, a) => t + a.balanceMinor, 0), upcoming: { windowTotalMinor: upcoming, window: SUBSCRIPTION_WINDOW, items }, opportunity, findings, notifications, tasks, homeGoal, demoNow: nowIso(db, ses.tenantId) };
});

/* ----------------------------------------------------------------------------------------- activity */
get("/activity", (c) => {
  const ses = s(c);
  const db = c.db;
  const txns = all<any>(db, "SELECT * FROM transactions WHERE tenant_id=? AND context_id=? ORDER BY booked_at DESC LIMIT 60", ses.tenantId, ses.contextId);
  const tasks = all<any>(db, "SELECT id, kind, title, state, summary, planner_mode, model, updated_at, created_at FROM tasks WHERE tenant_id=? AND context_id=? ORDER BY updated_at DESC LIMIT 30", ses.tenantId, ses.contextId);
  const receipts = all<any>(db, "SELECT r.id, r.issuer, r.issuer_reference, r.operation, r.effective_at, r.verified_at, a.spec_json FROM receipts r LEFT JOIN proposal_actions a ON a.id=r.action_id WHERE r.tenant_id=? AND r.context_id=? ORDER BY r.verified_at DESC LIMIT 40", ses.tenantId, ses.contextId).map((r) => ({ ...r, title: json<any>(r.spec_json, {})?.display?.title ?? r.operation, merchantName: json<any>(r.spec_json, {})?.merchantName ?? r.issuer, spec_json: undefined }));
  const recoveries = all<any>(db, "SELECT * FROM recoveries WHERE tenant_id=? AND context_id=? ORDER BY updated_at DESC", ses.tenantId, ses.contextId).map((r) => ({ ...r, timeline: json(r.timeline_json, []), timeline_json: undefined, data_json: undefined }));
  const subs = all<any>(db, "SELECT id, merchant_name, plan_name, amount_minor, state, next_charge_at, billing_period, dataset FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset != 'bulk' ORDER BY merchant_name", ses.tenantId, ses.contextId);
  return { transactions: txns.map((t) => ({ ...t, data_json: undefined })), tasks, receipts, recoveries, subscriptions: subs };
});

get("/transactions/:id", (c) => {
  const ses = s(c);
  const t = one<any>(c.db, "SELECT * FROM transactions WHERE id=?", c.params.id);
  assertOwned(c.db, ses, t);
  const lines = t.entry_id ? all<any>(c.db, "SELECT l.amount_minor, a.name FROM ledger_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=?", t.entry_id) : [];
  const recovery = one<any>(c.db, "SELECT id, kind, state, amount_minor, reference FROM recoveries WHERE tenant_id=? AND (transaction_id=? OR credit_transaction_id=?)", ses.tenantId, t.id, t.id);
  const sub = t.merchant_id ? one<any>(c.db, "SELECT id, plan_name FROM subscriptions WHERE tenant_id=? AND merchant_id=? AND dataset != 'bulk'", ses.tenantId, t.merchant_id) : null;
  const account = one<any>(c.db, "SELECT name FROM accounts WHERE id=?", t.account_id);
  return { transaction: { ...t, accountName: account?.name ?? null, data: json(t.data_json, {}), data_json: undefined }, ledgerLines: lines, recovery, subscription: sub };
});

get("/subscriptions/:id", (c) => {
  const ses = s(c);
  const sub = one<any>(c.db, "SELECT * FROM subscriptions WHERE id=?", c.params.id);
  assertOwned(c.db, ses, sub);
  const items = all<any>(c.db, "SELECT * FROM forecast_items WHERE subscription_id=? ORDER BY due_at", sub.id);
  const receipts = all<any>(c.db, "SELECT r.* FROM receipts r JOIN proposal_actions a ON a.id=r.action_id WHERE a.subject_ref=? ORDER BY r.verified_at DESC", sub.id);
  const charges = all<any>(c.db, "SELECT id, amount_minor, booked_at, status FROM transactions WHERE tenant_id=? AND merchant_name=? ORDER BY booked_at DESC LIMIT 6", ses.tenantId, sub.merchant_name);
  return { subscription: { ...sub, benefits: json(sub.benefits_json, {}), data: json(sub.data_json, {}), benefits_json: undefined, data_json: undefined }, forecast: items, receipts, charges };
});

/* -------------------------------------------------------------------------------------------- goals */
get("/goals", (c) => {
  const ses = s(c);
  const goals = all<any>(c.db, "SELECT id, kind, name, revision, updated_at FROM goals WHERE tenant_id=? AND context_id=? ORDER BY id", ses.tenantId, ses.contextId);
  const caps = capabilitiesFor(c.db, ses);
  const saved = all<any>(c.db, "SELECT id, kind, choice, input_revision, created_at FROM saved_comparisons WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 10", ses.tenantId, ses.contextId);
  return { goals, capabilities: caps, saved };
});

const GOAL_CAPABILITY: Record<string, string> = { HOME: "O1", PURCHASE: "A10", TRIP: "A14", WISHLIST: "A12", BUSINESS_ORDER: "O1", NEW_BUSINESS: "O5" };
get("/goals/:id", (c) => {
  const ses = s(c);
  const g = one<any>(c.db, "SELECT * FROM goals WHERE id=?", c.params.id);
  assertOwned(c.db, ses, g, { activeContextOnly: true });
  const saved = all<any>(c.db, "SELECT id, choice, input_revision, result_json, created_at FROM saved_comparisons WHERE goal_id=? ORDER BY created_at DESC LIMIT 5", g.id).map((x) => ({ ...x, result: json(x.result_json, null), result_json: undefined }));
  return { goal: { id: g.id, kind: g.kind, name: g.name, revision: g.revision, updatedAt: g.updated_at, inputs: json(g.inputs_json, {}) }, capabilityId: GOAL_CAPABILITY[g.kind] ?? null, saved };
});

get("/accounts/:id", (c) => {
  const ses = s(c);
  const a = one<any>(c.db, "SELECT * FROM accounts WHERE id=?", c.params.id);
  assertOwned(c.db, ses, a, { activeContextOnly: true });
  const acct = accountsFor(c.db, ses.tenantId, ses.contextId).find((x) => x.id === a.id);
  const txns = all<any>(c.db, "SELECT id, merchant_name, category, amount_minor, booked_at, status, reference FROM transactions WHERE tenant_id=? AND account_id=? ORDER BY booked_at DESC LIMIT 40", ses.tenantId, a.id);
  const cardActions = all<any>(c.db, "SELECT id, status, spec_json, updated_at FROM proposal_actions WHERE tenant_id=? AND operation='CARD_FREEZE' AND subject_ref=? ORDER BY updated_at DESC LIMIT 5", ses.tenantId, a.id).map((x) => ({ id: x.id, status: x.status, title: json<any>(x.spec_json, {})?.display?.title, updatedAt: x.updated_at }));
  return { account: acct, transactions: txns, cardActions };
});

get("/upcoming", (c) => {
  const ses = s(c);
  const items = all<any>(c.db, "SELECT f.id, f.kind, f.label, f.amount_minor, f.due_at, f.status, f.subscription_id, f.dataset, f.condition, s.merchant_name FROM forecast_items f LEFT JOIN subscriptions s ON s.id=f.subscription_id WHERE f.tenant_id=? AND f.context_id=? AND f.dataset != 'bulk' AND f.status='SCHEDULED' ORDER BY f.due_at LIMIT 40", ses.tenantId, ses.contextId);
  const subs = all<any>(c.db, "SELECT id, merchant_name, plan_name, amount_minor, state, next_charge_at, billing_period, access_until, dataset FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset != 'bulk' ORDER BY merchant_name", ses.tenantId, ses.contextId);
  const isAlexPersonal = ses.contextKind === "PERSONAL" && customerOf(c.db, ses.tenantId) === "alex";
  return { items, subscriptions: subs, window: SUBSCRIPTION_WINDOW, subscriptionWindowTotalMinor: isAlexPersonal ? subscriptionWindowTotal(c.db, ses.tenantId, ses.contextId) : null, bulkCount: one<any>(c.db, "SELECT COUNT(*) n FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='bulk'", ses.tenantId, ses.contextId)?.n ?? 0 };
});

get("/recoveries/:id", (c) => {
  const ses = s(c);
  const r = one<any>(c.db, "SELECT * FROM recoveries WHERE id=?", c.params.id);
  assertOwned(c.db, ses, r);
  const credit = r.credit_transaction_id ? one<any>(c.db, "SELECT id, amount_minor, booked_at, reference FROM transactions WHERE id=?", r.credit_transaction_id) : null;
  const original = r.transaction_id ? one<any>(c.db, "SELECT id, merchant_name, amount_minor, booked_at FROM transactions WHERE id=?", r.transaction_id) : null;
  const actions = all<any>(c.db, "SELECT id, status, operation, spec_json, updated_at FROM proposal_actions WHERE tenant_id=? AND subject_ref=? ORDER BY updated_at DESC LIMIT 5", ses.tenantId, r.id).map((x) => ({ id: x.id, status: x.status, operation: x.operation, title: json<any>(x.spec_json, {})?.display?.title }));
  return { recovery: { ...r, timeline: json(r.timeline_json, []), data: json(r.data_json, {}), timeline_json: undefined, data_json: undefined }, credit, original, actions };
});

/* ----------------------------------------------------------------------------------------- payments */
get("/payments/payees", (c) => {
  const ses = s(c);
  return { payees: payees(c.db, ses), accounts: accountsFor(c.db, ses.tenantId, ses.contextId) };
});
post("/payments/draft", async (c) => {
  const b = await c.body();
  return paymentDraft(c.db, s(c), { forecastItemId: String(b?.forecastItemId ?? ""), fromAccountId: String(b?.fromAccountId ?? "") });
});
post("/cards/:accountId/draft", async (c) => {
  const b = await c.body();
  return cardDraft(c.db, s(c), { accountId: c.params.accountId, freeze: b?.freeze === true });
});

/* ------------------------------------------------------------------------------------- capabilities */
get("/capabilities", (c) => ({ capabilities: capabilitiesFor(c.db, s(c)) }));

function inputsFromQuery(url: URL) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) if (k.startsWith("i.")) out[k.slice(2)] = /^-?\d+$/.test(v) ? Number(v) : v;
  return out;
}

get("/capabilities/:id", (c) => analyzeCapability(c.db, s(c), c.params.id.toUpperCase(), inputsFromQuery(c.url)));
post("/capabilities/:id", async (c) => analyzeCapability(c.db, s(c), c.params.id.toUpperCase(), (await c.body())?.inputs ?? {}));
post("/capabilities/:id/propose", async (c) => {
  const b = await c.body();
  return proposeFromCapability(c.db, s(c), c.params.id.toUpperCase(), Array.isArray(b?.keys) ? b.keys.map(String).slice(0, 50) : [], b?.inputs ?? {});
});
post("/capabilities/A14/verify", (c) => ({ verified: verifyTravelBenefit(makeEnv(c.db, s(c))) }));
post("/capabilities/O1/save", async (c) => {
  const ses = s(c);
  const b = await c.body();
  const a = await analyzeCapability(c.db, ses, "O1", b?.inputs ?? {});
  const goal = one<any>(c.db, "SELECT * FROM goals WHERE tenant_id=? AND context_id=? AND kind IN ('HOME','BUSINESS_ORDER') ORDER BY kind LIMIT 1", ses.tenantId, ses.contextId);
  return tx(c.db, () => {
    if (goal && ses.contextKind === "PERSONAL") {
      const inputs = { ...json<any>(goal.inputs_json, {}) };
      for (const k of ["monthlyContributionMinor", "transactionCostsMinor", "protectedReserveMinor", "downPaymentMinor"]) if (b?.inputs?.[k] !== undefined) inputs[k] = b.inputs[k] === null || b.inputs[k] === "" ? null : Number(b.inputs[k]);
      run(c.db, "UPDATE goals SET inputs_json=?, revision=revision+1, updated_at=? WHERE id=?", JSON.stringify(inputs), new Date().toISOString(), goal.id);
    }
    const rev = goal ? one<any>(c.db, "SELECT revision FROM goals WHERE id=?", goal.id).revision : 1;
    const id = shortId("cmp");
    run(c.db, "INSERT INTO saved_comparisons(id, tenant_id, context_id, goal_id, kind, input_revision, inputs_json, result_json, choice, created_at) VALUES (?,?,?,?, 'O1', ?, ?, ?, ?, ?)", id, ses.tenantId, ses.contextId, goal?.id ?? null, rev, JSON.stringify(b?.inputs ?? {}), JSON.stringify({ headline: a.headline, numbers: a.numbers }), String(b?.choice ?? "Saved plan").slice(0, 80), new Date().toISOString());
    return { saved: id, revision: rev };
  });
});

// O6 route to the home goal: Labs roadblocks (demo tenant only) and reroute choice. The route itself is GET /capabilities/O6.
post("/goals/home-route/roadblocks", async (c) => {
  const b = await c.body();
  return setRoadblock(c.db, s(c), String(b?.id ?? ""), b?.on !== false);
});
post("/goals/home-route/reset", (c) => resetRoute(c.db, s(c)));
post("/goals/home-route/choose", async (c) => chooseReroute(c.db, s(c), String((await c.body())?.route ?? "")));

get("/business/packet", (c) => {
  const ses = s(c);
  const r = one<any>(c.db, "SELECT * FROM business_records WHERE tenant_id=? AND context_id=? AND kind='FUNDING_PACKET'", ses.tenantId, ses.contextId);
  return { packet: r ? { ...json<any>(r.data_json, {}), revision: r.revision, updatedAt: r.updated_at } : null };
});
post("/business/packet", (c) => {
  const ses = s(c);
  if (ses.contextKind !== "BUSINESS") throw new HttpError(409, "WRONG_CONTEXT", "Switch to the business context");
  const text = buildFundingPacket(makeEnv(c.db, ses));
  const id = `${ses.tenantId}:funding-packet`;
  run(c.db, `INSERT INTO business_records(id, tenant_id, context_id, kind, data_json, revision, updated_at) VALUES (?,?,?, 'FUNDING_PACKET', ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, revision=business_records.revision+1, updated_at=excluded.updated_at`, id, ses.tenantId, ses.contextId, JSON.stringify({ markdown: text, status: "PREPARED_NOT_SENT" }), new Date().toISOString());
  return { ok: true, markdown: text };
});

/* ------------------------------------------------------------------------------------- authority */
get("/proposals/:id", (c) => proposalView(c.db, s(c), c.params.id));
post("/proposals/:id/approve", async (c) => {
  const ses = s(c);
  const b = await c.body();
  const p = one<any>(c.db, "SELECT batch_id, tenant_id FROM proposals WHERE id=?", c.params.id);
  if (p?.batch_id && p.tenant_id === ses.tenantId) throw new HttpError(409, "USE_BATCH", "Approve this list from the batch review");
  const ids = Array.isArray(b?.actionIds) ? b.actionIds.map(String).slice(0, 300) : [];
  const res = approveProposal(c.db, ses, { proposalId: c.params.id, digest: String(b?.digest ?? ""), actionIds: ids }, currentRevisionLookup(c.db, ses.tenantId));
  return { ...res, proposal: proposalView(c.db, ses, c.params.id) };
});
post("/proposals/:id/decline", (c) => ({ ...declineProposal(c.db, s(c), c.params.id), proposal: proposalView(c.db, s(c), c.params.id) }));
post("/mandates/:id/stop", (c) => {
  const ses = s(c);
  const m = one<any>(c.db, "SELECT * FROM mandates WHERE id=?", c.params.id);
  assertOwned(c.db, ses, m);
  return revokeMandate(c.db, ses.tenantId, m.id, "you");
});

get("/actions/:id", (c) => {
  const ses = s(c);
  const a = one<any>(c.db, "SELECT * FROM proposal_actions WHERE id=?", c.params.id);
  assertOwned(c.db, ses, a);
  const spec = json<any>(a.spec_json, {});
  const attempts = all<any>(c.db, "SELECT * FROM attempts WHERE action_id=? ORDER BY started_at", a.id).map((t) => ({ id: t.id, status: t.status, route: t.route, startedAt: t.started_at, dispatchedAt: t.dispatched_at, finishedAt: t.finished_at, reconcileChecks: t.reconcile_checks, nextCheckAt: t.next_reconcile_at, outcome: json(t.outcome_json, null), evidence: json(t.evidence_json, null), correlation: `${String(t.correlation_id).slice(0, 10)}…` }));
  const receipt = one<any>(c.db, "SELECT * FROM receipts WHERE action_id=?", a.id);
  const grant = one<any>(c.db, "SELECT status, expires_at, consumed_by_attempt, mandate_id FROM grants WHERE action_id=?", a.id);
  const p = one<any>(c.db, "SELECT task_id, batch_id FROM proposals WHERE id=?", a.proposal_id);
  return { action: { id: a.id, status: a.status, proposalId: a.proposal_id, taskId: p?.task_id, batchId: p?.batch_id, capability: spec.capability, operation: spec.operation, display: spec.display, route: spec.route, merchantName: spec.merchantName, money: spec.money, consequences: spec.consequences, termsRevision: spec.termsRevision, result: json(a.result_json, null) }, grant, attempts, receipt: receipt ? { ...receipt, verification: json(receipt.verification_json, {}), money: json(receipt.money_effect_json, {}) } : null };
});
post("/actions/:id/check", (c) => {
  const ses = s(c);
  const a = one<any>(c.db, "SELECT * FROM proposal_actions WHERE id=?", c.params.id);
  assertOwned(c.db, ses, a);
  return { scheduled: requestReconcileNow(c.db, ses.tenantId, a.id) };
});

get("/receipts/:id", (c) => {
  const ses = s(c);
  const r = one<any>(c.db, "SELECT * FROM receipts WHERE id=?", c.params.id);
  assertOwned(c.db, ses, r);
  const a = r.action_id ? one<any>(c.db, "SELECT spec_json, proposal_id, status FROM proposal_actions WHERE id=?", r.action_id) : null;
  return { receipt: { ...r, verification: json(r.verification_json, {}), money: json(r.money_effect_json, {}), verification_json: undefined, money_effect_json: undefined }, action: a ? { ...json<any>(a.spec_json, {}), proposalId: a.proposal_id, status: a.status } : null };
});

get("/evidence/screens/:file", (c) => {
  const ses = s(c);
  const f = c.params.file;
  if (!/^att_[A-Za-z0-9]+-\d{1,2}\.png$/.test(f)) throw new HttpError(404, "NOT_FOUND", "Not found");
  const att = one<any>(c.db, "SELECT a.tenant_id, pa.context_id FROM attempts a JOIN proposal_actions pa ON pa.id=a.action_id WHERE a.id=?", f.split("-")[0]);
  assertOwned(c.db, ses, att);
  const p = path.join(evidenceDir(), f);
  if (!fs.existsSync(p)) throw new HttpError(404, "NOT_FOUND", "Not found");
  return new Response(fs.readFileSync(p), { headers: { "content-type": "image/png", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
});

/* -------------------------------------------------------------------------------------------- tasks */
get("/tasks", (c) => {
  const ses = s(c);
  return { tasks: all<any>(c.db, "SELECT id, kind, title, state, summary, planner_mode, model, step_count, updated_at, created_at FROM tasks WHERE tenant_id=? AND context_id=? ORDER BY updated_at DESC LIMIT 30", ses.tenantId, ses.contextId) };
});
post("/tasks", async (c) => createAgentTask(c.db, s(c), String((await c.body())?.text ?? "")));

function taskView(db: DatabaseSync, ses: Session, id: string, after = 0) {
  const t = one<any>(db, "SELECT * FROM tasks WHERE id=?", id);
  assertOwned(db, ses, t);
  const events = all<any>(db, "SELECT seq, kind, label, evidence, payload_json, created_at FROM task_events WHERE task_id=? AND seq > ? ORDER BY seq LIMIT 400", id, after).map((e) => ({ ...e, payload: json(e.payload_json, null), payload_json: undefined }));
  const blocks = all<any>(db, "SELECT block_key, kind, payload_json, revision FROM task_blocks WHERE task_id=? ORDER BY ordinal", id).map((b) => ({ key: b.block_key, kind: b.kind, revision: b.revision, payload: json(b.payload_json, null) }));
  const questions = all<any>(db, "SELECT id, text, options_json, status, answer_json FROM task_questions WHERE task_id=? ORDER BY created_at", id).map((q) => ({ id: q.id, text: q.text, options: json(q.options_json, []), status: q.status, answer: json(q.answer_json, null) }));
  const proposalId = (blocks.find((b) => b.key === "proposal")?.payload as any)?.proposalId ?? (blocks.find((b) => b.key === "batch")?.payload as any)?.proposalId ?? null;
  const steps = (blocks.find((b) => b.key === "steps")?.payload as unknown as any[] | undefined) ?? [];
  return {
    task: { id: t.id, kind: t.kind, title: t.title, state: t.state, summary: t.summary, request: t.request_text, plannerMode: t.planner_mode, model: t.model, stepCount: t.step_count, stepBudget: t.step_budget, createdAt: t.created_at, updatedAt: t.updated_at, subjectRef: t.subject_ref },
    events,
    blocks: blocks.filter((b) => b.key !== "steps"),
    steps: steps.map((x: any) => ({ tool: x.tool, by: x.by, capabilityId: x.args?.capabilityId ?? null, summary: x.result?.headline ?? x.result?.asked ?? (x.result?.proposalId ? `Proposal ${x.result.proposalId}` : x.result?.error ?? null) })),
    questions,
    proposal: proposalId ? proposalView(db, ses, proposalId) : null,
  };
}
get("/tasks/:id", (c) => taskView(c.db, s(c), c.params.id));
get("/tasks/:id/stream", (c) => {
  const ses = s(c);
  const db = c.db;
  taskView(db, ses, c.params.id, Number.MAX_SAFE_INTEGER);
  let cursor = Number(c.url.searchParams.get("after") ?? 0);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => !closed && controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const timer = setInterval(() => {
        try {
          const rows = all<any>(db, "SELECT seq, kind, label, evidence, created_at FROM task_events WHERE task_id=? AND seq > ? ORDER BY seq LIMIT 100", c.params.id, cursor);
          for (const r of rows) {
            cursor = r.seq;
            send("task", r);
          }
          const t = one<any>(db, "SELECT state FROM tasks WHERE id=?", c.params.id);
          send("state", { state: t?.state, cursor });
        } catch {
          /* ignore */
        }
      }, 700);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      c.req.signal.addEventListener("abort", stop);
      setTimeout(stop, 5 * 60_000);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
});
post("/tasks/:id/stop", (c) => stopAgentTask(c.db, s(c), c.params.id));
post("/tasks/:id/answer", async (c) => {
  const b = await c.body();
  return answerQuestion(c.db, s(c), c.params.id, String(b?.questionId ?? ""), String(b?.answer ?? ""));
});

/* ------------------------------------------------------------------------------ facts / preferences */
const FACT_KEY = /^(t1|a8|t3|agent|e2):[A-Za-z0-9_:+.-]{1,80}$|^student_id_number$/;
post("/facts", async (c) => {
  const ses = s(c);
  const b = await c.body();
  const key = String(b?.key ?? "");
  if (!FACT_KEY.test(key)) throw new HttpError(400, "BAD_KEY", "Unsupported fact");
  const value = typeof b?.value === "string" ? b.value.slice(0, 120) : typeof b?.value === "number" || typeof b?.value === "boolean" ? b.value : null;
  const prev = one<any>(c.db, "SELECT MAX(revision) r FROM facts WHERE tenant_id=? AND context_id=? AND key=?", ses.tenantId, ses.contextId, key);
  run(c.db, "INSERT INTO facts(id, tenant_id, context_id, key, value_json, provenance, source_ref, revision, created_at) VALUES (?,?,?,?,?, 'YOU_ENTERED', 'app', ?, ?)", shortId("fact"), ses.tenantId, ses.contextId, key, JSON.stringify({ value }), (prev?.r ?? 0) + 1, new Date().toISOString());
  return { ok: true };
});
const PREF_KEYS = new Set(["hotspot_required", "protected_benefits", "simple_mode"]);
post("/preferences", async (c) => {
  const ses = s(c);
  const b = await c.body();
  const key = String(b?.key ?? "");
  if (!PREF_KEYS.has(key)) throw new HttpError(400, "BAD_KEY", "Unsupported preference");
  if (key === "simple_mode" && typeof b.value !== "boolean") throw new HttpError(400, "BAD_VALUE", "Simple mode must be on or off");
  const value = key === "simple_mode" ? b.value : key === "hotspot_required" ? b.value === true || b.value === "true" : Array.isArray(b.value) ? b.value.map(String).filter((x: string) => ["offline_playback", "tv_access"].includes(x)) : [];
  run(c.db, `INSERT INTO preferences(id, tenant_id, context_id, key, value_json, source, revision, updated_at) VALUES (?,?,?,?,?, 'USER_CONFIRMED', 1, ?)
    ON CONFLICT(tenant_id, context_id, key) DO UPDATE SET value_json=excluded.value_json, revision=preferences.revision+1, updated_at=excluded.updated_at`, shortId("pref"), ses.tenantId, ses.contextId, key, JSON.stringify(value), new Date().toISOString());
  return { ok: true, value };
});

/* ------------------------------------------------------------------------------------------ uploads */
post("/uploads", async (c) => {
  const ses = s(c);
  const len = Number(c.req.headers.get("content-length") ?? 0);
  if (len > 5 * 1024 * 1024) throw new HttpError(413, "TOO_LARGE", "Images must be 4 MB or smaller");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "NO_FILE", "Choose an image");
  const buf = Buffer.from(await (file as File).arrayBuffer());
  const up = saveUpload(c.db, ses, buf, String(form.get("label") ?? (file as File).name ?? "Image").slice(0, 80), null);
  return { upload: up };
});
const SAMPLES: Record<string, string> = { "screen-time": "Screen Time, last 7 days", "student-id": "Student ID card", "hostile-invoice": "Invoice from an unknown supplier", "subscription-page": "Streamly account page" };
post("/uploads/sample", async (c) => {
  const ses = s(c);
  const name = String((await c.body())?.name ?? "");
  if (!SAMPLES[name]) throw new HttpError(400, "BAD_SAMPLE", "Unknown sample");
  const file = path.join(repoRoot(), "fixtures", "images", `${name}.png`);
  if (!fs.existsSync(file)) throw new HttpError(404, "NO_SAMPLE", "Sample images have not been generated (npm run fixtures:images)");
  return { upload: saveUpload(c.db, ses, fs.readFileSync(file), SAMPLES[name], null) };
});
post("/uploads/:id/extract", async (c) => {
  const kind = String((await c.body())?.kind ?? "") as DocKind;
  if (!DOC_KINDS.includes(kind)) throw new HttpError(400, "BAD_KIND", "Unknown document type");
  return extractFromUpload(c.db, s(c), c.params.id, kind, null);
});
post("/uploads/:id/manual", async (c) => {
  const b = await c.body();
  const kind = String(b?.kind ?? "") as DocKind;
  if (!DOC_KINDS.includes(kind)) throw new HttpError(400, "BAD_KIND", "Unknown document type");
  return manualExtraction(c.db, s(c), c.params.id, kind, typeof b?.values === "object" && b.values ? b.values : {});
});
get("/uploads/:id/image", (c) => {
  const ses = s(c);
  const up = readUpload(c.db, ses.tenantId, c.params.id);
  if (!up) throw new HttpError(404, "NOT_FOUND", "Not found");
  assertOwned(c.db, ses, up.row);
  return new Response(new Uint8Array(up.data), { headers: { "content-type": up.row.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
});
get("/extractions", (c) => {
  const ses = s(c);
  return {
    extractions: all<any>(c.db, "SELECT e.*, u.label, u.width, u.height, u.bytes FROM extractions e JOIN uploads u ON u.id=e.upload_id WHERE e.tenant_id=? AND e.context_id=? ORDER BY e.created_at DESC LIMIT 12", ses.tenantId, ses.contextId).map((e) => ({ id: e.id, uploadId: e.upload_id, label: e.label, mode: e.mode, model: e.model, status: e.status, revision: e.revision, createdAt: e.created_at, confirmedAt: e.confirmed_at, image: { width: e.width, height: e.height, bytes: e.bytes }, fields: json(e.fields_json, {}) })),
    uploads: all<any>(c.db, "SELECT id, label, mime, bytes, width, height, created_at FROM uploads WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 12", ses.tenantId, ses.contextId),
  };
});
post("/extractions/:id/confirm", async (c) => confirmExtraction(c.db, s(c), c.params.id, (await c.body())?.edits ?? {}));

/* ------------------------------------------------------------------------------------------ batches */
post("/batches", (c) => startBulkReview(c.db, s(c)));
get("/batches/current", (c) => {
  const ses = s(c);
  const b = one<any>(c.db, "SELECT id FROM batches WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 1", ses.tenantId, ses.contextId);
  return { batch: b ? batchSummary(c.db, ses, b.id) : null, bulkCount: one<any>(c.db, "SELECT COUNT(*) n FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='bulk'", ses.tenantId, ses.contextId)?.n ?? 0 };
});
get("/batches/:id", (c) => batchSummary(c.db, s(c), c.params.id));
post("/batches/:id/approve", async (c) => {
  const b = await c.body();
  const ses = s(c);
  const ids = Array.isArray(b?.actionIds) ? b.actionIds.map(String).slice(0, 300) : [];
  const res = approveBatch(c.db, ses, c.params.id, String(b?.digest ?? ""), ids);
  return { ...res, grants: res.grants.length, batch: batchSummary(c.db, ses, c.params.id) };
});
post("/batches/:id/stop", (c) => ({ ...stopBatch(c.db, s(c), c.params.id), batch: batchSummary(c.db, s(c), c.params.id) }));
post("/batches/:id/recheck", (c) => recheckBatch(c.db, s(c), c.params.id, requestReconcileNow));
post("/batches/:id/revise", async (c) => {
  const outcome = String((await c.body())?.outcome ?? "");
  if (outcome !== "TERMS_CHANGED" && outcome !== "NEEDS_AUTH") throw new HttpError(400, "BAD_OUTCOME", "Choose terms changed or sign-in needed");
  return reviseBatch(c.db, s(c), c.params.id, outcome);
});
get("/batches/:id/followups", (c) => {
  const ses = s(c);
  batchSummary(c.db, ses, c.params.id);
  return { proposals: batchFollowUps(c.db, c.params.id).map((id) => proposalView(c.db, ses, id)) };
});
get("/batches/:id/export", (c) => {
  const sum = batchSummary(c.db, s(c), c.params.id);
  const cell = (v: unknown) => {
    let x = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`;
    return `"${x.replace(/"/g, '""')}"`;
  };
  const lines = [["Merchant", "Amount (RON)", "Next charge", "Review", "Route", "Selected", "Outcome", "Detail", "Receipt"].map(cell).join(",")];
  for (const i of sum.items) lines.push([i.merchantName, (i.amountMinor / 100).toFixed(2), i.nextChargeAt ?? "", i.reviewStatus, i.route ?? "", i.selected ? "yes" : "no", i.outcome ?? "", i.outcomeDetail ?? "", i.receipt ?? ""].map(cell).join(","));
  return new Response(lines.join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="nextmove-batch-${sum.id}.csv"`, "cache-control": "no-store" } });
});

/* ------------------------------------------------------------------------------ permissions / notes */
get("/permissions", (c) => {
  const ses = s(c);
  return {
    permissions: all<any>(c.db, "SELECT * FROM permissions WHERE tenant_id=? AND context_id=? ORDER BY kind, source", ses.tenantId, ses.contextId),
    watches: all<any>(c.db, "SELECT id, kind, label, status, next_check_at, last_checked_at, last_result FROM watches WHERE tenant_id=? AND context_id=? ORDER BY label", ses.tenantId, ses.contextId),
    findings: all<any>(c.db, "SELECT id, kind, title, body, task_kind, created_at FROM findings WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 20", ses.tenantId, ses.contextId),
    notifications: all<any>(c.db, "SELECT id, finding_id, title, body, link, created_at, read_at FROM notifications WHERE tenant_id=? AND context_id=? ORDER BY created_at DESC LIMIT 20", ses.tenantId, ses.contextId),
    preferences: Object.fromEntries(all<any>(c.db, "SELECT key, value_json FROM preferences WHERE tenant_id=? AND context_id=?", ses.tenantId, ses.contextId).map((p) => [p.key, json(p.value_json, null)])),
  };
});
post("/permissions/:id/revoke", (c) => {
  const ses = s(c);
  const p = one<any>(c.db, "SELECT * FROM permissions WHERE id=?", c.params.id);
  assertOwned(c.db, ses, p);
  return tx(c.db, () => {
    run(c.db, "UPDATE permissions SET status='REVOKED', revoked_at=? WHERE id=?", new Date().toISOString(), p.id);
    let watches = 0;
    if (p.kind === "MONITOR") {
      // A monitoring permission covers the watches on the same provider: matched on the label, subject or condition.
      const provider = String(p.source).toLowerCase().split(" ")[0];
      for (const w of all<any>(c.db, "SELECT id, label, subject_ref, condition_json FROM watches WHERE tenant_id=? AND context_id=? AND status='ACTIVE'", ses.tenantId, p.context_id)) {
        if ([w.label, w.subject_ref, w.condition_json].some((x) => String(x ?? "").toLowerCase().includes(provider))) {
          run(c.db, "UPDATE watches SET status='REVOKED', last_result='permission revoked' WHERE id=?", w.id);
          watches++;
        }
      }
    }
    return { revoked: true, watchesStopped: watches };
  });
});
post("/notifications/read", (c) => {
  const ses = s(c);
  run(c.db, "UPDATE notifications SET read_at=? WHERE tenant_id=? AND context_id=? AND read_at IS NULL", new Date().toISOString(), ses.tenantId, ses.contextId);
  return { ok: true };
});

/* --------------------------------------------------------------------------------------------- labs */
const LABS_ACTIONS = new Set(["set_cancellation_mode", "change_offer_terms", "refund_payout", "claims_fast_forward", "counterparty_pay", "counterparty_reply_now", "resolve_reviews", "finish_migrations", "fault", "expire_session", "restore_session"]);
post("/labs/merchant", async (c) => {
  requireLabs();
  const ses = s(c);
  const b = await c.body();
  if (!LABS_ACTIONS.has(String(b?.action))) throw new HttpError(400, "BAD_ACTION", "Unknown Labs action");
  const body = { ...(typeof b.body === "object" && b.body ? b.body : {}), action: b.action };
  if (body.contractId && !String(body.contractId).startsWith(`${ses.tenantId}:`)) throw new HttpError(404, "NOT_FOUND", "Not found");
  const r = await merchantAdmin.labs(ses.tenantId, body);
  run(c.db, "INSERT INTO task_events(task_id, tenant_id, kind, label, evidence, payload_json, created_at) SELECT id, tenant_id, 'labs', ?, 'SIMULATED_MERCHANT_EVENT', NULL, ? FROM tasks WHERE tenant_id=? AND context_id=? AND state NOT IN ('DONE','FAILED') ORDER BY updated_at DESC LIMIT 1", `Labs: ${String(b.action).replace(/_/g, " ")}`, new Date().toISOString(), ses.tenantId, ses.contextId);
  return r;
});
post("/labs/bank", async (c) => {
  requireLabs();
  const ses = s(c);
  const b = await c.body();
  if (!AUTOPILOT_LABS.has(String(b?.action))) throw new HttpError(400, "BAD_ACTION", "Unknown Labs action");
  return runAutopilotLabs(c.db, ses, String(b.action));
});
// Trial Shield: the simulated card network sends a charge the merchant started on its own. The bank decides.
post("/labs/card-attempt", async (c) => {
  requireLabs();
  const ses = s(c);
  const b = await c.body();
  const r = cardAttempt(c.db, { tenantId: ses.tenantId, contextId: ses.contextId, merchantId: String(b?.merchantId ?? "").slice(0, 40) });
  if (!r) throw new HttpError(404, "NOT_FOUND", "This merchant is not under Trial Shield here");
  return r;
});
// Wired extension modules: synthetic events (a charge after cancellation, a price rise, a card update inquiry...).
post("/labs/ext", async (c) => {
  requireLabs();
  const ses = s(c);
  const b = await c.body();
  const body = typeof b?.body === "object" && b.body && !Array.isArray(b.body) ? (b.body as Record<string, unknown>) : {};
  return runExtLabs(c.db, ses, String(b?.module ?? ""), String(b?.action ?? ""), body);
});
for (const m of EXTENSIONS) {
  for (const r of m.routes ?? []) {
    const register = r.method === "GET" ? get : post;
    register(`/ext/${m.key}${r.path}`, (c) => r.fn({ db: c.db, session: s(c), params: c.params, url: c.url, body: c.body }));
  }
}
post("/labs/clock", async (c) => {
  requireLabs();
  const ses = s(c);
  const minutes = Math.max(1, Math.min(60 * 24 * 7, Number((await c.body())?.minutes ?? 60)));
  const next = advanceClock(c.db, ses.tenantId, minutes * 60_000);
  await merchantAdmin.setClock(ses.tenantId, next);
  return { demoNow: nowIso(c.db, ses.tenantId), advancedMinutes: minutes };
});
post("/labs/reset", async (c) => {
  requireLabs();
  const ses = s(c);
  const t = one<any>(c.db, "SELECT base_customer, isolated FROM tenants WHERE id=?", ses.tenantId)!;
  await seedTenant(c.db, ses.tenantId, t.base_customer, { isolated: Boolean(t.isolated) });
  const user = one<any>(c.db, "SELECT id FROM users WHERE tenant_id=? ORDER BY id LIMIT 1", ses.tenantId)!;
  const { token } = createSession(c.db, ses.tenantId, user.id);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": sessionCookieHeader(token) } });
});

/* ---------------------------------------------------------------------------------------- developer */
get("/dev/status", (c) => {
  const ses = s(c);
  return {
    features: availabilityReport(),
    model: lastModelStatus(c.db, true),
    modelCalls: all<any>(c.db, "SELECT id, purpose, model, status, duration_ms, input_chars, image_count, output_chars, cost_usd, error, created_at FROM model_calls WHERE tenant_id=? ORDER BY created_at DESC LIMIT 25", ses.tenantId),
    worker: workerStatus(c.db),
    jobs: all<any>(c.db, "SELECT kind, status, COUNT(*) n FROM jobs WHERE tenant_id=? GROUP BY kind, status", ses.tenantId),
    inbox: all<any>(c.db, "SELECT issuer, event_id, kind, received_at, applied_at, result FROM inbox_events WHERE tenant_id=? ORDER BY received_at DESC LIMIT 20", ses.tenantId),
    attempts: all<any>(c.db, "SELECT id, route, status, reconcile_checks, started_at FROM attempts WHERE tenant_id=? ORDER BY started_at DESC LIMIT 20", ses.tenantId),
    clock: { demoNow: nowIso(c.db, ses.tenantId), demoMs: nowMs(c.db, ses.tenantId) },
    build: buildHash(),
    merchantInspector: `${config.merchantBaseUrl}/__inspect/${encodeURIComponent(ses.tenantId)}`,
  };
});

/* -------------------------------------------------------------------------------------------- inbox */
post("/inbox/merchant", async ({ db, req }) => {
  const raw = await req.text();
  if (raw.length > 64 * 1024) throw new HttpError(413, "TOO_LARGE", "Event too large");
  if (!verifyInboxSignature(raw, req.headers.get("x-nextmove-signature"))) throw new HttpError(401, "BAD_SIGNATURE", "Signature invalid");
  const r = storeInboxEvent(db, raw);
  if (!r.ok) throw new HttpError(400, "BAD_EVENT", r.error ?? "Invalid event");
  applyPendingInbox(db, 10);
  return { ok: true, duplicate: Boolean(r.duplicate) };
}, false);

/* ------------------------------------------------------------------------------------------ dispatch */
function match(pattern: string, pathName: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = pathName.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handleApi(req: Request, segments: string[]): Promise<Response> {
  const url = new URL(req.url);
  const pathName = `/${segments.map(encodeURIComponent).join("/")}`;
  const method = req.method as Route["method"];
  // Exact routes win over parameterized ones (e.g. /capabilities/A14/verify before /capabilities/:id/propose).
  const candidates = routes.filter((r) => r.method === method).map((r) => ({ r, p: match(r.pattern, pathName), exact: !r.pattern.includes(":") })).filter((x) => x.p);
  candidates.sort((x, y) => Number(y.exact) - Number(x.exact) || y.r.pattern.split(":").length - x.r.pattern.split(":").length);
  const hit = candidates.sort((x, y) => x.r.pattern.split(":").length - y.r.pattern.split(":").length)[0];
  if (!hit) return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
  try {
    const db = bankDb();
    const session = sessionFromToken(db, readCookie(req.headers.get("cookie"), SESSION_COOKIE));
    if (hit.r.auth !== false && !session) throw new HttpError(401, "UNAUTHENTICATED", "Sign in first");
    if (method !== "GET" && hit.r.auth !== false && session) assertCsrf(req, session);
    let cached: any;
    const body = async () => {
      if (cached !== undefined) return cached;
      const text = await req.text();
      if (text.length > 256 * 1024) throw new HttpError(413, "TOO_LARGE", "Request too large");
      try {
        cached = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, "BAD_JSON", "Invalid JSON");
      }
      return cached;
    };
    const out = await hit.r.fn({ req, url, db, session, params: hit.p!, body });
    if (out instanceof Response) return out;
    return Response.json(out ?? { ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    if (e instanceof HttpError) return Response.json({ error: e.code, message: e.message }, { status: e.status, headers: { "cache-control": "no-store" } });
    console.error(`[api] ${method} ${pathName.split("/").slice(0, 3).join("/")} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return Response.json({ error: "INTERNAL", message: "Something went wrong. Nothing was changed by this request." }, { status: 500 });
  }
}

export { dataDir, balanceOf, inWindow };
