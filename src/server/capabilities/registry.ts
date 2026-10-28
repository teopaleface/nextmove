import type { DatabaseSync } from "node:sqlite";
import { all, json, one } from "../db/connection";
import { HttpError, type Session } from "../auth/session";
import { createProposal, loadProposal, SCHEDULED_GRANT_GRACE_DAYS } from "../authority/authority";
import type { ActionSpec } from "../authority/actions";
import { featureAllowed, featureForRoute } from "../authority/features";
import { ALEX_SUBSCRIPTION_CAPS } from "./alex-subscriptions";
import { ALEX_MONEY_CAPS, O1_PERSONAL } from "./alex-money";
import { LAZIZ_CAPS, O1_BUSINESS } from "./laziz";
import { O6_ALEX } from "./goal-route";
import { CASH_AUTOPILOT_CAPS } from "./cash-autopilot";
import { T4 } from "./trial-shield";
import { HIDDEN_LOSS_CAPS } from "./hidden-losses";
import { O9 } from "./financial-airbag";
import { EXT_CAPABILITIES, EXT_CAPABILITY_ORDER } from "../extensions/registry";
import { isExtOperation } from "../extensions/types";
import { makeEnv, type Analysis, type CapabilityDef } from "./core";

const O1_ALEX: CapabilityDef = { id: "O1", title: "Goals: phone now, home later", short: "Home readiness with or without the new phone", group: "Goals", customer: "alex", contextKind: "PERSONAL", keywords: ["goal", "home", "house", "phone", "save", "afford", "down payment", "casa", "telefon"], analyze: O1_PERSONAL };
const O1_LAZIZ: CapabilityDef = { id: "O1", title: "Goals: the 40,000 RON order", short: "Business conditions for a large order", group: "Goals", customer: "laziz", contextKind: "BUSINESS", keywords: ["goal", "order", "afford", "big order", "new shop", "expand", "comanda", "large order"], analyze: O1_BUSINESS };

export const CAPABILITIES: CapabilityDef[] = [O1_ALEX, ...ALEX_SUBSCRIPTION_CAPS, T4, ...ALEX_MONEY_CAPS, ...HIDDEN_LOSS_CAPS, O6_ALEX, ...CASH_AUTOPILOT_CAPS, O9, O1_LAZIZ, ...LAZIZ_CAPS, ...EXT_CAPABILITIES];

export const CAPABILITY_ORDER = ["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9", "T1", "T2", "T3", "T4", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15", "A16", "A17", "A18", ...EXT_CAPABILITY_ORDER];

export function customerOf(db: DatabaseSync, tenantId: string): "alex" | "laziz" {
  return (one<any>(db, "SELECT base_customer FROM tenants WHERE id=?", tenantId)?.base_customer ?? "alex") as "alex" | "laziz";
}

export function contextKindOf(db: DatabaseSync, contextId: string): "PERSONAL" | "BUSINESS" {
  return (one<any>(db, "SELECT kind FROM contexts WHERE id=?", contextId)?.kind ?? "PERSONAL") as "PERSONAL" | "BUSINESS";
}

export function capabilitiesFor(db: DatabaseSync, session: Session) {
  const customer = customerOf(db, session.tenantId);
  const kind = contextKindOf(db, session.contextId);
  return CAPABILITIES.filter((c) => c.customer === customer)
    .map((c) => ({ id: c.id, title: c.title, short: c.short, group: c.group, contextKind: c.contextKind, inThisContext: c.contextKind === kind }))
    .sort((a, b) => CAPABILITY_ORDER.indexOf(a.id) - CAPABILITY_ORDER.indexOf(b.id));
}

export function findCapability(db: DatabaseSync, session: Session, id: string): CapabilityDef {
  const customer = customerOf(db, session.tenantId);
  const def = CAPABILITIES.find((c) => c.id === id && c.customer === customer);
  if (!def) throw new HttpError(404, "NOT_FOUND", "This capability is not available for this customer");
  if (def.contextKind !== contextKindOf(db, session.contextId)) {
    const target = one<any>(db, "SELECT name FROM contexts WHERE tenant_id=? AND kind=? LIMIT 1", session.tenantId, def.contextKind);
    throw new HttpError(409, "WRONG_CONTEXT", `Switch to ${target?.name ?? def.contextKind.toLowerCase()} to use this`);
  }
  return def;
}

export async function analyzeCapability(db: DatabaseSync, session: Session, id: string, inputs: Record<string, unknown> = {}): Promise<Analysis> {
  const def = findCapability(db, session, id);
  const a = await def.analyze(makeEnv(db, session, sanitizeInputs(inputs)));
  // Execution availability is decided by the server for this environment, not by the client.
  for (const c of a.candidates) {
    if (c.available && !featureAllowed(featureForRoute(c.spec.route))) {
      c.available = false;
      c.unavailableReason = "Execution is disabled in this environment (real-operation-disabled bank demo)";
    }
  }
  return a;
}

function sanitizeInputs(inputs: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs ?? {}).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "boolean") out[k] = v;
    else if (v === null) out[k] = null;
  }
  return out;
}

/**
 * Build a proposal from freshly computed server-side candidates. The client only names candidate keys;
 * specs, destinations, amounts and terms come from the analysis run here. Required prerequisites are added.
 */
