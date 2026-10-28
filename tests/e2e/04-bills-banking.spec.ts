import { apiGet, approve, expect, expectDone, openCapability, review, signIn, switchContext, test, totalFunds } from "./helpers";

test("A2: right-size the phone plan after a hotspot question", async ({ page, mark }) => {
  await signIn(page, "alex");
  await openCapability(page, "A2", /Smart 20 GB fits your use/);
  mark("A2 usage against the plan");
  await page.getByRole("group", { name: /Do you still need hotspot/ }).getByRole("button", { name: "No" }).click();
  await expect(page.getByRole("group", { name: /Do you still need hotspot/ }).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
  mark("Answer saved as a preference");
  await review(page);
  await approve(page);
  await expectDone(page, "MobileNet");
});

test("Pay a known bill and freeze the card, each with exact approval", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const before = await totalFunds(page);

  mark("Pay a bill NextMove knows about");
  await page.getByRole("link", { name: "Pay", exact: true }).click();
  await page.getByRole("radio", { name: /MobileNet/ }).check();
  await page.getByRole("button", { name: "Review payment of 65.00 RON" }).click();
  await page.waitForURL("**/review/**");
  await expect(page.getByRole("dialog")).toContainText("65.00 RON");
  await capture("pay-approval");
  await approve(page);
  await expectDone(page, "NextMove bank");
  expect(await totalFunds(page)).toBe(before - 6500);
  mark("Ledger posting: balance down by exactly 65.00 RON");

  mark("Freeze the card");
  await page.goto("/home");
  await page.getByRole("link", { name: "Cards" }).click();
  await page.getByRole("button", { name: "Freeze card" }).click();
  await page.waitForURL("**/review/**");
  await approve(page);
  await expectDone(page, "NextMove bank");
  await page.goto("/home");
  await page.getByRole("link", { name: "Cards" }).click();
  await expect(page.getByText("Frozen: new card payments are declined")).toBeVisible();
  await capture("card-frozen");
  mark("Card frozen; unfreeze is offered");
  await expect(page.getByRole("button", { name: "Unfreeze card" })).toBeVisible();
});

test("A11: move a household bill's date so it does not fail before the owner transfer", async ({ page, mark }) => {
  await signIn(page, "laziz");
  await switchContext(page, "PERSONAL");
  await openCapability(page, "A11", /On the 2nd the payment would fail/);
  mark("A11 dated cash forecast");
  await review(page);
  await approve(page);
  await expectDone(page, "ElectraCasa");
  const up = await apiGet(page, "/upcoming");
  expect(up.items.find((i: any) => /ElectraCasa/.test(i.label))?.due_at).toContain("-05T");
  mark("Bill moved to the 5th");
});
