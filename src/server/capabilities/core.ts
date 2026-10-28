import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run } from "../db/connection";
import { repoRoot } from "../config";
import { nowIso, nowMs } from "../clock";
import { MerchantClient } from "../merchant-client";
import { DEFAULT_CONSEQUENCES, DEFAULT_MONEY, type ActionSpec, type DisplayLine } from "../authority/actions";
import type { EvidenceLevel } from "../agent/events";
import type { MerchantContractView, MerchantDirectoryEntry } from "../../shared/merchant-contract";
import { formatMoney } from "../../shared/money";
import type { Simulation } from "../../shared/simulations";

// Shared vocabulary for capability workflows. A workflow reads current bank and provider state, runs the
// deterministic finance engine, and returns typed blocks plus server-built action candidates. Nothing here
// moves money or creates authority; proposals and approvals do that elsewhere.

export type Tone = "good" | "warn" | "bad" | "neutral";

export type Block =
  | { kind: "metrics"; items: { label: string; value: string; sub?: string; tone?: Tone }[] }
  | { kind: "table"; title: string; columns: string[]; rows: { cells: string[]; highlight?: boolean; tone?: Tone }[]; note?: string }
  | { kind: "conditions"; title: string; items: { label: string; state: "met" | "unmet" | "unknown"; detail?: string }[] }
  | { kind: "timeline"; title: string; items: { at: string; label: string; amount?: string; state?: string }[] }
  | { kind: "facts"; title: string; items: { label: string; value: string; provenance: string }[] }
  | { kind: "note"; tone: "info" | "warn"; text: string }
  | { kind: "question"; id: string; text: string; options: { value: string; label: string }[]; answer: string | null }
  | { kind: "status"; title: string; state: string; detail?: string; href?: string }
  | { kind: "simulation"; simulation: Simulation };

export interface InputField {
  key: string;
  label: string;
  type: "money" | "number" | "select" | "toggle" | "text";
  value: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  help?: string;
}

