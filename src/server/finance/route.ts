import { assertMinor } from "../../shared/money";
import { hasKeyword, normalizeRequest } from "../agent/routing";

// Route to a goal (O6). A deterministic planning model on the same inputs as home readiness (O1): today's liquid
// funds, a target that already contains the protected reserve, and discrete equal monthly contributions. Roadblocks
// are dated cash events; reroutes are alternative event sets evaluated by the same simulation. Nothing here moves
// money, creates authority or assumes growth, interest or price changes.

export interface RouteInputs {
  startMinor: number;            // all liquid accounts counted once (as O1)
  targetMinor: number;           // down payment + transaction costs + protected reserve (as O1)
  reserveMinor: number;          // protected reserve, already inside the target
  contributionMinor: number;     // planned monthly transfer to the goal
  incomeMinor: number;           // monthly income, for income roadblocks
  afterHomeMonthlyMinor: number; // expected monthly residual after the purchase (O1, separate period)
  horizonMonths?: number;
}

export type FlowKind = "ROADBLOCK" | "SAVING" | "INSTALLMENT";
export interface Flow {
  month: number;       // 0 = today, n = n-th monthly checkpoint
  amountMinor: number; // signed change to the goal position
  label: string;
  kind: FlowKind;
  source: string;      // roadblock id or lever id
}

export interface Checkpoint {
  month: number;
  positionMinor: number;
  contributionMinor: number;
  flows: Flow[];
}

export interface Simulation {
  checkpoints: Checkpoint[];
  arrivalMonth: number | null;
  spareOnArrivalMinor: number | null;
  minPositionMinor: number;
  outstandingAfterArrivalMinor: number; // installments still owed after the arrival checkpoint
}

export const DEFAULT_HORIZON = 60;

/** Walk month by month until the position covers the target (or the horizon ends). */
export function simulate(input: RouteInputs, flows: Flow[]): Simulation {
  assertMinor(input.startMinor);
  assertMinor(input.targetMinor);
  if (!(input.contributionMinor > 0)) throw new Error("Monthly contribution must be positive");
  const horizon = input.horizonMonths ?? DEFAULT_HORIZON;
  const checkpoints: Checkpoint[] = [];
  let position = input.startMinor;
  let arrival: number | null = null;
  let min = Number.POSITIVE_INFINITY;
  for (let m = 0; m <= horizon; m++) {
    const here = flows.filter((f) => f.month === m);
    const contribution = m === 0 ? 0 : input.contributionMinor;
    position = assertMinor(position + contribution + here.reduce((s, f) => s + f.amountMinor, 0));
    checkpoints.push({ month: m, positionMinor: position, contributionMinor: contribution, flows: here });
    min = Math.min(min, position);
    if (position >= input.targetMinor) {
      arrival = m;
      break;
    }
  }
  const outstanding = arrival == null ? 0 : -flows.filter((f) => f.kind === "INSTALLMENT" && f.month > arrival!).reduce((s, f) => s + f.amountMinor, 0);
  return {
    checkpoints,
    arrivalMonth: arrival,
    spareOnArrivalMinor: arrival == null ? null : checkpoints[checkpoints.length - 1].positionMinor - input.targetMinor,
    minPositionMinor: min,
    outstandingAfterArrivalMinor: outstanding,
  };
}

/* ------------------------------------------------------------------------------------------ roadblocks */

export type RoadblockId = "dental" | "rent" | "tool" | "income";

export interface RoadblockDef {
  id: RoadblockId;
  label: string;
  kind: "ONE_OFF" | "MONTHLY" | "INCOME_DROP";
  amountMinor?: number;     // ONE_OFF and MONTHLY
  incomeShare?: number;     // INCOME_DROP, e.g. 0.2
  months?: number;          // INCOME_DROP duration; MONTHLY is ongoing
  keywords: string[];
}

