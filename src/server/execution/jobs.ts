import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../db/connection";
import { shortId } from "../canonical";

// Durable job queue with leases and fencing tokens. Claims run inside one BEGIN IMMEDIATE transaction, so the
// concurrency limits (per user, global, one mutation per canonical merchant account) hold across worker processes.

export const LEASE_MS = 30_000;

export type JobKind = "ACTION" | "RECONCILE" | "AGENT" | "INSPECT_BATCH" | "WATCH";
export type LaneName = "API" | "BROWSER" | "AGENT";

export const LANES: Record<LaneName, { perUser: number; global: number }> = {
  API: { perUser: 4, global: 8 },
  BROWSER: { perUser: 2, global: 4 },
  AGENT: { perUser: 2, global: 4 },
};

export interface Job {
  id: string;
  tenant_id: string;
  kind: JobKind;
  ref_id: string;
  route: string | null;
  status: string;
  priority: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fence: number;
  attempts: number;
  concurrency_key: string | null;
  user_key: string | null;
  last_error: string | null;
}

export function laneOf(job: Pick<Job, "kind" | "route">): LaneName {
  if (job.kind === "AGENT" || job.kind === "INSPECT_BATCH" || job.kind === "WATCH") return "AGENT";
  return job.route === "ISOLATED_BROWSER" ? "BROWSER" : "API";
}

/** Insert a job, or re-queue an existing finished one with the same (kind, ref). Returns the job id. */
export function enqueueJob(
  db: DatabaseSync,
  j: { tenantId: string; kind: JobKind; refId: string; route?: string | null; priority?: number; availableAt?: string; concurrencyKey?: string | null; userKey?: string | null; requeue?: boolean },
): string {
  const now = new Date().toISOString();
  const existing = one<Job>(db, "SELECT * FROM jobs WHERE kind=? AND ref_id=?", j.kind, j.refId);
  if (existing) {
    if (j.requeue && existing.status !== "QUEUED" && existing.status !== "LEASED") {
      run(db, "UPDATE jobs SET status='QUEUED', available_at=?, last_error=NULL, updated_at=? WHERE id=?", j.availableAt ?? now, now, existing.id);
    } else if (j.requeue && existing.status === "QUEUED" && j.availableAt && j.availableAt < existing.available_at) {
      run(db, "UPDATE jobs SET available_at=?, updated_at=? WHERE id=?", j.availableAt, now, existing.id);
    }
    return existing.id;
  }
  const id = shortId("job");
  run(
    db,
    `INSERT INTO jobs(id, tenant_id, kind, ref_id, route, status, priority, available_at, fence, attempts, concurrency_key, user_key, created_at, updated_at)
     VALUES (?,?,?,?,?, 'QUEUED', ?, ?, 0, 0, ?, ?, ?, ?)`,
    id, j.tenantId, j.kind, j.refId, j.route ?? null, j.priority ?? 5, j.availableAt ?? now, j.concurrencyKey ?? null, j.userKey ?? null, now, now,
  );
  return id;
}

/** Claim up to `max` ready jobs for this worker, honouring lane limits and per-key serialization. */
export function claimJobs(db: DatabaseSync, workerId: string, max: number, kinds?: JobKind[]): Job[] {
  return tx(db, () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const leased = all<Job>(db, "SELECT * FROM jobs WHERE status='LEASED' AND lease_expires_at > ?", nowIso);
    const laneGlobal: Record<string, number> = {};
    const laneUser: Record<string, number> = {};
    const keys = new Set<string>();
    for (const l of leased) {
      const lane = laneOf(l);
      laneGlobal[lane] = (laneGlobal[lane] ?? 0) + 1;
      laneUser[`${lane}|${l.user_key}`] = (laneUser[`${lane}|${l.user_key}`] ?? 0) + 1;
      if (l.concurrency_key) keys.add(l.concurrency_key);
    }
    const ready = all<Job>(
      db,
      `SELECT * FROM jobs WHERE status='QUEUED' AND available_at <= ? ${kinds ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY priority, available_at LIMIT 400`,
      nowIso,
      ...(kinds ?? []),
    );
    const claimed: Job[] = [];
    for (const j of ready) {
      if (claimed.length >= max) break;
      const lane = laneOf(j);
      const limits = LANES[lane];
      if ((laneGlobal[lane] ?? 0) >= limits.global) continue;
      if ((laneUser[`${lane}|${j.user_key}`] ?? 0) >= limits.perUser) continue;
      if (j.concurrency_key && keys.has(j.concurrency_key)) continue;
      const expires = new Date(now + LEASE_MS).toISOString();
      run(db, "UPDATE jobs SET status='LEASED', lease_owner=?, lease_expires_at=?, fence=fence+1, attempts=attempts+1, updated_at=? WHERE id=? AND status='QUEUED'", workerId, expires, nowIso, j.id);
      laneGlobal[lane] = (laneGlobal[lane] ?? 0) + 1;
      laneUser[`${lane}|${j.user_key}`] = (laneUser[`${lane}|${j.user_key}`] ?? 0) + 1;
      if (j.concurrency_key) keys.add(j.concurrency_key);
      claimed.push({ ...j, status: "LEASED", lease_owner: workerId, lease_expires_at: expires, fence: j.fence + 1, attempts: j.attempts + 1 });
    }
    return claimed;
  });
}