export interface Candidate {
  key: string;
  spec: ActionSpec;
  defaultSelected: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface Analysis {
  capability: string;
  title: string;
  contextId: string;
  headline: string;
  summary: string;
  evidence: EvidenceLevel[];
  blocks: Block[];
  inputs: InputField[];
  candidates: Candidate[];
  numbers: Record<string, number>;
  done?: { label: string; href?: string } | null;
  links?: { label: string; href: string }[];
  // endpoint: "bank" posts {action, body} to /labs/bank; any other value is a Labs path that receives the body as is.
  labs?: { action: string; label: string; body?: Record<string, unknown>; endpoint?: string }[];
}

export interface CapEnv {
  db: DatabaseSync;
  tenantId: string;
  contextId: string;
  userId: string;
  customer: "alex" | "laziz";
  now: string;
  nowMs: number;
  merchant: MerchantClient;
  inputs: Record<string, unknown>;
}

export interface CapabilityDef {
  id: string;
  title: string;
  short: string;
  group: "Subscriptions" | "Bills" | "Money back" | "Purchases" | "Goals" | "Business" | "Travel" | "Evidence";
  customer: "alex" | "laziz";
  contextKind: "PERSONAL" | "BUSINESS";
  keywords: string[];
  analyze(env: CapEnv): Promise<Analysis>;
}

export function makeEnv(db: DatabaseSync, s: { tenantId: string; contextId: string; userId: string }, inputs: Record<string, unknown> = {}): CapEnv {
  const tenant = one<any>(db, "SELECT base_customer FROM tenants WHERE id=?", s.tenantId);
  return { db, tenantId: s.tenantId, contextId: s.contextId, userId: s.userId, customer: tenant?.base_customer ?? "alex", now: nowIso(db, s.tenantId), nowMs: nowMs(db, s.tenantId), merchant: new MerchantClient(db, s.tenantId), inputs };
}

let fixtureCache: Record<string, any> = {};
export function fixture(rel: "demo/capability-scenarios.json" | "demo/cases.json" | "design/ui-fixtures.json" | "demo/bulk-cancellations.json"): any {
  if (!fixtureCache[rel]) fixtureCache[rel] = JSON.parse(fs.readFileSync(path.join(repoRoot(), rel), "utf8"));
  return fixtureCache[rel];
}

export function directory(db: DatabaseSync, tenantId: string): MerchantDirectoryEntry[] {
  return json<MerchantDirectoryEntry[]>(one<any>(db, "SELECT value_json FROM system_status WHERE key=?", `directory:${tenantId}`)?.value_json, []);
}

export function routeFor(db: DatabaseSync, tenantId: string, merchantId: string): "PARTNER_API" | "ISOLATED_BROWSER" | null {
  const d = directory(db, tenantId).find((x) => x.id === merchantId);
  if (!d || d.connector === "NONE") return null;
  return d.connector;
}

export function subscription(env: CapEnv, local: string) {
  return one<any>(env.db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=?", `${env.tenantId}:sub:${local}`, env.tenantId);
}

export function forecastFor(env: CapEnv, subscriptionId: string) {
  return all<any>(env.db, "SELECT * FROM forecast_items WHERE tenant_id=? AND subscription_id=? AND status='SCHEDULED' ORDER BY due_at", env.tenantId, subscriptionId);
}

/** Read the provider's current contract and record what the bank observed (revision and time). */
export async function liveContract(env: CapEnv, sub: any): Promise<{ contract: MerchantContractView | null; status: number; error?: string }> {
  try {
    const r = await env.merchant.getContract(sub.merchant_id, sub.subscriber_account_id, sub.contract_id);
    if (r.contract) run(env.db, "UPDATE subscriptions SET observed_revision=?, last_observed_at=? WHERE id=?", r.contract.termsRevision, env.now, sub.id);
    return { contract: r.contract ?? null, status: r.status, error: r.error };
  } catch (e: any) {
    return { contract: null, status: 0, error: String(e?.message ?? e) };
  }
}

export function spec(p: Partial<ActionSpec> & Pick<ActionSpec, "operation" | "route" | "capability" | "subjectRef" | "display">): ActionSpec {
  return {
    merchantId: null,
    merchantName: null,
    subscriberAccountId: null,
    contractId: null,
    canonicalKey: null,
    params: {},
    termsRevision: null,
    dependsOn: [],
    ...p,
    money: { ...DEFAULT_MONEY, ...(p.money ?? {}) },
    consequences: { ...DEFAULT_CONSEQUENCES, ...(p.consequences ?? {}) },
  };
}

export function display(title: string, summary: string, lines: DisplayLine[], note: string, confirmLabel = "Approve", declineLabel = "Not now"): ActionSpec["display"] {
  return { title, summary, lines, note, confirmLabel, declineLabel };
}

export function subjectFields(sub: any) {
  return { merchantId: sub.merchant_id, merchantName: sub.merchant_name, subscriberAccountId: sub.subscriber_account_id, contractId: sub.contract_id, canonicalKey: sub.canonical_key, subjectRef: sub.id };
}

export function stopRenewalCandidate(env: CapEnv, capability: string, sub: any, contract: MerchantContractView, opts: { key?: string; dependsOn?: string[]; lostBenefits?: string[]; reason?: string; defaultSelected?: boolean } = {}): Candidate {
  const route = routeFor(env.db, env.tenantId, sub.merchant_id);
  const items = forecastFor(env, sub.id);
  const removed = items.reduce((s, i) => s - i.amount_minor, 0);
  const available = Boolean(route) && contract.autoRenew;
  return {
    key: opts.key ?? `stop-${sub.merchant_id}`,
    defaultSelected: opts.defaultSelected ?? true,
    available,
    unavailableReason: !route ? "No supported connector for this provider" : !contract.autoRenew ? "Renewal is already off" : undefined,
    spec: spec({
      operation: "STOP_RENEWAL",
      route: route ?? "PARTNER_API",
      capability,
      ...subjectFields(sub),
      termsRevision: contract.termsRevision,
      money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: -removed },
      consequences: { effectiveAt: null, accessUntil: contract.accessUntil ?? contract.nextChargeAt, lostBenefits: opts.lostBenefits ?? [], dataEffect: null, remainingObligations: null },
      dependsOn: opts.dependsOn ?? [],
      display: display(
        `Turn off ${sub.merchant_name} renewal`,
        opts.reason ?? `Stop the next ${sub.merchant_name} charge; access continues until the paid period ends.`,
        [
          { label: "Provider", value: `${sub.merchant_name} · ${contract.planName}` },
          { label: "Account", value: maskAccount(sub.subscriber_account_id) },
          { label: "Change", value: "Turn off renewal (no cancellation fee)" },
          { label: "Access until", value: fmtWhen(contract.accessUntil ?? contract.nextChargeAt) },
          { label: "Charges avoided", value: removed ? `${formatMoney(removed)} due ${fmtWhen(items[0]?.due_at)}` : "None in this window" },
          { label: "Terms", value: `Revision ${contract.termsRevision}` },
          { label: "Route", value: route === "ISOLATED_BROWSER" ? "Provider website in an isolated browser" : "Provider partner API" },
        ],
        "Money in your accounts does not change. If the provider's terms change before this starts, nothing is sent.",
      ),
    }),
  };
}

export function maskAccount(id: string) {
  const local = id.split(":").pop() ?? id;
  return local.length > 6 ? `${local.slice(0, 3)}…${local.slice(-3)}` : local;
}

export function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso.length === 10 ? `${iso}T12:00:00+02:00` : iso));
}