// Fictional demo events. Amounts are scenario inputs, not observed bills.
export const ROADBLOCKS: RoadblockDef[] = [
  { id: "dental", label: "Unexpected 900 RON dental bill", kind: "ONE_OFF", amountMinor: 90000, keywords: ["dental", "dentist", "tooth", "teeth", "medical bill"] },
  { id: "rent", label: "Rent +100 RON a month", kind: "MONTHLY", amountMinor: 10000, keywords: ["rent rise", "rent rose", "rent increase", "rent went up", "rent goes up", "rent is going up", "rent up", "higher rent", "rent hike"] },
  { id: "tool", label: "Forgot to cancel a 50 RON/month tool", kind: "MONTHLY", amountMinor: 5000, keywords: ["forgot to cancel", "software", "tool"] },
  { id: "income", label: "Income −20% for 2 months", kind: "INCOME_DROP", incomeShare: 0.2, months: 2, keywords: ["income drop", "income fell", "income cut", "lower income", "less income", "pay cut", "salary cut", "salary drop", "lower salary", "paid less", "earn less"] },
];

export function roadblock(id: string): RoadblockDef | undefined {
  return ROADBLOCKS.find((r) => r.id === id);
}

/**
 * Roadblock ids from a list of ids ("dental,rent") or named in free text ("A 900 RON dental bill just came in"), on
 * whole words. Rent and income count only with a change ("my rent rose"), never for the word alone.
 */
export function roadblocksFromText(text: string): RoadblockId[] {
  const t = normalizeRequest(text);
  const ids = t.split(/[\s,;]+/).filter(Boolean);
  if (ids.length && ids.every((x) => roadblock(x))) return [...new Set(ids)] as RoadblockId[];
  return ROADBLOCKS.filter((r) => r.keywords.some((k) => hasKeyword(t, k))).map((r) => r.id);
}

export function incomeDropMinor(def: RoadblockDef, incomeMinor: number) {
  return Math.round(incomeMinor * (def.incomeShare ?? 0));
}

export function roadblockFlows(ids: RoadblockId[], input: RouteInputs): Flow[] {
  const horizon = input.horizonMonths ?? DEFAULT_HORIZON;
  const flows: Flow[] = [];
  for (const id of ids) {
    const r = roadblock(id);
    if (!r) continue;
    if (r.kind === "ONE_OFF") flows.push({ month: 0, amountMinor: -(r.amountMinor ?? 0), label: r.label, kind: "ROADBLOCK", source: r.id });
    if (r.kind === "MONTHLY") for (let m = 1; m <= horizon; m++) flows.push({ month: m, amountMinor: -(r.amountMinor ?? 0), label: r.label, kind: "ROADBLOCK", source: r.id });
    if (r.kind === "INCOME_DROP") for (let m = 1; m <= (r.months ?? 1); m++) flows.push({ month: m, amountMinor: -incomeDropMinor(r, input.incomeMinor), label: r.label, kind: "ROADBLOCK", source: r.id });
  }
  return flows;
}

/* --------------------------------------------------------------------------------------------- reroutes */

export interface Saving {
  key: string;            // candidate key in the route analysis
  capability: string;     // capability that computed it
  label: string;
  amountMinor: number;    // positive: scheduled charge that would no longer be paid
  month: number;          // checkpoint it lands before (1 = within the next 30 days)
}

export type RerouteId = "A" | "B" | "C" | "D";

export type Impact =
  | { kind: "BACK"; amountMinor: number }                                   // money kept within 30 days
  | { kind: "TRANSFER"; transferMinor: number; months: number[]; schedule: { month: number; transferMinor: number }[] } // lowest transfer, its months, every lowered month
  | { kind: "INSTALLMENT"; perMonthMinor: number; months: number }
  | { kind: "NONE" };

export type ReasonCode = "NO_SAVINGS" | "NO_ONE_OFF" | "RESERVE_ON_ARRIVAL" | "RESERVE_BEFORE_ARRIVAL" | "AFTER_HOME_BUDGET" | "NOT_REACHABLE";

export interface Reroute {
  id: RerouteId;
  verdict: "OK" | "REJECTED" | "UNAVAILABLE";
  reason: { code: ReasonCode; amountMinor?: number } | null;
  action: "PROPOSAL" | "PLAN_CHANGE" | null;
  arrivalMonth: number | null;
  delayMonths: number | null;          // versus the original route
  spareOnArrivalMinor: number | null;
  reserveOnArrivalMinor: number | null;
  minPositionMinor: number | null;
  impact: Impact;
  outstandingAfterArrivalMinor: number;
  savings: Saving[];
  cancelsTool: boolean;
  fictional: boolean;
  sim: Simulation | null;
}

export interface RouteEvaluation {
  original: Simulation;
  recalculated: Simulation;
  active: RoadblockId[];
  totalHitMinor: number;               // roadblock cost up to the recalculated arrival
  reroutes: Reroute[];
  recommended: RerouteId | null;
}

