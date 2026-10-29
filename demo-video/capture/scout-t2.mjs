// Scouting (no model calls): the deterministic T2 path from its capability page to approval and receipt.
import { launch, signIn, settle, still, stillFull, sleep } from "./lib.mjs";
const { browser, page, problems } = await launch();
const who = await signIn(page, "alex", "PERSONAL");
console.log("tenant", who.tenant);
const cap = process.argv[2] ?? "T2";
await page.goto(`http://127.0.0.1:3210/capabilities/${cap}`, { waitUntil: "networkidle" });
await settle(page, 800);
await stillFull(page, `scout-cap-${cap}`);
const buttons = await page.$$eval("button, a", (els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean));
console.log(buttons.join(" | "));
if (process.argv[3] === "go") {
  // pick the first candidate checkbox if any, then propose
  const cb = page.locator("input[type=checkbox]").first();
  if (await cb.count()) { if (!(await cb.isChecked())) await cb.check(); }
  await page.getByRole("button", { name: /review|prepare|continue/i }).first().click();
  await page.waitForURL(/review|actions|tasks/, { timeout: 15000 }).catch(() => {});
  await settle(page, 1200);
  console.log("url", page.url());
  await stillFull(page, `scout-cap-${cap}-review`);
  console.log((await page.$$eval("button, a", (els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean))).join(" | "));
}
console.log("problems", problems);
await browser.close();
