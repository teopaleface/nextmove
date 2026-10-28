import { randomBytes } from "node:crypto";
import { bankDb } from "../server/db/connection";
import { run } from "../server/db/connection";
import { claimJobs, heartbeat, recoverExpiredLeases, type Job } from "../server/execution/jobs";
import { runActionJob, runReconcileJob, enqueueDueReconciliations, type WorkerCtx } from "../server/execution/executor";
import { applyPendingInbox } from "../server/execution/inbox";
import { runInspectBatchJob } from "../server/capabilities/batch";
import { runAgentJob } from "../server/agent/orchestrator";
import { runDueWatches } from "../server/monitoring/watches";
import { closeSharedBrowser } from "../server/execution/browser";
import { callModel, cliArgs, hardeningProblems } from "../server/model/claude-cli";
import { config } from "../server/config";

// Durable local worker. Several workers may run against the same database: claims, leases and fences live in
// SQLite, and the dispatch gate re-checks authority at the moment of each external effect.

const db = bankDb();
const workerId = `w-${process.pid}-${randomBytes(3).toString("hex")}`;
const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
const ctx: WorkerCtx = { workerId, log };
const MAX_IN_FLIGHT = Number(process.env.NEXTMOVE_WORKER_CONCURRENCY ?? 12);
const running = new Map<string, Promise<void>>();
let stopping = false;
let last = { beat: 0, recover: 0, watches: 0 };
const started = Date.now();

async function dispatch(job: Job) {
  try {
    if (job.kind === "ACTION") await runActionJob(db, job, ctx);
    else if (job.kind === "RECONCILE") await runReconcileJob(db, job, ctx);
    else if (job.kind === "AGENT") await runAgentJob(db, job, ctx);
    else if (job.kind === "INSPECT_BATCH") await runInspectBatchJob(db, job, ctx);
  } catch (e: any) {
    log(`[worker] ${job.kind} ${job.ref_id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    run(db, "UPDATE jobs SET status='QUEUED', available_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error=? WHERE id=? AND lease_owner=? AND fence=?", new Date(Date.now() + 5000).toISOString(), String(e?.message ?? e).slice(0, 200), job.id, workerId, job.fence);
  }
}

async function tick() {
  const now = Date.now();
  if (now - last.beat > 2000) {
    heartbeat(db, workerId, { running: running.size, kinds: [...running.keys()].map((k) => k.split(":")[0]), uptimeS: Math.round((now - started) / 1000), mode: config.mode, planner: config.planner });
    last.beat = now;
  }
  if (now - last.recover > 5000) {
    const r = recoverExpiredLeases(db);
    if (r.requeued) log(`[worker] recovered ${r.requeued} expired lease(s); ${r.unknown} attempt(s) marked unknown`);
    last.recover = now;
  }
  applyPendingInbox(db);
  enqueueDueReconciliations(db);
  if (now - last.watches > 3000) {
    last.watches = now;
    runDueWatches(db, workerId).catch((e) => log(`[worker] watches ${String(e?.message ?? e)}`));
  }
  const free = MAX_IN_FLIGHT - running.size;
  if (free > 0 && !stopping) {
    for (const job of claimJobs(db, workerId, free)) {
      const key = `${job.kind}:${job.id}`;
      const p = dispatch(job).finally(() => running.delete(key));
      running.set(key, p);
    }
  }
}

/** The CLI must carry every hardening flag (ADR 0005); otherwise the planner is reported misconfigured, not ready. */
function checkCliFlags() {
  const problems = hardeningProblems(cliArgs(config.model, "", {}));
  if (!problems.length) return true;
  run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES ('model:smoke', ?, ?)", JSON.stringify({ ok: false, status: "MISCONFIGURED", reason: "Model CLI flags are missing hardening", at: new Date().toISOString() }), new Date().toISOString());
  log(`[worker] model CLI misconfigured: ${problems.join(", ")}`);
  return false;
}

async function smoke() {
  if (config.planner === "simulated") {
    run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES ('model:smoke', ?, ?)", JSON.stringify({ ok: false, skipped: true, reason: "NEXTMOVE_PLANNER=simulated", at: new Date().toISOString() }), new Date().toISOString());
    return;
  }
  const r = await callModel(db, { purpose: "smoke", system: "Reply with the JSON requested. No other text.", text: 'Return {"ok": true, "word": "ready"}.', schema: { type: "object", additionalProperties: false, required: ["ok", "word"], properties: { ok: { type: "boolean" }, word: { type: "string" } } }, timeoutMs: 60_000 });
  const value = r.ok ? { ok: true, model: r.model, durationMs: r.durationMs, output: r.output, at: new Date().toISOString() } : { ok: false, status: r.status, error: r.error, at: new Date().toISOString() };
  run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES ('model:smoke', ?, ?)", JSON.stringify(value), new Date().toISOString());
  log(`[worker] model smoke: ${r.ok ? `ok (${r.model}, ${r.durationMs} ms)` : `${r.status}: ${r.error}`}`);
}

async function main() {
  log(`[worker] ${workerId} started (mode ${config.mode}, planner ${config.planner})`);
  if (checkCliFlags() && !process.env.NEXTMOVE_SKIP_SMOKE) smoke().catch(() => undefined);
  while (!stopping) {
    try {
      await tick();
    } catch (e: any) {
      log(`[worker] tick error ${String(e?.message ?? e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`[worker] ${signal}: finishing ${running.size} in-flight job(s)`);
  const deadline = new Promise((r) => setTimeout(r, 10_000));
  await Promise.race([Promise.allSettled([...running.values()]), deadline]);
  await closeSharedBrowser();
  run(db, "DELETE FROM worker_heartbeats WHERE worker_id=?", workerId);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
void main();
