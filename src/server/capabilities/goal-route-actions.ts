import type { DatabaseSync } from "node:sqlite";
import { one, run, tx } from "../db/connection";
import { config } from "../config";
import { shortId } from "../canonical";
import { HttpError, type Session } from "../auth/session";
import { ROADBLOCKS } from "../finance/route";
import { analyzeCapability, findCapability, proposeFromCapability } from "./registry";
import { ROUTE_PREF_KEY, storedRoadblocks } from "./goal-route";
import type { RouteView } from "./goal-route";

// Mutations for O6. Roadblocks are Labs events stored for the signed-in demo tenant and context only. Choosing a
// reroute either prepares a proposal through the existing approval flow (only where an executable action exists)
// or records a customer-confirmed plan change. Neither moves money.

async function view(db: DatabaseSync, session: Session) {
  const a = (await analyzeCapability(db, session, "O6", {})) as any;
  return { analysis: a, route: a.route as RouteView | null };
}

function requireLabs() {
  if (config.mode !== "labs") throw new HttpError(403, "LABS_DISABLED", "Labs controls are disabled in the bank demo");
}

function saveRoadblocks(db: DatabaseSync, session: Session, ids: string[]) {
  run(
    db,
    `INSERT INTO preferences(id, tenant_id, context_id, key, value_json, source, revision, updated_at) VALUES (?,?,?,?,?, 'LABS', 1, ?)
     ON CONFLICT(tenant_id, context_id, key) DO UPDATE SET value_json=excluded.value_json, revision=preferences.revision+1, updated_at=excluded.updated_at`,
    shortId("pref"), session.tenantId, session.contextId, ROUTE_PREF_KEY, JSON.stringify(ids), new Date().toISOString(),
  );
}

export async function setRoadblock(db: DatabaseSync, session: Session, id: string, on: boolean) {
  requireLabs();
  findCapability(db, session, "O6");
  if (!ROADBLOCKS.some((r) => r.id === id)) throw new HttpError(400, "BAD_ROADBLOCK", "Unknown roadblock");
  const now = storedRoadblocks({ db, tenantId: session.tenantId, contextId: session.contextId });
  const next = ROADBLOCKS.map((r) => r.id).filter((x) => (x === id ? on : now.includes(x)));
  saveRoadblocks(db, session, next);
  return view(db, session);
}

export async function resetRoute(db: DatabaseSync, session: Session) {
  requireLabs();
  findCapability(db, session, "O6");
  run(db, "DELETE FROM preferences WHERE tenant_id=? AND context_id=? AND key=?", session.tenantId, session.contextId, ROUTE_PREF_KEY);
  return view(db, session);
}

export async function chooseReroute(db: DatabaseSync, session: Session, routeId: string) {
  const { route } = await view(db, session);
  if (!route) throw new HttpError(409, "NO_ROUTE", "The home goal needs all its costs before a route can be planned");
  const r = route.reroutes.find((x) => x.id === routeId);
  if (!r) throw new HttpError(400, "UNKNOWN_ROUTE", "This reroute is no longer offered. Refresh and try again.");
  if (r.verdict !== "OK" || !r.action) throw new HttpError(409, "ROUTE_REJECTED", r.reason ?? "This reroute is not available");
  const roadblocks = route.roadblocks.filter((x) => x.active).map((x) => x.id);
  let proposalId: string | null = null;
  if (r.action === "PROPOSAL") {
    const a = await analyzeCapability(db, session, "O6", {});
    const keys = a.candidates.filter((c) => c.available).map((c) => c.key);
    if (!keys.length) throw new HttpError(409, "NOT_AVAILABLE", "The charges NextMove found can no longer be stopped. Refresh the route.");
    proposalId = (await proposeFromCapability(db, session, "O6", keys, {})).id;
  }
  const goal = one<any>(db, "SELECT id, revision FROM goals WHERE tenant_id=? AND context_id=? AND kind='HOME' LIMIT 1", session.tenantId, session.contextId);
  const label = `Route ${r.id}: ${r.title.toLowerCase()}, home ${r.arrival}`;
  const id = shortId("cmp");
  tx(db, () =>
    run(
      db,
      "INSERT INTO saved_comparisons(id, tenant_id, context_id, goal_id, kind, input_revision, inputs_json, result_json, choice, created_at) VALUES (?,?,?,?, 'O6', ?, ?, ?, ?, ?)",
      id, session.tenantId, session.contextId, goal?.id ?? null, goal?.revision ?? 1,
      JSON.stringify({ roadblocks, route: r.id, proposalId }),
      JSON.stringify({ headline: `${label}. ${r.summary}`, arrival: r.arrival, impact: r.impact, reserve: r.reserve }),
      label.slice(0, 80), new Date().toISOString(),
    ),
  );
  return { saved: id, proposalId, route: r.id, label };
}
