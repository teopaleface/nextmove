import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config, dataDir } from "../config";
import { run, one } from "../db/connection";
import { shortId } from "../canonical";

// Server-only adapter for the locally authenticated, first-party Claude Code CLI in headless print mode.
// - Fixed argument array (no shell), prompt and image bytes only through stdin.
// - All tools disabled, no MCP servers, no slash commands or skills, no session persistence, safe mode; only user
//   settings load (where CLI sign-in may live) and anything that would ask for permission is denied (HARDENING_FLAGS).
// - Empty sandbox working directory and a minimal environment (no application secrets are inherited).
// - Bounded: timeout, spend ceiling, output size and process concurrency.
// - Only metadata is logged (purpose, sizes, duration, status); never prompt text or image payloads.

export interface ModelImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: Buffer;
}

export interface ModelRequest {
  purpose: string;
  system: string;
  text: string;
  images?: ModelImage[];
  schema: Record<string, unknown>;
  tenantId?: string | null;
  taskId?: string | null;
  timeoutMs?: number;
}

export type ModelResult =
  | { ok: true; output: unknown; model: string; durationMs: number; costUsd: number | null; callId: string }
  | { ok: false; status: "ERROR" | "TIMEOUT" | "UNAVAILABLE" | "BUDGET"; error: string; callId: string; costUsd?: number | null };

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_CONCURRENCY = 2;
let active = 0;
const waiters: (() => void)[] = [];

async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}

