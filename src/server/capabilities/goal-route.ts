import { json, one } from "../db/connection";
import { addLocalMonths } from "../../shared/time";
import { config } from "../config";
import { accountsFor } from "../bank/ledger";
import { featureAllowed, featureForRoute } from "../authority/features";
import { afterHomeBudget } from "../finance/goals";
import {
  ROADBLOCKS,
  evaluateRoute,
  incomeDropMinor,
  roadblock,
  roadblocksFromText,
  type Reroute,
  type RoadblockId,
  type RouteInputs,
  type Saving,
  type Simulation,
} from "../finance/route";
import { formatMoney } from "../../shared/money";
import { ALEX_SUBSCRIPTION_CAPS } from "./alex-subscriptions";
import type { Analysis, Block, CapEnv, CapabilityDef, Candidate } from "./core";

// O6 "Route to your home": a live route from today's funds to Alex's home goal (the same inputs as O1), with
// Labs roadblocks and deterministic reroutes. Savings come only from candidates other capabilities computed;
// installments are a fictional, labelled plan; nothing here moves money.

export const ROUTE_PREF_KEY = "o6_roadblocks";
export const ROUTE_HREF = "/goals/home-route";
const SAVING_SOURCES = ["T2", "A6", "A1", "A2"];
const SAVING_OPS = new Set(["STOP_RENEWAL", "PAUSE", "CHANGE_PLAN"]);

const whole = (minor: number | null | undefined) => (minor == null ? "—" : formatMoney(Math.round(minor / 100) * 100, "RON", { whole: true }));

function monthDate(nowMs: number, n: number) {
  return new Date(addLocalMonths(nowMs, n));
}
const fmtMonth = (nowMs: number, n: number | null, style: "long" | "short" = "long") =>
  n == null ? "Not within 5 years" : new Intl.DateTimeFormat("en-GB", { month: style, year: style === "long" ? "numeric" : undefined, timeZone: "Europe/Bucharest" }).format(monthDate(nowMs, n));

export function storedRoadblocks(env: Pick<CapEnv, "db" | "tenantId" | "contextId">): RoadblockId[] {
  const p = one<any>(env.db, "SELECT value_json FROM preferences WHERE tenant_id=? AND context_id=? AND key=?", env.tenantId, env.contextId, ROUTE_PREF_KEY);
  const ids = json<string[]>(p?.value_json, []);
  return ROADBLOCKS.map((r) => r.id).filter((id) => ids.includes(id));
}

/** Roadblocks for this run: an explicit input (agent what-if, not saved) wins over the Labs roadblocks stored for the demo customer. */
function activeRoadblocks(env: CapEnv): { ids: RoadblockId[]; whatIf: boolean } {
  const given = Object.entries(env.inputs).filter(([k]) => /roadblock|event|surprise|what_?if/i.test(k)).map(([, v]) => String(v ?? ""));
  if (given.length) return { ids: roadblocksFromText(given.join(",")), whatIf: true };
  return { ids: storedRoadblocks(env), whatIf: false };
}

function routeInputs(env: CapEnv) {
  const g = one<any>(env.db, "SELECT * FROM goals WHERE id=? AND tenant_id=?", `${env.tenantId}:goal:home`, env.tenantId);
  if (!g) return null;
  const i = json<any>(g.inputs_json, {});
  if (i.transactionCostsMinor == null) return null;
  const liquid = accountsFor(env.db, env.tenantId, env.contextId).reduce((s, a) => s + a.balanceMinor, 0);
  const input: RouteInputs = {
    startMinor: liquid,
    targetMinor: Number(i.downPaymentMinor) + Number(i.transactionCostsMinor) + Number(i.protectedReserveMinor),
    reserveMinor: Number(i.protectedReserveMinor),
    contributionMinor: Number(i.monthlyContributionMinor),
    incomeMinor: Number(i.afterHome?.incomeMinor ?? 0),
    afterHomeMonthlyMinor: afterHomeBudget(i.afterHome).monthlyMinor,
  };
  return { goal: g, input, afterHome: afterHomeBudget(i.afterHome) };
}