export async function proposeFromCapability(db: DatabaseSync, session: Session, id: string, keys: string[], inputs: Record<string, unknown> = {}, taskId: string | null = null) {
  const a = await analyzeCapability(db, session, id, inputs);
  const byKey = new Map(a.candidates.map((c) => [c.key, c]));
  const want = new Set<string>();
  const add = (k: string) => {
    const c = byKey.get(k);
    if (!c) throw new HttpError(400, "UNKNOWN_CANDIDATE", "One of the selected actions is no longer offered. Refresh and try again.");
    if (!c.available) throw new HttpError(409, "NOT_AVAILABLE", c.unavailableReason ?? "This action is not available");
    // Extension operations run only inside the bank; refuse a mis-routed candidate before it can become a proposal.
    if (c.spec.operation.startsWith("EXT_") && (c.spec.route !== "BANK_INTERNAL" || !isExtOperation(c.spec.operation))) throw new HttpError(500, "BAD_CANDIDATE", "This action is misconfigured and was not offered");
    want.add(k);
    for (const d of c.spec.dependsOn) if (byKey.has(d)) add(d);
  };
  for (const k of keys) add(k);
  if (!want.size) throw new HttpError(400, "BAD_SELECTION", "Select at least one action");
  const ordered = a.candidates.filter((c) => want.has(c.key));
  const p = createProposal(db, {
    tenantId: session.tenantId,
    contextId: session.contextId,
    actorUserId: session.userId,
    taskId,
    scope: ordered.length > 1 ? "BATCH" : "SINGLE",
    actions: ordered.map((c) => ({ key: c.key, spec: { ...c.spec, dependsOn: c.spec.dependsOn.filter((d) => want.has(d)) } })),
  });
  return proposalView(db, session, p.id);
}

export function proposalView(db: DatabaseSync, session: Session, proposalId: string) {
  const p = loadProposal(db, proposalId);
  if (!p || p.tenant_id !== session.tenantId) throw new HttpError(404, "NOT_FOUND", "Not found");
  const ctx = one<any>(db, "SELECT user_id, name, kind FROM contexts WHERE id=?", p.context_id);
  if (!ctx || ctx.user_id !== session.userId) throw new HttpError(404, "NOT_FOUND", "Not found");
  const mandate = one<any>(db, "SELECT * FROM mandates WHERE proposal_id=?", p.id);
  const grants = mandate ? all<any>(db, "SELECT action_id, status, expires_at FROM grants WHERE mandate_id=?", mandate.id) : [];
  const titleOf = new Map(p.actions.map((a: any) => [a.id, a.spec.display.title]));
  const actions = p.actions.map((a: any) => {
    const s: ActionSpec = a.spec;
    const attempt = one<any>(db, "SELECT id, status, evidence_json, reconcile_checks, next_reconcile_at FROM attempts WHERE action_id=? ORDER BY started_at DESC LIMIT 1", a.id);
    const receipt = one<any>(db, "SELECT id, issuer_reference FROM receipts WHERE action_id=? LIMIT 1", a.id);
    return {
      id: a.id,
      ordinal: a.ordinal,
      status: a.status,
      operation: s.operation,
      route: s.route,
      capability: s.capability,
      merchantName: s.merchantName,
      display: s.display,
      money: s.money,
      consequences: s.consequences,
      termsRevision: s.termsRevision,
      dependsOn: s.dependsOn.map((d) => titleOf.get(d) ?? d),
      grant: grants.find((g) => g.action_id === a.id) ?? null,
      result: json(a.result_json, null),
      attempt: attempt ? { id: attempt.id, status: attempt.status, reconcileChecks: attempt.reconcile_checks, nextCheckAt: attempt.next_reconcile_at, steps: json<any>(attempt.evidence_json, {})?.steps ?? [] } : null,
      receipt: receipt ? { id: receipt.id, reference: receipt.issuer_reference } : null,
    };
  });
  const sum = (f: (s: ActionSpec) => number) => p.actions.reduce((t: number, a: any) => t + f(a.spec), 0);
  // An agent task's proposal records the capability inputs the planner set (each one given by the customer).
  const agent = p.task_id ? json<any>(one<any>(db, "SELECT payload_json FROM task_blocks WHERE task_id=? AND block_key='proposal'", p.task_id)?.payload_json, null) : null;
  return {
    id: p.id,
    revision: p.revision,
    status: p.status,
    outdatedReason: p.outdated_reason,
    scope: p.scope,
    digest: p.digest,
    createdAt: p.created_at,
    readyExpiresAt: p.ready_expires_at,
    approvalWindowMinutes: p.manifest.approvalWindowMinutes,
    scheduledGrantGraceDays: SCHEDULED_GRANT_GRACE_DAYS,
    context: { id: p.context_id, name: ctx.name, kind: ctx.kind },
    taskId: p.task_id,
    batchId: p.batch_id,
    agentInputs: agent?.proposalId === p.id && Array.isArray(agent.inputs) ? (agent.inputs as { key: string; label: string; value: string }[]) : [],
    mandate: mandate ? { id: mandate.id, status: mandate.status, startExpiresAt: mandate.start_expires_at, revokedAt: mandate.revoked_at } : null,
    totals: { immediateDebitMinor: sum((s) => s.money.immediateDebitMinor), maxDebitMinor: sum((s) => s.money.maxDebitMinor), feesMinor: sum((s) => s.money.feesMinor), forecastChangeMinor: sum((s) => s.money.forecastChangeMinor) },
    actions,
  };
}

export function currentRevisionLookup(db: DatabaseSync, tenantId: string) {
  return (spec: ActionSpec): number | null => {
    if (!spec.subjectRef) return null;
    const s = one<any>(db, "SELECT observed_revision FROM subscriptions WHERE id=? AND tenant_id=?", spec.subjectRef, tenantId);
    return s ? s.observed_revision : null;
  };
}
