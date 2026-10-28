import type { DatabaseSync } from "node:sqlite";
import { all, one, run } from "../../db/connection";
import { HttpError } from "../../auth/session";
import { nowIso, nowMs } from "../../clock";
import { MerchantClient } from "../../merchant-client";
import { notify, taskEvent, taskIdForAction } from "../../agent/events";
import { shortId } from "../../canonical";
import type { ActionSpec } from "../../authority/actions";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, fmtDate, fmtWhen, inputOr, liveContract, money, stopRenewalCandidate } from "../../capabilities/core";
import { toLocalIso, toMs } from "../../../shared/time";
import type { ExtensionModule, ExtPreDispatch } from "../types";
import { answerExitQuestion, countUses, createExitPlan, runExitPlan, DEFAULT_EXIT_POLICY, type ExitPlan, type ExitPlanTerms, type UsageEvidence } from "../../../../extensions/src/exit-plan/index.ts";
import { digestOf } from "../../../../extensions/src/shared/digest.ts";
import { addDays, localDate } from "../../../../extensions/src/shared/time.ts";

// E2 Exit plan: "stop this unless I use it N times by day D", approved once as an exact, conditional STOP_RENEWAL.
// The terms (condition, evaluation day, price ceiling, provider deadline) are part of the digested spec. The worker
// holds the action until the evaluation day, evaluates it with the pure module, and then either closes it unsent
// (kept, voided, missed) or lets the normal stop-renewal route run through the dispatch gate under the same grant.

const KEY = "exit-plan";
const EVALUATE_AT_LOCAL = "09:00:00";
const POLL_MS = 3_000;

interface ExitParams {
  ruleId: string;
  manifestDigest: string;
  createdOn: string;
  executeAt: string;
  terms: ExitPlanTerms;
}

const exitParams = (spec: ActionSpec) => (spec.params as any)?.exitPlan as ExitParams | undefined;

/** 09:00 Bucharest time on a local date, as an instant with its real offset (DST-safe). */
function morningOf(date: string): string {
  const guess = Date.parse(`${date}T${EVALUATE_AT_LOCAL}+02:00`);
  const iso = toLocalIso(guess);
  return iso.slice(11, 19) === EVALUATE_AT_LOCAL ? iso : toLocalIso(guess - 3_600_000);
}

function evidenceFor(db: DatabaseSync, tenantId: string, contextId: string, subscriptionId: string): UsageEvidence[] {
  return all<any>(db, "SELECT * FROM ext_exit_usage WHERE tenant_id=? AND context_id=? AND subscription_id=? ORDER BY created_at", tenantId, contextId, subscriptionId).map((r) => ({
    source: r.source,
    coverage: r.coverage,
    sharedByCustomer: Boolean(r.shared_by_customer),
    uses: r.uses,
    periodStart: r.period_start,
    periodEnd: r.period_end,
  }));
}

function planActions(db: DatabaseSync, tenantId: string, contextId: string) {
  return all<any>(db, "SELECT * FROM proposal_actions WHERE tenant_id=? AND context_id=? AND operation='STOP_RENEWAL' ORDER BY updated_at DESC", tenantId, contextId)
    .map((a) => ({ a, spec: JSON.parse(a.spec_json) as ActionSpec }))
    .filter((x) => x.spec.capability === "E2" && exitParams(x.spec));
}

const answerKey = (actionId: string) => `e2:answer:${actionId}`;

function answerFor(db: DatabaseSync, action: any): "KEEP" | "STOP" | null {
  const f = one<any>(db, "SELECT value_json FROM facts WHERE tenant_id=? AND context_id=? AND key=? ORDER BY revision DESC, created_at DESC LIMIT 1", action.tenant_id, action.context_id, answerKey(action.id));
  const v = f ? JSON.parse(f.value_json)?.value : null;
  return v === "KEEP" || v === "STOP" ? v : null;
}

/* ------------------------------------------------------------------------------------------ capability */

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "Waiting for the check day",
  ASKED: "Needs your answer",
  STOP_REQUESTED: "Stopping renewal",
  KEPT: "Kept: you used it",
  VOID: "Closed without stopping",
};

