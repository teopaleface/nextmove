import type { DatabaseSync } from "node:sqlite";
import { all, one, run } from "../db/connection";
import { shortId } from "../canonical";
import type { ForecastEntry } from "../finance/subscriptions";
import { inWindow, toMs } from "../../shared/time";

// The dated forecast is a projection, never a posting. Changes are applied through forecast_events keyed by a
// unique authoritative source (e.g. a verified merchant receipt), so a repeated confirmation is a no-op.

export const SUBSCRIPTION_WINDOW = {
  startInclusive: "2026-10-28T09:41:00+02:00",
  endExclusive: "2026-11-27T09:41:00+02:00",
};

export interface ForecastRow {
  id: string;
  context_id: string;
  dataset: string;
  subscription_id: string | null;
  kind: string;
  label: string;
  amount_minor: number;
  due_at: string;
  status: string;
  condition: string | null;
  source: string;
  revision: number;
}

export function scheduledItems(db: DatabaseSync, tenantId: string, contextId: string, dataset?: string): ForecastRow[] {
  return all<ForecastRow>(
    db,
    `SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND status='SCHEDULED' ${dataset ? "AND dataset=?" : ""} ORDER BY due_at`,
    ...(dataset ? [tenantId, contextId, dataset] : [tenantId, contextId]),
  );
}

export function toEntries(rows: ForecastRow[]): ForecastEntry[] {
  return rows
    .filter((r) => r.amount_minor < 0)
    .map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      label: r.label,
      kind: r.kind === "TRIAL_CONVERSION" ? "TRIAL_CONVERSION" : r.kind === "RENEWAL" ? "RENEWAL" : r.kind === "BILL" ? "BILL" : "NEW_CHARGE",
      amountMinor: -r.amount_minor,
      dueAt: r.due_at,
    }));
}

export function subscriptionWindowTotal(db: DatabaseSync, tenantId: string, contextId: string, window = SUBSCRIPTION_WINDOW): number {
  return scheduledItems(db, tenantId, contextId, "ui")
    .filter((r) => r.amount_minor < 0 && inWindow(r.due_at, window.startInclusive, window.endExclusive))
    .reduce((s, r) => s - r.amount_minor, 0);
}

export function addForecastItem(
  db: DatabaseSync,
  item: { tenantId: string; contextId: string; dataset: string; subscriptionId?: string | null; kind: string; label: string; amountMinor: number; dueAt: string; condition?: string | null; source: string; data?: object },
): string {
  const id = shortId("fc");
  run(
    db,
    `INSERT INTO forecast_items(id, tenant_id, context_id, dataset, subscription_id, kind, label, amount_minor, due_at, status, condition, source, data_json) VALUES (?,?,?,?,?,?,?,?,?,'SCHEDULED',?,?,?)`,
    id,
    item.tenantId,
    item.contextId,
    item.dataset,
    item.subscriptionId ?? null,
    item.kind,
    item.label,
    item.amountMinor,
    item.dueAt,
    item.condition ?? null,
    item.source,
    item.data ? JSON.stringify(item.data) : null,
  );
  return id;
}

/**
 * Apply one forecast change exactly once per source event. Returns false when the event was already applied.
 * kinds: REMOVE (renewal stopped / paused charge), CHANGE (amount/date), ADD (new commitment), SETTLE (now posted).
 */
export function applyForecastEvent(
  db: DatabaseSync,
  ev: {
    sourceEventId: string;
    tenantId: string;
    kind: "REMOVE" | "CHANGE" | "ADD" | "SETTLE";
    itemId?: string | null;
    changes?: { amountMinor?: number; dueAt?: string; label?: string };
    add?: Parameters<typeof addForecastItem>[1];
    reason: string;
  },
): boolean {
  if (one(db, "SELECT id FROM forecast_events WHERE tenant_id=? AND id=?", ev.tenantId, ev.sourceEventId)) return false;
  let itemId = ev.itemId ?? null;
  if (ev.kind === "REMOVE" && itemId) run(db, "UPDATE forecast_items SET status='REMOVED', revision=revision+1 WHERE id=? AND tenant_id=?", itemId, ev.tenantId);
  if (ev.kind === "SETTLE" && itemId) run(db, "UPDATE forecast_items SET status='SETTLED', revision=revision+1 WHERE id=? AND tenant_id=?", itemId, ev.tenantId);
  if (ev.kind === "CHANGE" && itemId && ev.changes) {
    const cur = one<any>(db, "SELECT * FROM forecast_items WHERE id=? AND tenant_id=?", itemId, ev.tenantId);
    if (cur) {
      run(db, "UPDATE forecast_items SET status='SUPERSEDED' WHERE id=?", itemId);
      itemId = addForecastItem(db, {
        tenantId: ev.tenantId,
        contextId: cur.context_id,
        dataset: cur.dataset,
        subscriptionId: cur.subscription_id,
        kind: cur.kind,
        label: ev.changes.label ?? cur.label,
        amountMinor: ev.changes.amountMinor ?? cur.amount_minor,
        dueAt: ev.changes.dueAt ?? cur.due_at,
        condition: cur.condition,
        source: ev.sourceEventId,
      });
    }
  }
  if (ev.kind === "ADD" && ev.add) itemId = addForecastItem(db, ev.add);
  run(db, "INSERT INTO forecast_events(id, tenant_id, forecast_item_id, kind, payload_json, applied_at) VALUES (?,?,?,?,?,?)", ev.sourceEventId, ev.tenantId, itemId, ev.kind, JSON.stringify({ reason: ev.reason, changes: ev.changes ?? null }), new Date().toISOString());
  return true;
}

export function upcomingFor(db: DatabaseSync, tenantId: string, contextId: string, window = SUBSCRIPTION_WINDOW) {
  const rows = scheduledItems(db, tenantId, contextId).filter((r) => toMs(r.due_at) >= toMs(window.startInclusive) - 86_400_000 * 0);
  return rows;
}
