// Deterministic UI shots (no model calls), each on a fresh isolated Alex copy.
// Usage: node capture/shots-ui.mjs [home,route,airbag,monitoring]
import { launch, signIn, settle, still, recorder, assertClean, sleep, BASE } from "./lib.mjs";
const which = new Set((process.argv[2] ?? "home,route,monitoring").split(","));

async function smoothScroll(page, px, ms = 1600) {
  const steps = Math.round(ms / 16);
  for (let i = 0; i < steps; i++) {
    // ease-in-out increments
    const a = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps), b = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / steps);
    await page.mouse.wheel(0, px * (b - a));
    await sleep(16);
  }
  await sleep(200);
}

async function shot(name, route, body) {
  const { browser, page, problems } = await launch();
  await signIn(page, "alex", "PERSONAL");
  await page.goto(BASE + route, { waitUntil: "networkidle" });
  await settle(page, 1200);
  await page.mouse.move(195, 400);
  await assertClean(page);
  const rec = await recorder(page, name);
  await body(page, rec);
  console.log(name, JSON.stringify(await rec.stop()), problems);
  await browser.close();
}

if (which.has("home")) await shot("home", "/home", async (page) => {
  await still(page, "home-00");
  await sleep(3000);
  await smoothScroll(page, 560, 2600);
  await sleep(2500);
  await still(page, "home-01");
  await smoothScroll(page, 360, 2000);
  await sleep(2000);
  await still(page, "home-02");
});

if (which.has("route")) await shot("route", "/goals/home-route", async (page, rec) => {
  await still(page, "route-00");
  await sleep(2500);
  await smoothScroll(page, 300, 1400);
  await sleep(1200);
  rec.mark("click-dental");
  await page.getByRole("button", { name: /dental/i }).click();
  await sleep(3500);
  await still(page, "route-01");
  await smoothScroll(page, 520, 2400);
  await sleep(2500);
  await still(page, "route-02");
  await smoothScroll(page, 560, 2400);
  await sleep(2500);
  await still(page, "route-03");
});

if (which.has("monitoring")) await shot("monitoring", "/agent/monitoring", async (page) => {
  await still(page, "monitoring-00");
  await sleep(2000);
  await smoothScroll(page, 700, 2600);
  await sleep(1500);
  await still(page, "monitoring-01");
  await smoothScroll(page, 700, 2600);
  await sleep(1500);
  await still(page, "monitoring-02");
});

if (which.has("airbag")) await shot("airbag", "/capabilities/O9", async (page) => {
  await still(page, "airbag-00");
  await sleep(2000);
});

// The exact-approval sheet for T2, prepared from the capability page (deterministic, no model), scrolled to "This approval".
if (which.has("approval")) await shot("approval", "/capabilities/T2", async (page) => {
  const cb = page.locator("input[type=checkbox]").first();
  if ((await cb.count()) && !(await cb.isChecked())) await cb.check();
  await page.getByRole("button", { name: /review this action/i }).click();
  await page.waitForURL(/\/review\//);
  await settle(page, 2000);
  await still(page, "approval-00");
  await page.mouse.move(195, 500);
  await smoothScroll(page, 500, 1800);
  await sleep(1200);
  await still(page, "approval-01");
  await smoothScroll(page, 600, 1800);
  await sleep(1200);
  await still(page, "approval-02");
});

// E3 retention offer: a signed merchant offer, its text quoted as untrusted data (deterministic, no model).
if (which.has("offer")) await shot("offer", "/capabilities/E3", async (page) => {
  await still(page, "offer-00");
  // Labs: the simulated merchant sends a tampered offer, then a properly signed one.
  for (const [label, tag] of [[/tampered Streamly offer/i, "tampered"], [/signed discount offer/i, "signed"]]) {
    await page.getByRole("button", { name: label }).first().click().catch(async () => { await page.getByText(label).first().click(); });
    await settle(page, 2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(800);
    await still(page, `offer-${tag}-0`);
    for (let i = 1; i <= 3; i++) { await smoothScroll(page, 600, 1200); await sleep(700); await still(page, `offer-${tag}-${i}`); }
  }
});
