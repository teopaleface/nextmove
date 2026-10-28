import fs from "node:fs";
import path from "node:path";

// Shared helpers for the local process scripts. Only PIDs recorded by run-all in .data/pids.json are ever signalled.

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DATA = path.resolve(ROOT, process.env.NEXTMOVE_DATA_DIR ?? ".data");
export const PIDS_FILE = path.join(DATA, "pids.json");
export const LOG_DIR = path.join(DATA, "logs");

export interface PidRecord {
  runner: number;
  children: Record<string, number>;
  startedAt: string;
  mode: string;
  bankUrl: string;
  merchantUrl: string;
}

export function isAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export function readPids(): PidRecord | null {
  try {
    return JSON.parse(fs.readFileSync(PIDS_FILE, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

export function livePids(rec: PidRecord | null): { name: string; pid: number }[] {
  if (!rec) return [];
  const out = [{ name: "runner", pid: rec.runner }, ...Object.entries(rec.children).map(([name, pid]) => ({ name, pid }))];
  return out.filter((p) => isAlive(p.pid));
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function httpOk(url: string): Promise<boolean> {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return r.ok;
}

export async function portFree(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export function loadLocalEnv() {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(ROOT, name);
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