function sandboxDir() {
  const dir = path.join(dataDir(), "model-sandbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "TERM"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.NO_COLOR = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env as NodeJS.ProcessEnv;
}

/**
 * Flags every CLI call must carry (ADR 0005). Left out on purpose: --bare (it reads only ANTHROPIC_API_KEY or an
 * apiKeyHelper passed with --settings, never the OAuth/keychain sign-in) and --restricted (it ignores user settings,
 * which can hold the apiKeyHelper sign-in). With --tools "" no tool runs either way.
 */
export const HARDENING_FLAGS: readonly (readonly string[])[] = [
  ["--tools", ""],
  ["--safe-mode"],
  ["--no-session-persistence"],
  ["--strict-mcp-config"],
  ["--disable-slash-commands"],
  ["--setting-sources", "user"],
  ["--permission-prompts", "none"],
];

/** What an argv lacks against HARDENING_FLAGS (each flag with its exact value), for the worker's startup check and tests. */
export function hardeningProblems(argv: readonly string[]): string[] {
  const problems = HARDENING_FLAGS.filter(([flag, ...values]) => {
    const i = argv.indexOf(flag);
    return i < 0 || values.some((v, j) => argv[i + 1 + j] !== v);
  }).map((f) => `missing ${f.join(" ").trim()}`);
  // Nothing may add an MCP server, a tool or a different sign-in next to them.
  for (const f of ["--mcp-config", "--allowedTools", "--allowed-tools", "--bare", "--dangerously-skip-permissions", "--settings"]) if (argv.includes(f)) problems.push(`unexpected ${f}`);
  return problems;
}

export function cliArgs(model: string, system: string, schema: Record<string, unknown>) {
  return [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    ...HARDENING_FLAGS.flat(),
    "--model",
    model,
    "--effort",
    "low",
    "--max-budget-usd",
    String(config.modelMaxBudgetUsd),
    "--system-prompt",
    system,
    "--json-schema",
    JSON.stringify(schema),
  ];
}

function logCall(db: DatabaseSync | null, row: { id: string; tenantId?: string | null; taskId?: string | null; purpose: string; model: string; status: string; durationMs: number; inputChars: number; imageCount: number; outputChars: number; costUsd: number | null; error: string | null }) {
  if (!db) return;
  try {
    run(
      db,
      "INSERT INTO model_calls(id, tenant_id, task_id, purpose, model, status, duration_ms, input_chars, image_count, output_chars, cost_usd, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      row.id, row.tenantId ?? null, row.taskId ?? null, row.purpose, row.model, row.status, row.durationMs, row.inputChars, row.imageCount, row.outputChars, row.costUsd, row.error, new Date().toISOString(),
    );
  } catch {
    /* metadata logging must never break a request */
  }
}

/**
 * Why no further live call may start now, or null. Calls that reached the CLI in the last 24 hours count (a call
 * that could not start spent nothing); one with no reported cost counts at its per-call maximum, since a timeout may
 * have spent all of it. A bad setting fails closed: no live calls.
 */
export function modelBudgetProblem(db: DatabaseSync, tenantId?: string | null): string | null {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  // A call counts unless it provably cost nothing: the CLI reported a cost of 0, or it refused at the account level
  // ("You've hit your monthly spend limit") before reaching the model. Such refusals arrive in a burst while the
  // account is capped and would otherwise use up the day's budget for the hours after the cap is lifted.
  const counted = "created_at > ? AND (status IN ('OK','TIMEOUT') OR (status = 'ERROR' AND COALESCE(cost_usd, -1) <> 0 AND COALESCE(error, '') NOT LIKE 'You''ve hit your %limit%'))";
  const perCall = Number(config.modelMaxBudgetUsd);
  const caps = { calls: config.modelDailyCalls, usd: config.modelDailyUsd, tenant: config.modelTenantDailyCalls };
  if (![caps.calls, caps.usd, caps.tenant].every((n) => Number.isFinite(n) && n >= 0)) return "The live-model budget settings are invalid";
  const used = one<any>(db, `SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cost_usd, ?)), 0) usd FROM model_calls WHERE ${counted}`, Number.isFinite(perCall) ? perCall : 0, since);
  if ((used?.n ?? 0) >= caps.calls) return `Daily live-model call limit reached (${caps.calls})`;
  if ((used?.usd ?? 0) >= caps.usd) return `Daily live-model spend limit reached (${caps.usd} USD)`;
  if (tenantId) {
    const mine = one<any>(db, `SELECT COUNT(*) n FROM model_calls WHERE tenant_id=? AND ${counted}`, tenantId, since);
    if ((mine?.n ?? 0) >= caps.tenant) return `Daily live-model limit for this customer reached (${caps.tenant})`;
  }
  return null;
}

export async function callModel(db: DatabaseSync | null, req: ModelRequest): Promise<ModelResult> {
  const callId = shortId("mc");
  const model = config.model;
  const started = Date.now();
  const content: any[] = [];
  for (const img of req.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") } });
  content.push({ type: "text", text: req.text });
  const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  const meta = { id: callId, tenantId: req.tenantId, taskId: req.taskId, purpose: req.purpose, model, inputChars: req.text.length, imageCount: req.images?.length ?? 0 };
  await acquire();
  try {
    // Checked after the slot is taken, so calls queued behind each other cannot all pass on the same count.
    const over = db ? modelBudgetProblem(db, req.tenantId) : null;
    if (over) return { ok: false, status: "BUDGET", error: over, callId };
    const result = await new Promise<ModelResult>((resolve) => {
      let child;
      try {
        const argv = cliArgs(model, req.system, req.schema);
        // Never run the CLI without its hardening, whatever edits cliArgs later (the worker also checks at startup).
        const problems = hardeningProblems(argv);
        if (problems.length) return resolve({ ok: false, status: "UNAVAILABLE", error: `CLI flags refused: ${problems.join(", ")}`, callId });
        child = spawn(config.claudeBin, argv, { cwd: sandboxDir(), env: minimalEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (e: any) {
        return resolve({ ok: false, status: "UNAVAILABLE", error: `CLI not startable: ${String(e?.code ?? e?.message ?? e)}`, callId });
      }
      let out = "";
      let errText = "";
      let settled = false;
      const done = (r: ModelResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        done({ ok: false, status: "TIMEOUT", error: `No answer within ${Math.round((req.timeoutMs ?? config.modelTimeoutMs) / 1000)} s`, callId });
      }, req.timeoutMs ?? config.modelTimeoutMs);
      child.on("error", (e: any) => done({ ok: false, status: "UNAVAILABLE", error: `CLI unavailable: ${String(e?.code ?? e?.message ?? e)}`, callId }));
      child.stdout.on("data", (b: Buffer) => {
        if (out.length < MAX_OUTPUT_BYTES) out += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        if (errText.length < 4000) errText += b.toString("utf8");
      });
      child.on("close", (code: number | null) => {
        const resultLine = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter((x) => x && x.type === "result")
          .pop();
        if (!resultLine) return done({ ok: false, status: "ERROR", error: sanitizeError(errText || `CLI exited with code ${code} without a result`), callId });
        const costUsd = typeof resultLine.total_cost_usd === "number" ? resultLine.total_cost_usd : null;
        if (resultLine.is_error || resultLine.subtype !== "success") return done({ ok: false, status: "ERROR", error: sanitizeError(String(resultLine.result ?? resultLine.subtype ?? "model error")), callId, costUsd });
        let output = resultLine.structured_output;
        if (output === undefined && typeof resultLine.result === "string") {
          try {
            output = JSON.parse(resultLine.result);
          } catch {
            output = undefined;
          }
        }
        if (output === undefined) return done({ ok: false, status: "ERROR", error: "The model did not return structured output", callId, costUsd });
        const usedModel = Object.keys(resultLine.modelUsage ?? {})[0] ?? model;
        done({ ok: true, output: sanitizeValue(output), model: usedModel, durationMs: Date.now() - started, costUsd, callId });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(line);
    });
    logCall(db, {
      ...meta,
      model: result.ok ? result.model : model,
      status: result.ok ? "OK" : result.status,
      durationMs: Date.now() - started,
      outputChars: result.ok ? JSON.stringify(result.output).length : 0,
      costUsd: result.costUsd ?? null,
      error: result.ok ? null : result.error.slice(0, 300),
    });
    if (db) {
      try {
        run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES ('model:last', ?, ?)", JSON.stringify({ ok: result.ok, model: result.ok ? result.model : model, status: result.ok ? "OK" : result.status, purpose: req.purpose, at: new Date().toISOString(), durationMs: Date.now() - started }), new Date().toISOString());
      } catch {
        /* ignore */
      }
    }
    return result;
  } finally {
    release();
  }
}

/** Remove control characters and cap string sizes in model output before any further validation. */
export function sanitizeValue(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof v === "string") return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "").slice(0, 4000);
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => sanitizeValue(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 64)) o[k.slice(0, 64)] = sanitizeValue(x, depth + 1);
    return o;
  }
  return typeof v === "number" || typeof v === "boolean" || v === null ? v : null;
}

function sanitizeError(s: string) {
  return s.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Model health for display. Without `detail` (the unauthenticated health and session routes) CLI error text is left out. */
export function lastModelStatus(db: DatabaseSync, detail = false) {
  const last = one<any>(db, "SELECT value_json, updated_at FROM system_status WHERE key='model:last'");
  const smoke = one<any>(db, "SELECT value_json, updated_at FROM system_status WHERE key='model:smoke'");
  const calls = one<any>(db, "SELECT COUNT(*) n, SUM(CASE WHEN status='OK' THEN 1 ELSE 0 END) ok, SUM(image_count) images FROM model_calls");
  return {
    configuredModel: config.model,
    planner: config.planner,
    last: last ? JSON.parse(last.value_json) : null,
    smoke: smoke ? (({ error, ...rest }) => (detail ? { error, ...rest } : rest))(JSON.parse(smoke.value_json)) : null,
    totals: { calls: calls?.n ?? 0, ok: calls?.ok ?? 0, images: calls?.images ?? 0 },
  };
}