/** Charges other capabilities can stop, as they computed them (next-30-day forecast only), with their candidates. */
async function findSavings(env: CapEnv): Promise<{ savings: Saving[]; candidates: Candidate[] }> {
  const best = new Map<string, { saving: Saving; candidate: Candidate }>();
  for (const id of SAVING_SOURCES) {
    const def = ALEX_SUBSCRIPTION_CAPS.find((c) => c.id === id);
    if (!def) continue;
    let a: Analysis;
    try {
      a = await def.analyze({ ...env, inputs: {} });
    } catch {
      continue;
    }
    for (const c of a.candidates) {
      const s = c.spec;
      const back = -s.money.forecastChangeMinor;
      if (!c.available || !SAVING_OPS.has(s.operation) || s.dependsOn.length || back <= 0 || s.money.immediateDebitMinor || s.money.feesMinor) continue;
      if (!featureAllowed(featureForRoute(s.route))) continue;
      const key = `${id}:${c.key}`;
      const prev = s.subjectRef ? best.get(s.subjectRef) : undefined;
      if (prev && prev.saving.amountMinor >= back) continue;
      best.set(s.subjectRef ?? key, {
        saving: { key, capability: id, label: s.display.title, amountMinor: back, month: 1 },
        candidate: { ...c, key, defaultSelected: false },
      });
    }
  }
  const list = [...best.values()];
  return { savings: list.map((x) => x.saving), candidates: list.map((x) => x.candidate) };
}

/** "2,700 RON in Nov, 3,600 RON in Dec" or "2,550 RON in Nov, then 5,850 RON a month" (a repeated tail runs to arrival). */
function scheduleText(nowMs: number, schedule: { month: number; transferMinor: number }[], last: number) {
  let tail = schedule.length;
  while (tail > 1 && schedule[tail - 2].transferMinor === schedule[schedule.length - 1].transferMinor) tail--;
  const ongoing = schedule.length >= last && schedule.length - tail + 1 >= 2;
  const head = (ongoing ? schedule.slice(0, tail - 1) : schedule).map((s) => `${whole(s.transferMinor)} in ${fmtMonth(nowMs, s.month, "short")}`);
  if (!ongoing) return head.join(", ");
  const t = schedule[tail - 1];
  const rest = `${whole(t.transferMinor)} a month${head.length ? "" : ` from ${fmtMonth(nowMs, t.month, "short")}`}`;
  return head.length ? `${head.join(", ")}, then ${rest}` : rest;
}

const ROADBLOCK_NOUN: Record<string, string> = { dental: "the dental bill", rent: "the rent rise", tool: "the forgotten tool", income: "the income drop" };

export interface RouteView {
  goalName: string;
  labs: boolean;
  whatIf: boolean;
  targetMinor: number;
  reserveMinor: number;
  startMinor: number;
  contributionMinor: number;
  roadblocks: { id: string; label: string; detail: string; active: boolean }[];
  months: { month: number; label: string; short: string }[];
  original: { arrival: string; arrivalMonth: number | null; spareMinor: number | null; points: number[] };
  current: { arrival: string; arrivalMonth: number | null; spareMinor: number | null; delayMonths: number; hitMinor: number; points: number[] };
  reroutes: {
    id: string;
    title: string;
    summary: string;
    verdict: Reroute["verdict"];
    reason: string | null;
    action: Reroute["action"];
    arrival: string;
    arrivalMonth: number | null;
    delayMonths: number | null;
    impact: string;
    reserve: string;
    spareMinor: number | null;
    fictional: boolean;
    sources: { capability: string; label: string; amountMinor: number }[];
    points: number[];
  }[];
  recommended: string | null;
  choice: { route: string; label: string; at: string; proposalId: string | null } | null;
}

const points = (s: Simulation | null) => (s ? s.checkpoints.map((c) => c.positionMinor) : []);

