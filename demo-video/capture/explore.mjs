// Scouting pass (no model calls): viewport stills of the main screens of an isolated Alex copy.
import { launch, signIn, settle, still, api } from "./lib.mjs";
const { browser, page, problems } = await launch();
const who = await signIn(page, process.argv[2] ?? "alex", process.argv[3] ?? "PERSONAL");
console.log("tenant", who.tenant);
const caps = (await api(page, "GET", "/capabilities")).json.capabilities.filter((c) => c.inThisContext !== false);
console.log(caps.map((c) => `${c.id} ${c.title} | ${c.short}`).join("\n"));
const routes = (process.argv[4] ?? "/home,/home/upcoming,/agent,/activity,/goals,/goals/home-route,/agent/monitoring,/profile").split(",");
for (const r of routes) {
  await page.goto("http://127.0.0.1:3210" + r, { waitUntil: "networkidle" });
  await settle(page, 800);
  await still(page, `scout-${who.session.customer ?? "x"}${r.replace(/\//g, "_")}`);
}
console.log("problems", problems);
await browser.close();
