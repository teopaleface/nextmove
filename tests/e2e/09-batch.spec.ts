import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { apiGet, approve, expect, moneyText, signIn, test } from "./helpers";

// The 200-item scenario from demo/bulk-cancellations.json (unchanged). Every child item is inspected and executed by
// the durable worker against the simulated providers; the counts below are read back, never mirrored.

test.describe.configure({ timeout: 900_000 });

async function current(page: Page) {
  return (await apiGet(page, "/batches/current")).batch;
}

async function startAndOpenApproval(page: Page) {
  await page.goto("/batch");
  await expect(page.getByText("200", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start the review" }).click();
  await expect(page.getByText("Inspecting with each provider")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve an exact list" })).toBeVisible({ timeout: 300_000 });
}

test("200 recurring payments: inspect, approve an exact list, read back every outcome, resolve exceptions", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const fundsBefore = (await apiGet(page, "/home")).totalMinor;
  mark("Batch review: 200 recurring payments");
  await startAndOpenApproval(page);
  mark("Inspection finished: 120 ready, 80 left out with reasons");
  const inspected = await current(page);
  expect(inspected.reviewCounts).toEqual({ READY: 120, ALREADY_OFF: 25, NEEDS_AUTH: 20, FIXED_COMMITMENT: 15, PROTECTED_OR_SHARED: 10, UNSUPPORTED: 10 });
  await capture("batch-review");

  await page.getByRole("button", { name: "Approve 120 exact actions" }).click();
  mark("Approved 120 exact actions; workers run with bounded concurrency");
  await expect(page.getByRole("heading", { name: "Working through your approval" })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.reload();
  mark("Phone reload mid-run: progress comes back from the server");
  await capture("batch-running");

  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 600_000 });
  await expect.poll(async () => (await current(page)).outcomes, { timeout: 120_000 }).toEqual({ CONFIRMED: 100, WAITING_EXTERNAL: 8, NEEDS_AUTH: 5, TERMS_CHANGED: 4, OUTCOME_UNKNOWN: 3 });
  const done = await current(page);
  expect(done.avoidedFutureChargesMinor).toBe(282400);
  expect(done.fundsBeforeMinor).toBe(fundsBefore);
  expect(done.fundsNowMinor).toBe(fundsBefore);
  expect(done.cashRefundedMinor).toBe(0);
  expect(done.approvedRoutes).toEqual({ PARTNER_API: 90, ISOLATED_BROWSER: 30 });
  await expect(page.getByText(moneyText(282400)).first()).toBeVisible();
  await capture("batch-results");
  mark("Outcomes 100 / 8 / 5 / 4 / 3; 2,824.00 RON avoided; funds unchanged");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Export as CSV/ }).click();
  const csvPath = await (await download).path();
  const csv = fs.readFileSync(csvPath!, "utf8");
  expect(csv.split("\r\n")[0]).toContain('"Merchant"');
  expect(csv.split("\r\n").length).toBe(201);
  mark("CSV export, formula-safe");

  await page.getByRole("button", { name: /Check status now/ }).click();
  await expect(page.locator(".toast")).toContainText("Nothing was resubmitted");
  await page.getByRole("button", { name: "Labs: +6 hours" }).click();
  await expect.poll(async () => (await current(page)).outcomes.OUTCOME_UNKNOWN ?? 0, { timeout: 120_000 }).toBe(0);
  mark("Lost responses reconciled by read-back after the provider's 6 hour lag; never resent");

  await page.getByRole("button", { name: "Labs: +48 hours" }).click();
  await expect.poll(async () => (await current(page)).outcomes.WAITING_EXTERNAL ?? 0, { timeout: 120_000 }).toBe(0);
  mark("Manual reviews finished after 48 hours");
  expect((await current(page)).outcomes.CONFIRMED).toBe(111);

  await page.getByRole("button", { name: "Review the new terms" }).click();
  await page.waitForURL("**/review/**");
  await expect(page.getByRole("dialog")).toContainText("What changed");
  mark("Changed terms: a fresh review with the new price; the old approval is not reused");
  await capture("batch-terms");
  await approve(page);
  await expect(page.getByText(/^Confirmed by /)).toHaveCount(4, { timeout: 180_000 });

  await page.goto("/batch");
  await page.getByRole("button", { name: "Labs: sign in at these providers" }).click();
  await page.getByRole("button", { name: "Prepare a fresh approval" }).click();
  await page.waitForURL("**/review/**");
  mark("Sign-in needed: you sign in on the provider page, then approve again");
  await approve(page);
  await expect(page.getByText(/^Confirmed by /)).toHaveCount(5, { timeout: 180_000 });

  await page.goto("/batch");
  await expect(page.getByRole("heading", { name: "Follow-up approvals" })).toBeVisible();
  const last = await current(page);
  expect(last.fundsNowMinor).toBe(fundsBefore);
  await capture("batch-followups");
  mark("All exceptions resolved; balance still unchanged");
});