export async function computeRoute(env: CapEnv) {
  const base = routeInputs(env);
  if (!base) return null;
  const { input } = base;
  const { ids, whatIf } = activeRoadblocks(env);
  const { savings, candidates } = await findSavings(env);
  const e = evaluateRoute(input, ids, savings);
  const orig = e.original;
  const cur = e.recalculated;
  const delay = cur.arrivalMonth != null && orig.arrivalMonth != null ? cur.arrivalMonth - orig.arrivalMonth : 0;
  const last = Math.max(orig.arrivalMonth ?? 0, ...e.reroutes.map((r) => r.arrivalMonth ?? 0), cur.arrivalMonth ?? 0);

  const reason = (r: Reroute): string | null => {
    if (!r.reason) return null;
    switch (r.reason.code) {
      case "RESERVE_ON_ARRIVAL":
        return `The reserve would drop to ${whole(r.reason.amountMinor)}, below the ${whole(input.reserveMinor)} you protect.`;
      case "RESERVE_BEFORE_ARRIVAL":
        return `Your funds would fall to ${whole(r.reason.amountMinor)}, below the ${whole(input.reserveMinor)} protected reserve.`;
      case "AFTER_HOME_BUDGET":
        return `Installments left after the move don't fit the ${whole(r.reason.amountMinor)} after-home budget.`;
      case "NO_SAVINGS":
        return "NextMove found no other charge it can stop right now.";
      case "NO_ONE_OFF":
        return "Nothing to spread: these are monthly changes, not one bill.";
      case "NOT_REACHABLE":
        return "The goal is not reachable within 5 years on this route.";
    }
  };
  const lastCut = Math.max(1, cur.arrivalMonth ?? 1);
  const describe = (r: Reroute) => {
    switch (r.id) {
      case "A": {
        const parts = r.savings.map((s) => `${s.label.replace(/^Turn off /, "Stop ").replace(/ renewal$/, "")} (${whole(s.amountMinor)})`);
        const text = [parts.length ? `${parts.join(", ")}. Found by ${[...new Set(r.savings.map((s) => s.capability))].join(", ")}; you approve each one.` : null, r.cancelsTool ? "Cancel the forgotten tool yourself; NextMove has no connector for it." : null].filter(Boolean).join(" ");
        const saved = r.savings.reduce((s, x) => s + x.amountMinor, 0);
        return { title: "Cut what you don't use", summary: r.verdict === "UNAVAILABLE" ? "Nothing NextMove found is left to stop." : text, impact: saved ? `${whole(saved)} kept in 30 days` : r.cancelsTool ? `${whole(roadblock("tool")!.amountMinor)} a month kept` : "—" };
      }
      case "B":
        return {
          title: "Lower the transfer for a while",
          summary: r.impact.kind === "TRANSFER" ? `Send ${scheduleText(env.nowMs, r.impact.schedule, lastCut)} instead of ${whole(input.contributionMinor)}. Spending stays the same.` : "Nothing changes this month.",
          impact: r.impact.kind === "TRANSFER" ? `Transfer ${whole(r.impact.transferMinor)}` : "—",
        };
      case "C":
        return {
          title: "Spread the bill at 0%",
          summary: r.impact.kind === "INSTALLMENT" ? `${r.impact.months} × ${whole(r.impact.perMonthMinor)} on a fictional 0% plan.${r.outstandingAfterArrivalMinor ? ` ${whole(r.outstandingAfterArrivalMinor)} is still owed after the move, paid from the after-home budget.` : ""}` : "Nothing to spread.",
          impact: r.impact.kind === "INSTALLMENT" ? `${whole(r.impact.perMonthMinor)} a month` : "—",
        };
      default:
        return { title: "Keep the original date", summary: `Buy in ${fmtMonth(env.nowMs, r.arrivalMonth)} and cover the gap from the reserve.`, impact: "No change" };
    }
  };

  const choiceRow = one<any>(env.db, "SELECT choice, inputs_json, created_at FROM saved_comparisons WHERE tenant_id=? AND context_id=? AND kind='O6' ORDER BY created_at DESC LIMIT 1", env.tenantId, env.contextId);
  const choiceInputs = json<any>(choiceRow?.inputs_json, {});
  const sameSet = choiceRow && JSON.stringify(choiceInputs.roadblocks ?? []) === JSON.stringify(ids);

  const view: RouteView = {
    goalName: base.goal.name,
    labs: config.mode === "labs",
    whatIf,
    targetMinor: input.targetMinor,
    reserveMinor: input.reserveMinor,
    startMinor: input.startMinor,
    contributionMinor: input.contributionMinor,
    roadblocks: ROADBLOCKS.map((r) => ({
      id: r.id,
      label: r.label,
      detail: r.kind === "ONE_OFF" ? "Paid today" : r.kind === "MONTHLY" ? "Every month from next month" : `${whole(incomeDropMinor(r, input.incomeMinor))} less a month, then back to normal`,
      active: ids.includes(r.id),
    })),
    months: Array.from({ length: last + 1 }, (_, m) => ({ month: m, label: m === 0 ? "Today" : fmtMonth(env.nowMs, m), short: m === 0 ? "Now" : fmtMonth(env.nowMs, m, "short") })),
    original: { arrival: fmtMonth(env.nowMs, orig.arrivalMonth), arrivalMonth: orig.arrivalMonth, spareMinor: orig.spareOnArrivalMinor, points: points(orig) },
    current: { arrival: fmtMonth(env.nowMs, cur.arrivalMonth), arrivalMonth: cur.arrivalMonth, spareMinor: cur.spareOnArrivalMinor, delayMonths: delay, hitMinor: e.totalHitMinor, points: points(cur) },
    reroutes: ids.length
      ? e.reroutes.map((r) => {
          const d = describe(r);
          return {
            id: r.id,
            title: d.title,
            summary: d.summary,
            verdict: r.verdict,
            reason: reason(r),
            action: r.action,
            arrival: r.verdict === "UNAVAILABLE" ? "—" : fmtMonth(env.nowMs, r.arrivalMonth),
            arrivalMonth: r.arrivalMonth,
            delayMonths: r.delayMonths,
            impact: d.impact,
            reserve: r.reserveOnArrivalMinor == null ? "—" : whole(r.reserveOnArrivalMinor),
            spareMinor: r.spareOnArrivalMinor,
            fictional: r.fictional,
            sources: r.savings.map((s) => ({ capability: s.capability, label: s.label, amountMinor: s.amountMinor })),
            points: points(r.sim),
          };
        })
      : [],
    recommended: e.recommended,
    choice: sameSet && !whatIf ? { route: String(choiceInputs.route ?? ""), label: choiceRow.choice, at: choiceRow.created_at, proposalId: choiceInputs.proposalId ?? null } : null,
  };
  return { view, evaluation: e, input, candidates, ids, whatIf };
}

