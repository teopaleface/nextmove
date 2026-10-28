import type { DatabaseSync } from "node:sqlite";
import { one, run } from "./db/connection";
import { toLocalIso } from "../shared/time";

// Each tenant has an isolated demo clock. It starts at the fixture instant and advances in real time;
// Labs controls may advance it explicitly, and the UI labels the demo clock visibly.

export const FIXTURE_INSTANT = "2026-10-28T09:41:00+02:00";

export function setClock(db: DatabaseSync, tenantId: string, demoMs: number, frozen = false): void {
  run(
    db,
    `INSERT INTO demo_clocks(tenant_id, base_ms, anchor_real_ms, frozen) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET base_ms=excluded.base_ms, anchor_real_ms=excluded.anchor_real_ms, frozen=excluded.frozen`,
    tenantId,
    demoMs,
    Date.now(),
    frozen ? 1 : 0,
  );
}

export function nowMs(db: DatabaseSync, tenantId: string): number {
  const row = one<{ base_ms: number; anchor_real_ms: number; frozen: number }>(
    db,
    "SELECT base_ms, anchor_real_ms, frozen FROM demo_clocks WHERE tenant_id=?",
    tenantId,
  );
  if (!row) return Date.now();
  return row.frozen ? row.base_ms : row.base_ms + (Date.now() - row.anchor_real_ms);
}

export function nowIso(db: DatabaseSync, tenantId: string): string {
  return toLocalIso(nowMs(db, tenantId));
}

export function advanceClock(db: DatabaseSync, tenantId: string, deltaMs: number): number {
  const current = nowMs(db, tenantId);
  const row = one<{ frozen: number }>(db, "SELECT frozen FROM demo_clocks WHERE tenant_id=?", tenantId);
  setClock(db, tenantId, current + deltaMs, Boolean(row?.frozen));
  return current + deltaMs;
}

/** Real wall-clock ISO, used for audit timestamps that are not part of the demo timeline. */
export function realIso(): string {
  return new Date().toISOString();
}
