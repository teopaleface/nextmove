import type { DatabaseSync } from "node:sqlite";
import { one, run } from "../db/connection";
import { shortId } from "../canonical";

// Durable task timeline, blocks and notifications. Chat text is never the record: every step, approval,
// attempt and receipt is persisted here and in the authority/execution tables.

/** At most n UTF-16 units, never ending on half of an emoji (SQLite would store the lone half as U+FFFD). */
export const cut = (s: string, n: number) => (s.length > n && /[\uD800-\uDBFF]/.test(s[n - 1]) ? s.slice(0, n - 1) : s.slice(0, n));

export type EvidenceLevel =
  | "DETERMINISTIC_CALCULATION"
  | "BANK_RECORD"
  | "BANK_LEDGER_POSTING"
  | "SIMULATED_MERCHANT_API"
  | "SIMULATED_MERCHANT_BROWSER"
  | "SIMULATED_MERCHANT_EVENT"
  | "LIVE_MODEL"
  | "LIVE_MODEL_VISION"
  | "SIMULATED_PLANNER"
  | "MANUAL_INPUT"
  | "PREPARED_NOT_SENT"
  | "FICTIONAL_CATALOG"
  | "CUSTOMER_APPROVAL";

export function taskEvent(db: DatabaseSync, e: { taskId: string | null; tenantId: string; kind: string; label: string; evidence?: EvidenceLevel | null; payload?: unknown }) {
  if (!e.taskId) return;
  run(
    db,
    "INSERT INTO task_events(task_id, tenant_id, kind, label, evidence, payload_json, created_at) VALUES (?,?,?,?,?,?,?)",
    e.taskId,
    e.tenantId,
    e.kind,
    cut(e.label, 400),
    e.evidence ?? null,
    e.payload === undefined ? null : JSON.stringify(e.payload),
    new Date().toISOString(),
  );
  run(db, "UPDATE tasks SET updated_at=? WHERE id=?", new Date().toISOString(), e.taskId);
}

export function setBlock(db: DatabaseSync, taskId: string, key: string, ordinal: number, kind: string, payload: unknown) {
  const now = new Date().toISOString();
  run(
    db,
    `INSERT INTO task_blocks(task_id, block_key, ordinal, kind, payload_json, revision, updated_at) VALUES (?,?,?,?,?,1,?)
     ON CONFLICT(task_id, block_key) DO UPDATE SET ordinal=excluded.ordinal, kind=excluded.kind, payload_json=excluded.payload_json, revision=task_blocks.revision+1, updated_at=excluded.updated_at`,
    taskId, key, ordinal, kind, JSON.stringify(payload), now,
  );
}

export function setTaskState(db: DatabaseSync, taskId: string, state: string, summary?: string | null) {
  // A task the customer stopped stays stopped; late worker steps cannot revive it.
  run(db, "UPDATE tasks SET state=?, summary=COALESCE(?, summary), updated_at=? WHERE id=? AND state != 'STOPPED'", state, summary ?? null, new Date().toISOString(), taskId);
}

export function notify(db: DatabaseSync, n: { tenantId: string; contextId: string; title: string; body: string; link?: string | null; findingId?: string | null; dedupeKey?: string }) {
  if (n.dedupeKey && one(db, "SELECT id FROM notifications WHERE id=?", n.dedupeKey)) return;
  run(
    db,
    "INSERT INTO notifications(id, tenant_id, context_id, finding_id, title, body, link, created_at) VALUES (?,?,?,?,?,?,?,?)",
    n.dedupeKey ?? shortId("ntf"),
    n.tenantId,
    n.contextId,
    n.findingId ?? null,
    n.title,
    n.body,
    n.link ?? null,
    new Date().toISOString(),
  );
}

export function taskIdForAction(db: DatabaseSync, actionId: string): string | null {
  return one<any>(db, "SELECT p.task_id FROM proposal_actions a JOIN proposals p ON p.id=a.proposal_id WHERE a.id=?", actionId)?.task_id ?? null;
}
