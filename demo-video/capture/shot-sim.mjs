// The interactive what-if in a live chat answer: ask the phone question (ONE live model request), then drag the
// sliders on the answer's simulation card with a visible touch point. Fresh isolated Alex copy.
// Usage: MODEL_BUDGET=19 node capture/shot-sim.mjs [name]
import { launch, signIn, settle, still, recorder, humanType, assertClean, api, sleep, BASE, modelRequestsSoFar, installTouch, hideTouch, dragRange, scrollTopTo, smoothScrollBy } from "./lib.mjs";
const name = process.argv[2] ?? "sim";
const question = "Can I buy a 6,000 RON phone and still reach my home goal?";
console.log("model requests used before this shot:", modelRequestsSoFar());
const { browser, page, problems } = await launch();
await signIn(page, "alex", "PERSONAL");
await page.goto(BASE + "/agent", { waitUntil: "networkidle" });
await settle(page, 1000);
await page.mouse.move(-10, -10);
await assertClean(page);
const rec = await recorder(page, name);
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
await settle(page, 1800);
await still(page, `${name}-10-answer-top`);
const card = page.locator("section", { hasText: "What-if · recalculates as you move" }).first();
if (!(await card.count())) throw new Error("no simulation card");
rec.mark("to-card");
await scrollTopTo(page, card, 64, 2200);
await sleep(1500);
await installTouch(page);
await still(page, `${name}-20-card`);
const ranges = card.locator("input[type=range]");
const labels = await card.locator("label").allTextContents();
console.log("sliders", labels);
const term = card.locator("input[type=range]").nth(labels.findIndex((l) => /term/i.test(l)));
const amount = card.locator("input[type=range]").nth(labels.findIndex((l) => /amount/i.test(l)));
const headline = async () => (await card.innerText()).split("\n").slice(0, 8).join(" / ");
console.log("before:", await headline());
// Keep the sliders on screen: if they sit below the fold, scroll just enough.
const tb = await term.boundingBox();
if (tb && tb.y > 760) { await smoothScrollBy(page, tb.y - 700, 1200); await sleep(800); }
rec.mark("drag-term-3");
console.log("term ->", await dragRange(page, term, 3, 2200));
await sleep(2600);
await still(page, `${name}-21-term3`);
console.log("after term 3:", await headline());
rec.mark("drag-term-24");
console.log("term ->", await dragRange(page, term, 24, 2200));
await sleep(2400);
await still(page, `${name}-22-term24`);
console.log("after term 24:", await headline());
rec.mark("drag-amount");
console.log("amount ->", await dragRange(page, amount, 300000, 2000));
await sleep(2400);
await still(page, `${name}-23-amount`);
console.log("after amount:", await headline());
await hideTouch(page);
await sleep(600);
const meta = await rec.stop();
console.log(JSON.stringify(meta));
// Full card text, for the record.
await scrollTopTo(page, card, 0, 400);
console.log("card:", (await card.innerText()).replace(/\n/g, " | ").slice(0, 1500));
console.log("problems", problems);
console.log("model requests used after this shot:", modelRequestsSoFar());
await browser.close();
