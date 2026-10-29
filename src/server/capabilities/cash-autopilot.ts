import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all, one, tx } from "../db/connection";
import { repoRoot } from "../config";
import { sha256Hex } from "../canonical";
import { advanceClock, nowIso, nowMs } from "../clock";
import { accountsFor, balanceOf, postCardOrTransfer } from "../bank/ledger";
import { addForecastItem, applyForecastEvent } from "../bank/forecast";
import { HttpError, type Session } from "../auth/session";
import { merchantAdmin } from "../merchant-client";
import { DAY_MS, atLocal, nextPayday, planShield, planVault, project, type Flow, type Outflow } from "../finance/cash-autopilot";
import { internalTransferSpec, planLegs, transferParams, type TransferAccount } from "../execution/internal-transfer";
import { formatDay, formatDayTime, toLocalIso, toMs } from "../../shared/time";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, PROVENANCE, inputOr, money } from "./core";

// O7 Bill vault and O8 Overdraft shield for Alex's personal context. Both read the ledger and the dated forecast,
// run the deterministic calculations in finance/cash-autopilot, and propose INTERNAL_TRANSFER legs between the
// customer's own accounts. Rates, fees and the landlord/clinic are fictional (demo/cash-autopilot.json).

let cfgCache: any = null;
export function autopilotConfig(): any {
  if (!cfgCache) cfgCache = JSON.parse(fs.readFileSync(path.join(repoRoot(), "demo/cash-autopilot.json"), "utf8"));
  return cfgCache;
}

const LIVE = ["APPROVED", "EXECUTING", "CONFIRMED", "PENDING", "UNKNOWN", "NO_CHANGE"];

function accounts(env: { db: DatabaseSync; tenantId: string; contextId: string }) {
  const list = accountsFor(env.db, env.tenantId, env.contextId);
  const cfg = autopilotConfig();
  const current = list.find((a) => a.kind === "CURRENT");
  const savings = list.find((a) => a.kind === "SAVINGS");
  const vaultId = `${env.tenantId}:${cfg.pockets.vault.accountLocal}`;
  const vault = list.find((a) => a.id === vaultId);
  return { current, savings, vault: vault ?? null, vaultId };
}

function latestSalary(db: DatabaseSync, tenantId: string, accountId: string) {
  return one<any>(db, "SELECT * FROM transactions WHERE tenant_id=? AND account_id=? AND category='Income' AND status='POSTED' AND amount_minor > 0 ORDER BY booked_at DESC LIMIT 1", tenantId, accountId);
}

/** The next expected salary after `fromMs`, from the latest posted one and the monthly payday. */
function expectedPayday(db: DatabaseSync, tenantId: string, accountId: string, fromMs: number) {
  const cfg = autopilotConfig().salary;
  const last = latestSalary(db, tenantId, accountId);
  let next = nextPayday(last ? toMs(last.booked_at) : fromMs, cfg.dayOfMonth, cfg.hourLocal);
  while (next <= fromMs) next = nextPayday(next, cfg.dayOfMonth, cfg.hourLocal);
  return next;
}

function scheduled(env: CapEnv) {
  return all<any>(env.db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND status='SCHEDULED' AND dataset != 'bulk' ORDER BY due_at", env.tenantId, env.contextId);
}

function outflows(env: CapEnv): Outflow[] {
  return scheduled(env)
    .filter((f) => f.amount_minor < 0)
    .map((f) => ({ id: f.id, label: f.label, amountMinor: -f.amount_minor, dueAt: f.due_at }));
}

function flows(env: CapEnv): Flow[] {
  return scheduled(env).map((f) => ({ id: f.id, label: f.label, amountMinor: f.amount_minor, at: f.due_at }));
}

function acct(a: { id: string; name: string; balanceMinor: number } | null | undefined, fallback: TransferAccount): TransferAccount {
  return a ? { id: a.id, name: a.name, balanceMinor: a.balanceMinor } : fallback;
}

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, "");
const statusText = (s: string) => ({ APPROVED: "Scheduled", EXECUTING: "Moving", CONFIRMED: "Done", NO_CHANGE: "Nothing to move", REFUSED: "Refused", REVOKED: "Stopped", EXPIRED: "Expired", BLOCKED: "Blocked", UNKNOWN: "Checking", NOT_STARTED: "Not started", OUTDATED: "Needs a fresh check" } as Record<string, string>)[s] ?? s.toLowerCase();

