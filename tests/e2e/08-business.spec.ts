import { approve, expect, expectDone, labs, openCapability, review, signIn, test } from "./helpers";

test("Business: order conditions, stock order, owner pay, receivables, funding packet, unused seats", async ({ page, mark, capture }) => {
  await signIn(page, "laziz");
  await expect(page.getByText("Business funds")).toBeVisible();

  await openCapability(page, "O1", /Only with a deposit and early collection/);
  mark("O1 the 40,000 RON order: conditions to keep the reserve");
  await capture("o1-business");

  await openCapability(page, "O2", /Buy 800 units/);
  mark("O2 compare suppliers and order");
  await review(page);
  await approve(page);
  await expectDone(page, "MillCo Ingredients");

  await openCapability(page, "O3", /Household goes to/);
  mark("O3 owner pay before household bills");
  await review(page);
  await approve(page);
  await expectDone(page, "NextMove bank");

  await openCapability(page, "O4", /24,000.00 RON is owed to you/);
  mark("O4 receivables and a reminder");
  await review(page);
  await approve(page);
  await expectDone(page, "Cafe Aurora SRL");
  await openCapability(page, "O4");
  await labs(page, /Cafe Aurora pays 4,000 RON/);
  await expect(page.getByText(/20,000.00 RON is owed to you|Cafe Aurora/).first()).toBeVisible();

  await openCapability(page, "O5", /offer A costs 250.00 RON less/);
  mark("O5 two fictional funding offers compared");
  await page.goto("/business/packet");
  await page.getByRole("button", { name: /Prepare the packet|Prepare again/ }).click();
  await expect(page.getByText("Prepared, not sent")).toBeVisible();
  await capture("funding-packet");
  mark("Funding packet prepared, never sent");

  await openCapability(page, "A13", /3 seats can go/);
  mark("A13 unused software seats");
  await review(page);
  await approve(page);
  await expectDone(page, "TeamDesk");
});
