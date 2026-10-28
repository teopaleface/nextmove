import fs from "node:fs";
import { PIDS_FILE, isAlive, livePids, readPids, waitFor } from "./lib/procs";

// Stops only the processes recorded by run-all. Sends SIGTERM to the runner (which stops its children), then to any
// recorded child that is still alive; SIGKILL only after 15 s.

const rec = readPids();
const live = livePids(rec);
if (!rec || live.length === 0) {
  console.log("[stop] nothing running");
  try {
    fs.rmSync(PIDS_FILE);
  } catch {
    /* none */
  }
  process.exit(0);
}
const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
};
if (isAlive(rec.runner)) signal(rec.runner, "SIGTERM");
else for (const p of live) signal(p.pid, "SIGTERM");
try {
  await waitFor(async () => livePids(rec).length === 0, 15_000, "processes to exit");
} catch {
  for (const p of livePids(rec)) {
    console.log(`[stop] ${p.name} ${p.pid} did not exit; sending SIGKILL`);
    signal(p.pid, "SIGKILL");
  }
}
try {
  fs.rmSync(PIDS_FILE);
} catch {
  /* runner removed it */
}
console.log(`[stop] stopped ${live.map((p) => `${p.name} ${p.pid}`).join(", ")}`);