/* ------------------------------------------------------------------------------------------------ O7 */
const O7: CapabilityDef = {
  id: "O7",
  title: "Bill vault",
  short: "Park bill money from payday until each bill is due",
  group: "Bills",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["salary", "payday", "get paid", "got paid", "been paid", "payment schedule", "schedule of payments", "upcoming payments", "rent", "bill vault", "vault", "park", "idle", "interest", "autopilot", "set aside"],
  async analyze(env) {
    const cfg = autopilotConfig();
    const rules = cfg.vaultRules;
    const a = accounts(env);
    if (!a.current) return emptyAnalysis(env, "O7", "Bill vault", "No current account in this context");
    const salary = latestSalary(env.db, env.tenantId, a.current.id);
    const salaryMs = salary ? toMs(salary.booked_at) : null;
    const recent = salaryMs != null && env.nowMs - salaryMs <= 3 * DAY_MS && env.nowMs >= salaryMs;
    const minDaysAway = Math.max(1, Math.min(20, Math.round(Number(inputOr(env, "minDaysAway", rules.minDaysAway)))));
    const keepInDaily = Math.max(0, Number(inputOr(env, "keepInDailyMinor", rules.keepInDailyMinor)));
    const vaultTo = acct(a.vault, { id: a.vaultId, name: cfg.pockets.vault.name, balanceMinor: 0 });
    const inputs: Analysis["inputs"] = [
      { key: "minDaysAway", label: "Only park bills due in at least", type: "number", value: minDaysAway, min: 1, max: 20, suffix: "days", help: "Bills due sooner stay in your Daily account." },
      { key: "keepInDailyMinor", label: "Always keep in Daily", type: "money", value: keepInDaily },
    ];
    const labs: Analysis["labs"] = [{ action: "salary_arrives", label: "Salary arrives", endpoint: "bank" }];

    // A plan already approved for the latest salary is shown until its cycle ends, whatever the date.
    const planId = salary ? `vault-${sha256Hex(`${env.tenantId}:${salary.id}`).slice(0, 10)}` : null;
    const legs = planId ? planLegs(env.db, env.tenantId, planId) : [];
    const live = legs.filter((l) => LIVE.includes(l.status));
    if (planId && salaryMs != null && live.length) return planStatus(env, planId, legs, live, a, inputs, labs, nextPayday(salaryMs, cfg.salary.dayOfMonth, cfg.salary.hourLocal));

    // Waiting for payday: preview what the vault would do with the next salary.
    if (!recent || !salaryMs || !planId) {
      const payMs = expectedPayday(env.db, env.tenantId, a.current.id, env.nowMs);
      const preview = planVault({ nowMs: payMs, nextPaydayMs: nextPayday(payMs, cfg.salary.dayOfMonth, cfg.salary.hourLocal), dailyBalanceMinor: a.current.balanceMinor + cfg.salary.amountMinor, keepInDailyMinor: keepInDaily, minDaysAway, annualRatePct: cfg.pockets.vault.annualRatePct, returnHourLocal: rules.returnHourLocal, outflows: outflows(env), toIso: toLocalIso });
      return {
        capability: "O7",
        title: "Bill vault",
        contextId: env.contextId,
        headline: preview.parkMinor > 0 ? `Next salary ${formatDay(payMs)}: ${money(preview.parkMinor)} of bills can wait in the vault` : `Next salary ${formatDay(payMs)}: no bills far enough away to park`,
        summary: "When your salary lands, NextMove sets aside the bills due before the next payday and brings each amount back one business day before it is due.",
        evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
        blocks: [
          { kind: "metrics", items: [{ label: "Expected salary", value: money(cfg.salary.amountMinor), sub: `${formatDay(payMs)}, from your payroll history` }, { label: "Would park", value: money(preview.parkMinor), sub: `${preview.returns.length} return${preview.returns.length === 1 ? "" : "s"} before the bills` }] },
          billsTable(preview, "Bills after the next salary"),
          rulesBlock(minDaysAway, keepInDaily),
          { kind: "note", tone: "info", text: "Nothing moves until your salary arrives and you approve the plan. In Labs, use “Salary arrives” to jump the demo clock to payday." },
        ],
        inputs,
        candidates: [],
        numbers: { previewParkMinor: preview.parkMinor, previewInterestMinor: preview.interestMinor, dailyMinor: a.current.balanceMinor },
        labs,
      };
    }

    const nextPayMs = nextPayday(salaryMs, cfg.salary.dayOfMonth, cfg.salary.hourLocal);
    const plan = planVault({ nowMs: env.nowMs, nextPaydayMs: nextPayMs, dailyBalanceMinor: a.current.balanceMinor, keepInDailyMinor: keepInDaily, minDaysAway, annualRatePct: cfg.pockets.vault.annualRatePct, returnHourLocal: rules.returnHourLocal, outflows: outflows(env), toIso: toLocalIso });
    const subjectRef = `${env.tenantId}:autopilot:${planId}`;
    const daily = acct(a.current, a.current as any);
    const returnLegs = plan.returns.map((r) => ({ ...r, legId: `${planId}:ret:${ymd(r.returnAt)}`, label: r.labels.join(", ") }));
    const candidates: Candidate[] = plan.parkMinor > 0
      ? [
          {
            key: "park",
            defaultSelected: true,
            available: true,
            spec: internalTransferSpec({
              capability: "O7",
              subjectRef,
              from: daily,
              to: vaultTo,
              params: {
                amountMinor: plan.parkMinor, mode: "EXACT", executeAt: null, returnEarlyBelowMinor: null, purpose: "VAULT_PARK", description: "Bill vault: set aside for bills before the next payday", planId, legId: `${planId}:park`,
                openPocket: a.vault ? null : { name: cfg.pockets.vault.name, kind: cfg.pockets.vault.kind },
                returnSchedule: returnLegs.map((r) => ({ legId: r.legId, returnAt: r.returnAt, amountMinor: r.amountMinor, label: r.label })),
              },
              title: `Park ${money(plan.parkMinor)} in the Bill vault`,
              summary: `For ${plan.bills.filter((b) => b.status === "PARK").length} bills due ${formatDay(plan.bills.find((b) => b.status === "PARK")!.dueAt)}–${formatDay([...plan.bills].reverse().find((b) => b.status === "PARK")!.dueAt)}. Comes back in ${returnLegs.length} scheduled return${returnLegs.length === 1 ? "" : "s"}.`,
              extraLines: [
                { label: "Estimated interest", value: `${money(plan.interestMinor)} (${cfg.pockets.vault.rateLabel})` },
                { label: "Kept in Daily", value: `${money(a.current.balanceMinor - plan.parkMinor)}, including ${money(plan.keptForSoonMinor)} for bills due before ${formatDay(plan.soonCutoffAt)}` },
              ],
              note: "Only moves together with its scheduled returns. Both accounts are yours; total funds do not change.",
            }),
          },
          ...returnLegs.map((r, i): Candidate => ({
            key: `return-${i + 1}`,
            defaultSelected: true,
            available: true,
            spec: internalTransferSpec({
              capability: "O7",
              subjectRef,
              from: vaultTo,
              to: daily,
              params: {
                amountMinor: r.amountMinor, mode: "UP_TO", executeAt: r.returnAt, returnEarlyBelowMinor: 0, purpose: "VAULT_RETURN", description: `Bill vault: back for ${r.label}`, planId, legId: r.legId, openPocket: null,
                covers: plan.bills.filter((b) => r.billIds.includes(b.id)).map((b) => ({ label: b.label, amountMinor: b.amountMinor, dueAt: b.dueAt })),
              },
              title: `Bring ${money(r.amountMinor)} back on ${formatDay(r.returnAt)}`,
              summary: `One business day before ${r.label}.`,
              extraLines: [{ label: "Early return", value: "Runs at once if Daily goes below 0 RON" }],
              note: "Scheduled return from your own pocket. If the vault holds less, it returns what is there and never more than approved.",
              dependsOn: ["park"],
            }),
          })),
        ]
      : [];
    return {
      capability: "O7",
      title: "Bill vault",
      contextId: env.contextId,
      headline: plan.parkMinor > 0 ? `Salary landed. ${money(plan.parkMinor)} can wait in the vault until the bills are due` : "Salary landed. No bills far enough away to park",
      summary: `Bills due ${minDaysAway}+ days from now and before your next salary on ${formatDay(nextPayMs)}. Each amount comes back one business day before its bill.`,
      evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Park now", value: money(plan.parkMinor), sub: `Daily keeps ${money(a.current.balanceMinor - plan.parkMinor)}` }, { label: "Estimated interest", value: money(plan.interestMinor), sub: `${cfg.pockets.vault.annualRatePct.toFixed(2)}% a year, fictional` }] },
        billsTable(plan, "Bills before your next salary"),
        { kind: "timeline", title: "Scheduled returns", items: returnLegs.map((r) => ({ at: r.returnAt, label: `Back to Daily for ${r.label}`, amount: money(r.amountMinor, { sign: true }) })) },
        rulesBlock(minDaysAway, keepInDaily),
        { kind: "note", tone: "info", text: `The interest is small: about ${money(plan.interestMinor)} this month at a fictional rate. The main gain is that bill money is set aside and cannot be spent by mistake.` },
      ],
      inputs,
      candidates,
      numbers: { parkMinor: plan.parkMinor, interestMinor: plan.interestMinor, returns: plan.returns.length, dailyMinor: a.current.balanceMinor, keptForSoonMinor: plan.keptForSoonMinor },
      labs,
    };
  },
};

