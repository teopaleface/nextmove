import fs from "node:fs";
import path from "node:path";
import { bankDb, run } from "../src/server/db/connection";
import { callModel } from "../src/server/model/claude-cli";
import { config } from "../src/server/config";
import { loadLocalEnv, ROOT } from "./lib/procs";

// Live smoke test of the server-side Claude CLI adapter: one structured text call and one vision call on a synthetic
// image. Prints only metadata and the validated structured answer (no prompt text, no image bytes).

loadLocalEnv();
const db = bankDb();

const text = await callModel(db, {
  purpose: "smoke",
  system: "Reply with the JSON requested. No other text.",
  text: 'Return {"ok": true, "word": "ready"}.',
  schema: { type: "object", additionalProperties: false, required: ["ok", "word"], properties: { ok: { type: "boolean" }, word: { type: "string" } } },
  timeoutMs: 90_000,
});
console.log(`[smoke] text: ${text.ok ? `ok model=${text.model} ${text.durationMs} ms output=${JSON.stringify(text.output)}` : `${text.status}: ${text.error}`}`);
run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES ('model:smoke', ?, ?)", JSON.stringify(text.ok ? { ok: true, model: text.model, durationMs: text.durationMs, output: text.output, at: new Date().toISOString() } : { ok: false, status: text.status, error: text.error, at: new Date().toISOString() }), new Date().toISOString());

const image = path.join(ROOT, "fixtures", "images", "screen-time.png");
if (!fs.existsSync(image)) {
  console.log("[smoke] vision: skipped (run npm run fixtures:images)");
} else {
  const vision = await callModel(db, {
    purpose: "smoke:vision",
    system: "You read one synthetic image. Report only what is visible. Return JSON matching the schema.",
    text: "Which app has the least screen time in this list, and how many minutes is it?",
    images: [{ mediaType: "image/png", data: fs.readFileSync(image) }],
    schema: { type: "object", additionalProperties: false, required: ["app", "minutes"], properties: { app: { type: "string" }, minutes: { type: "integer" } } },
    timeoutMs: 120_000,
  });
  console.log(`[smoke] vision: ${vision.ok ? `ok model=${vision.model} ${vision.durationMs} ms output=${JSON.stringify(vision.output)}` : `${vision.status}: ${vision.error}`}`);
}
console.log(`[smoke] configured model ${config.model}, planner ${config.planner}`);
