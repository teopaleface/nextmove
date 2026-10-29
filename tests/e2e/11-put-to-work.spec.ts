import { approve, expect, expectDone, review, signIn, test, totalFunds } from "./helpers";

test("After the FitFlow stop: put the 79 RON to work in Savings, through the same exact approval", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const before = await totalFunds(page);

  mark("Stop the FitFlow trial (T2)");
  await page.getByRole("link", { name: "Review my options" }).click();
  await expect(page.getByText("Stopping the trial lowers upcoming charges from 242.00 RON to 163.00 RON")).toBeVisible();
  await review(page);
  await approve(page);
  await expectDone(page, "FitFlow");

  mark("Receipt offers to put the avoided 79 RON to work");
  await page.getByRole("link", { name: /You kept 79 RON\. Put it to work\?/ }).click();
  const offer = page.locator("#put-to-work");
  await expect(offer.getByRole("heading", { name: "You kept 79 RON. Put it to work?" })).toBeVisible();
  await expect(offer).toContainText("That is a charge avoided, not a refund");
  await expect(offer).toContainText("Savings account, 5% a year");
  await expect(offer).toContainText("Demo rate");
  await expect(offer).toContainText("Titluri de stat (Romanian government bonds)");
  await expect(offer).toContainText("Simulated, not an offer");
  await expect(offer).toContainText("82.95 RON, of which 3.95 RON interest");
  await expect(offer).toContainText("Projection, not a promise");
  await offer.getByRole("radio", { name: /Savings account, 5% a year/ }).check();
  await offer.scrollIntoViewIfNeeded();
  await capture("put-to-work-offer");

  mark("Exact approval of one transfer from Daily");
  await offer.getByRole("button", { name: "Review: move 79.00 RON from Daily account" }).click();
  await page.waitForURL("**/review/**");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Move 79.00 RON from Daily account to Savings");
  await expect(sheet).toContainText("(projection, not a promise)");
  await expect(sheet).toContainText("5.00% a year, demo rate");
  await capture("put-to-work-approval");
  await approve(page);

  mark("Bank posts the transfer; the offer is done");
  await expectDone(page, "NextMove bank");
  await page.getByRole("link", { name: /View receipt NMT-/ }).click();
  await expect(page.getByText("79.00 RON between your accounts")).toBeVisible();
  expect(await totalFunds(page)).toBe(before);
  await page.goto("/home");
  await expect(page.getByText("5.00% a year, demo rate")).toBeVisible();
  await capture("put-to-work-home");
});
