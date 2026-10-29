import { candidate, approve, expect, expectDone, openCapability, review, signIn, test } from "./helpers";

test("O1 and A10: home goal with and without the phone, true cost, saved plan", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await openCapability(page, "O1", /Home ready (in|after)/);
  mark("O1 dated home readiness with each phone");
  await capture("o1");
  await page.getByLabel("Monthly saving").fill("7000");
  await page.getByRole("button", { name: "Recalculate" }).click();
  await expect(page.getByLabel("Monthly saving")).toHaveValue("7000");
  mark("Assumption changed; dates recalculated");
  await page.getByRole("button", { name: "Save this plan to my goal" }).click();
  await expect(page.locator(".toast")).toContainText("Saved as plan revision 2");
  await page.goto("/goals");
  await expect(page.getByText(/input revision 2/)).toBeVisible();
  mark("Saved decision with its input revision");

  await openCapability(page, "A10", /2,560.00 RON less than/);
  mark("A10 two-year cost of each phone");
});

test("A12 and A14: use expiring credit, verify a card benefit, buy the eSIM", async ({ page, mark }) => {
  await signIn(page, "alex");
  await openCapability(page, "A12", /uses 120.00 RON of credit/);
  mark("A12 credit before it expires");
  await review(page);
  await approve(page);
  await expectDone(page, "BookNook");

  await openCapability(page, "A14", /DataPass may be cheapest/);
  mark("A14 trip costs: data, cards, currency");
  await page.getByRole("button", { name: "Check my card's travel credit" }).click();
  await expect(page.locator(".toast")).toContainText("confirmed from the bank record");
  await expect(candidate(page, "Buy the DataPass Europe eSIM")).toBeEnabled();
  mark("Card credit verified from the bank record");
  await review(page);
  await approve(page);
  await expectDone(page, "DataPass Europe");
});
