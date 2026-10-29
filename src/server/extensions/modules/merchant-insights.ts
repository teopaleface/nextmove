import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../../db/connection";
import { sha256Hex } from "../../canonical";
import { FIXTURE_INSTANT } from "../../clock";
import { toLocalIso } from "../../../shared/time";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, RENEWAL_FLOW, fmtDate, money } from "../../capabilities/core";
import type { ExtensionModule } from "../types";
import {
  cancellationDifficulty,
  detectPriceChanges,
  merchantTrackRecords,
  priceAlertsFor,
  DEFAULT_TRACK_RECORD_POLICY,
  type CancellationRunObservation,
  type ChargeObservation,
  type DifficultyRecord,
  type PostCancellationObservation,
  type PriceChangeCluster,
  type TrackRecord,
} from "../../../../extensions/src/merchant-insights/index.ts";

// E4 Merchant insights (extensions/src/merchant-insights, incl. difficulty.ts). Read-only: for each of the customer's
// subscription merchants, what other customers saw (billing after a verified cancellation, price changes, how hard
// cancelling was). The cohort is SYNTHETIC demo data with pseudonymous keys; the page says so. Any group below k
// distinct customers is shown as "not enough data", never as a number. No candidates: it links to stop-renewal flows.

const K = DEFAULT_TRACK_RECORD_POLICY.minCustomers;
const DAY = 86_400_000;
const SYNTHETIC = "Synthetic demo cohort";


/* ------------------------------------------------------------------------------------------ seed */

// The cohort: other (fictional) customers of the same fictional merchants. Sized so some merchants meet k = 20 and
// others do not. Times are relative to the fixture instant, so the windows (180 days, 35-day maturity, 90-day
// lookback) hold for the demo clock.
const TRACK = [
  { m: "pulsegym", n: 30, billed: 4, unverified: 3, immature: 2 },
  { m: "streamly", n: 42, billed: 0, unverified: 0, immature: 0 },
  { m: "cloudbox", n: 24, billed: 1, unverified: 0, immature: 0 },
  { m: "dasheats", n: 9, billed: 2, unverified: 0, immature: 1 },
  { m: "studyplus", n: 6, billed: 0, unverified: 4, immature: 0 },
];
const PRICES = [
  { m: "pulsegym", plan: "Full access monthly", n: 24, from: 25000, to: 27500 },
  { m: "streamly", plan: "Streamly Standard", n: 33, from: 3900, to: 4900 },
  { m: "dasheats", plan: "Plus monthly", n: 8, from: 2999, to: 3499 },
  { m: "cloudbox", plan: "CloudBox 100 GB", n: 25, from: 3500, to: 3500 },
];
const RUNS = [
  { m: "pulsegym", n: 22, rev: 1, steps: [9, 12], screens: [3, 4], secs: [700, 1100], humanEvery: [0, 1, 2], failed: 3, partnerApi: 3, oldRev: 0 },
  { m: "streamly", n: 28, rev: 3, steps: [2, 3], screens: [0, 0], secs: [60, 140], humanEvery: [], failed: 0, partnerApi: 0, oldRev: 0 },
  { m: "cloudbox", n: 21, rev: 2, steps: [4, 6], screens: [1, 1], secs: [200, 320], humanEvery: [], failed: 1, partnerApi: 0, oldRev: 10 },
  { m: "dasheats", n: 7, rev: 1, steps: [5, 7], screens: [1, 2], secs: [240, 400], humanEvery: [], failed: 0, partnerApi: 0, oldRev: 0 },
];

const span = ([lo, hi]: number[], i: number) => lo! + (i % (hi! - lo! + 1));