export function renewLease(db: DatabaseSync, job: Pick<Job, "id" | "fence">, workerId: string): boolean {
  const expires = new Date(Date.now() + LEASE_MS).toISOString();
  const r = run(db, "UPDATE jobs SET lease_expires_at=?, updated_at=? WHERE id=? AND lease_owner=? AND fence=? AND status='LEASED'", expires, new Date().toISOString(), job.id, workerId, job.fence);
  return Number(r.changes) === 1;
}

/** Finish or re-queue a job; ignored when this worker no longer holds the current fence. */
export function finishJob(db: DatabaseSync, job: Pick<Job, "id" | "fence">, workerId: string, next: { status: "DONE" | "QUEUED" | "PARKED" | "FAILED"; availableAt?: string; error?: string | null }): boolean {
  const r = run(
    db,
    "UPDATE jobs SET status=?, available_at=COALESCE(?, available_at), lease_owner=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE id=? AND lease_owner=? AND fence=?",
    next.status, next.availableAt ?? null, next.error ?? null, new Date().toISOString(), job.id, workerId, job.fence,
  );
  return Number(r.changes) === 1;
}

/**
 * Return expired leases to the queue. An action attempt that never passed the dispatch gate is closed as
 * NOT_DISPATCHED; one that passed the gate may have reached the merchant and becomes UNKNOWN (reconcile first).
 */
export function recoverExpiredLeases(db: DatabaseSync): { requeued: number; unknown: number } {
  return tx(db, () => {
    const nowIso = new Date().toISOString();
    const expired = all<Job>(db, "SELECT * FROM jobs WHERE status='LEASED' AND lease_expires_at <= ?", nowIso);
    let unknown = 0;
    for (const j of expired) {
      if (j.kind === "ACTION") {
        for (const a of all<any>(db, "SELECT id, status FROM attempts WHERE job_id=? AND fence=? AND status IN ('CLAIMED','DISPATCH_AUTHORIZED','SENT')", j.id, j.fence)) {
          if (a.status === "CLAIMED") run(db, "UPDATE attempts SET status='NOT_DISPATCHED', finished_at=?, outcome_json=? WHERE id=?", nowIso, JSON.stringify({ reason: "Worker stopped before the dispatch gate" }), a.id);
          else {
            run(db, "UPDATE attempts SET status='UNKNOWN', next_reconcile_at=?, outcome_json=? WHERE id=?", nowIso, JSON.stringify({ reason: "Worker stopped after dispatch authorization; the merchant may have committed" }), a.id);
            unknown++;
          }
        }
      }
      run(db, "UPDATE jobs SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, last_error='LEASE_EXPIRED', updated_at=? WHERE id=?", nowIso, j.id);
    }
    return { requeued: expired.length, unknown };
  });
}

export function heartbeat(db: DatabaseSync, workerId: string, info: Record<string, unknown>) {
  const now = new Date().toISOString();
  run(
    db,
    `INSERT INTO worker_heartbeats(worker_id, pid, started_at, beat_at, info_json) VALUES (?,?,?,?,?)
     ON CONFLICT(worker_id) DO UPDATE SET beat_at=excluded.beat_at, info_json=excluded.info_json`,
    workerId, process.pid, now, now, JSON.stringify(info),
  );
}

export function workerStatus(db: DatabaseSync) {
  const beats = all<any>(db, "SELECT * FROM worker_heartbeats ORDER BY beat_at DESC");
  const live = beats.filter((b) => Date.now() - Date.parse(b.beat_at) < 10_000);
  const queue = all<any>(db, "SELECT kind, status, COUNT(*) n FROM jobs GROUP BY kind, status");
  return { live: live.map((b) => ({ workerId: b.worker_id, pid: b.pid, beatAt: b.beat_at, info: JSON.parse(b.info_json ?? "{}") })), queue };
}
