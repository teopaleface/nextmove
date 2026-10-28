import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

// End-to-end walk of the cash autopilot (O7 bill vault, O8 overdraft shield) against a running Labs stack, through
// the phone UI. Signs in an isolated Alex copy, triggers the Labs events, proposes and approves in the UI, waits for
// the worker, and saves screenshots under .data/qa/cash-autopilot/. Reports horizontal overflow and small targets.
//
//   NEXTMOVE_BANK_URL=http://127.0.0.1:3260 node --import tsx scripts/qa-cash-autopilot.ts [--widths=390,360]

const BASE = process.env.NEXTMOVE_BANK_URL ?? "http://127.0.0.1:3210";
const widths = (process.argv.find((a) => a.startsWith("--widths="))?.split("=")[1] ?? "390").split(",").map(Number);
const outDir = path.join(process.cwd(), ".data", "qa", "cash-autopilot");

async function check(page: Page, label: string, report: string[]) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const small = [...document.querySelectorAll("main a, main button, main input, main select, main label.check-row")]
      .filter((el) => {
        const b = (el as HTMLElement).getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (el as HTMLElement).offsetParent !== null && b.height < 44 && !(el as HTMLElement).closest("details.dev, .table, .kv");
      })
      .map((el) => `${el.tagName.toLowerCase()}:"${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round((el as HTMLElement).getBoundingClientRect().height)}px`);
    return { overflow: doc.scrollWidth - doc.clientWidth, small };
  });
  report.push(`${label}: overflow ${r.overflow}px${r.small.length ? `; under 44px: ${r.small.join(", ")}` : ""}`);
}

async function shot(page: Page, width: number, name: string, report: string[]) {
  await page.waitForTimeout(400);
  const file = path.join(outDir, `${width}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await check(page, `${width} ${name}`, report);
  report.push(`  → ${file}`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report: string[] = [];
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
    const r = await page.request.post(`${BASE}/api/session/demo`, { data: { customer: "alex", isolated: true } });
    if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
    const csrf = (await r.json()).csrfToken as string;
    const post = async (p: string, data: unknown) => {
      const x = await page.request.post(`${BASE}/api${p}`, { data, headers: { "x-csrf-token": csrf } });
      if (!x.ok()) throw new Error(`${p} -> ${x.status()} ${await x.text()}`);
      return x.json();
    };
    const waitHeadline = async (re: RegExp, timeout = 30_000) => {
      const until = Date.now() + timeout;
      for (;;) {
        await page.reload();
        const h = await page.locator(".opportunity h2").first().textContent({ timeout: 15_000 });
        if (h && re.test(h)) return h;
        if (Date.now() > until) throw new Error(`headline never matched ${re}: ${h}`);
        await page.waitForTimeout(1500);
      }
    };
    let reviews = 0;
    const approveInUi = async () => {
      await page.getByRole("button", { name: /Review/ }).click();
      await page.waitForURL(/\/review\//);
      const approve = page.locator(".sheet-actions .btn.primary");
      await approve.waitFor();
      await shot(page, width, `review-${++reviews}`, report);
      await approve.click();
      await page.waitForTimeout(1500);
    };

    // O7: waiting for payday → salary arrives → plan → approve → parked → first return.
    await page.goto(`${BASE}/capabilities/O7`);
    await page.locator(".opportunity h2").waitFor();
    await shot(page, width, "o7-1-waiting", report);
    report.push(`  salary: ${JSON.stringify(await post("/labs/bank", { action: "salary_arrives" }))}`);
    await page.reload();
    await waitHeadline(/Salary landed/);
    await shot(page, width, "o7-2-plan", report);
    await approveInUi();
    await page.goto(`${BASE}/capabilities/O7`);
    report.push(`  O7 after approval: ${await waitHeadline(/in the vault/)}`);
    await shot(page, width, "o7-3-parked", report);
    report.push(`  next return: ${JSON.stringify(await post("/labs/bank", { action: "next_return" }))}`);
    report.push(`  O7 after first return: ${await waitHeadline(/Next return 25 Nov/)}`);
    await shot(page, width, "o7-4-first-return", report);

    // O8: unexpected bill → exact top-up from Savings → approve → covered.
    report.push(`  bill: ${JSON.stringify(await post("/labs/bank", { action: "unexpected_bill" }))}`);
    await page.goto(`${BASE}/capabilities/O8`);
    await page.locator(".opportunity h2").waitFor();
    await shot(page, width, "o8-1-shield", report);
    // Edge case: keep almost all Savings → partial top-up with the shortfall stated.
    await page.locator("#in-savingsKeepMinor").fill("97000");
    await page.getByRole("button", { name: "Recalculate" }).click();
    await page.waitForTimeout(1200);
    report.push(`  O8 partial: ${await page.locator(".opportunity h2").first().textContent()}`);
    await shot(page, width, "o8-2-partial", report);
    await page.reload();
    await page.locator(".opportunity h2").waitFor();
    await approveInUi();
    await page.goto(`${BASE}/capabilities/O8`);
    report.push(`  O8 after top-up: ${await waitHeadline(/stays above/)}`);
    await shot(page, width, "o8-3-covered", report);
    await page.goto(`${BASE}/home`);
    await page.waitForTimeout(1200);
    await shot(page, width, "home-after", report);
    if (errors.length) report.push(`  page errors: ${errors.join(" | ")}`);
    await context.close();
  }
  await browser.close();
  console.log(report.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
