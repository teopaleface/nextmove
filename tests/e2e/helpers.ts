import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

// Shared steps for the phone E2E suite. Each test signs in a separate demo copy, so tests never share state.
// `mark(label)` records the time since the page (and its video) started, giving per-feature video timestamps in the
// JSON results; `capture(name)` attaches a readable screenshot of the current screen.

type Fixtures = { mark: (label: string) => void; capture: (name: string) => Promise<void> };

export const test = base.extend<Fixtures>({
  mark: async ({ page }, use, testInfo) => {
    const t0 = Date.now();
    void page;
    await use((label: string) => {
      testInfo.annotations.push({ type: "feature", description: `${((Date.now() - t0) / 1000).toFixed(1)}s ${label}` });
    });
  },
  capture: async ({ page }, use, testInfo) => {
    await use(async (name: string) => {
      await page.waitForTimeout(250);
      const body = await page.screenshot({ fullPage: false });
      await testInfo.attach(`capture:${name}`, { body, contentType: "image/png" });
    });
  },
});
export { expect };

export async function signIn(page: Page, customer: "alex" | "laziz") {
  await page.goto("/signin");
  await page.locator(`input[name="customer"][value="${customer}"]`).check();
  await page.getByRole("checkbox", { name: /Start a separate copy/ }).check();
  await page.getByRole("button", { name: /Continue as/ }).click();
  await page.waitForURL("**/home");
  await expect(page.getByText("Demo Labs").first()).toBeVisible();
}

export async function session(page: Page) {
  const r = await page.request.get("/api/session");
  return r.json();
}

/** A same-origin API call with the session's CSRF token, as the app itself makes it. */
export async function apiPost(page: Page, path: string, body: unknown = {}) {
  const s = await session(page);
  return page.request.post(`/api${path}`, { data: body, headers: { "x-csrf-token": s.csrfToken } });
}

export async function apiGet(page: Page, path: string) {
  const r = await page.request.get(`/api${path}`);
  expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy();
  return r.json();
}

export async function switchContext(page: Page, kind: "BUSINESS" | "PERSONAL") {
  const s = await session(page);
  const target = s.contexts.find((c: any) => c.kind === kind);
  if (target.id === s.context.id) return;
  await page.getByRole("button", { name: /Switch context/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(target.name) }).click();
  await page.waitForURL("**/home");
  await expect(page.getByRole("button", { name: new RegExp(`Context: ${target.name}`) })).toBeVisible();
}

export async function openCapability(page: Page, id: string, headline?: RegExp | string) {
  await page.goto(`/capabilities/${id}`);
  if (headline) await expect(page.getByText(headline).first()).toBeVisible({ timeout: 60_000 });
  else await expect(page.locator(".opportunity h2")).toBeVisible({ timeout: 60_000 });
}

/** Choose candidates on a capability page and open the exact-approval sheet. */
export async function review(page: Page, select?: { check?: RegExp[]; uncheck?: RegExp[] }) {
  for (const r of select?.uncheck ?? []) await page.locator("label.check-row", { hasText: r }).locator("input").uncheck();
  for (const r of select?.check ?? []) await page.locator("label.check-row", { hasText: r }).locator("input").check();
  await page.getByRole("button", { name: /^Review (this action|\d+ actions)$/ }).click();
  await page.waitForURL("**/review/**");
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** Approve what the sheet shows. Single actions land on the live action page. */
export async function approve(page: Page) {
  const button = page.locator(".sheet-actions .btn.primary");
  await expect(button).toBeEnabled();
  await button.click();
}

export async function expectDone(page: Page, merchant: string, timeout = 120_000) {
  await page.waitForURL("**/actions/**");
  await expect(page.getByText(`Done. ${merchant} confirmed it`)).toBeVisible({ timeout });
}

export async function labs(page: Page, label: RegExp) {
  await page.getByRole("button", { name: label }).click();
  await expect(page.locator(".toast")).toContainText("Labs");
}

/** The checkbox of one candidate action, matched on the start of its title (dependent rows mention other titles). */
export function candidate(page: Page, title: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
}

export async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
}

export function moneyText(minor: number) {
  return `${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} RON`;
}

export async function totalFunds(page: Page) {
  const h = await apiGet(page, "/home");
  return h.totalMinor as number;
}

export function annotate(testInfo: TestInfo, type: string, description: string) {
  testInfo.annotations.push({ type, description });
}