test("Stop during a batch: nothing new starts; requests already sent may finish", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const fundsBefore = (await apiGet(page, "/home")).totalMinor;
  await startAndOpenApproval(page);
  await page.getByRole("button", { name: "Approve 120 exact actions" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  mark("Stop pressed while the batch runs");
  await expect(page.locator(".toast")).toContainText("Stopped.");
  await expect.poll(async () => (await current(page)).outcomes.IN_PROGRESS ?? 0, { timeout: 120_000 }).toBe(0);
  const b = await current(page);
  const total = Object.values(b.outcomes as Record<string, number>).reduce((s, n) => s + n, 0);
  expect(total).toBe(120);
  expect(b.outcomes.NOT_STARTED ?? 0).toBeGreaterThan(0);
  expect(b.status).toBe("STOPPED");
  expect(b.fundsNowMinor).toBe(fundsBefore);
  await expect(page.getByText("Stopped before it started").first()).toBeVisible();
  await capture("batch-stopped");
  mark(`Stopped: ${b.outcomes.NOT_STARTED} not started, ${b.outcomes.CONFIRMED ?? 0} already sent and confirmed`);
});

test("Worker process killed mid-batch: the supervisor restarts it and leases recover without duplicates", async ({ page, mark }) => {
  await signIn(page, "alex");
  const pidsFile = path.join(process.cwd(), ".data", "pids.json");
  test.skip(!fs.existsSync(pidsFile), "needs the stack started by npm run demo / npm run dev");
  await startAndOpenApproval(page);
  await page.getByRole("button", { name: "Approve 120 exact actions" }).click();
  await expect.poll(async () => 120 - ((await current(page)).outcomes.IN_PROGRESS ?? 120), { timeout: 120_000 }).toBeGreaterThan(10);
  const before = JSON.parse(fs.readFileSync(pidsFile, "utf8")).children.worker as number;
  process.kill(before, "SIGKILL");
  mark(`Worker ${before} killed with SIGKILL mid-run`);
  await expect.poll(async () => {
    const h = await (await page.request.get("/api/health")).json();
    return h.worker.pids.filter((p: number) => p !== before).length;
  }, { timeout: 60_000 }).toBeGreaterThan(0);
  mark("Supervisor restarted the worker");
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 600_000 });
  await page.getByRole("button", { name: /Check status now/ }).click();
  await expect.poll(async () => {
    const b = await current(page);
    return Object.values(b.outcomes as Record<string, number>).reduce((s, n) => s + n, 0) - (b.outcomes.IN_PROGRESS ?? 0);
  }, { timeout: 180_000 }).toBe(120);
  const b = await current(page);
  const receipts = b.items.map((i: any) => i.receipt).filter(Boolean);
  expect(new Set(receipts).size).toBe(receipts.length);
  expect(b.outcomes.CONFIRMED).toBeGreaterThanOrEqual(95);
  expect(b.fundsNowMinor).toBe(b.fundsBeforeMinor);
  mark(`After restart: ${b.outcomes.CONFIRMED} confirmed, one receipt each, funds unchanged`);
});