export function seedMerchantInsights(db: DatabaseSync, tenantId: string) {
  const base = Date.parse(FIXTURE_INSTANT);
  const at = (days: number, extraMs = 0) => toLocalIso(base - days * DAY + extraMs);
  // Per tenant and per merchant salt: a key cannot be joined across merchants, tenants or to any account.
  const key = (m: string, i: number) => `ck_${sha256Hex(`cohort:${tenantId}:${m}:${i}`).slice(0, 16)}`;
  for (const g of TRACK) {
    const total = g.n + g.unverified + g.immature;
    for (let i = 0; i < total; i++) {
      const immature = i >= g.n + g.unverified;
      const days = immature ? 10 + (i % 20) : 40 + ((i * 7) % 120);
      run(db, "INSERT OR IGNORE INTO ext_mi_cohort_cancellation(tenant_id, obs_id, customer_key, merchant_id, cancellation_confirmed_at, verified, billed_after) VALUES (?,?,?,?,?,?,?)",
        tenantId, `cxl:${g.m}:${i}`, key(g.m, i), g.m, at(days), i >= g.n && i < g.n + g.unverified ? 0 : 1, i < g.billed ? 1 : 0);
    }
  }
  for (const g of PRICES) {
    for (let i = 0; i < g.n; i++) {
      const k = key(g.m, 1000 + i);
      run(db, "INSERT OR IGNORE INTO ext_mi_cohort_charge(tenant_id, obs_id, customer_key, merchant_id, plan_key, currency, amount_minor, charged_at, recurring) VALUES (?,?,?,?,?, 'RON', ?,?, 1)", tenantId, `chg:${g.m}:${i}:a`, k, g.m, g.plan, g.from, at(38 + (i % 5)));
      run(db, "INSERT OR IGNORE INTO ext_mi_cohort_charge(tenant_id, obs_id, customer_key, merchant_id, plan_key, currency, amount_minor, charged_at, recurring) VALUES (?,?,?,?,?, 'RON', ?,?, 1)", tenantId, `chg:${g.m}:${i}:b`, k, g.m, g.plan, g.to, at(8 + (i % 5)));
    }
  }
  const insertRun = (id: string, ck: string, m: string, channel: string, rev: number, days: number, secs: number, outcome: string, verified: number, steps: number, screens: number, human: number) =>
    run(db, "INSERT OR IGNORE INTO ext_mi_cohort_run(tenant_id, run_id, customer_key, merchant_id, channel, flow_revision, started_at, finished_at, outcome, verified, steps, retention_screens, human_contact_required) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      tenantId, id, ck, m, channel, rev, at(days), at(days, secs * 1000), outcome, verified, steps, screens, human);
  for (const g of RUNS) {
    for (let i = 0; i < g.n; i++) insertRun(`run:${g.m}:${i}`, key(g.m, 2000 + i), g.m, "BROWSER_ADAPTER", g.rev, 5 + i * 3, span(g.secs, i * 37), "CONFIRMED", 1, span(g.steps, i), span(g.screens, i), g.humanEvery.includes(i % 5) ? 1 : 0);
    for (let i = 0; i < g.failed; i++) insertRun(`run:${g.m}:fail:${i}`, key(g.m, 2500 + i), g.m, "BROWSER_ADAPTER", g.rev, 6 + i * 4, span(g.secs, i), "FAILED", 0, span(g.steps, i), span(g.screens, i), 1);
    // Partner-API runs bypass the merchant's flow; older flow revisions no longer describe it. Both are excluded.
    for (let i = 0; i < g.partnerApi; i++) insertRun(`run:${g.m}:api:${i}`, key(g.m, 2600 + i), g.m, "PARTNER_API", g.rev, 7 + i, 4, "CONFIRMED", 1, 1, 0, 0);
    for (let i = 0; i < g.oldRev; i++) insertRun(`run:${g.m}:old:${i}`, key(g.m, 2700 + i), g.m, "BROWSER_ADAPTER", g.rev - 1, 100 + i, 1500, "CONFIRMED", 1, 14, 5, 1);
  }
}

/* --------------------------------------------------------------------------------------- compute */

export interface MerchantInsights {
  records: TrackRecord[];
  clusters: PriceChangeCluster[];
  difficulty: DifficultyRecord[];
}

/** Run the module's batch functions over this tenant's cohort and publish the aggregates (no customer column). */
export function computeInsights(db: DatabaseSync, tenantId: string, now: string): MerchantInsights {
  const obs: PostCancellationObservation[] = all<any>(db, "SELECT customer_key, merchant_id, cancellation_confirmed_at, verified, billed_after FROM ext_mi_cohort_cancellation WHERE tenant_id=?", tenantId)
    .map((r) => ({ customerKey: r.customer_key, merchantId: r.merchant_id, cancellationConfirmedAt: r.cancellation_confirmed_at, verified: r.verified === 1, billedAfterCancellation: r.billed_after === 1 }));
  const charges: ChargeObservation[] = all<any>(db, "SELECT customer_key, merchant_id, plan_key, currency, amount_minor, charged_at, recurring FROM ext_mi_cohort_charge WHERE tenant_id=?", tenantId)
    .map((r) => ({ customerKey: r.customer_key, merchantId: r.merchant_id, planKey: r.plan_key, currency: r.currency, amountMinor: r.amount_minor, chargedAt: r.charged_at, recurring: r.recurring === 1 }));
  const runs: CancellationRunObservation[] = all<any>(db, "SELECT * FROM ext_mi_cohort_run WHERE tenant_id=?", tenantId).map((r) => ({
    customerKey: r.customer_key, merchantId: r.merchant_id, runId: r.run_id, channel: r.channel, flowRevision: r.flow_revision, startedAt: r.started_at, finishedAt: r.finished_at,
    outcome: r.outcome, verified: r.verified === 1, steps: r.steps, retentionScreens: r.retention_screens, humanContactRequired: r.human_contact_required === 1,
  }));
  const out = { records: merchantTrackRecords(obs, now), clusters: detectPriceChanges(charges, now), difficulty: cancellationDifficulty(runs, now) };
  tx(db, () => {
    for (const t of ["ext_merchant_track_record", "ext_price_change_cluster", "ext_cancellation_difficulty"]) run(db, `DELETE FROM ${t} WHERE tenant_id=?`, tenantId);
    for (const r of out.records) {
      const n = r.status === "INSUFFICIENT_DATA" ? null : r;
      run(db, "INSERT INTO ext_merchant_track_record(tenant_id, merchant_id, status, customers, billed_after_customers, rate_bp, lower_bound_bp, computed_at) VALUES (?,?,?,?,?,?,?,?)", tenantId, r.merchantId, r.status, n?.customers ?? null, n?.billedAfterCustomers ?? null, n?.rateBp ?? null, n?.lowerBoundBp ?? null, now);
    }
    for (const c of out.clusters) run(db, "INSERT INTO ext_price_change_cluster(tenant_id, merchant_id, plan_key, currency, old_minor, new_minor, direction, change_bp, customers, first_seen_on, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", tenantId, c.merchantId, c.planKey, c.currency, c.oldMinor, c.newMinor, c.direction, c.changeBp, c.customers, c.firstSeenOn, now);
    for (const d of out.difficulty) {
      const m = d.status === "MEASURED" ? d : null;
      run(db, "INSERT INTO ext_cancellation_difficulty(tenant_id, merchant_id, flow_revision, status, customers, grade, median_steps, p90_steps, median_retention_screens, median_seconds, human_contact_bp, completion_bp, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        tenantId, d.merchantId, d.flowRevision, d.status, m?.customers ?? null, m?.grade ?? null, m?.medianSteps ?? null, m?.p90Steps ?? null, m?.medianRetentionScreens ?? null, m?.medianSeconds ?? null, m?.humanContactBp ?? null, m?.completionBp ?? null, now);
    }
  });
  return out;
}

/* ------------------------------------------------------------------------------------- capability */

const pct = (bp: number) => `${Math.floor(bp / 100)}.${Math.floor((bp % 100) / 10)}%`;
const duration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`);
const GRADE: Record<string, string> = { EASY: "Easy", MODERATE: "Moderate", HARD: "Hard" };
const NOT_ENOUGH = `Not enough data (fewer than ${K} customers)`;

function subscriptionsOf(env: CapEnv) {
  return all<any>(env.db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset IN ('ui','hidden','bills') AND state <> 'CANCELLED' ORDER BY merchant_name", env.tenantId, env.contextId);
}

export const E4: CapabilityDef = {
  id: "E4",
  title: "Merchant insights",
  short: "How your subscription merchants treat other customers",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["merchant insights", "track record", "price radar", "price rise", "billed after cancel", "hard to cancel", "cancellation difficulty", "other customers", "merchant reputation"],
  async analyze(env): Promise<Analysis> {
    const base = { capability: "E4", title: "Merchant insights", contextId: env.contextId, evidence: ["DETERMINISTIC_CALCULATION", "FICTIONAL_CATALOG"] as Analysis["evidence"] };
    const subs = subscriptionsOf(env);
    const ins = computeInsights(env.db, env.tenantId, env.now);
    const rec = new Map(ins.records.map((r) => [r.merchantId, r]));
    const diff = new Map(ins.difficulty.map((d) => [d.merchantId, d]));
    const alerts = priceAlertsFor(
      subs.filter((s) => s.next_charge_at).map((s) => ({ subscriptionId: s.id, merchantId: s.merchant_id, planKey: s.plan_name, currency: s.currency, currentMinor: s.amount_minor, nextChargeAt: s.next_charge_at })),
      ins.clusters,
      env.now,
    );
    const flagged = subs.filter((s) => rec.get(s.merchant_id)?.status === "FLAGGED");
    const hard = subs.filter((s) => { const d = diff.get(s.merchant_id); return d?.status === "MEASURED" && d.grade === "HARD"; });
    const covered = subs.filter((s) => { const r = rec.get(s.merchant_id); return r && r.status !== "INSUFFICIENT_DATA"; });

    const blocks: Block[] = [
      { kind: "note", tone: "info", text: `${SYNTHETIC}: these figures come from generated, pseudonymous records of fictional customers in this demo, not from real bank data. A merchant is shown only when at least ${K} different customers are behind a number; otherwise it says "not enough data".` },
      {
        kind: "metrics",
        items: [
          { label: "Merchants with enough data", value: `${covered.length} of ${subs.length}`, sub: `At least ${K} customers each` },
          { label: "Kept billing after cancelling", value: String(flagged.length), sub: flagged.length ? flagged.map((s) => s.merchant_name).join(", ") : "None flagged", tone: flagged.length ? ("bad" as const) : ("good" as const) },
          { label: "Price rise before your next charge", value: String(alerts.length), sub: alerts.length ? "Seen by other customers first" : "None seen", tone: alerts.length ? ("warn" as const) : undefined },
        ],
      },
    ];

    for (const a of alerts) {
      const s = subs.find((x) => x.id === a.subscriptionId)!;
      blocks.push({ kind: "note", tone: "warn", text: `${s.merchant_name}: ${a.customersSeen} customers on ${s.plan_name} already pay ${money(a.expectedMinor)} instead of ${money(a.currentMinor)} (+${money(a.increaseMinor)}). Your next charge is on ${fmtDate(a.nextChargeAt)}. This is what others were charged, not a notice from ${s.merchant_name}.` });
    }
    for (const s of flagged) {
      const r = rec.get(s.merchant_id) as Exclude<TrackRecord, { status: "INSUFFICIENT_DATA" }>;
      blocks.push({ kind: "note", tone: "warn", text: `${s.merchant_name} charged ${r.billedAfterCustomers} of ${r.customers} customers again after a cancellation the bank had verified. Even at the cautious end (95% confidence) that is at least ${pct(r.lowerBoundBp)}. If you cancel, check your statement after the next billing date.` });
    }

    blocks.push({
      kind: "table",
      title: "Track record: billed after a verified cancellation",
      columns: ["Merchant", "Customers", "Billed again", "Status"],
      rows: subs.map((s) => {
        const r = rec.get(s.merchant_id);
        if (!r || r.status === "INSUFFICIENT_DATA") return { cells: [s.merchant_name, "—", "—", NOT_ENOUGH] };
        return { cells: [s.merchant_name, String(r.customers), `${r.billedAfterCustomers} (${pct(r.rateBp)}; at least ${pct(r.lowerBoundBp)})`, r.status === "FLAGGED" ? "Flagged" : "No pattern"], highlight: r.status === "FLAGGED", tone: r.status === "FLAGGED" ? ("bad" as const) : undefined };
      }),
      note: `Counts only cancellations the bank read back independently, at least 35 days old and within the last 180 days. A merchant is flagged only when the 95% lower bound reaches 2%, so one unlucky customer cannot flag it. ${SYNTHETIC}.`,
    });

    blocks.push({
      kind: "table",
      title: "Price radar: changes other customers already paid",
      columns: ["Merchant", "Your price", "Others now pay", "Customers", "First seen"],
      rows: subs.map((s) => {
        const c = ins.clusters.filter((x) => x.merchantId === s.merchant_id && x.planKey === s.plan_name && x.currency === s.currency).sort((a, b) => b.customers - a.customers)[0];
        if (!c) return { cells: [s.merchant_name, money(s.amount_minor), `No change seen by ${K}+ customers`, "—", "—"] };
        const already = c.newMinor === s.amount_minor;
        return {
          cells: [s.merchant_name, money(s.amount_minor), `${money(c.oldMinor)} → ${money(c.newMinor)}${already ? " (you already pay this)" : ""}`, String(c.customers), fmtDate(c.firstSeenOn)],
          highlight: c.direction === "INCREASE" && c.oldMinor === s.amount_minor,
          tone: c.direction === "INCREASE" && c.oldMinor === s.amount_minor ? ("warn" as const) : undefined,
        };
      }),
      note: `Same plan and currency only; one-off, zero and far-apart charges are ignored. A change seen by fewer than ${K} customers is not shown, so "no change seen" can also mean not enough data. ${SYNTHETIC}.`,
    });

    blocks.push({
      kind: "table",
      title: "Cancellation difficulty",
      columns: ["Merchant", "Grade", "Steps (median)", "Time (median)", "Retention screens", "Asked to call or write", "Completed"],
      rows: subs.map((s) => {
        const d = diff.get(s.merchant_id);
        if (!d || d.status !== "MEASURED") return { cells: [s.merchant_name, NOT_ENOUGH, "—", "—", "—", "—", "—"] };
        return { cells: [s.merchant_name, GRADE[d.grade]!, `${d.medianSteps} (p90 ${d.p90Steps})`, duration(d.medianSeconds), String(d.medianRetentionScreens), pct(d.humanContactBp), pct(d.completionBp)], highlight: d.grade === "HARD", tone: d.grade === "HARD" ? ("bad" as const) : d.grade === "EASY" ? ("good" as const) : undefined };
      }),
      note: `Measured from NextMove's own website cancellation runs on the merchant's current flow, one run per customer. Partner-API cancellations skip the merchant's flow and are not counted. ${SYNTHETIC}.`,
    });

    blocks.push({ kind: "note", tone: "info", text: "These insights describe what other customers saw. They are not a finding about your account and do not change any charge. To stop a renewal, open the subscription's own flow below; nothing is sent from this page." });

    const attention = new Set([...alerts.map((a) => subs.find((s) => s.id === a.subscriptionId)!.merchant_id), ...flagged.map((s) => s.merchant_id), ...hard.map((s) => s.merchant_id)]);
    const links = subs
      .filter((s) => RENEWAL_FLOW[s.merchant_id] && attention.has(s.merchant_id))
      .map((s) => ({ label: `${s.merchant_name}: renewal options (${RENEWAL_FLOW[s.merchant_id]})`, href: `/capabilities/${RENEWAL_FLOW[s.merchant_id]}` }));

    const first = alerts[0] ? subs.find((s) => s.id === alerts[0]!.subscriptionId) : null;
    return {
      ...base,
      headline: first
        ? `Other customers already pay more for ${first.merchant_name}. Your next charge is on ${fmtDate(alerts[0]!.nextChargeAt)}.`
        : flagged.length
          ? `${flagged.map((s) => s.merchant_name).join(", ")} kept billing some customers after they cancelled.`
          : `Nothing unusual across your ${subs.length} subscription merchants.`,
      summary: `Track record, price radar and cancellation difficulty for your subscription merchants, from a ${SYNTHETIC.toLowerCase()}. Read-only.`,
      blocks,
      inputs: [],
      candidates: [],
      numbers: { merchants: subs.length, covered: covered.length, flagged: flagged.length, priceAlerts: alerts.length, hard: hard.length, k: K },
      links,
    };
  },
};

export const merchantInsights: ExtensionModule = {
  key: "merchant-insights",
  capabilities: [E4],
  seed(db, input) {
    if (input.customer !== "alex") return;
    if (one(db, "SELECT 1 FROM ext_mi_cohort_run WHERE tenant_id=? LIMIT 1", input.tenantId)) return;
    seedMerchantInsights(db, input.tenantId);
  },
};
