import fs from "node:fs";
import path from "node:path";
import { DATA, livePids, readPids } from "./lib/procs";

// Deletes local runtime state (bank and merchant databases, private uploads, browser captures, logs).
// Refuses while owned processes are running. `--all` also removes the generated local secrets.

const live = livePids(readPids());
if (live.length) {
  console.error(`[reset] refusing: running ${live.map((p) => `${p.name} ${p.pid}`).join(", ")}. Run \`npm run stop\` first.`);
  process.exit(1);
}
if (!fs.existsSync(DATA)) {
  console.log("[reset] nothing to reset");
  process.exit(0);
}
const removed: string[] = [];
for (const entry of fs.readdirSync(DATA)) {
  if (entry === "local-secrets.json" && !process.argv.includes("--all")) continue;
  fs.rmSync(path.join(DATA, entry), { recursive: true, force: true });
  removed.push(entry);
}
console.log(`[reset] removed ${removed.length ? removed.join(", ") : "nothing"} from ${path.relative(process.cwd(), DATA) || DATA}`);
