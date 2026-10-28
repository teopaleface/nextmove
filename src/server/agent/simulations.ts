import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { all, json, one } from "../db/connection";
import { accountsFor } from "../bank/ledger";
import { comparison } from "../capabilities/alex-subscriptions";
import { makeEnv, type CapEnv } from "../capabilities/core";
import { customerOf, contextKindOf } from "../capabilities/registry";
import type { Session } from "../auth/session";
import { setBlock } from "./events";
import { formatMoney } from "../../shared/money";
import {
  SIMULATION_KINDS,
  evaluate,
  initialValues,
  makeIncomeSimulation,
  makeInvestSimulation,
  makeLoanSimulation,
  type HomeBase,
  type Simulation,
  type SimulationKind,
} from "../../shared/simulations";

// The planner's show_simulation tool. The planner names a kind and, optionally, values the customer wrote; every
// starting number is read here from bank records, the confirmed goal and NextMove's own calculations. The
// widget then recomputes on the phone with the same pure functions. Nothing is offered, approved or moved.

export const SimulationArgs = z.object({
  kind: z.enum(SIMULATION_KINDS),
  inputs: z.array(z.object({ key: z.string().max(40), value: z.string().max(120) })).max(10).optional(),
});

/** Home goal numbers exactly as O1 uses them (liquid funds counted once, target = down payment + costs + reserve). */
export function homeBase(env: Pick<CapEnv, "db" | "tenantId" | "contextId">): (HomeBase & { incomeMinor: number; phones: { label: string; priceMinor: number }[] }) | null {
  const g = one<any>(env.db, "SELECT inputs_json FROM goals WHERE id=? AND tenant_id=?", `${env.tenantId}:goal:home`, env.tenantId);
  if (!g) return null;
  const i = json<any>(g.inputs_json, {});
  if (i.transactionCostsMinor == null) return null;
  const phone = one<any>(env.db, "SELECT inputs_json FROM goals WHERE id=? AND tenant_id=?", `${env.tenantId}:goal:phone`, env.tenantId);
  const liquid = accountsFor(env.db, env.tenantId, env.contextId).reduce((s, a) => s + a.balanceMinor, 0);
  return {
    liquidMinor: liquid,
    targetMinor: i.downPaymentMinor + i.transactionCostsMinor + i.protectedReserveMinor,
    monthlySavingMinor: i.monthlyContributionMinor,
    incomeMinor: i.afterHome?.incomeMinor ?? 0,
    phones: (json<any>(phone?.inputs_json, {}).options ?? []).map((o: any) => ({ label: o.label, priceMinor: o.priceMinor })),
  };
}

/** Monthly savings NextMove confirmed (receipts for renewals turned off) and found but not yet acted on. */
async function savingsBase(env: CapEnv) {
  const confirmed = all<any>(
    env.db,
    `SELECT DISTINCT s.id, s.merchant_name, s.amount_minor FROM subscriptions s
       JOIN proposal_actions a ON a.subject_ref=s.id AND a.tenant_id=s.tenant_id
       JOIN receipts r ON r.action_id=a.id
      WHERE s.tenant_id=? AND s.context_id=? AND s.dataset='ui' AND s.state IN ('RENEWAL_OFF','CANCELLED') AND r.operation='STOP_RENEWAL'`,
    env.tenantId,
    env.contextId,
  );
  let found = 0;
  try {
    found = (await comparison(env)).result.potentialMinor;
  } catch {
    /* provider unreachable: only confirmed savings count */
  }
  return { confirmedMinor: confirmed.reduce((s, c) => s + c.amount_minor, 0), foundMinor: found, confirmedNames: confirmed.map((c) => c.merchant_name as string) };
}

const NUM = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (text: string) => new Set([...text.matchAll(NUM)].map((m) => Number(m[0].replace(/,/g, ""))));

