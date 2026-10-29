// Shared capture helpers for the NextMove demo film.
// - Signs in to an ISOLATED demo tenant (never the shared demo tenants).
// - Renders the app with Inter (open font, OFL) instead of the system UI font, and hides dev-only overlays.
// - Records real UI footage at device resolution through the Chrome DevTools screencast, with timestamps,
//   so frames can be assembled into a constant-frame-rate clip with ffmpeg.
// - Counts every request that can reach the live model (POST /api/tasks, POST /api/tasks/:id/answer)
//   and refuses to exceed the budget passed in MODEL_BUDGET.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "../../node_modules/playwright/index.mjs";

export const BASE = process.env.BASE ?? "http://127.0.0.1:3210";
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const CAPTURES = path.join(ROOT, "captures");
const FONT = path.join(ROOT, "assets/fonts/inter-latin-wght-normal.woff2");
const LEDGER = path.join(CAPTURES, "model-requests.log");
export const VIEWPORT = { width: 390, height: 844 };
export const DPR = 3;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STYLE = `
@font-face { font-family: "InterDemo"; src: url("/__demo/inter.woff2") format("woff2"); font-weight: 100 900; font-display: block; }
:root { --font: "InterDemo", sans-serif !important; }
html, body, button, input, select, textarea { font-family: "InterDemo", sans-serif !important; }
nextjs-portal, [data-nextjs-toast], [data-next-badge-root], #__next-build-watcher { display: none !important; }
* { caret-color: #151515; }
::-webkit-scrollbar { display: none; }
@keyframes demoTick { from { opacity: 0.98; } to { opacity: 1; } }
html::after { content: ""; position: fixed; left: 0; top: 0; width: 1px; height: 1px; background: #f7f7f2; z-index: 2147483647; pointer-events: none; animation: demoTick 0.5s steps(15) infinite alternate; }
`;

export function modelRequestsSoFar() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length;
}
const MAX = Number(process.env.MODEL_BUDGET ?? 15);

export async function launch() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR, colorScheme: "light", locale: "en-GB", timezoneId: "Europe/Bucharest", hasTouch: false });
  await context.route("**/__demo/inter.woff2", (r) => r.fulfill({ status: 200, contentType: "font/woff2", body: fs.readFileSync(FONT) }));
  await context.addInitScript((css) => {
    const add = () => { if (document.getElementById("__demo_style")) return; const s = document.createElement("style"); s.id = "__demo_style"; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
    new MutationObserver(add).observe(document, { childList: true, subtree: true });
  }, STYLE);
  // Model budget guard: count and cap the requests that can reach the live model.
  await context.route("**/api/tasks", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    if (modelRequestsSoFar() >= MAX) { console.log("BUDGET EXHAUSTED: blocked POST /api/tasks"); return r.abort(); }
    fs.appendFileSync(LEDGER, `${new Date().toISOString()} POST /api/tasks ${r.request().postData()}\n`);
    return r.fallback();
  });
  await context.route("**/api/tasks/*/answer", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    if (modelRequestsSoFar() >= MAX) { console.log("BUDGET EXHAUSTED: blocked answer"); return r.abort(); }
    fs.appendFileSync(LEDGER, `${new Date().toISOString()} POST answer ${r.request().url()} ${r.request().postData()}\n`);
    return r.fallback();
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror " + String(e).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && problems.push("console " + m.text().slice(0, 200)));
  return { browser, context, page, problems };
}

/** Sign in as a fresh isolated copy of a demo customer and switch to the given context kind. */
export async function signIn(page, customer = "alex", kind = "PERSONAL") {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const r = await page.evaluate(async (customer) => (await fetch("/api/session/demo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customer, isolated: true }) })).status, customer);
  if (r !== 200) throw new Error("demo sign-in failed " + r);
  const sess = await page.evaluate(async () => (await (await fetch("/api/session")).json()));
  const ctx = sess.contexts.find((x) => x.kind === kind);
  if (sess.context?.id !== ctx.id) await page.evaluate(async ([id, csrf]) => { await fetch("/api/session/context", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ contextId: id }) }); }, [ctx.id, sess.csrfToken]);
  const after = await page.evaluate(async () => (await (await fetch("/api/session")).json()));
  const tenant = JSON.stringify(after).match(/iso-[a-z0-9-]+/)?.[0];
  return { csrf: after.csrfToken, session: after, tenant };
}

export async function api(page, method, p, body) {
  return page.evaluate(async ([method, p, body]) => {
    const s = await (await fetch("/api/session")).json();
    const r = await fetch("/api" + p, { method, headers: { "content-type": "application/json", "x-csrf-token": s.csrfToken }, body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}" });
    let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 500) };
  }, [method, p, body]);
}

/** Wait until the page is quiet: no "Compiling" text, fonts loaded, network idle. */
export async function settle(page, ms = 600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await sleep(ms);
}

export async function still(page, name) {
  fs.mkdirSync(path.join(CAPTURES, "stills"), { recursive: true });
  const file = path.join(CAPTURES, "stills", name + ".png");
  await page.screenshot({ path: file });
  return file;
}

export async function stillFull(page, name) {
  fs.mkdirSync(path.join(CAPTURES, "stills"), { recursive: true });
  const file = path.join(CAPTURES, "stills", name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** CDP screencast at device resolution. stop() writes frames + an ffconcat file and encodes an mp4 at 30 fps. */
export async function recorder(page, name) {
  const dir = path.join(CAPTURES, "rec", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(dir, `f${String(n++).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEWPORT.width * DPR, maxHeight: VIEWPORT.height * DPR, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  const marks = [];
  return {
    mark(label) { marks.push({ label, t: Date.now() / 1000 - t0 }); },
    async stop() {
      await sleep(400);
      await cdp.send("Page.stopScreencast").catch(() => {});
      await sleep(300);
      if (!frames.length) throw new Error("no frames");
      const start = frames[0].t;
      let txt = "ffconcat version 1.0\n";
      for (let i = 0; i < frames.length; i++) {
        const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 0.5;
        txt += `file '${path.basename(frames[i].file)}'\nduration ${d.toFixed(4)}\n`;
      }
      txt += `file '${path.basename(frames[frames.length - 1].file)}'\n`;
      fs.writeFileSync(path.join(dir, "list.ffconcat"), txt);
      const out = path.join(CAPTURES, "rec", name + ".mp4");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.ffconcat"), "-vf", "fps=30,scale=1170:2532:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-movflags", "+faststart", out]);
      const meta = { name, frames: frames.length, seconds: frames[frames.length - 1].t - start, firstFrameOffset: start - t0, marks };
      fs.writeFileSync(path.join(CAPTURES, "rec", name + ".json"), JSON.stringify(meta, null, 2));
      return meta;
    },
  };
}

/** Type like a person: steady cadence with small natural variation (deterministic). */
export async function humanType(page, selector, text, cps = 16) {
  const el = page.locator(selector);
  await el.click();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    await sleep(1000 / cps + ((i * 37) % 23));
  }
}

/** Fail the shot if the screen shows something we must not film. */
export async function assertClean(page) {
  const t = await page.evaluate(() => document.body.innerText);
  const bad = [/Compiling/i, /Unhandled Runtime Error/i, /Application error/i, /Something went wrong/i, /\bNaN\b/, /\bundefined\b/];
  const hit = bad.find((re) => re.test(t));
  if (hit) throw new Error("dirty screen: " + hit);
}
