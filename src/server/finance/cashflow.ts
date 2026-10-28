import { assertMinor } from "../../shared/money";

// Dated cash trace with explicit intraday ordering. Mirrors demo/verify_cases.py semantics:
// duplicate event ids and ambiguous (day, sequence) positions are rejected rather than guessed.

export interface CashEvent {
  id: string;
  day: number;
  sequence: number;
  amountMinor: number;
  kind?: string;
  label?: string;
  conditional?: boolean;
  settled?: boolean;
}

export interface TracePoint {
  id: string;
  day: number;
  sequence: number;
  amountMinor: number;
  balanceMinor: number;
  label?: string;
  kind?: string;
  conditional?: boolean;
}

export interface CashTrace {
  openingMinor: number;
  minimumMinor: number;
  minimumDay: number | null;
  finalMinor: number;
  floorMinor: number | null;
  feasible: boolean | null;
  breachDays: number[];
  points: TracePoint[];
}

export class TraceError extends Error {}

export function traceCash(openingMinor: number, events: CashEvent[], floorMinor: number | null = null): CashTrace {
  assertMinor(openingMinor, "opening");
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const e of events) {
    if (ids.has(e.id)) throw new TraceError(`Duplicate event id ${e.id}`);
    ids.add(e.id);
    const pos = `${e.day}:${e.sequence}`;
    if (positions.has(pos)) throw new TraceError(`Ambiguous intraday order at day ${e.day}, sequence ${e.sequence}`);
    positions.add(pos);
    assertMinor(e.amountMinor, `event ${e.id}`);
  }
  const sorted = [...events].sort((a, b) => a.day - b.day || a.sequence - b.sequence);
  let balance = openingMinor;
  let minimum = openingMinor;
  let minimumDay: number | null = null;
  const breachDays: number[] = [];
  const points: TracePoint[] = [];
  for (const e of sorted) {
    balance = assertMinor(balance + e.amountMinor);
    points.push({ id: e.id, day: e.day, sequence: e.sequence, amountMinor: e.amountMinor, balanceMinor: balance, label: e.label, kind: e.kind, conditional: e.conditional });
    if (balance < minimum) {
      minimum = balance;
      minimumDay = e.day;
    }
    if (floorMinor != null && balance < floorMinor && !breachDays.includes(e.day)) breachDays.push(e.day);
  }
  return {
    openingMinor,
    minimumMinor: minimum,
    minimumDay,
    finalMinor: balance,
    floorMinor,
    feasible: floorMinor == null ? null : minimum >= floorMinor,
    breachDays,
    points,
  };
}