/** Values the customer actually wrote, read from their request (the simulated planner uses this too). */
export function valuesFromText(text: string) {
  const t = text.toLowerCase();
  const out: { amountRon?: number; changePct?: number; termMonths?: number; ratePct?: number; years?: number } = {};
  const amount = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:ron|lei)\b/);
  if (amount) out.amountRon = Number(amount[1].replace(/,/g, ""));
  const term = t.match(/(\d{1,2})\s*(?:months?|installments?|instalments?)\b/);
  if (term) out.termMonths = Number(term[1]);
  const years = t.match(/(\d{1,2})\s*years?\b/);
  if (years) out.years = Number(years[1]);
  const pctm = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctm) {
    const p = Number(pctm[1]);
    if (/\b(raise|salary|income|pay|earn|drop|cut)/.test(t)) out.changePct = /\b(drop|cut|lose|lower|less|decrease|fall)/.test(t) ? -p : p;
    else out.ratePct = p;
  }
  return out;
}

/** Which what-if a request is about, if any. Deliberately narrow so other suggestions keep their own flow. */
export function simulationIntent(text: string): SimulationKind | null {
  const t = text.toLowerCase();
  if (/\b(invest|compound|grow (it|them|my)|put (it|this|that|them) aside)/.test(t)) return "invest";
  if (/\b(raise|salary|pay ?rise|pay ?cut|income (drop|change|goes|falls|rises))|\bmy income\b/.test(t)) return "income";
  if (/\b(loan|installments?|instalments?|borrow|financing|pay (it )?over)\b/.test(t)) return "loan";
  if (/\b(buy|afford|purchase)\b/.test(t) && /\bphone\b/.test(t) && /\bhome|house|goal\b/.test(t)) return "loan";
  return null;
}

export async function buildSimulation(env: CapEnv, kind: SimulationKind, request: string, planned: Record<string, string> = {}): Promise<{ sim: Simulation; ignored: string[] } | { error: string }> {
  // Planner-supplied values count only when the customer wrote that number; everything else comes from records.
  const written = numbersIn(request);
  const fromText = valuesFromText(request);
  const ignored: string[] = [];
  const pick = (key: keyof typeof fromText) => {
    const raw = planned[key];
    if (raw != null && raw !== "") {
      const n = Number(String(raw).replace(/,/g, ""));
      if (Number.isFinite(n) && written.has(Math.abs(n))) return n;
      ignored.push(key);
    }
    return fromText[key];
  };
  if (kind === "invest") {
    const s = await savingsBase(env);
    const monthly = pick("amountRon");
    const rate = pick("ratePct");
    const years = pick("years");
    const sources = [
      s.confirmedMinor ? `${formatMoney(s.confirmedMinor)} a month confirmed by receipts (${s.confirmedNames.join(", ")})` : "No confirmed savings yet",
      s.foundMinor ? `${formatMoney(s.foundMinor)} a month found in your subscriptions, not yet acted on` : "No further savings found in your subscriptions",
      ...(monthly != null ? [`${formatMoney(monthly * 100)} a month: your question`] : []),
      "Growth rate: fictional, not a product or a forecast",
    ];
    return { sim: makeInvestSimulation(env.now, s, { monthlyMinor: monthly != null ? Math.round(monthly * 100) : undefined, annualRateBp: rate != null ? Math.round(rate * 100) : undefined, years, sources }), ignored };
  }
  const home = homeBase(env);
  if (!home) return { error: "The home goal needs every cost component before a what-if can be shown" };
  const base: HomeBase = { liquidMinor: home.liquidMinor, targetMinor: home.targetMinor, monthlySavingMinor: home.monthlySavingMinor };
  const goalSources = [`Liquid funds ${formatMoney(home.liquidMinor)}: your accounts`, `Home target ${formatMoney(home.targetMinor)} and ${formatMoney(home.monthlySavingMinor)} monthly saving: your First home goal`];
  if (kind === "income") {
    const change = pick("changePct");
    return {
      sim: makeIncomeSimulation(env.now, { ...base, incomeMinor: home.incomeMinor }, { changeBp: change != null ? Math.round(change * 100) : 0, sources: [...goalSources, `Income ${formatMoney(home.incomeMinor)} a month: your plan`] }),
      ignored,
    };
  }
  const amount = pick("amountRon");
  const priceMinor = amount != null ? Math.round(amount * 100) : home.phones.at(-1)?.priceMinor ?? 600_000;
  const phone = home.phones.find((p) => p.priceMinor === priceMinor);
  const term = pick("termMonths");
  const rate = pick("ratePct");
  return {
    sim: makeLoanSimulation(env.now, base, {
      principalMinor: priceMinor,
      itemLabel: phone || /\bphone\b/i.test(request) ? "the phone" : "the purchase",
      termMonths: term,
      annualRateBp: rate != null ? Math.round(rate * 100) : undefined,
      sources: [...goalSources, `Price ${formatMoney(priceMinor)}: ${amount != null ? "your question" : "your phone goal"}`, "Installment rate: fictional, not an offer or a credit decision"],
    }),
    ignored,
  };
}

