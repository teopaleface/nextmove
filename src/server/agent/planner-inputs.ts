import type { InputField } from "../capabilities/core";
import { roadblocksFromText } from "../finance/route";
import { formatMoney } from "../../shared/money";
import { numbersIn } from "./simulations";

// Capability inputs the planner may set. Each capability lists its keys; every other key is dropped. A value counts
// only when it comes from the customer:
// - number: the customer wrote that number in the request or an answer (a *Minor field may be written in RON);
// - text: the customer wrote that text;
// - answer: the customer's answer, in this task, to that capability's own question for this key (ask_user with
//   capabilityId and inputKey); an answer to any other question does not count;
// - roadblocks: only roadblocks the customer's own words name.
// Inputs that lower a protection (savings and home reserves, keep-playback) are not listed: the customer changes
// them on the capability screen, never the planner.

export type InputSource = "number" | "text" | "answer" | "roadblocks";

interface Rule {
  key: string | RegExp;
  source: InputSource;
  label?: string;
  /** The capability's question block that asks for this key (otherwise its select input of the same key). */
  question?: string;
  mask?: boolean;
}

export const PLANNER_INPUTS: Record<string, Rule[]> = {
  O1: [
    { key: "downPaymentMinor", source: "number", label: "Down payment" },
    { key: "transactionCostsMinor", source: "number", label: "Transaction costs" },
    { key: "monthlyContributionMinor", source: "number", label: "Monthly saving" },
  ],
  O6: [{ key: "roadblocks", source: "roadblocks", label: "What-if roadblocks" }],
  O7: [
    { key: "minDaysAway", source: "number", label: "Minimum days away" },
    { key: "keepInDailyMinor", source: "number", label: "Keep in the daily account" },
  ],
  O8: [{ key: "dailyFloorMinor", source: "number", label: "Daily account floor" }],
  O9: [{ key: /^airbag_[0-9a-f]{12}$/, source: "answer" }],
  T3: [{ key: "studentIdNumber", source: "text", label: "Student ID number", mask: true }],
  A3: [{ key: "horizonMonths", source: "number", label: "Months compared" }],
  A5: [
    { key: "atlasFrom", source: "text", label: "Atlas Files from" },
    { key: "atlasUntil", source: "text", label: "Atlas Files until" },
    { key: "chaosFrom", source: "text", label: "Code and Chaos from" },
    { key: "chaosUntil", source: "text", label: "Code and Chaos until" },
  ],
  A6: [{ key: "months", source: "number", label: "Pause length (months)" }],
  A10: [{ key: "horizonMonths", source: "number", label: "Months compared" }],
  A11: [{ key: "billingDay", source: "number", label: "Billing day" }],
  A14: [{ key: "dataNeedGb", source: "number", label: "Data you need (GB)" }],
  A17: [
    { key: "stillGoing", source: "answer", label: "Still going to PulseGym", question: "agent:a17:pulsegym" },
    { key: "months", source: "number", label: "Freeze length (months)" },
  ],
  A18: [{ key: "needsExtras", source: "answer", label: "Needs what only SafeTrip covers", question: "agent:a18:safetrip" }],
};

export function plannerRule(capabilityId: string, key: string): Rule | null {
  return (PLANNER_INPUTS[capabilityId] ?? []).find((r) => (typeof r.key === "string" ? r.key === key : r.key.test(key))) ?? null;
}

/** The task question key for a capability's own question about one input. */
export const answerKey = (capabilityId: string, key: string) => `input:${capabilityId}:${key}`;

/** What the customer said in this task: the request plus answers, and answers to capability questions by key. */
export interface CustomerSaid {
  text: string;
  answers: Record<string, { value: string; label: string }>;
}

export interface ShownInput {
  key: string;
  label: string;
  value: string;
}

export function acceptPlannerInputs(capabilityId: string, raw: { key: string; value: string }[], said: CustomerSaid) {
  const inputs: Record<string, unknown> = {};
  const ignored: string[] = [];
  const written = numbersIn(said.text);
  const lower = said.text.toLowerCase();
  for (const { key, value } of raw) {
    const rule = plannerRule(capabilityId, key);
    const v = String(value ?? "").trim();
    let ok: unknown = undefined;
    // No negative amounts, and a *Minor field is the customer's RON in bani: "500" for "500 RON" would be 5 RON.
    if (rule?.source === "number" && /^\d{1,15}(\.\d+)?$/.test(v)) {
      const n = Number(v);
      if (key.endsWith("Minor") ? Number.isSafeInteger(n) && written.has(n / 100) : written.has(n)) ok = n;
    } else if (rule?.source === "text") {
      if (v.length >= 3 && lower.includes(v.toLowerCase())) ok = v;
    } else if (rule?.source === "answer") {
      const a = said.answers[answerKey(capabilityId, key)];
      if (a && (a.value === v || a.label === v)) ok = a.value;
    } else if (rule?.source === "roadblocks") {
      const theirs = roadblocksFromText(said.text);
      const ids = roadblocksFromText(v).filter((id) => theirs.includes(id));
      if (ids.length) ok = ids.join(",");
    }
    if (ok === undefined) ignored.push(key);
    else inputs[key] = ok;
  }
  return { inputs, ignored };
}

/** Accepted inputs as the customer sees them on the review screen (labels from the rule or the capability's own input). */
export function showInputs(capabilityId: string, inputs: Record<string, unknown>, fields: InputField[], said: CustomerSaid): ShownInput[] {
  return Object.entries(inputs).map(([key, v]) => {
    const rule = plannerRule(capabilityId, key);
    const field = fields.find((f) => f.key === key);
    const label = rule?.label ?? field?.label ?? key;
    let value = String(v);
    if (rule?.source === "answer") value = said.answers[answerKey(capabilityId, key)]?.label ?? value;
    else if (typeof v === "number" && key.endsWith("Minor")) value = formatMoney(v);
    else if (rule?.mask && value.length > 4) value = `•••• ${value.slice(-4)}`;
    return { key, label, value };
  });
}

/** Keys the planner may set for this analysis, for the planner's own view of the capability. */
export function settableInputs(capabilityId: string, fields: InputField[]) {
  const out: { key: string; source: InputSource }[] = [];
  for (const r of PLANNER_INPUTS[capabilityId] ?? []) {
    if (typeof r.key === "string") out.push({ key: r.key, source: r.source });
    else for (const f of fields) if (r.key.test(f.key)) out.push({ key: f.key, source: r.source });
  }
  return out;
}