export function money(minor: number | null | undefined, opts: { sign?: boolean } = {}) {
  if (minor == null) return "Unknown";
  return formatMoney(minor, "RON", opts);
}

export function lastReceipt(env: CapEnv, subjectRef: string, operation: string) {
  return one<any>(
    env.db,
    `SELECT r.* FROM receipts r JOIN proposal_actions a ON a.id=r.action_id WHERE r.tenant_id=? AND a.subject_ref=? AND r.operation=? ORDER BY r.verified_at DESC LIMIT 1`,
    env.tenantId,
    subjectRef,
    operation,
  );
}

export function openActionFor(env: CapEnv, subjectRef: string, operation: string) {
  return one<any>(
    env.db,
    "SELECT * FROM proposal_actions WHERE tenant_id=? AND subject_ref=? AND operation=? AND status IN ('APPROVED','EXECUTING','PENDING','UNKNOWN') ORDER BY updated_at DESC LIMIT 1",
    env.tenantId,
    subjectRef,
    operation,
  );
}

export function fact(env: CapEnv, key: string) {
  return one<any>(env.db, "SELECT * FROM facts WHERE tenant_id=? AND context_id=? AND key=? ORDER BY revision DESC, created_at DESC LIMIT 1", env.tenantId, env.contextId, key);
}

export function preference(env: CapEnv, key: string): any {
  const p = one<any>(env.db, "SELECT value_json FROM preferences WHERE tenant_id=? AND context_id=? AND key=?", env.tenantId, env.contextId, key);
  return p ? JSON.parse(p.value_json) : undefined;
}

export function inputOr<T>(env: CapEnv, key: string, fallback: T): T {
  const v = env.inputs[key];
  return (v === undefined || v === null || v === "" ? fallback : v) as T;
}

export const PROVENANCE: Record<string, string> = {
  READ_FROM_IMAGE: "Read from your image",
  MATCHED_BANK_RECORD: "Matched to a bank record",
  YOU_ENTERED: "You entered",
  NEEDS_CHECKING: "Needs checking",
  MERCHANT: "From the provider (simulated)",
  CATALOG: "Fictional catalog",
  BANK: "NextMove bank record",
  CALCULATED: "Calculated by NextMove",
};
