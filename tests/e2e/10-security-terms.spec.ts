import { apiGet, apiPost, approve, expect, expectDone, openCapability, review, session, signIn, switchContext, test } from "./helpers";

test("Isolation: another session cannot open this session's action, receipt or proposal", async ({ page, browser, mark, capture }, testInfo) => {
  await signIn(page, "alex");
  await openCapability(page, "A6", /A 1-month pause skips 49.00 RON/);
  await review(page);
  const proposalId = page.url().split("/review/")[1];
  await approve(page);
  await expectDone(page, "Streamly");
  const actionUrl = new URL(page.url()).pathname;
  const receiptHref = await page.getByRole("link", { name: /View receipt/ }).getAttribute("href");
  mark("Session A owns an action, a receipt and a proposal");

  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: testInfo.outputPath("session-b"), size: { width: 390, height: 844 } } });
  const b = await other.newPage();
  await signIn(b, "alex");
  await b.goto(actionUrl);
  await expect(b.getByText("Not found")).toBeVisible();
  await b.screenshot({ path: testInfo.outputPath("isolation-denied.png") });
  await b.goto(receiptHref!);
  await expect(b.getByText("Not found")).toBeVisible();
  expect((await b.request.get(`/api/proposals/${proposalId}`)).status()).toBe(404);
  expect((await b.request.get(`/api${actionUrl}`)).status()).toBe(404);
  mark("Session B (another copy) gets Not found for all of them");
  const video = b.video();
  await other.close();
  if (video) await testInfo.attach("video:session-b", { path: await video.path(), contentType: "video/webm" });
  await testInfo.attach("capture:isolation-denied", { path: testInfo.outputPath("isolation-denied.png"), contentType: "image/png" });
  await capture("isolation-owner");
});

test("Forged, cross-site, replayed and wrong-context approvals are refused", async ({ page, mark }) => {
  await signIn(page, "laziz");
  const p = await (await apiPost(page, "/capabilities/A13/propose", { keys: ["reduce-seats"] })).json();
  mark("A proposal for the business context");

  expect((await apiPost(page, `/proposals/${p.id}/approve`, { digest: "0".repeat(64), actionIds: p.actions.map((a: any) => a.id) })).status()).toBe(409);
  expect((await page.request.post(`/api/proposals/${p.id}/approve`, { data: { digest: p.digest, actionIds: p.actions.map((a: any) => a.id) } })).status()).toBe(403);
  const s = await session(page);
  expect((await page.request.post(`/api/proposals/${p.id}/approve`, { data: { digest: p.digest, actionIds: p.actions.map((a: any) => a.id) }, headers: { "x-csrf-token": s.csrfToken, "sec-fetch-site": "cross-site", origin: "https://evil.example" } })).status()).toBe(403);
  mark("Forged digest 409, missing CSRF 403, cross-site 403");

  await switchContext(page, "PERSONAL");
  await page.goto(`/review/${p.id}`);
  await expect(page.getByText("This belongs to Laziz Products")).toBeVisible();
  await expect(page.locator(".sheet-actions .btn.primary")).toBeDisabled();
  const wrong = await apiPost(page, `/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((a: any) => a.id) });
  expect(wrong.status()).toBe(409);
  expect((await wrong.json()).error).toBe("WRONG_CONTEXT");
  mark("Wrong context: the sheet shows whose it is and approval is refused");

  await page.getByRole("button", { name: "Switch to Laziz Products" }).click();
  await page.waitForURL(`**/review/${p.id}`);
  await approve(page);
  await expectDone(page, "TeamDesk");
  const replay = await apiPost(page, `/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((a: any) => a.id) });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).alreadyApproved).toBe(true);
  const receipts = (await apiGet(page, "/activity")).receipts.filter((r: any) => r.operation === "REDUCE_SEATS");
  expect(receipts.length).toBe(1);
  mark("Replay returns the same approval; one receipt, one change");
});

test("Changed terms before approval: nothing is sent and the plan asks for a fresh check", async ({ page, mark, capture }) => {
  await signIn(page, "alex");
  await openCapability(page, "T3", /Bundle would save 39.00 RON/);
  await page.getByRole("textbox", { name: "Student ID number" }).fill("S202404173381");
  await page.getByRole("button", { name: "Recalculate" }).click();
  await review(page);
  const proposalId = page.url().split("/review/")[1];
  mark("Approval sheet open for the student bundle");

  const t3 = await apiGet(page, "/capabilities/T3");
  const change = t3.labs.find((l: any) => l.action === "change_offer_terms");
  expect((await apiPost(page, "/labs/merchant", { action: change.action, body: change.body })).ok()).toBeTruthy();
  mark("Labs: the provider removes offline playback from the offer (new terms revision)");
  await expect.poll(async () => (await apiGet(page, `/proposals/${proposalId}`)).status, { timeout: 30_000 }).toBe("OUTDATED");

  await page.locator(".sheet-actions .btn.primary").click();
  await expect(page.getByText(/needs a fresh check/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Terms or inputs changed")).toBeVisible();
  await capture("terms-changed");
  const p = await apiGet(page, `/proposals/${proposalId}`);
  expect(p.actions.every((a: any) => !a.attempt)).toBeTruthy();
  mark("Refused before any request: no attempt exists; Review updated plan");
  await page.getByRole("link", { name: "Review updated plan" }).click();
  await expect(page).toHaveURL(/\/capabilities\/T3/);
});