export const O6_PERSONAL = async (env: CapEnv): Promise<Analysis & { route: RouteView | null }> => {
  const r = await computeRoute(env);
  if (!r) {
    return { capability: "O6", title: "Route to your home", contextId: env.contextId, headline: "Add transaction costs to the home goal to plan a route", summary: "The route uses the same target as the home plan.", evidence: [], blocks: [{ kind: "note", tone: "warn", text: "The home goal is missing transaction costs. NextMove does not assume zero." }], inputs: [], candidates: [], numbers: {}, route: null, links: [{ label: "Open the home plan", href: "/capabilities/O1" }] };
  }
  const { view, evaluation: e, input, candidates, ids, whatIf } = r;
  const orig = view.original;
  const cur = view.current;
  const rec = view.reroutes.find((x) => x.id === view.recommended);
  const names = ids.map((id) => ROADBLOCK_NOUN[id]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const headline = !ids.length
    ? `On route: home ready in ${orig.arrival} with ${whole(orig.spareMinor)} to spare`
    : cur.delayMonths > 0
      ? `Rerouted: ${list} move${ids.length === 1 ? "s" : ""} the home from ${orig.arrival} to ${cur.arrival}`
      : `Still on route for ${cur.arrival}: spare on arrival drops from ${whole(orig.spareMinor)} to ${whole(cur.spareMinor)}`;
  const summary = !ids.length
    ? `${e.original.arrivalMonth} monthly checkpoints from ${whole(input.startMinor)} to the ${whole(input.targetMinor)} target, which keeps the ${whole(input.reserveMinor)} reserve. Planning model only; no loan or mortgage approval is implied.`
    : `Roadblocks cost ${whole(cur.hitMinor)} before arrival${whatIf ? " (what-if, not saved)" : ""}. ${rec ? `Best route: ${rec.title.toLowerCase()} (${rec.arrival}).` : ""} Every accepted route keeps the ${whole(input.reserveMinor)} reserve.`;
  const blocks: Block[] = [
    { kind: "metrics", items: [
      { label: "Arrival", value: cur.arrival, sub: cur.delayMonths > 0 ? `was ${orig.arrival}` : "Unchanged", tone: cur.delayMonths > 0 ? "warn" : "good" },
      { label: "Spare on arrival", value: whole(cur.spareMinor) },
      { label: "Protected reserve", value: whole(input.reserveMinor), sub: "Never used" },
    ] },
  ];
  if (view.reroutes.length) {
    blocks.push({
      kind: "table",
      title: "Reroutes evaluated",
      columns: ["Route", "Arrives", "Monthly", "Reserve on arrival"],
      rows: view.reroutes.map((x) => ({ cells: [`${x.id}. ${x.title}${x.fictional ? " (fictional)" : ""}`, x.arrival, x.impact, x.verdict === "REJECTED" ? `${x.reserve}: rejected` : x.reserve], highlight: x.id === view.recommended, tone: x.verdict === "REJECTED" ? ("bad" as const) : x.verdict === "UNAVAILABLE" ? ("neutral" as const) : undefined })),
      note: view.reroutes.filter((x) => x.reason).map((x) => `${x.id}: ${x.reason}`).join(" "),
    });
  }
  blocks.push({ kind: "timeline", title: "Checkpoints", items: e.recalculated.checkpoints.map((c) => ({ at: monthDate(env.nowMs, c.month).toISOString(), label: c.month === 0 ? "Today" : c.month === e.recalculated.arrivalMonth ? "Home target reached" : `Checkpoint ${c.month}`, amount: whole(c.positionMinor) })) });
  blocks.push({ kind: "note", tone: "info", text: "Same inputs as the home plan: monthly deposits, no growth or interest. Roadblocks are Labs events for the demo customer. The 0% installment plan is fictional." });
  const byId = Object.fromEntries(view.reroutes.map((x) => [x.id, x]));
  return {
    capability: "O6",
    title: "Route to your home",
    contextId: env.contextId,
    headline,
    summary,
    evidence: ["DETERMINISTIC_CALCULATION", "BANK_RECORD", ...(candidates.length ? (["SIMULATED_MERCHANT_API"] as const) : [])],
    blocks,
    inputs: [],
    candidates: ids.length ? candidates : [],
    numbers: {
      liquidMinor: input.startMinor,
      targetMinor: input.targetMinor,
      reserveMinor: input.reserveMinor,
      originalArrivalMonths: e.original.arrivalMonth ?? -1,
      arrivalMonths: e.recalculated.arrivalMonth ?? -1,
      delayMonths: cur.delayMonths,
      spareOnArrivalMinor: cur.spareMinor ?? 0,
      roadblockCostMinor: cur.hitMinor,
      ...Object.fromEntries(Object.entries(byId).map(([k, x]) => [`route${k}ArrivalMonths`, x.arrivalMonth ?? -1])),
    },
    links: [{ label: "Open the live route", href: ROUTE_HREF }, { label: "Home plan (phone now, home later)", href: "/capabilities/O1" }],
    route: view,
  };
};

export const O6_ALEX: CapabilityDef = {
  id: "O6",
  title: "Route to your home",
  short: "Live route to the home goal; reroutes around a dental bill, rent rise, forgotten tool or lower income",
  group: "Goals",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["on track", "off track", "route", "roadblock", "recalculate", "recalculation", "dental", "unexpected", "surprise", "rent went", "rent rise", "rent rose", "rent increase", "lower income", "less income", "income drop", "forgot to cancel"],
  analyze: O6_PERSONAL,
};
