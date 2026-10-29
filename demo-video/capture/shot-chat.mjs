// One live chat shot on a fresh isolated tenant, recorded at device resolution.
// Usage: node capture/shot-chat.mjs <name> <customer> <kind> "<question>" [approve]
// ANSWER=<regex> picks which option chip answers a follow-up question; NO_ANSWER=1 stops at the question.
// Each run sends exactly ONE question to the live model (plus one answer per follow-up question, if asked).
import { launch, signIn, settle, still, recorder, humanType, assertClean, api, sleep, BASE, modelRequestsSoFar } from "./lib.mjs";

const [name, customer, kind, question, approveFlag] = process.argv.slice(2);
if (!question) throw new Error("usage: name customer kind question [approve]");
console.log("model requests used before this shot:", modelRequestsSoFar());
const { browser, page, problems } = await launch();
const who = await signIn(page, customer, kind);
console.log("tenant", who.tenant);

async function smoothScroll(px, steps = 40) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await sleep(16); }
  await sleep(250);
}
async function scrollIntoCenter(locator) {
  const box = await locator.boundingBox();
  if (!box) return;
  const delta = box.y + box.height / 2 - 844 * 0.55;
  if (Math.abs(delta) > 20) await smoothScroll(delta, Math.min(70, Math.max(20, Math.round(Math.abs(delta) / 12))));
}

await page.goto(BASE + "/agent", { waitUntil: "networkidle" });
await settle(page, 1000);
await page.mouse.move(-10, -10);
await assertClean(page);
await still(page, `${name}-00-agent`);
const rec = await recorder(page, name);
await sleep(1500);
rec.mark("type");
await humanType(page, "#ask", question, 18);
await sleep(700);
rec.mark("send");
await page.keyboard.press("Enter");
await page.waitForURL(/\/agent\/tasks\//, { timeout: 20000 });
const taskId = page.url().split("/").pop();
rec.mark("task-open");
console.log("task", taskId);

let view;
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 360; i++) {
    view = (await api(page, "GET", `/tasks/${taskId}`)).json;
    if (view && !["QUEUED", "RUNNING"].includes(view.task.state)) break;
    await sleep(500);
  }
  if (view.task.state !== "WAITING_USER") break;
  rec.mark("question");
  if (process.env.NO_ANSWER) { await sleep(2500); await still(page, `${name}-05-question`); break; } // film the question, send no answer
  await sleep(2500);
  const chip = process.env.ANSWER ? page.locator("button.chip", { hasText: new RegExp(process.env.ANSWER, "i") }).first() : page.locator("button.chip").first();
  await scrollIntoCenter(chip);
  await sleep(800);
  console.log("question answered with:", await chip.textContent());
  await chip.click();
  await sleep(1500);
}
rec.mark("done:" + view.task.state);
console.log("state", view.task.state, "planner", view.task.plannerMode ?? view.task.planner_mode, "|", view.blocks?.find((b) => b.kind === "answer")?.payload?.text?.slice(0, 400));
await settle(page, 1800);
await assertClean(page).catch((e) => console.log("WARN", e.message));
await still(page, `${name}-10-answer-top`);
await smoothScroll(420, 60);
await sleep(1600);
await still(page, `${name}-11-answer-mid`);
const reviewLink = page.locator('a[href^="/review/"]').first();
if (await reviewLink.count()) {
  await scrollIntoCenter(reviewLink);
  await sleep(1400);
  await still(page, `${name}-12-proposal`);
}
if (approveFlag === "approve" && (await reviewLink.count())) {
  rec.mark("review");
  await reviewLink.click();
  await page.waitForURL(/\/review\//);
  await settle(page, 2500);
  await still(page, `${name}-20-review`);
  const approveBtn = page.locator("button.btn.primary.main").first();
  await sleep(1200);
  rec.mark("approve");
  await approveBtn.click();
  await page.waitForURL(/\/actions\//, { timeout: 20000 });
  rec.mark("action");
  for (let i = 0; i < 180; i++) {
    if (await page.locator('a[href^="/receipts/"]').count()) break;
    await sleep(500);
  }
  await settle(page, 1500);
  await still(page, `${name}-30-action-top`);
  const frame = page.locator("#browser");
  if (await frame.count()) { await scrollIntoCenter(frame); await sleep(1800); await still(page, `${name}-31-action-browser`); }
  const receipt = page.locator('a[href^="/receipts/"]').first();
  if (await receipt.count()) {
    await scrollIntoCenter(receipt);
    await sleep(1200);
    rec.mark("receipt");
    await receipt.click();
    await page.waitForURL(/\/receipts\//);
    await settle(page, 2500);
    await still(page, `${name}-40-receipt`);
    await smoothScroll(500, 60);
    await sleep(1500);
    await still(page, `${name}-41-receipt-more`);
  }
}
await sleep(800);
const meta = await rec.stop();
console.log(JSON.stringify(meta));
// After-state stills, outside the recording.
for (const r of ["/home", "/home/upcoming", "/activity"]) {
  await page.goto(BASE + r, { waitUntil: "networkidle" });
  await settle(page, 1200);
  await still(page, `${name}-50${r.replace(/\//g, "_")}`);
}
console.log("problems", problems);
console.log("model requests used after this shot:", modelRequestsSoFar());
await browser.close();