function rulesBlock(minDaysAway: number, keepInDaily: number): Block {
  return {
    kind: "conditions",
    title: "Rules the vault follows",
    items: [
      { label: "Never park money needed sooner", state: "met", detail: `Bills due in under ${minDaysAway} days and ${money(keepInDaily)} stay in Daily` },
      { label: "Returns early if Daily needs it", state: "met", detail: "If Daily goes below 0 RON, each return runs at once" },
      { label: "Re-plans if a bill changes", state: "met", detail: "A changed amount shows here with a new proposal; returns never exceed what you approved" },
    ],
  };
}

function billsTable(plan: ReturnType<typeof planVault>, title: string): Block {
  const why: Record<string, string> = { PARK: "Park", TOO_SOON: "Stays", AFTER_PAYDAY: "Next cycle", NO_ROOM: "Stays" };
  return {
    kind: "table",
    title,
    columns: ["Bill", "Due", "Amount", "Back"],
    rows: plan.bills.map((b) => ({ cells: [b.label, formatDay(b.dueAt), money(b.amountMinor), b.status === "PARK" && b.returnAt ? formatDay(b.returnAt) : why[b.status]], highlight: b.status === "PARK" })),
    note: plan.bills.length ? "Back: the day the money returns to Daily. Stays: due too soon or no room, paid from Daily as usual." : "No scheduled bills found.",
  };
}

