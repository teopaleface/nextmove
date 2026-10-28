import { candidate, apiGet, expect, openCapability, signIn, test } from "./helpers";

// These tests call the live model through the server-side Claude CLI adapter, on synthetic images. They fail (they do
// not silently fall back) when the model is unavailable, so a passing run is a real model response.

test.describe.configure({ timeout: 420_000 });

test("T1: the live model reads a Screen Time image; you confirm; NextMove matches it to subscriptions", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await page.goto("/agent/evidence");
  mark("Evidence: synthetic samples or your own upload");
  await page.getByRole("button", { name: /Screen Time, last 7 days/ }).click();
  mark("Live model reading the image bytes");
  await expect(page.getByText(/Read by the live model \(/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByLabel("Streamly (minutes)")).toHaveValue("38");
  await capture("t1-read");
  mark("Each value labelled: read from the image, or check this");
  await page.getByRole("button", { name: "Confirm these values" }).click();
  await expect(page.locator(".toast")).toContainText("Confirmed");
  await page.getByRole("link", { name: "See what it means for your subscriptions" }).click();
  await expect(page.getByText("Screen Time confirmed and matched to your subscriptions")).toBeVisible();
  mark("T1 result: phone minutes against what each subscription costs");
  await page.getByRole("group", { name: /watch Streamly on a TV or laptop/ }).getByRole("button", { name: "No" }).click();
  await page.getByRole("group", { name: /anyone else in your household use your Streamly/ }).getByRole("button", { name: "No" }).click();
  await expect(page.getByText(/A pause \(A6\) would skip the next 49 RON charge/)).toBeVisible();
  await capture("t1-matched");
});

test("Image instructions are data: a hostile invoice cannot create a payment", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await page.goto("/agent/evidence");
  await page.getByRole("button", { name: /Invoice from an unknown supplier/ }).click();
  mark("Live model reading an invoice that contains instructions");
  await expect(page.getByText(/Read by the live model \(/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText("Instructions inside the image were ignored")).toBeVisible();
  await capture("invoice-injection");
  mark("Instructions flagged and ignored; nothing paid or approved");
  await page.getByRole("button", { name: "Confirm these values" }).click();
  await openCapability(page, "T1");
  await expect(page.getByText(/NextMove will not prepare a payment to it/)).toBeVisible();
  const home = await apiGet(page, "/home");
  expect(home.tasks.filter((t: any) => t.state === "NEEDS_APPROVAL").length).toBe(0);
});

test("Student ID read by the live model unlocks bundle verification", async ({ page, mark }) => {
  await signIn(page, "alex");
  await page.goto("/agent/evidence");
  await page.getByRole("button", { name: /Student ID card/ }).click();
  mark("Live model reading a synthetic student ID");
  await expect(page.getByText(/Read by the live model \(/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("textbox", { name: "Student ID number" })).toHaveValue(/S\s?2024\s?0417\s?3381/);
  await page.getByRole("button", { name: "Confirm these values" }).click();
  await page.getByRole("link", { name: "Use it for the student bundle" }).click();
  await expect(candidate(page, "Verify student status with StudyPlus")).toBeEnabled();
  mark("T3 verification available from the confirmed fact");
});

test("Agent: a question answered by the planner, with the planner disclosed", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  const s = await apiGet(page, "/session");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Agent" }).click();
  await page.getByLabel("Ask NextMove").fill("Am I paying twice for cloud storage?");
  mark("Ask in your own words");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL("**/agent/tasks/**");
  mark("Planner chooses typed tools; code does the money");
  const live = s.model.planner !== "simulated";
  await expect(page.getByText(live ? /Answer by (claude|the live model)/ : "Answer by the simulated planner")).toBeVisible({ timeout: 240_000 });
  await capture("agent-answer");
  await expect(page.getByRole("heading", { name: "Calculations" })).toBeVisible();
  mark(live ? "Answered by the live model" : "Answered by the labelled simulated planner");
});
