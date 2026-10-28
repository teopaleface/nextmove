import { makeIncomeSimulation, makeLoanSimulation } from "../../shared/simulations";
import { money, type Block, type CapEnv } from "./core";

// Interactive what-ifs inside the O1 goal analysis. They start from the same numbers the analysis just used,
// including any assumption the customer changed, and recompute on the phone with the shared pure functions.

export function goalSimulationBlocks(env: CapEnv, b: { liquidMinor: number; targetMinor: number | null; monthlySavingMinor: number; incomeMinor: number; phonePriceMinor?: number }): Block[] {
  if (b.targetMinor == null || !(b.monthlySavingMinor > 0)) return [];
  const base = { liquidMinor: b.liquidMinor, targetMinor: b.targetMinor, monthlySavingMinor: b.monthlySavingMinor };
  const goal = [`Liquid funds ${money(b.liquidMinor)}: your accounts`, `Home target ${money(b.targetMinor)} and ${money(b.monthlySavingMinor)} monthly saving: this calculation`];
  const out: Block[] = [];
  if (b.phonePriceMinor) out.push({ kind: "simulation", simulation: makeLoanSimulation(env.now, base, { principalMinor: b.phonePriceMinor, itemLabel: "the phone", sources: [...goal, `Price ${money(b.phonePriceMinor)}: your phone goal`, "Installment rate: fictional, not an offer or a credit decision"] }) });
  if (b.incomeMinor > 0) out.push({ kind: "simulation", simulation: makeIncomeSimulation(env.now, { ...base, incomeMinor: b.incomeMinor }, { sources: [...goal, `Income ${money(b.incomeMinor)} a month: your plan`] }) });
  return out;
}
