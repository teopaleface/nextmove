import { approve, expect, signIn, test, totalFunds } from "./helpers";

test("Financial Airbag: one tap prepares every optional change, rent stays due, one exact approval", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const before = await totalFunds(page);

  mark("Home → Financial Airbag");
  await page.getByRole("link", { name: /Review optional spending/ }).click();
  await page.waitForURL("**/capabilities/O9");
  await expect(page.getByRole("heading", { name: /optional services? .* can be paused or stopped/ })).toBeVisible();
  await expect(page.getByText("Essential bills, storage and student tools stay protected.")).toBeVisible();

  mark("One tap: Deploy the airbag");
  await page.getByRole("button", { name: "Deploy the airbag" }).click();
  await expect(page.getByRole("heading", { name: "3 optional changes ready for exact review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deploy the airbag" })).toHaveCount(0);
  await expect(page.getByText("Current cash · unchanged")).toBeVisible();
  await capture("airbag-deployed");

  mark("Exact approval of the three provider changes");
  await page.getByRole("button", { name: "Review 3 actions" }).click();
  await page.waitForURL("**/review/**");
  await expect(page.getByRole("dialog")).toContainText("3 actions to approve");
  await capture("airbag-approval");
  await approve(page);

  mark("Each provider confirms; cash is untouched");
  await expect(page.getByText(/approved actions/)).toBeVisible();
  await expect(page.getByText(/^Confirmed by /)).toHaveCount(3, { timeout: 180_000 });
  expect(await totalFunds(page)).toBe(before);
  await capture("airbag-done");
});
