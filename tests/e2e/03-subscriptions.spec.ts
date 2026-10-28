import type { Page } from "@playwright/test";
import { candidate, approve, expect, expectDone, labs, openCapability, review, signIn, test } from "./helpers";

/** On the approved-plan screen, wait until every action reached the given count of provider confirmations. */
async function waitAllConfirmed(page: Page, count: number, timeout = 180_000) {
  await expect(page.getByText(/approved actions/)).toBeVisible();
  await expect(page.getByText(/^Confirmed by /)).toHaveCount(count, { timeout });
}

test("T3: student bundle with verification, activation and two renewals stopped in order", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await openCapability(page, "T3", /Bundle would save 39.00 RON/);
  mark("Bundle comparison against current plans");
  await page.getByRole("textbox", { name: "Student ID number" }).fill("S202404173381");
  await page.getByRole("button", { name: "Recalculate" }).click();
  await expect(candidate(page, "Verify student status with StudyPlus")).toBeEnabled();
  await review(page);
  mark("Four dependent actions approved together");
  await expect(page.getByRole("dialog")).toContainText("4 actions to approve");
  await capture("t3-approval");
  await approve(page);
  await waitAllConfirmed(page, 4);
  mark("Verification first, then activation, then the old plans");
  await capture("t3-done");
});

test("A1: copy CloudBox files first, then stop the duplicate storage", async ({ page, mark }) => {
  await signIn(page, "alex");
  await openCapability(page, "A1", /35.00 RON of storage is duplicated/);
  mark("Duplicate storage found");
  await review(page);
  await approve(page);
  await expect(page.getByText(/2 approved actions/)).toBeVisible();
  const plan = page.url();
  mark("The stop waits until the file copy is verified");
  await openCapability(page, "A1");
  await labs(page, /finish file copy now/);
  await page.goto(plan);
  await waitAllConfirmed(page, 2);
  mark("Copy verified, then renewal stopped");
});

test("A3, A5, A6: annual billing, timed CinemaMax starts and a Streamly pause", async ({ page, mark }) => {
  await signIn(page, "alex");
  await openCapability(page, "A3", /Annual saves 158.00 RON/);
  mark("A3 monthly or annual");
  await review(page);
  await approve(page);
  await expectDone(page, "StudyPlus");

  await openCapability(page, "A5", /Rotating saves 39.00 RON/);
  mark("A5 time a service around the shows you want");
  await review(page);
  await approve(page);
  await waitAllConfirmed(page, 2);

  await openCapability(page, "A6", /A 1-month pause skips 49.00 RON/);
  mark("A6 pause instead of paying");
  await review(page);
  await approve(page);
  await expectDone(page, "Streamly");
});

test("A4: a price rise, and a protected benefit that keeps a cheaper plan off the table", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await openCapability(page, "A4", /Streamly went from 39.00 RON to 49.00 RON/);
  mark("A4 price rise explained");
  const basic = page.locator("label.check-row", { hasText: "Move Streamly to Streamly Basic with ads" });
  await expect(basic).toContainText("You marked offline playback as must-keep");
  await expect(basic.locator("input")).toBeDisabled();
  await capture("a4-protected");

  mark("Preference changed in Monitoring");
  await page.goto("/agent/monitoring");
  await page.getByRole("checkbox", { name: /Keep offline downloads/ }).uncheck();
  await expect(page.locator(".toast")).toContainText("Preference saved");

  await openCapability(page, "A4");
  await expect(candidate(page, "Move Streamly to Streamly Basic with ads")).toBeEnabled();
  mark("The cheaper plan becomes available, still only with your approval");
});
