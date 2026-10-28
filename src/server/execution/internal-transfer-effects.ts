import type { DatabaseSync } from "node:sqlite";
import { all, one } from "../db/connection";
import { applyForecastEvent } from "../bank/forecast";
import type { ActionSpec } from "../authority/actions";
import type { TransferParams } from "./internal-transfer";

// Forecast effects of a confirmed internal transfer. Runs inside recordConfirmed's transaction, once per receipt.
// The ledger posting itself is made by the transfer adapter in the same transaction.

export function autopilotSource(legId: string) {
  return `autopilot:${legId}`;
}

export function applyInternalTransferEffects(db: DatabaseSync, action: any, spec: ActionSpec, src: string) {
  const p = spec.params as unknown as TransferParams;
  const t = action.tenant_id;
  if (p.purpose === "VAULT_PARK") {
    // The approved returns become visible dated inflows on the current account.
    for (const r of p.returnSchedule ?? []) {
      applyForecastEvent(db, {
        sourceEventId: `${src}:ret:${r.legId}`,
        tenantId: t,
        kind: "ADD",
        add: { tenantId: t, contextId: action.context_id, dataset: "autopilot", kind: "PLANNED_TRANSFER", label: `Back from Bill vault: ${r.label}`, amountMinor: r.amountMinor, dueAt: r.returnAt, condition: "Scheduled return you approved", source: autopilotSource(r.legId) },
        reason: `Bill vault park posted (${src})`,
      });
    }
  }
  if (p.purpose === "VAULT_RETURN") {
    const item = one<any>(db, "SELECT id FROM forecast_items WHERE tenant_id=? AND source=? AND status='SCHEDULED'", t, autopilotSource(p.legId));
    if (item) applyForecastEvent(db, { sourceEventId: `${src}:settle`, tenantId: t, kind: "SETTLE", itemId: item.id, reason: `Bill vault return posted (${src})` });
  }
  if (p.purpose === "VAULT_RETURN_ALL" && p.planId) {
    for (const item of all<any>(db, "SELECT id FROM forecast_items WHERE tenant_id=? AND source LIKE ? AND status='SCHEDULED'", t, `${autopilotSource(p.planId)}%`)) {
      applyForecastEvent(db, { sourceEventId: `${src}:settle:${item.id}`, tenantId: t, kind: "SETTLE", itemId: item.id, reason: `Bill vault emptied early (${src})` });
    }
  }
}