function planStatus(env: CapEnv, planId: string, legs: any[], live: any[], a: ReturnType<typeof accounts>, inputs: Analysis["inputs"], labs: Analysis["labs"], nextPayMs: number): Analysis {
  const cfg = autopilotConfig();
  const park = live.find((l) => transferParams(l.spec).purpose === "VAULT_PARK");
  const returns = live.filter((l) => transferParams(l.spec).purpose === "VAULT_RETURN").sort((x, y) => toMs(transferParams(x.spec).executeAt!) - toMs(transferParams(y.spec).executeAt!));
  const vaultBal = a.vault ? balanceOf(env.db, a.vault.id) : 0;
  const pending = returns.filter((r) => ["APPROVED", "EXECUTING", "UNKNOWN"].includes(r.status));
  const parkReceipt = park ? one<any>(env.db, "SELECT id, issuer_reference FROM receipts WHERE action_id=?", park.id) : null;

  // Re-plan check: the bills each pending return covers, against the current forecast.
  const current = outflows(env);
  const changes: { label: string; before: number; now: number; returnAt: string }[] = [];
  for (const r of pending) {
    for (const c of transferParams(r.spec).covers ?? []) {
      const match = current.find((o) => o.label === c.label && o.dueAt.slice(0, 10) === c.dueAt.slice(0, 10));
      if (match && match.amountMinor !== c.amountMinor) changes.push({ label: c.label, before: c.amountMinor, now: match.amountMinor, returnAt: transferParams(r.spec).executeAt! });
    }
  }
  const candidates: Candidate[] = [];
  const daily = acct(a.current, a.current as any);
  const vault = acct(a.vault, { id: a.vaultId, name: cfg.pockets.vault.name, balanceMinor: 0 });
  const subjectRef = `${env.tenantId}:autopilot:${planId}`;
  const extra = changes.reduce((s, c) => s + (c.now - c.before), 0);
  if (changes.length && extra > 0 && a.current) {
    const first = changes[0];
    const legId = `${planId}:extra:${sha256Hex(JSON.stringify(changes)).slice(0, 8)}`;
    const retLeg = `${legId}:ret`;
    candidates.push(
      {
        key: "park-extra",
        defaultSelected: true,
        available: a.current.balanceMinor >= extra,
        unavailableReason: a.current.balanceMinor >= extra ? undefined : "Not enough in Daily",
        spec: internalTransferSpec({ capability: "O7", subjectRef, from: daily, to: vault, params: { amountMinor: extra, mode: "EXACT", executeAt: null, returnEarlyBelowMinor: null, purpose: "VAULT_PARK", description: "Bill vault: extra for a changed bill", planId, legId, openPocket: null, returnSchedule: [{ legId: retLeg, returnAt: first.returnAt, amountMinor: extra, label: first.label }] }, title: `Park the extra ${money(extra)}`, summary: `${first.label} went from ${money(first.before)} to ${money(first.now)}.` }),
      },
      {
        key: "return-extra",
        defaultSelected: true,
        available: true,
        spec: internalTransferSpec({ capability: "O7", subjectRef, from: vault, to: daily, params: { amountMinor: extra, mode: "UP_TO", executeAt: first.returnAt, returnEarlyBelowMinor: 0, purpose: "VAULT_RETURN", description: `Bill vault: back for ${first.label} (changed)`, planId, legId: retLeg, openPocket: null, covers: [] }, title: `Bring ${money(extra)} back on ${formatDay(first.returnAt)}`, summary: `With the rest of the ${first.label} money.`, dependsOn: ["park-extra"] }),
      },
    );
  }
  if (pending.length && vaultBal > 0 && a.current) {
    candidates.push({
      key: "return-all",
      defaultSelected: false,
      available: true,
      spec: internalTransferSpec({ capability: "O7", subjectRef, from: vault, to: daily, params: { amountMinor: vaultBal, mode: "UP_TO", executeAt: null, returnEarlyBelowMinor: null, purpose: "VAULT_RETURN_ALL", description: "Bill vault: everything back now", planId, legId: `${planId}:all:${vaultBal}`, openPocket: null }, title: `Bring all ${money(vaultBal)} back now`, summary: "Empties the vault into Daily. Scheduled returns then find nothing left to move." }),
    });
  }
  const done = returns.length > 0 && returns.every((r) => ["CONFIRMED", "NO_CHANGE"].includes(r.status));
  const nextRet = pending[0];
  return {
    capability: "O7",
    title: "Bill vault",
    contextId: env.contextId,
    headline: done ? "All bill money is back in Daily before the bills" : nextRet ? `${money(vaultBal)} in the vault. Next return ${formatDayTime(transferParams(nextRet.spec).executeAt!)}` : park?.status === "CONFIRMED" ? `${money(vaultBal)} in the vault` : "Bill vault plan approved",
    summary: `Plan for this salary, until the next payday on ${formatDay(nextPayMs)}. Returns run on the demo clock; each one is its own approved action with a receipt.`,
    evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
    blocks: [
      { kind: "metrics", items: [{ label: "In the vault", value: money(vaultBal), sub: cfg.pockets.vault.rateLabel }, { label: "Daily", value: money(a.current?.balanceMinor ?? 0), sub: `${pending.length} return${pending.length === 1 ? "" : "s"} to come` }] },
      ...(park ? [{ kind: "status" as const, title: `Parked ${money(transferParams(park.spec).amountMinor)}`, state: park.status, detail: parkReceipt ? `${statusText(park.status)}, ref ${parkReceipt.issuer_reference}` : statusText(park.status), href: parkReceipt ? `/receipts/${parkReceipt.id}` : `/actions/${park.id}` }] : []),
      {
        kind: "timeline",
        title: "Returns",
        items: returns.map((r) => {
          const rec = one<any>(env.db, "SELECT result_json FROM proposal_actions WHERE id=?", r.id);
          const res = rec?.result_json ? JSON.parse(rec.result_json) : null;
          const early = res?.details?.early ? " (early)" : "";
          return { at: transferParams(r.spec).executeAt!, label: `${r.spec.display.summary.replace(/^One business day before /, "For ").replace(/\.$/, "")}${early}`, amount: money(res?.details?.amountMinor ?? transferParams(r.spec).amountMinor, { sign: true }), state: statusText(r.status) };
        }),
      },
      ...changes.map((c): Block => ({ kind: "note", tone: "warn", text: `${c.label} changed from ${money(c.before)} to ${money(c.now)}. The return on ${formatDay(c.returnAt)} brings back ${money(c.before)} as approved; ${c.now > c.before ? `approve parking the extra ${money(c.now - c.before)}, or it is paid from Daily as usual` : `the extra ${money(c.before - c.now)} stays in Daily when it returns`}.` })),
      ...(legs.some((l) => ["REVOKED", "EXPIRED", "REFUSED", "BLOCKED"].includes(l.status)) ? [{ kind: "note" as const, tone: "warn" as const, text: "Some steps did not run. Money already in the vault stays yours: use “Bring all back now” to move it to Daily." }] : []),
    ],
    inputs: [],
    candidates,
    numbers: { vaultMinor: vaultBal, pendingReturns: pending.length, changedBills: changes.length, dailyMinor: a.current?.balanceMinor ?? 0 },
    done: done ? { label: "Bill vault cycle finished" } : null,
    labs: [...(pending.length ? [{ action: "next_return", label: "Move clock to the next return", endpoint: "bank" as const }] : []), ...(pending.length ? [{ action: "rent_up", label: "Rent goes up by 100 RON", endpoint: "bank" as const }] : []), ...(pending.length ? [] : labs ?? [])],
  };
}

