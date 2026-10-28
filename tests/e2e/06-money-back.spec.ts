import { apiGet, approve, expect, expectDone, labs, openCapability, review, signIn, test, totalFunds } from "./helpers";

test("A7: an accepted refund is not money until the bank credit posts, once", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const before = await totalFunds(page);
  await page.goto("/activity");
  await page.getByRole("button", { name: "Refunds" }).click();
  await page.getByRole("link", { name: /StudioMart refund/ }).click();
  await expect(page.getByText("Accepted by merchant, waiting for bank credit").first()).toBeVisible();
  mark("Refund tracker: accepted, not credited");
  await capture("a7-waiting");

  await openCapability(page, "A7", /StudioMart accepted 249.00 RON/);
  await review(page);
  await approve(page);
  await expectDone(page, "StudioMart");
  mark("Follow-up sent to StudioMart");
  expect(await totalFunds(page)).toBe(before);

  await openCapability(page, "A7");
  await labs(page, /pay the refund now/);
  mark("Labs: StudioMart pays; the bank credit arrives as a separate event");
  await expect.poll(async () => totalFunds(page), { timeout: 60_000 }).toBe(before + 24900);
  await page.goto("/activity");
  await page.getByRole("button", { name: "Refunds" }).click();
  await expect(page.getByText("Credited to your account")).toBeVisible();
  await capture("a7-credited");
  mark("Credited once: +249.00 RON");
});

test("A8 and A9: duplicate-charge check and a price-protection claim", async ({ page, mark }) => {
  await signIn(page, "alex");
  await openCapability(page, "A8", /3 repeated payments/);
  mark("A8 tells a card hold apart from two settled payments");
  const q = page.getByRole("group", { name: /TechBits/ });
  await q.getByRole("button", { name: "Yes" }).click();
  await expect(q.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await review(page);
  await approve(page);
  await page.waitForURL("**/actions/**");
  await expect(page.getByText(/Done\. TechBits confirmed it|Awaiting TechBits confirmation/)).toBeVisible({ timeout: 120_000 });
  mark("Claim submitted to TechBits");

  await openCapability(page, "A9", /Eligible: 100.00 RON/);
  mark("A9 price protection window");
  await review(page);
  await approve(page);
  await page.waitForURL("**/actions/**");
  await expect(page.getByText(/Done\. SoundHub confirmed it|Awaiting SoundHub confirmation/)).toBeVisible({ timeout: 120_000 });
  const act = await apiGet(page, "/activity");
  expect(act.recoveries.some((r: any) => r.kind === "PRICE_ADJUSTMENT")).toBeTruthy();
  mark("Request tracked as a recovery");
});