/** Run the tool for an agent task: store the widget on the task and return the numbers the planner may cite. */
export async function showSimulation(db: DatabaseSync, task: { id: string; request_text: string }, session: Session, args: unknown) {
  const parsed = SimulationArgs.safeParse(args);
  if (!parsed.success) return { result: { error: "Unknown simulation; use loan, income or invest" } };
  if (customerOf(db, session.tenantId) !== "alex" || contextKindOf(db, session.contextId) !== "PERSONAL") return { result: { error: "What-if simulations are available in Alex's personal context" } };
  const env = makeEnv(db, session);
  const planned = Object.fromEntries((parsed.data.inputs ?? []).map((x) => [x.key, x.value]));
  const built = await buildSimulation(env, parsed.data.kind, task.request_text, planned);
  if ("error" in built) return { result: { error: built.error } };
  const outcome = evaluate(built.sim, initialValues(built.sim));
  setBlock(db, task.id, `simulation:${built.sim.kind}`, 35, "simulation", built.sim);
  return {
    result: {
      simulation: built.sim.kind,
      title: built.sim.title,
      headline: outcome.headline,
      summary: outcome.summary,
      numbers: outcome.numbers,
      sources: built.sim.sources,
      ignoredInputs: built.ignored,
    },
  };
}

interface StepLike {
  tool: string;
  args?: Record<string, unknown>;
  result: any;
}

/**
 * Simulated planner path for what-if questions: ground the goal with O1, show the widget, then answer with the
 * tool's own sentence. Returns null when the request is not a what-if, so the normal deterministic flow runs.
 */
export function simulatedSimulationDecision(request: string, steps: StepLike[], eligible: boolean) {
  const kind = simulationIntent(request);
  if (!kind || !eligible) return null;
  const sim = [...steps].reverse().find((s) => s.tool === "show_simulation");
  if (sim) {
    // The O1 headline is about the phone, so it only leads the answer to a purchase question.
    const goal = kind === "loan" ? [...steps].reverse().find((s) => s.tool === "analyze" && s.result?.capability === "O1") : undefined;
    if (sim.result?.error) return { tool: "final_answer" as const, reason: "Simulation unavailable", text: `${goal ? `${goal.result.headline}. ` : ""}I could not build the what-if: ${sim.result.error}.` };
    return {
      tool: "final_answer" as const,
      reason: "Explain the what-if",
      text: `${goal ? `${goal.result.headline}. ` : ""}${sim.result.summary} Move the sliders to try other numbers; nothing changes in your accounts.`,
    };
  }
  if (kind !== "invest" && !steps.some((s) => s.tool === "analyze" && s.result?.capability === "O1")) return { tool: "analyze" as const, capabilityId: "O1", reason: "The home goal sets the target and the monthly saving" };
  return { tool: "show_simulation" as const, simulation: kind, reason: `Show a ${kind} what-if with numbers from your records` };
}

/**
 * Safety net for the live planner: a what-if question always gets its widget. If the planner tries to answer
 * before showing one, the step becomes show_simulation; the planner then answers with the tool's numbers.
 */
export function ensureSimulation<D extends { tool: string; reason: string; simulation?: SimulationKind }>(d: D, request: string, steps: StepLike[], eligible: boolean): D {
  if (d.tool !== "final_answer" || !eligible || steps.some((s) => s.tool === "show_simulation")) return d;
  const kind = simulationIntent(request);
  if (!kind) return d;
  return { ...d, tool: "show_simulation", simulation: kind, reason: "What-if questions get an interactive simulation before the answer" };
}