/* ------------------------------------------------------------------------------------------------ O8 */
const O8: CapabilityDef = {
  id: "O8",
  title: "Overdraft shield",
  short: "Top up from a pocket before a bill takes Daily below zero",
  group: "Bills",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["overdraft", "below zero", "negative", "unexpected bill", "shield", "top up", "short", "not enough", "descoperit"],
  async analyze(env) {
    const cfg = autopilotConfig();
    const a = accounts(env);
    if (!a.current) return emptyAnalysis(env, "O8", "Overdraft shield", "No current account in this context");
    const home = one<any>(env.db, "SELECT inputs_json FROM goals WHERE tenant_id=? AND context_id=? AND kind='HOME'", env.tenantId, env.contextId);
    const homeReserve = home ? Number(JSON.parse(home.inputs_json).protectedReserveMinor ?? 0) : 0;
    const floor = Math.max(0, Number(inputOr(env, "dailyFloorMinor", 0)));
    const keepSavings = Math.max(0, Number(inputOr(env, "savingsKeepMinor", homeReserve)));
    const horizon = expectedPayday(env.db, env.tenantId, a.current.id, env.nowMs);
    const vaultEarmarked = scheduled(env).some((f) => f.dataset === "autopilot" && f.amount_minor > 0);
    const sources = [
      ...(a.savings ? [{ accountId: a.savings.id, name: a.savings.name, balanceMinor: a.savings.balanceMinor, keepMinor: keepSavings, annualRatePct: cfg.pockets.savings.annualRatePct, withdrawalFeeMinor: cfg.pockets.savings.withdrawalFeeMinor }] : []),
      ...(a.vault ? [{ accountId: a.vault.id, name: a.vault.name, balanceMinor: a.vault.balanceMinor, keepMinor: 0, annualRatePct: cfg.pockets.vault.annualRatePct, withdrawalFeeMinor: cfg.pockets.vault.withdrawalFeeMinor, excludedReason: vaultEarmarked ? "Reserved for your scheduled bills" : null }] : []),
    ];
    const f = flows(env);
    const plan = planShield({ balanceMinor: a.current.balanceMinor, floorMinor: floor, nowMs: env.nowMs, horizonMs: horizon, flows: f, sources, overdraft: cfg.overdraft });
    const pr = project(a.current.balanceMinor, env.nowMs, horizon, f, floor);
    const inputs: Analysis["inputs"] = [
      { key: "dailyFloorMinor", label: "Keep Daily at least at", type: "money", value: floor, help: "0 RON means: never overdrawn." },
      { key: "savingsKeepMinor", label: "Keep in Savings at least", type: "money", value: keepSavings, help: homeReserve ? `Your home plan protects ${money(homeReserve)}.` : undefined },
    ];
    const labs: Analysis["labs"] = [{ action: "unexpected_bill", label: "Unexpected bill arrives", endpoint: "bank" }];
    const last = one<any>(env.db, "SELECT r.id, r.issuer_reference, r.verified_at, pa.spec_json FROM receipts r JOIN proposal_actions pa ON pa.id=r.action_id WHERE r.tenant_id=? AND r.context_id=? AND pa.operation='INTERNAL_TRANSFER' AND pa.subject_ref LIKE ? ORDER BY r.verified_at DESC LIMIT 1", env.tenantId, env.contextId, `${env.tenantId}:autopilot:shield%`);
    const lastBlock: Block[] = last ? [{ kind: "status", title: `Last top-up: ${money(JSON.parse(last.spec_json).params.amountMinor)}`, state: "CONFIRMED", detail: `Done, ref ${last.issuer_reference}`, href: `/receipts/${last.id}` }] : [];
    const timeline: Block = { kind: "timeline", title: `Daily until your salary on ${formatDay(horizon)}`, items: pr.points.map((p) => ({ at: p.at, label: p.label, amount: money(p.amountMinor, { sign: true }), state: `Daily ${money(p.balanceMinor)}${p.balanceMinor < floor ? ", below your floor" : ""}` })) };

    if (plan.needMinor === 0) {
      return {
        capability: "O8",
        title: "Overdraft shield",
        contextId: env.contextId,
        headline: `Daily stays above ${money(floor)} until your salary on ${formatDay(horizon)}`,
        summary: "NextMove checks every dated bill and scheduled transfer before your next salary.",
        evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
        blocks: [{ kind: "metrics", items: [{ label: "Daily now", value: money(a.current.balanceMinor) }, { label: "Lowest before salary", value: money(plan.lowestMinor), sub: plan.lowestAt ? formatDay(plan.lowestAt) : "No bills" }] }, ...lastBlock, timeline],
        inputs,
        candidates: [],
        numbers: { lowestMinor: plan.lowestMinor, needMinor: 0, dailyMinor: a.current.balanceMinor },
        labs,
      };
    }

    const trigger = plan.trigger!;
    const subjectRef = `${env.tenantId}:autopilot:shield:${trigger.id}`;
    const daily = acct(a.current, a.current as any);
    const legKey = sha256Hex(`${trigger.id}:${plan.needMinor}:${a.current.balanceMinor}`).slice(0, 10);
    const candidates: Candidate[] = plan.legs.map((l, i) => {
      const src = sources.find((s) => s.accountId === l.accountId)!;
      return {
        key: `top-up-${i + 1}`,
        defaultSelected: true,
        available: true,
        spec: internalTransferSpec({
          capability: "O8",
          subjectRef,
          from: { id: src.accountId, name: src.name, balanceMinor: src.balanceMinor },
          to: daily,
          params: { amountMinor: l.amountMinor, mode: "EXACT", executeAt: null, returnEarlyBelowMinor: null, purpose: "SHIELD_TOP_UP", description: `Overdraft shield: before ${trigger.label}`, planId: null, legId: `shield:${legKey}:${i + 1}`, openPocket: null },
          title: `Move ${money(l.amountMinor)} from ${src.name} to Daily`,
          summary: plan.shortfallMinor > 0 ? `Covers ${money(plan.coveredMinor)} of the ${money(plan.needMinor)} needed before ${trigger.label}.` : `Exactly what Daily needs before ${trigger.label} on ${formatDay(trigger.at)}.`,
          extraLines: [
            { label: "Overdraft cost avoided", value: `${money(plan.overdraftWithoutMinor.costMinor - plan.overdraftAfterMinor.costMinor)} (fictional terms)` },
            { label: "Interest you give up", value: `${money(l.forgoneInterestMinor)} until ${formatDay(horizon)}` },
            { label: `${src.name} keeps`, value: money(src.balanceMinor - l.amountMinor) },
          ],
        }),
      };
    });
    const shortNote: Block[] =
      plan.shortfallMinor > 0
        ? [{ kind: "note", tone: "warn", text: `Your pockets cover ${money(plan.coveredMinor)} of ${money(plan.needMinor)}. Daily is still ${money(plan.shortfallMinor)} short on ${formatDay(trigger.at)}, with about ${money(plan.overdraftAfterMinor.costMinor)} of fictional overdraft cost. Options: lower what you keep in Savings, ask ${trigger.label.split(" ")[0]} for a later date, or add money from outside NextMove.` }]
        : [];
    return {
      capability: "O8",
      title: "Overdraft shield",
      contextId: env.contextId,
      headline: plan.legs.length === 0 ? `${trigger.label} takes Daily to ${money(plan.lowestMinor)} and no pocket can cover it` : plan.shortfallMinor > 0 ? `${trigger.label} takes Daily to ${money(plan.lowestMinor)}. A partial top-up of ${money(plan.coveredMinor)} is possible` : `${trigger.label} would take Daily to ${money(plan.lowestMinor)}. Move ${money(plan.needMinor)} first`,
      summary: `Lowest point before your salary on ${formatDay(horizon)}. The top-up comes from the pocket that costs least to use.`,
      evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Top-up needed", value: money(plan.needMinor), sub: `to stay at ${money(floor)} or more`, tone: "bad" }, { label: "Overdraft cost avoided", value: money(plan.overdraftWithoutMinor.costMinor - plan.overdraftAfterMinor.costMinor), sub: "fictional fee and interest", tone: "good" }] },
        ...shortNote,
        {
          kind: "table",
          title: "Where the money comes from",
          columns: ["Pocket, rate", "Can use", "Uses"],
          rows: plan.sources.map((s) => ({ cells: [`${s.name}, ${s.annualRatePct.toFixed(2)}%`, s.excludedReason ? "Reserved for bills" : money(s.availableMinor), s.usedMinor ? money(s.usedMinor) : "—"], highlight: s.usedMinor > 0 })),
          note: `Cheapest first: the lowest fictional rate you give up, then fees. ${cfg.overdraft.label}.`,
        },
        { kind: "table", title: "Compared", columns: ["", "Overdraft cost", "Interest given up"], rows: [{ cells: ["Do nothing", money(plan.overdraftWithoutMinor.costMinor), "—"], tone: "bad" }, { cells: [`Top up ${money(plan.coveredMinor)}`, money(plan.overdraftAfterMinor.costMinor), money(plan.legs.reduce((s, l) => s + l.forgoneInterestMinor, 0))], highlight: true }] },
        ...lastBlock,
        timeline,
        { kind: "facts", title: "What triggered this", items: [{ label: trigger.label, value: `${money(-trigger.amountMinor)} due ${formatDay(trigger.at)}`, provenance: PROVENANCE.BANK }, { label: "Next income", value: `Salary ${formatDay(horizon)}`, provenance: PROVENANCE.CALCULATED }] },
      ],
      inputs,
      candidates,
      numbers: { lowestMinor: plan.lowestMinor, needMinor: plan.needMinor, coveredMinor: plan.coveredMinor, shortfallMinor: plan.shortfallMinor, overdraftAvoidedMinor: plan.overdraftWithoutMinor.costMinor - plan.overdraftAfterMinor.costMinor, dailyMinor: a.current.balanceMinor },
      labs,
    };
  },
};

