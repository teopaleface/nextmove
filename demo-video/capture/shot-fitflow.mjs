// The main workflow, live: Alex asks to stop the FitFlow trial (ONE live model request), reviews and approves the
// exact action, watches it run, then puts the 79 RON it kept to work (savings, demo rate) and checks Home.
// Fresh isolated Alex copy, visible touch point. Usage: MODEL_BUDGET=19 node capture/shot-fitflow.mjs [name]
import { launch, signIn, settle, still, recorder, humanType, assertClean, api, sleep, BASE, modelRequestsSoFar, installTouch, hideTouch, tapOn, scrollTopTo, smoothScrollBy } from "./lib.mjs";
const name = process.argv[2] ?? "ff2";
const question = "Can you stop the FitFlow trial before it charges me?";
console.log("model requests used before this shot:", modelRequestsSoFar());
const { browser, page, problems } = await launch();
await signIn(page, "alex", "PERSONAL");
let rec;
if (process.env.START === "dry") {
await page.goto(BASE + "/capabilities/T2", { waitUntil: "networkidle" });
await settle(page, 1200);
rec = await recorder(page, name);
const boxes = page.locator("label", { has: page.locator("input[type=checkbox]") });
for (let i = 0; i < (await boxes.count()); i++) {
  const l = boxes.nth(i); const cb = l.locator("input[type=checkbox]");
  const want = /FitFlow/.test(await l.innerText());
  if ((await cb.isChecked()) !== want) await cb.setChecked(want);
}
await page.getByRole("button", { name: /review/i }).first().click();
} else {
await page.goto(BASE + "/agent", { waitUntil: "networkidle" });
await settle(page, 1000);
await page.mouse.move(-10, -10);
await assertClean(page);
rec = await recorder(page, name);
await sleep(1200);
rec.mark("type");
await humanType(page, "#ask", question, 20);
await sleep(600);
rec.mark("send");
await page.keyboard.press("Enter");
await page.waitForURL(/\/agent\/tasks\//, { timeout: 20000 });
const taskId = page.url().split("/").pop();
rec.mark("task-open");
let view;
for (let i = 0; i < 360; i++) {
  view = (await api(page, "GET", `/tasks/${taskId}`)).json;
  if (view && !["QUEUED", "RUNNING"].includes(view.task.state)) break;
  await sleep(500);
}
rec.mark("done:" + view.task.state);
console.log("state", view.task.state, "planner", view.task.plannerMode ?? view.task.planner_mode, "|", view.blocks?.find((b) => b.kind === "answer")?.payload?.text?.slice(0, 500));
await settle(page, 1500);
await still(page, `${name}-10-answer-top`);
const reviewLink = page.locator('a[href^="/review/"]').first();
if (!(await reviewLink.count())) throw new Error("no proposal");
rec.mark("to-proposal");
await scrollTopTo(page, page.getByText("Calculations").first(), 70, 1800);
await sleep(1600);
await still(page, `${name}-11-calc`);
await scrollTopTo(page, reviewLink, 470, 1400);
await sleep(1400);
await installTouch(page);
await still(page, `${name}-12-proposal`);
rec.mark("tap-review");
await tapOn(page, reviewLink, 600);
}
await page.waitForURL(/\/review\//);
await settle(page, 2000);
await installTouch(page);
await still(page, `${name}-20-review`);
await sleep(1600);
const approveBtn = page.locator("button.btn.primary.main").first();
rec.mark("approve");
await tapOn(page, approveBtn, 600);
await page.waitForURL(/\/actions\//, { timeout: 20000 });
rec.mark("action");
await hideTouch(page);
for (let i = 0; i < 180; i++) {
  if (await page.getByText(/Put it to work\?/).count()) break;
  await sleep(400);
}
rec.mark("done");
await settle(page, 1200);
await still(page, `${name}-30-done`);
await sleep(1500);
let ptw = page.getByRole("link", { name: /Put it to work\?/ }).first();
if (!(await ptw.count())) ptw = page.getByText(/Put it to work\?/).first();
await ptw.scrollIntoViewIfNeeded();
await installTouch(page);
await sleep(600);
await still(page, `${name}-31-link`);
rec.mark("tap-ptw");
await tapOn(page, ptw, 600);
await page.waitForURL(/\/receipts\//, { timeout: 20000 });
await settle(page, 1500);
await installTouch(page);
const card = page.locator("#put-to-work");
await scrollTopTo(page, card, 64, 1200);
await sleep(1500);
await still(page, `${name}-40-offer`);
rec.mark("pick-savings");
await tapOn(page, page.locator('input[name="put-to-work"][value]').first().locator("xpath=.."), 600);
await sleep(1200);
await still(page, `${name}-41-picked`);
const go = card.locator("button.btn.primary.main");
const gb = await go.boundingBox();
if (gb && gb.y + gb.height > 780) { await smoothScrollBy(page, gb.y - 560, 1200); await sleep(700); }
rec.mark("tap-move-review");
await tapOn(page, go, 600);
await page.waitForURL(/\/review\//, { timeout: 20000 });
await settle(page, 1800);
await installTouch(page);
await still(page, `${name}-50-move-review`);
await sleep(1600);
rec.mark("approve-move");
await tapOn(page, page.locator("button.btn.primary.main").first(), 600);
await page.waitForURL(/\/actions\//, { timeout: 20000 });
await hideTouch(page);
for (let i = 0; i < 120; i++) {
  if (await page.getByText(/NextMove bank confirmed it/).count()) break;
  await sleep(400);
}
rec.mark("move-done");
await settle(page, 1000);
await still(page, `${name}-60-move-done`);
await sleep(1800);
rec.mark("home");
await installTouch(page);
await tapOn(page, page.getByRole("link", { name: /^Home$/ }).last(), 600);
await page.waitForURL(/\/home$/, { timeout: 20000 });
await settle(page, 1500);
await hideTouch(page);
await still(page, `${name}-70-home`);
await sleep(2200);
const meta = await rec.stop();
console.log(JSON.stringify(meta));
console.log("problems", problems);
console.log("model requests used after this shot:", modelRequestsSoFar());
await browser.close();
