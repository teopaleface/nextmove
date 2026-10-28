import { approve, expect, expectDone, review, signIn, test, totalFunds } from "./helpers";

test("T2: stop a trial on the provider's website in an isolated browser, then verify the receipt", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const before = await totalFunds(page);

  mark("Home suggests the trial before it charges");
  await expect(page.getByText(/could stay with you/)).toBeVisible();
  await page.getByRole("link", { name: "Review my options" }).click();
  await expect(page.getByText("Stopping the trial lowers upcoming charges from 242.00 RON to 163.00 RON")).toBeVisible();
  mark("Deterministic comparison of the options");
  await capture("t2-options");

  await review(page);
  mark("Exact approval: operation, route, money, consequences, window");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Turn off FitFlow renewal");
  await expect(sheet).toContainText("Provider website in an isolated browser");
  await expect(sheet).toContainText("10 minutes of approval");
  await capture("t2-approval");
  await approve(page);

  mark("Live task: the isolated browser works on the provider page");
  await page.waitForURL("**/actions/**");
  await expect(page.locator(".browser")).toBeVisible({ timeout: 60_000 });
  await expectDone(page, "FitFlow");
  await expect(page.getByText("Final request passed the approval check and was sent from the page")).toBeVisible();
  await capture("t2-done");

  mark("Receipt: independent read-back, balance unchanged");
  await page.getByRole("link", { name: /View receipt/ }).click();
  await expect(page.getByText("Unchanged by this action")).toBeVisible();
  await expect(page.getByText("79.00 RON avoided")).toBeVisible();
  await capture("t2-receipt");
  expect(await totalFunds(page)).toBe(before);

  mark("Upcoming charges updated from the confirmed receipt");
  await page.getByRole("link", { name: "View updated payments" }).click();
  await expect(page.getByText("163.00 RON").first()).toBeVisible();
});