export const INSTALLMENT_MONTHS = 12;

/** Split an amount into n monthly parts that sum exactly (remainder on the first parts). */
export function splitEven(amountMinor: number, n: number): number[] {
  const base = Math.floor(amountMinor / n);
  const rem = amountMinor - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

type Draft = Pick<Reroute, "id" | "verdict" | "reason" | "action" | "impact" | "savings" | "cancelsTool" | "fictional"> & { sim: Simulation | null };

/**
 * Evaluate reroutes around the active roadblocks. Every candidate route runs through the same simulation and the
 * same reserve check; a route that would leave less than the protected reserve is rejected, with the reason.
 * A: redirect charges other NextMove capabilities can stop (only what they computed) and cancel a forgotten tool.
 * B: absorb the cost by lowering goal transfers; arrival moves if it must.
 * C: spread one-off bills over fictional 0% installments; what is owed after arrival comes from the after-home budget.
 * D: keep the original date by spending part of the protected reserve. Shown only when arrival slips; always rejected.
 */
export function evaluateRoute(input: RouteInputs, active: RoadblockId[], savings: Saving[]): RouteEvaluation {
  const original = simulate(input, []);
  const hits = roadblockFlows(active, input);
  const recalculated = simulate(input, hits);
  const base = original.arrivalMonth;
  const until = recalculated.arrivalMonth ?? input.horizonMonths ?? DEFAULT_HORIZON;
  const totalHit = hits.filter((f) => f.month <= until).reduce((s, f) => s - f.amountMinor, 0);

  const finish = (d: Draft): Reroute => {
    const sim = d.sim;
    const out: Reroute = { ...d, arrivalMonth: null, delayMonths: null, spareOnArrivalMinor: null, reserveOnArrivalMinor: null, minPositionMinor: null, outstandingAfterArrivalMinor: 0 };
    if (!sim) return out;
    out.arrivalMonth = sim.arrivalMonth;
    out.delayMonths = sim.arrivalMonth == null || base == null ? null : sim.arrivalMonth - base;
    out.spareOnArrivalMinor = sim.spareOnArrivalMinor;
    out.reserveOnArrivalMinor = sim.spareOnArrivalMinor == null ? null : input.reserveMinor + Math.min(0, sim.spareOnArrivalMinor);
    out.minPositionMinor = sim.minPositionMinor;
    out.outstandingAfterArrivalMinor = sim.outstandingAfterArrivalMinor;
    if (out.verdict !== "OK") return out;
    const breach: Reroute["reason"] =
      sim.minPositionMinor < input.reserveMinor ? { code: "RESERVE_BEFORE_ARRIVAL", amountMinor: sim.minPositionMinor } :
      out.reserveOnArrivalMinor != null && out.reserveOnArrivalMinor < input.reserveMinor ? { code: "RESERVE_ON_ARRIVAL", amountMinor: out.reserveOnArrivalMinor } :
      sim.arrivalMonth == null ? { code: "NOT_REACHABLE" } : null;
    if (breach) return { ...out, verdict: "REJECTED", reason: breach, action: null };
    return out;
  };

  const reroutes: Reroute[] = [];

  // A — use what NextMove already found.
  const usable = savings.filter((s) => s.amountMinor > 0);
  const toolActive = active.includes("tool");
  const aSaved = usable.reduce((s, x) => s + x.amountMinor, 0);
  const aFlows: Flow[] = [...hits.filter((f) => f.source !== "tool"), ...usable.map((s) => ({ month: s.month, amountMinor: s.amountMinor, label: s.label, kind: "SAVING" as const, source: s.key }))];
  reroutes.push(
    finish(
      usable.length || toolActive
        ? { id: "A", verdict: "OK", reason: null, action: usable.length ? "PROPOSAL" : "PLAN_CHANGE", impact: aSaved ? { kind: "BACK", amountMinor: aSaved } : { kind: "NONE" }, savings: usable, cancelsTool: toolActive, fictional: false, sim: simulate(input, aFlows) }
        : { id: "A", verdict: "UNAVAILABLE", reason: { code: "NO_SAVINGS" }, action: null, impact: { kind: "NONE" }, savings: [], cancelsTool: false, fictional: false, sim: null },
    ),
  );

  // B — lower the goal transfer while costs are higher (a one-off is refilled from next month's transfer).
  const oneOffMinor = hits.filter((f) => f.month === 0).reduce((s, f) => s - f.amountMinor, 0);
  const last = Math.max(1, recalculated.arrivalMonth ?? 1);
  const cuts = Array.from({ length: last }, (_, i) => i + 1).map((m) => ({ m, cut: hits.filter((f) => f.month === m).reduce((s, f) => s - f.amountMinor, 0) + (m === 1 ? oneOffMinor : 0) }));
  const biggest = cuts.reduce((a, b) => (b.cut > a.cut ? b : a), { m: 1, cut: 0 });
  reroutes.push(
    finish({
      id: "B",
      verdict: "OK",
      reason: null,
      action: "PLAN_CHANGE",
      impact: biggest.cut > 0 ? { kind: "TRANSFER", transferMinor: input.contributionMinor - biggest.cut, months: cuts.filter((c) => c.cut === biggest.cut).map((c) => c.m), schedule: cuts.filter((c) => c.cut > 0).map((c) => ({ month: c.m, transferMinor: input.contributionMinor - c.cut })) } : { kind: "NONE" },
      savings: [],
      cancelsTool: false,
      fictional: false,
      sim: recalculated,
    }),
  );

  // C — fictional 0% installments for one-off bills.
  const oneOffs = hits.filter((f) => f.month === 0);
  if (oneOffs.length) {
    const spread: Flow[] = oneOffs.flatMap((f) => splitEven(-f.amountMinor, INSTALLMENT_MONTHS).map((p, i) => ({ month: i + 1, amountMinor: -p, label: `${f.label} (installment ${i + 1}/${INSTALLMENT_MONTHS})`, kind: "INSTALLMENT" as const, source: f.source })));
    const perMonth = splitEven(oneOffMinor, INSTALLMENT_MONTHS)[0];
    const fits = input.afterHomeMonthlyMinor >= perMonth;
    reroutes.push(
      finish({
        id: "C",
        verdict: fits ? "OK" : "REJECTED",
        reason: fits ? null : { code: "AFTER_HOME_BUDGET", amountMinor: input.afterHomeMonthlyMinor },
        action: fits ? "PLAN_CHANGE" : null,
        impact: { kind: "INSTALLMENT", perMonthMinor: perMonth, months: INSTALLMENT_MONTHS },
        savings: [],
        cancelsTool: false,
        fictional: true,
        sim: simulate(input, [...hits.filter((f) => f.month !== 0), ...spread]),
      }),
    );
  } else {
    reroutes.push(finish({ id: "C", verdict: "UNAVAILABLE", reason: { code: "NO_ONE_OFF" }, action: null, impact: { kind: "NONE" }, savings: [], cancelsTool: false, fictional: true, sim: null }));
  }

  // D — keep the original date by spending the reserve.
  if (base != null && recalculated.arrivalMonth != null && recalculated.arrivalMonth > base) {
    const shortfall = input.targetMinor - recalculated.checkpoints[base].positionMinor;
    const sim: Simulation = { ...recalculated, checkpoints: recalculated.checkpoints.slice(0, base + 1), arrivalMonth: base, spareOnArrivalMinor: -shortfall, outstandingAfterArrivalMinor: 0 };
    reroutes.push(finish({ id: "D", verdict: "OK", reason: null, action: "PLAN_CHANGE", impact: { kind: "NONE" }, savings: [], cancelsTool: false, fictional: false, sim }));
  }

  const ok = reroutes.filter((r) => r.verdict === "OK" && r.arrivalMonth != null);
  // Earliest arrival, then the most money left once anything still owed is counted, then the smallest monthly squeeze.
  const net = (r: Reroute) => (r.spareOnArrivalMinor ?? 0) - r.outstandingAfterArrivalMinor;
  ok.sort((a, b) => a.arrivalMonth! - b.arrivalMonth! || net(b) - net(a) || impactMinor(a.impact) - impactMinor(b.impact));
  return { original, recalculated, active, totalHitMinor: totalHit, reroutes, recommended: active.length && ok.length ? ok[0].id : null };
}

/** How much less the customer has in a month under this route (0 for routes that give money back). */
export function impactMinor(i: Impact) {
  return i.kind === "TRANSFER" ? 0 : i.kind === "INSTALLMENT" ? i.perMonthMinor : 0;
}