function emptyAnalysis(env: CapEnv, id: string, title: string, why: string): Analysis {
  return { capability: id, title, contextId: env.contextId, headline: why, summary: "", evidence: ["BANK_RECORD"], blocks: [], inputs: [], candidates: [], numbers: {} };
}

export const CASH_AUTOPILOT_CAPS = [O7, O8];

/* ------------------------------------------------------------------------------------------------ Labs */

export const AUTOPILOT_LABS = new Set(["salary_arrives", "unexpected_bill", "next_return", "rent_up"]);

async function moveClockTo(db: DatabaseSync, tenantId: string, targetMs: number) {
  const delta = targetMs - nowMs(db, tenantId);
  if (delta > 0) {
    const next = advanceClock(db, tenantId, delta);
    await merchantAdmin.setClock(tenantId, next);
  }
}

/** Bank-side Labs events for the cash autopilot. They simulate the outside world, never a customer approval. */
export async function runAutopilotLabs(db: DatabaseSync, s: Session, action: string): Promise<Record<string, unknown>> {
  const cfg = autopilotConfig();
  const a = accounts({ db, tenantId: s.tenantId, contextId: s.contextId });
  if (!a.current || s.contextKind !== "PERSONAL") throw new HttpError(409, "WRONG_CONTEXT", "Switch to a personal context with a current account");
  const t = s.tenantId;
  if (action === "salary_arrives") {
    const payMs = expectedPayday(db, t, a.current.id, nowMs(db, t) - 3 * DAY_MS);
    await moveClockTo(db, t, payMs);
    const at = toLocalIso(payMs);
    const r = tx(db, () => postCardOrTransfer(db, { tenantId: t, contextId: s.contextId, accountId: a.current!.id, sourceEventId: `labs:salary:${t}:${at.slice(0, 10)}`, amountMinor: cfg.salary.amountMinor, merchantName: cfg.salary.merchant, category: "Income", reference: `PAY-${at.slice(0, 7)}`, bookedAt: at, note: "Labs: simulated salary credit" }));
    return { demoNow: nowIso(db, t), salaryAt: at, amountMinor: cfg.salary.amountMinor, duplicate: r.duplicate };
  }
  if (action === "unexpected_bill") {
    const b = cfg.unexpectedBill;
    const now = nowMs(db, t);
    const day = new Date(now + b.dueInDays * DAY_MS);
    const parts = toLocalIso(day.getTime()).slice(0, 10).split("-").map(Number);
    const dueAt = toLocalIso(atLocal(parts[0], parts[1], parts[2], b.hourLocal));
    const source = `labs:bill:${t}:${dueAt.slice(0, 10)}`;
    const existing = one<any>(db, "SELECT id FROM forecast_items WHERE tenant_id=? AND source=?", t, source);
    if (!existing) addForecastItem(db, { tenantId: t, contextId: s.contextId, dataset: "bills", kind: "BILL", label: b.label, amountMinor: -b.amountMinor, dueAt, source, data: { payee: b.payee, labs: true } });
    return { dueAt, amountMinor: b.amountMinor, duplicate: Boolean(existing) };
  }
  if (action === "next_return") {
    const now = nowMs(db, t);
    const next = all<any>(db, "SELECT spec_json FROM proposal_actions WHERE tenant_id=? AND context_id=? AND operation='INTERNAL_TRANSFER' AND status='APPROVED'", t, s.contextId)
      .map((r) => JSON.parse(r.spec_json).params?.executeAt as string | null)
      .filter((x): x is string => Boolean(x) && toMs(x!) > now)
      .sort((x, y) => toMs(x) - toMs(y))[0];
    if (!next) throw new HttpError(409, "NOTHING_SCHEDULED", "No scheduled return is waiting");
    await moveClockTo(db, t, toMs(next) + 60_000);
    return { demoNow: nowIso(db, t), returnAt: next };
  }
  if (action === "rent_up") {
    const r = cfg.rent;
    const item = one<any>(db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND label=? AND status='SCHEDULED' ORDER BY due_at LIMIT 1", t, s.contextId, r.label);
    if (!item) throw new HttpError(409, "NOTHING_TO_CHANGE", "No scheduled rent to change");
    tx(db, () => applyForecastEvent(db, { sourceEventId: `labs:rent_up:${item.id}`, tenantId: t, kind: "CHANGE", itemId: item.id, changes: { amountMinor: item.amount_minor - 10000 }, reason: "Labs: the landlord raised the rent" }));
    return { label: r.label, amountMinor: -item.amount_minor + 10000 };
  }
  throw new HttpError(400, "BAD_ACTION", "Unknown Labs action");
}
