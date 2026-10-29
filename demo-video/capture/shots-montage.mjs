// Stills for the feature montage (no model calls), each on a fresh isolated Alex copy.
// Usage: node capture/shots-montage.mjs [O9,T4,O6,O7,O8,A15,A16,A17,A18,simple,O1]
import { launch, signIn, settle, still, stillFull, assertClean, sleep, BASE } from "./lib.mjs";
const all = ["O9", "T4", "O6", "O7", "O8", "A15", "A16", "A17", "A18", "simple", "O1"];
const which = (process.argv[2] ?? all.join(",")).split(",");
const { browser, page, problems } = await launch();
await signIn(page, "alex", "PERSONAL");
for (const id of which) {
  if (id === "simple") {
    await page.goto(BASE + "/profile#display", { waitUntil: "networkidle" });
    await settle(page, 1000);
    const cb = page.locator("#display input[type=checkbox], input[aria-describedby=simple-mode-help]").first();
    if (!(await cb.isChecked())) await cb.check();
    await settle(page, 1500);
    for (const r of ["/home", "/agent"]) {
      await page.goto(BASE + r, { waitUntil: "networkidle" });
      await settle(page, 1200);
      await assertClean(page).catch((e) => console.log("WARN", e.message));
      await still(page, `mont-simple${r.replace(/\//g, "_")}`);
    }
    continue;
  }
  const route = id === "O6" ? "/goals/home-route" : `/capabilities/${id}`;
  await page.goto(BASE + route, { waitUntil: "networkidle" });
  await settle(page, 1200);
  await page.mouse.move(-10, -10);
  await assertClean(page).catch((e) => console.log("WARN", id, e.message));
  await still(page, `mont-${id}-0`);
  await stillFull(page, `mont-${id}-full`);
}
console.log("problems", problems);
await browser.close();
