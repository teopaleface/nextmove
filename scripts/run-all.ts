import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DATA, LOG_DIR, PIDS_FILE, ROOT, httpOk, livePids, loadLocalEnv, portFree, readPids, waitFor, type PidRecord } from "./lib/procs";

// One command for the whole local system: simulated merchant (3211), bank database seed, durable worker and the
// Next.js bank app (3210). Everything binds to 127.0.0.1. PIDs go to .data/pids.json; `npm run stop` ends them.

loadLocalEnv();
const args = new Set(process.argv.slice(2));
const mode = args.has("--mode=development") ? "development" : "production";
const forceBuild = args.has("--build");
const bankPort = Number(process.env.NEXTMOVE_BANK_PORT ?? 3210);
const merchantPort = Number(process.env.NEXTMOVE_MERCHANT_PORT ?? 3211);
const bankUrl = `http://127.0.0.1:${bankPort}`;
const merchantUrl = `http://127.0.0.1:${merchantPort}`;
const env = { ...process.env, NEXTMOVE_ROOT: ROOT, NEXTMOVE_BANK_PORT: String(bankPort), NEXTMOVE_MERCHANT_PORT: String(merchantPort), NEXTMOVE_BANK_BASE_URL: bankUrl, NEXTMOVE_MERCHANT_BASE_URL: merchantUrl } as Record<string, string>;
const asEnv = (e: Record<string, string | undefined>) => e as unknown as NodeJS.ProcessEnv;
const children = new Map<string, ChildProcess>();
let stopping = false;
const log = (m: string) => process.stdout.write(`[run-all] ${m}\n`);

function start(name: string, cmd: string, argv: string[], extraEnv: Record<string, string> = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: "a" });
  const child = spawn(cmd, argv, { cwd: ROOT, env: asEnv({ ...env, ...extraEnv }), stdio: ["ignore", "pipe", "pipe"] as const });
  const prefix = (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).map((l) => `[${name}] ${l}\n`).join("");
  child.stdout!.on("data", (c: Buffer) => {
    out.write(c);
    process.stdout.write(prefix(c));
  });
  child.stderr!.on("data", (c: Buffer) => {
    out.write(c);
    process.stderr.write(prefix(c));
  });
  child.on("exit", (code: number | null, signal: string | null) => {
    children.delete(name);
    writePids();
    if (stopping) return;
    if (name === "worker") {
      log(`worker exited (${code ?? signal}); restarting in 1 s`);
      setTimeout(() => !stopping && startWorker(), 1000);
    } else {
      log(`${name} exited (${code ?? signal}); stopping everything`);
      void shutdown(1);
    }
  });
  children.set(name, child);
  writePids();
  return child;
}

function writePids() {
  const rec: PidRecord = { runner: process.pid, children: Object.fromEntries([...children].map(([n, c]) => [n, c.pid ?? 0])), startedAt: startedAt, mode, bankUrl, merchantUrl };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PIDS_FILE, JSON.stringify(rec, null, 2));
}

const tsx = ["--import", "tsx"];
const startWorker = () => start("worker", process.execPath, [...tsx, "src/worker/main.ts"]);
const startedAt = new Date().toISOString();

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

function needsBuild() {
  const id = path.join(ROOT, ".next", "BUILD_ID");
  if (forceBuild || !fs.existsSync(id)) return true;
  const built = fs.statSync(id).mtimeMs;
  return [path.join(ROOT, "src"), path.join(ROOT, "next.config.ts")].some((p) => (fs.statSync(p).isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs) > built);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log("stopping owned processes");
  for (const name of ["next", "worker", "merchant"]) children.get(name)?.kill("SIGTERM");
  await waitFor(async () => children.size === 0, 15_000, "children to exit").catch(() => {
    for (const c of children.values()) c.kill("SIGKILL");
  });
  try {
    fs.rmSync(PIDS_FILE);
  } catch {
    /* already gone */
  }
  log("stopped");
  process.exit(code);
}

async function main() {
  const existing = livePids(readPids()).filter((p) => p.pid !== process.pid);
  if (existing.length) {
    log(`already running (${existing.map((p) => `${p.name} ${p.pid}`).join(", ")}). Run \`npm run stop\` first.`);
    process.exit(1);
  }
  for (const port of [bankPort, merchantPort]) {
    if (!(await portFree(port))) {
      log(`port ${port} on 127.0.0.1 is in use by another process; refusing to start (only owned processes are managed).`);
      process.exit(1);
    }
  }
  if (mode === "production" && needsBuild()) {
    log("building the bank app (next build)");
    const r = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { cwd: ROOT, env: asEnv({ ...env, NODE_ENV: "production" }), stdio: "inherit" });
    if (r.status !== 0) {
      log("build failed");
      process.exit(r.status ?? 1);
    }
  }

  start("merchant", process.execPath, [...tsx, "src/merchant/main.ts"]);
  await waitFor(() => httpOk(`${merchantUrl}/health`), 20_000, "merchant health");
  log(`merchant ready on ${merchantUrl}`);

  const seed = spawnSync(process.execPath, [...tsx, "scripts/seed.ts"], { cwd: ROOT, env: asEnv(env), stdio: "inherit" });
  if (seed.status !== 0) {
    log("seed failed");
    await shutdown(1);
    return;
  }

  startWorker();
  const nextArgs = mode === "production" ? ["start", "-p", String(bankPort), "-H", "127.0.0.1"] : ["dev", "-p", String(bankPort), "-H", "127.0.0.1"];
  start("next", process.execPath, ["node_modules/next/dist/bin/next", ...nextArgs], { NODE_ENV: mode === "production" ? "production" : "development" });
  await waitFor(() => httpOk(`${bankUrl}/api/health`), mode === "production" ? 30_000 : 120_000, "bank health");
  log(`ready: ${bankUrl}  (health ${bankUrl}/api/health, merchant ${merchantUrl}/health, mode ${process.env.NEXTMOVE_MODE ?? "labs"})`);
  log(`pids: runner ${process.pid}, ${[...children].map(([n, c]) => `${n} ${c.pid}`).join(", ")}`);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
main().catch(async (e) => {
  log(`failed: ${e?.message ?? e}`);
  await shutdown(1);
});
