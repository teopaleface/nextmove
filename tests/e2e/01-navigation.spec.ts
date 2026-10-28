import { expect, noOverflow, signIn, switchContext, test } from "./helpers";

test("navigation: tabs, detail screens, alerts, profile and contexts @layout", async ({ page, mark, capture }) => {
  const nav = page.getByRole("navigation", { name: "Main" });

  mark("Sign in as a separate copy of Alex");
  await signIn(page, "alex");
  mark("Home: funds, accounts, everyday actions, coming up");
  await expect(page.getByText("Total liquid funds")).toBeVisible();
  await expect(page.getByText("Demo Labs").first()).toBeVisible();
  await noOverflow(page);
  await capture("home");

  mark("Upcoming payments and a subscription");
  await page.getByRole("link", { name: "Upcoming" }).first().click();
  await expect(page.getByRole("heading", { name: "Upcoming", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: /^Streamly/ }).first().click();
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
  await noOverflow(page);
  await capture("subscription");

  mark("Account and card");
  await nav.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "Cards" }).click();
  await expect(page.getByRole("button", { name: "Freeze card" })).toBeVisible();
  await noOverflow(page);

  mark("Activity: transactions, agent outcomes, refunds, subscriptions");
  await nav.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await page.locator("a.row").first().click();
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
  await noOverflow(page);
  await page.goBack();
  await page.getByRole("button", { name: "Refunds" }).click();
  await page.getByRole("link", { name: /StudioMart refund/ }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await noOverflow(page);
  await capture("refund-tracker");

  mark("Goals and a goal plan");
  await nav.getByRole("link", { name: "Goals" }).click();
  await expect(page.getByRole("heading", { name: "Your goals" })).toBeVisible();
  await page.getByRole("link", { name: /First home/ }).click();
  await expect(page.getByRole("link", { name: "Open the calculation" })).toBeVisible();
  await noOverflow(page);

  mark("Agent: ask, tools, everything NextMove can help with, planned items");
  await nav.getByRole("link", { name: "Agent" }).click();
  await expect(page.getByRole("heading", { name: "What NextMove can help with" })).toBeVisible();
  await expect(page.getByText("Operate apps on your own computer")).toBeVisible();
  await expect(page.getByText(/Planned, not in this build/)).toBeVisible();
  await noOverflow(page);
  await capture("agent");

  mark("Alerts, monitoring and permissions");
  await page.getByRole("link", { name: "Alerts and monitoring" }).click();
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
  await noOverflow(page);

  mark("Profile: contexts, features, Labs controls");
  await page.getByRole("link", { name: "Profile, context and access" }).click();
  await expect(page.getByRole("heading", { name: "What is switched on" })).toBeVisible();
  await noOverflow(page);

  mark("Switch demo customer to Laziz (business and household)");
  await page.getByRole("button", { name: /Switch demo customer/ }).click();
  await page.waitForURL("**/signin");
  await signIn(page, "laziz");
  await expect(page.getByText("Business funds")).toBeVisible();
  await capture("business-home");
  await switchContext(page, "PERSONAL");
  await expect(page.getByText("Total liquid funds")).toBeVisible();
  mark("Household context");
  await switchContext(page, "BUSINESS");
  await expect(page.getByText("Business funds")).toBeVisible();
  await noOverflow(page);
});