async function analyzeE2(env: CapEnv): Promise<Analysis> {
  const subs = all<any>(env.db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='ui' AND state IN ('TRIAL','ACTIVE') ORDER BY state DESC, merchant_name", env.tenantId, env.contextId);
  const blocks: Block[] = [];
  const candidates: Candidate[] = [];
  const plans = planActions(env.db, env.tenantId, env.contextId);
  const live = plans.filter((p) => ["PROPOSED", "APPROVED", "EXECUTING", "PENDING", "UNKNOWN", "CONFIRMED", "NO_CHANGE", "EXPIRED", "TERMS_CHANGED", "BLOCKED", "REVOKED"].includes(p.a.status) && p.a.status !== "PROPOSED");

  if (live.length) {
    blocks.push({
      kind: "table",
      title: "Your exit plans",
      columns: ["Subscription", "Condition", "Check day", "Uses so far", "Status"],
      rows: live.map(({ a, spec }) => {
        const p = exitParams(spec)!;
        const row = one<any>(env.db, "SELECT status FROM ext_exit_plan WHERE action_id=? AND tenant_id=?", a.id, env.tenantId);
        const counts = countUses(evidenceFor(env.db, env.tenantId, env.contextId, p.terms.subscriptionId), p.createdOn, localDate(env.now));
        const uses = Math.max(counts.allDevices ?? 0, counts.thisDevice ?? 0);
        const status = a.status === "CONFIRMED" ? "Renewal stopped" : a.status === "APPROVED" || a.status === "EXECUTING" ? STATUS_TEXT[row?.status ?? "ACTIVE"] : STATUS_TEXT[row?.status ?? ""] ?? a.status.toLowerCase().replace(/_/g, " ");
        return { cells: [spec.merchantName ?? "—", `Stop unless used ${p.terms.minUses}×`, fmtDate(p.terms.evaluateOn), `${uses}${counts.allDevices === undefined && counts.thisDevice !== undefined ? " (this phone only)" : ""}`, status], tone: a.status === "CONFIRMED" ? "good" : row?.status === "ASKED" ? "warn" : "neutral" };
      }),
      note: "Usage counts only come from sources you chose to share. A phone cannot see TV or family-profile use, so phone-only data never stops a subscription on its own.",
    });
    for (const { a, spec } of live) {
      const row = one<any>(env.db, "SELECT status, outcome_json FROM ext_exit_plan WHERE action_id=? AND tenant_id=?", a.id, env.tenantId);
      if (row?.status !== "ASKED" || !["APPROVED", "EXECUTING"].includes(a.status)) continue;
      const o = JSON.parse(row.outcome_json ?? "{}");
      blocks.push({
        kind: "question",
        id: answerKey(a.id),
        text: `${spec.merchantName}: ${o.reason === "PARTIAL_COVERAGE" ? `we only see ${o.uses} use(s) on this phone` : "we have no usage data you shared"}. Did you use it enough to keep it? Answer before ${fmtWhen(exitParams(spec)!.terms.cancelDeadline)}.`,
        options: [{ value: "KEEP", label: "Keep it" }, { value: "STOP", label: "Stop renewal" }],
        answer: answerFor(env.db, a),
      });
    }
  }

  const pick = subs.find((s) => s.id === inputOr(env, "subscription", "")) ?? subs.find((s) => s.state === "TRIAL") ?? subs[0];
  const inputs: Analysis["inputs"] = [];
  if (pick) {
    const { contract, error } = await liveContract(env, pick);
    const minUses = Math.max(1, Math.min(60, Math.round(Number(inputOr(env, "minUses", 4)) || 4)));
    const today = localDate(env.now);
    const deadline = contract?.nextChargeAt ?? null;
    const lastDay = deadline ? addDays(localDate(deadline), -DEFAULT_EXIT_POLICY.minMarginDays) : today;
    const days: string[] = [];
    for (let d = addDays(today, 1); d <= lastDay && days.length < 60; d = addDays(d, 1)) days.push(d);
    const evaluateOn = days.includes(String(inputOr(env, "evaluateOn", ""))) ? String(env.inputs.evaluateOn) : days[days.length - 1];
    inputs.push(
      { key: "subscription", label: "Subscription", type: "select", value: pick.id, options: subs.map((s) => ({ value: s.id, label: `${s.merchant_name}${s.state === "TRIAL" ? " (trial)" : ""}` })) },
      { key: "minUses", label: "Keep it if I use it at least", type: "number", value: minUses, min: 1, max: 60, suffix: "times" },
      ...(days.length ? [{ key: "evaluateOn", label: "Check on", type: "select" as const, value: evaluateOn, options: days.map((d) => ({ value: d, label: fmtDate(d) })) }] : []),
    );
    blocks.unshift({
      kind: "facts",
      title: `${pick.merchant_name} today`,
      items: [
        { label: "Plan", value: contract ? `${contract.planName} · ${money(contract.priceMinor)}` : "Provider not reachable", provenance: "Provider contract" },
        { label: "Next charge", value: fmtWhen(deadline), provenance: "Provider contract" },
        { label: "Last day to check", value: days.length ? fmtDate(lastDay) : "Too close to the next charge", provenance: "Calculated by NextMove" },
      ],
    });
    if (contract && deadline && evaluateOn) {
      const terms: ExitPlanTerms = {
        scope: { ownerId: `${env.tenantId}:${env.userId}`, contextId: "PERSONAL" },
        subscriptionId: pick.id,
        merchantId: pick.merchant_id,
        termsRevision: contract.termsRevision,
        priceCeilingMinor: contract.priceMinor,
        currency: contract.currency,
        minUses,
        evaluateOn,
        cancelDeadline: deadline,
      };
      let plan: ExitPlan | null = null;
      let refusal: string | null = null;
      try {
        plan = createExitPlan(terms, env.now);
      } catch (e: any) {
        refusal = String(e?.message ?? e);
      }
      const base = stopRenewalCandidate(env, "E2", pick, contract, { key: `exit-${pick.merchant_id}`, defaultSelected: true });
      const executeAt = morningOf(evaluateOn);
      const params = { ...base.spec.params, exitPlan: plan ? { ruleId: plan.ruleId, manifestDigest: plan.manifestDigest, createdOn: plan.createdOn, executeAt, terms } : null };
      const lines = base.spec.display.lines.filter((l) => !["Change", "Charges avoided"].includes(l.label));
      candidates.push({
        ...base,
        available: base.available && Boolean(plan),
        unavailableReason: base.unavailableReason ?? refusal ?? undefined,
        spec: {
          ...base.spec,
          params,
          consequences: { ...base.spec.consequences, effectiveAt: executeAt },
          display: {
            ...base.spec.display,
            title: `Stop ${pick.merchant_name} unless I use it ${minUses}× by ${fmtDate(evaluateOn)}`,
            summary: `On ${fmtWhen(executeAt)} NextMove counts the uses you shared. Fewer than ${minUses}: renewal is turned off before ${fmtWhen(deadline)}. Otherwise nothing is sent.`,
            lines: [
              ...lines,
              { label: "Condition", value: `Fewer than ${minUses} uses from ${fmtDate(plan?.createdOn ?? today)} to ${fmtDate(evaluateOn)}` },
              { label: "Check day", value: fmtWhen(executeAt) },
              { label: "Price ceiling", value: `${money(contract.priceMinor)}. A higher price cancels this plan; you are asked again` },
              { label: "If unsure", value: "Phone-only or no data: you are asked; nothing stops on silence" },
              { label: "Approval valid until", value: fmtWhen(deadline) },
            ],
            note: "This approval covers exactly this one stop and condition. If the provider changes its terms or price, the plan closes without sending anything. You can revoke it at any time before the check day.",
            confirmLabel: "Approve exit plan",
          },
        },
      });
    } else if (error || !contract) {
      blocks.push({ kind: "note", tone: "warn", text: `The provider could not be reached (${String(error ?? "no contract").slice(0, 80)}). No plan can be built without its current terms.` });
    }
  } else {
    blocks.push({ kind: "note", tone: "info", text: "No active subscription or trial in this context." });
  }

  const target = pick?.id;
  return {
    capability: "E2",
    title: "Exit plan",
    contextId: env.contextId,
    headline: live.some((p) => ["APPROVED", "EXECUTING"].includes(p.a.status)) ? `${live.filter((p) => ["APPROVED", "EXECUTING"].includes(p.a.status)).length} exit plan(s) active` : "Decide now when a subscription should end",
    summary: "Approve once: on the check day NextMove stops renewal only if you did not use the service as often as you said. If the data cannot show it, you are asked.",
    evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
    blocks,
    inputs,
    candidates,
    numbers: { activePlans: live.filter((p) => ["APPROVED", "EXECUTING"].includes(p.a.status)).length },
    labs: target
      ? [
          { action: "usage-all", label: "Provider reports 6 uses (all devices)", endpoint: "/labs/ext", body: { module: KEY, action: "report-usage", body: { subscriptionId: target, uses: 6, coverage: "ALL_DEVICES" } } },
          { action: "usage-low", label: "Provider reports 1 use (all devices)", endpoint: "/labs/ext", body: { module: KEY, action: "report-usage", body: { subscriptionId: target, uses: 1, coverage: "ALL_DEVICES" } } },
          { action: "usage-phone", label: "Phone screen time: 1 use (this phone only)", endpoint: "/labs/ext", body: { module: KEY, action: "report-usage", body: { subscriptionId: target, uses: 1, coverage: "THIS_DEVICE_ONLY" } } },
          { action: "clock-day", label: "Move demo clock forward 1 day", endpoint: "/labs/clock", body: { minutes: 1440 } },
        ]
      : [],
  };
}

export const E2: CapabilityDef = { id: "E2", title: "Exit plan", short: "Stop it unless you actually use it", group: "Subscriptions", customer: "alex", contextKind: "PERSONAL", keywords: ["exit plan", "unless i use", "stop unless", "trial", "use it", "condition", "cancel later"], analyze: analyzeE2 };

/* ------------------------------------------------------------------------------------------ worker hold */

function setRow(db: DatabaseSync, action: any, p: ExitParams, status: string, outcome: unknown) {
  run(
    db,
    `INSERT INTO ext_exit_plan(action_id, tenant_id, context_id, subscription_id, rule_id, status, outcome_json, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(action_id) DO UPDATE SET status=excluded.status, outcome_json=excluded.outcome_json, updated_at=excluded.updated_at`,
    action.id, action.tenant_id, action.context_id, p.terms.subscriptionId, p.ruleId, status, JSON.stringify(outcome ?? null), nowIso(db, action.tenant_id),
  );
}

const poll = (db: DatabaseSync, t: string, dueIso?: string) => ({ wait: new Date(Date.now() + (dueIso ? Math.min(POLL_MS, Math.max(250, toMs(dueIso) - nowMs(db, t))) : POLL_MS)).toISOString() });

async function holdExitPlan(c: { db: DatabaseSync; action: any; spec: ActionSpec; grant: any }): Promise<ExtPreDispatch | undefined> {
  const { db, action, spec, grant } = c;
  if (spec.capability !== "E2" || spec.operation !== "STOP_RENEWAL") return undefined;
  const t = action.tenant_id;
  const p = exitParams(spec);
  // The digested spec must carry a plan whose own digest still matches its terms and that targets this action's subject.
  if (!p || digestOf({ kind: "EXIT_PLAN", terms: p.terms }) !== p.manifestDigest || p.ruleId !== `exit_${p.manifestDigest.slice(0, 24)}` || p.terms.subscriptionId !== action.subject_ref || p.terms.scope.ownerId !== `${t}:${grant.actor_user_id}`) {
    return { settle: "BLOCKED", reason: "The exit plan does not match what was approved; nothing was sent" };
  }
  const sub = one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", p.terms.subscriptionId, t, action.context_id);
  if (!sub) return { settle: "BLOCKED", reason: "The subscription is not in this context; nothing was sent" };

  const row = one<any>(db, "SELECT * FROM ext_exit_plan WHERE action_id=? AND tenant_id=?", action.id, t);
  if (!row) setRow(db, action, p, "ACTIVE", null);
  if (row?.status === "STOP_REQUESTED") return null; // a retry before send: the decision was already made under this grant
  if (row && ["KEPT", "VOID"].includes(row.status)) return { settle: row.status === "KEPT" ? "NO_CHANGE" : "BLOCKED", reason: "This exit plan is already closed" };

  const now = nowIso(db, t);
  if (nowMs(db, t) < toMs(p.executeAt)) return poll(db, t, p.executeAt);
  // While the customer has not answered, waiting is a local read; the provider is read again once there is an answer or at the deadline.
  if (row?.status === "ASKED" && !answerFor(db, action) && nowMs(db, t) < toMs(p.terms.cancelDeadline)) return poll(db, t, p.terms.cancelDeadline);

  const r = await new MerchantClient(db, t).getContract(sub.merchant_id, sub.subscriber_account_id, sub.contract_id).catch(() => null);
  const contract = r?.contract;
  if (!contract) {
    // No provider read: never guess. Keep trying until the deadline, then close unsent.
    if (nowMs(db, t) >= toMs(p.terms.cancelDeadline)) return closeWith(db, action, spec, p, "VOID", { kind: "MISSED_DEADLINE" }, "EXPIRED", "The provider could not be checked before its deadline; nothing was sent");
    return poll(db, t);
  }
  run(db, "UPDATE subscriptions SET observed_revision=?, last_observed_at=? WHERE id=? AND tenant_id=?", contract.termsRevision, now, sub.id, t);
  const plan: ExitPlan = { ruleId: p.ruleId, terms: p.terms, manifestDigest: p.manifestDigest, createdOn: p.createdOn, status: "ACTIVE", grantId: grant.id };
  const snapshot = {
    subscriptionId: sub.id,
    state: contract.state === "CANCELLED" ? ("CANCELLED" as const) : !contract.autoRenew || contract.state === "RENEWAL_OFF" ? ("RENEWAL_OFF" as const) : contract.state === "TRIAL" ? ("TRIAL" as const) : ("ACTIVE" as const),
    termsRevision: contract.termsRevision,
    nextChargeMinor: contract.priceMinor,
    currency: contract.currency,
  };
  let res = runExitPlan(plan, { subscription: snapshot, evidence: evidenceFor(db, t, action.context_id, sub.id), now });
  const answer = res.outcome.kind === "ASK" ? answerFor(db, action) : null;
  if (answer) res = answerExitQuestion(plan, answer, now);
  const o = res.outcome;
  const name = spec.merchantName ?? "the provider";
  const taskId = taskIdForAction(db, action.id);

  switch (o.kind) {
    case "TOO_EARLY":
      return poll(db, t);
    case "ASK":
      if (row?.status !== "ASKED") {
        setRow(db, action, p, "ASKED", o);
        notify(db, { tenantId: t, contextId: action.context_id, title: `${name}: did you use it?`, body: o.reason === "NO_EVIDENCE" ? "You shared no usage data, so NextMove will not stop it on its own. Answer in Exit plan." : `We only see ${o.uses} use(s) on this phone. Answer in Exit plan before the deadline.`, link: "/capabilities/E2", dedupeKey: `ntf_e2_ask_${action.id}` });
        taskEvent(db, { taskId, tenantId: t, kind: "waiting", label: `${name} exit plan: asking you, usage data is incomplete`, evidence: "BANK_RECORD" });
      }
      return poll(db, t);
    case "STOP":
      setRow(db, action, p, "STOP_REQUESTED", o);
      taskEvent(db, { taskId, tenantId: t, kind: "decision", label: answer === "STOP" ? `${name} exit plan: you chose to stop` : `${name} exit plan: ${o.uses} of ${o.minUses} uses, stopping renewal`, evidence: "BANK_RECORD" });
      return null;
    case "KEEP":
      return closeWith(db, action, spec, p, "KEPT", o, "NO_CHANGE", answer === "KEEP" ? `You chose to keep ${name}; nothing was sent` : `You used ${name} ${o.uses} times (needed ${o.minUses}); it stays on and nothing was sent`);
    case "MISSED_DEADLINE":
      return closeWith(db, action, spec, p, "VOID", o, "EXPIRED", "The provider's deadline passed before a decision; nothing was sent");
    case "VOID": {
      const why: Record<string, [Exclude<ExtPreDispatch, null | { wait: string }>["settle"], string]> = {
        TERMS_CHANGED: ["TERMS_CHANGED", `${name} changed its terms after you approved; the plan closed and nothing was sent`],
        PRICE_ABOVE_CEILING: ["BLOCKED", `${name} now charges ${money(contract.priceMinor)}, above the ${money(p.terms.priceCeilingMinor)} you approved; the plan closed and nothing was sent`],
        ALREADY_ENDED: ["NO_CHANGE", `${name} renewal is already off`],
        CURRENCY_CHANGED: ["BLOCKED", `${name} changed currency; the plan closed and nothing was sent`],
        SUBSCRIPTION_MISMATCH: ["BLOCKED", "The subscription does not match the plan; nothing was sent"],
        MERCHANT_REFUSED: ["REFUSED", `${name} refused the stop`],
      };
      const [status, reason] = why[o.reason] ?? ["BLOCKED", "The plan closed; nothing was sent"];
      return closeWith(db, action, spec, p, "VOID", o, status, reason);
    }
    default:
      return { settle: "BLOCKED", reason: "The exit plan is not active; nothing was sent" };
  }
}

function closeWith(db: DatabaseSync, action: any, spec: ActionSpec, p: ExitParams, rowStatus: string, outcome: unknown, settle: Exclude<ExtPreDispatch, null | { wait: string }>["settle"], reason: string): ExtPreDispatch {
  setRow(db, action, p, rowStatus, outcome);
  notify(db, { tenantId: action.tenant_id, contextId: action.context_id, title: `${spec.merchantName ?? "Exit plan"}: ${rowStatus === "KEPT" ? "kept" : "plan closed"}`, body: reason, link: "/capabilities/E2", dedupeKey: `ntf_e2_close_${action.id}` });
  return { settle, reason, detail: { exitPlan: { ruleId: p.ruleId, outcome } } };
}

/* ------------------------------------------------------------------------------------------ labs */

const SOURCES = new Set(["MERCHANT_REPORTED", "DEVICE_SCREEN_TIME", "CUSTOMER_REPORTED"]);
const COVERAGE = new Set(["ALL_DEVICES", "THIS_DEVICE_ONLY"]);

export const exitPlan: ExtensionModule = {
  key: KEY,
  capabilities: [E2],
  preDispatch: holdExitPlan,
  labs: {
    // Simulates usage data the customer chose to share: the provider's own count (all devices) or phone screen time.
    "report-usage": ({ db, session, body }) => {
      const subId = String(body.subscriptionId ?? "");
      const sub = one<any>(db, "SELECT id FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", subId, session.tenantId, session.contextId);
      if (!sub) throw new HttpError(404, "NOT_FOUND", "Subscription not found in this context");
      const uses = Number(body.uses);
      if (!Number.isSafeInteger(uses) || uses < 0 || uses > 500) throw new HttpError(400, "BAD_USES", "uses must be an integer from 0 to 500");
      const coverage = String(body.coverage ?? "ALL_DEVICES");
      if (!COVERAGE.has(coverage)) throw new HttpError(400, "BAD_COVERAGE", "Unknown coverage");
      const source = String(body.source ?? (coverage === "ALL_DEVICES" ? "MERCHANT_REPORTED" : "DEVICE_SCREEN_TIME"));
      if (!SOURCES.has(source)) throw new HttpError(400, "BAD_SOURCE", "Unknown source");
      const today = localDate(nowIso(db, session.tenantId));
      // One reading per source covering the whole period so far; a new reading replaces the previous one.
      run(db, "DELETE FROM ext_exit_usage WHERE tenant_id=? AND context_id=? AND subscription_id=? AND source=? AND coverage=?", session.tenantId, session.contextId, sub.id, source, coverage);
      run(
        db,
        "INSERT INTO ext_exit_usage(id, tenant_id, context_id, subscription_id, source, coverage, shared_by_customer, uses, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)",
        shortId("use"), session.tenantId, session.contextId, sub.id, source, coverage, uses, addDays(today, -60), today, new Date().toISOString(),
      );
      return { ok: true, subscriptionId: sub.id, uses, coverage, source, through: today };
    },
  },
};
