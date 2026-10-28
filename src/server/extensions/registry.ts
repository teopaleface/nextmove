import type { DatabaseSync } from "node:sqlite";
import { all, run, tx } from "../db/connection";
import { HttpError, type Session } from "../auth/session";
import type { CapabilityDef } from "../capabilities/core";
import type { ActionSpec } from "../authority/actions";
import { recordSettled } from "../execution/effects";
import { isExtOperation, type ExtActionContext, type ExtensionModule, type ExtPreDispatch } from "./types";
import { cancellationGuarantee } from "./modules/cancellation-guarantee";
import { exitPlan } from "./modules/exit-plan";
import { retentionOffers } from "./modules/retention-offers";
import { merchantInsights } from "./modules/merchant-insights";
import { priceGate } from "./modules/price-gate";
import { cardReissue } from "./modules/card-reissue";
import { businessMove } from "./modules/business-move";
import { certificate } from "./modules/certificate";
import { sharedSplit } from "./modules/shared-split";

// The wired extension modules (extensions/src). Order is display order on the capability list.

export const EXTENSIONS: ExtensionModule[] = [cancellationGuarantee, exitPlan, retentionOffers, merchantInsights, priceGate, cardReissue, businessMove, certificate, sharedSplit];

export const EXT_CAPABILITIES: CapabilityDef[] = EXTENSIONS.flatMap((m) => m.capabilities);
export const EXT_CAPABILITY_ORDER = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E7H", "E8", "E9"];

/** Every ext_* table carries tenant_id, so a tenant reset or deletion removes its extension rows too. */
export function extTenantTables(db: DatabaseSync): string[] {
  return all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ext\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name);
}

export function deleteExtTenantRows(db: DatabaseSync, tenantId: string) {
  // Children (tables whose rows reference another ext table) first: delete in reverse dependency order by retrying.
  let pending = extTenantTables(db);
  for (let pass = 0; pending.length && pass < 5; pass++) {
    const failed: string[] = [];
    for (const t of pending) {
      try {
        run(db, `DELETE FROM ${t} WHERE tenant_id=?`, tenantId);
      } catch {
        failed.push(t);
      }
    }
    pending = failed;
  }
  if (pending.length) throw new Error(`could not clear extension tables: ${pending.join(", ")}`);
}

export function seedExtensions(db: DatabaseSync, input: { tenantId: string; customer: "alex" | "laziz"; contexts: string[] }) {
  for (const m of EXTENSIONS) m.seed?.(db, input);
}

function handlerFor(op: string) {
  for (const m of EXTENSIONS) {
    const h = m.operations?.[op as `EXT_${string}`];
    if (h) return h;
  }
  return null;
}

/** Executor hook for EXT_* operations. Called only after the dispatch gate authorized the attempt. */
export async function runExtOperation(c: ExtActionContext) {
  const h = isExtOperation(c.spec.operation) ? handlerFor(c.spec.operation) : null;
  if (!h || c.spec.route !== "BANK_INTERNAL") {
    return void tx(c.db, () => recordSettled(c.db, c.action.id, c.attemptId, "BLOCKED", { reason: "This step has no bank handler in this build; nothing was changed" }));
  }
  try {
    tx(c.db, () => h(c));
  } catch (e: any) {
    // The handler's whole unit of work rolled back with it, so this is known to have changed nothing (not UNKNOWN).
    tx(c.db, () => recordSettled(c.db, c.action.id, c.attemptId, "BLOCKED", { reason: "The bank step failed and was rolled back; nothing was changed", error: String(e?.message ?? e).slice(0, 200) }));
  }
}

/** Executor hook before an attempt is created: a module may hold its conditional action (wait) or close it unsent. */
export async function extPreDispatch(c: { db: DatabaseSync; action: any; spec: ActionSpec; grant: any }): Promise<ExtPreDispatch> {
  for (const m of EXTENSIONS) {
    const r = await m.preDispatch?.(c);
    if (r !== undefined) return r;
  }
  return null;
}

export async function runExtLabs(db: DatabaseSync, session: Session, moduleKey: string, action: string, body: Record<string, unknown>) {
  const m = EXTENSIONS.find((x) => x.key === moduleKey);
  const fn = m?.labs && Object.prototype.hasOwnProperty.call(m.labs, action) ? m.labs[action] : undefined;
  if (!fn) throw new HttpError(400, "BAD_ACTION", "Unknown Labs action");
  return fn({ db, session, body });
}
