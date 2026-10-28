import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { config, dataDir } from "../config";
import { CORRELATION_HEADER } from "../../shared/merchant-contract";

// Isolated server browser for merchants without a partner write API. Each action gets a fresh synthetic context
// (no personal profile, no downloads, no service workers, page JavaScript off) whose network is restricted to the
// merchant's registered loopback path prefix. The final committing POST is intercepted: its form fields must
// match the approved action and the dispatch gate must authorize it, otherwise the request is aborted.

export type GateDecision = { ok: true } | { ok: false; reason: string };

export interface BrowserStep {
  at: string;
  label: string;
  url: string;
  screenshot: string | null; // file name under .data/evidence (never captured on sign-in pages)
}

export type BrowserOutcome =
  | { kind: "CONFIRMED"; reference: string; accessUntil: string | null }
  | { kind: "ALREADY_OFF"; reference: string | null }
  | { kind: "PENDING" }
  | { kind: "REFUSED"; reason: string }
  | { kind: "TERMS_CHANGED"; currentRevision: number | null; dispatched: boolean }
  | { kind: "AUTH_REQUIRED" }
  | { kind: "GATE_DENIED"; reason: string }
  | { kind: "UNKNOWN"; detail: string }
  | { kind: "FAILED_BEFORE_SEND"; detail: string };

export interface BrowserRun {
  outcome: BrowserOutcome;
  steps: BrowserStep[];
  dispatched: boolean;
  blockedRequests: string[];
  untrustedContentIgnored: boolean;
}

let shared: Promise<Browser> | null = null;

export function sharedBrowser(): Promise<Browser> {
  if (!shared) {
    shared = chromium.launch({ headless: true, args: ["--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-sync"] }).catch((e) => {
      shared = null;
      throw e;
    });
  }
  return shared;
}

export async function closeSharedBrowser() {
  if (!shared) return;
  const b = await shared.catch(() => null);
  shared = null;
  await b?.close().catch(() => undefined);
}

export function evidenceDir() {
  const dir = path.join(dataDir(), "evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function browserStopRenewal(input: {
  attemptId: string;
  merchantId: string;
  contractId: string;
  approvedTermsRevision: number;
  correlationId: string;
  delegatedToken: string;
  authorize: () => Promise<GateDecision>;
  onStep?: (step: BrowserStep) => void;
}): Promise<BrowserRun> {
  const origin = new URL(config.merchantBaseUrl);
  const prefix = `/m/${input.merchantId}/`;
  const finalPath = `${prefix}account/contracts/${encodeURIComponent(input.contractId)}/cancel`;
  const steps: BrowserStep[] = [];
  const blockedRequests: string[] = [];
  let dispatched = false;
  let gateDenied: string | null = null;
  let formMismatch: string | null = null;
  let responseLost: string | null = null;
  const browser = await sharedBrowser();
  const context = await browser.newContext({
    javaScriptEnabled: false,
    acceptDownloads: false,
    serviceWorkers: "block",
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 1,
    userAgent: "NextMove-Labs-IsolatedBrowser/1.0 (synthetic)",
  });
  await context.addCookies([{ name: "fm_session", value: input.delegatedToken, domain: origin.hostname, path: prefix, httpOnly: true, sameSite: "Strict", secure: false }]);
  await context.route("**/*", async (route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      blockedRequests.push("unparseable");
      return route.abort("blockedbyclient");
    }
    if (url.protocol !== "http:" || url.hostname !== origin.hostname || url.port !== origin.port || url.username || url.password || !url.pathname.startsWith(prefix)) {
      blockedRequests.push(`${req.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (req.method() === "GET") return route.continue();
    if (req.method() === "POST" && url.pathname === finalPath) {
      const form = new URLSearchParams(req.postData() ?? "");
      const ok = form.get("contractId") === input.contractId && form.get("operation") === "STOP_RENEWAL" && Number(form.get("termsRevision")) === input.approvedTermsRevision;
      if (!ok) {
        formMismatch = `form fields ${form.get("contractId")}/${form.get("operation")}/rev ${form.get("termsRevision")} do not match the approved action`;
        blockedRequests.push(`POST ${url.pathname} (mismatch)`);
        return route.abort("blockedbyclient");
      }
      const decision = await input.authorize();
      if (!decision.ok) {
        gateDenied = decision.reason;
        blockedRequests.push(`POST ${url.pathname} (gate: ${decision.reason})`);
        return route.abort("blockedbyclient");
      }
      // The gate forwards the page's own request exactly once. Chromium silently re-sends a POST when a reused
      // keep-alive socket resets before response headers, and that re-send would bypass this handler; fetching
      // through the gate (no retries, no redirects) keeps one physical request per approved grant.
      dispatched = true;
      try {
        const response = await route.fetch({ headers: { ...req.headers(), [CORRELATION_HEADER]: input.correlationId }, maxRetries: 0, maxRedirects: 0, timeout: 10_000 });
        return route.fulfill({ response });
      } catch (e: any) {
        responseLost = String(e?.message ?? e).split("\n")[0].slice(0, 160);
        return route.abort("connectionreset");
      }
    }
    // Sign-in forms and any other write are never submitted by the agent.
    blockedRequests.push(`${req.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const dir = evidenceDir();
  const snap = async (label: string, capture = true) => {
    let file: string | null = null;
    if (capture) {
      file = `${input.attemptId}-${steps.length + 1}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: false }).catch(() => (file = null));
    }
    const step = { at: new Date().toISOString(), label, url: page.url().replace(origin.origin, ""), screenshot: file };
    steps.push(step);
    input.onStep?.(step);
  };
  const finish = async (outcome: BrowserOutcome, untrusted = false): Promise<BrowserRun> => {
    await context.close().catch(() => undefined);
    return { outcome, steps, dispatched, blockedRequests, untrustedContentIgnored: untrusted };
  };
  try {
    await page.goto(`${origin.origin}${prefix}account`, { waitUntil: "domcontentloaded" });
    if (await page.locator("[data-nm-auth-required]").count()) {
      await snap("Provider asks the account holder to sign in (not captured)", false);
      return finish({ kind: "AUTH_REQUIRED" });
    }
    const untrusted = (await page.locator("[data-nm-untrusted]").count()) > 0;
    await snap(untrusted ? "Opened the provider account page (untrusted promotional text ignored)" : "Opened the provider account page");
    const card = page.locator(`section[data-nm-contract="${cssEscape(input.contractId)}"]`);
    if ((await card.count()) !== 1) return finish({ kind: "FAILED_BEFORE_SEND", detail: "The approved contract is not on the provider page" }, untrusted);
    const rev = Number(await card.getAttribute("data-nm-terms-revision"));
    if ((await card.getAttribute("data-nm-auto-renew")) !== "true") return finish({ kind: "ALREADY_OFF", reference: null }, untrusted);
    if (rev !== input.approvedTermsRevision) {
      await snap(`Terms on the page are revision ${rev}, approved revision ${input.approvedTermsRevision}: stopped`);
      return finish({ kind: "TERMS_CHANGED", currentRevision: rev, dispatched: false }, untrusted);
    }
    await card.locator('a[data-nm-action="manage-renewal"]').click();
    await page.waitForLoadState("domcontentloaded");
    if (await page.locator("[data-nm-auth-required]").count()) {
      await snap("Provider asks the account holder to sign in (not captured)", false);
      return finish({ kind: "AUTH_REQUIRED" }, untrusted);
    }
    const confirm = page.locator('[data-nm-confirm="stop-renewal"]');
    if ((await confirm.count()) !== 1) {
      const result = await page.locator("[data-nm-result]").getAttribute("data-nm-result").catch(() => null);
      if (result === "ALREADY_OFF") return finish({ kind: "ALREADY_OFF", reference: null }, untrusted);
      return finish({ kind: "FAILED_BEFORE_SEND", detail: "The provider's confirmation step was not shown" }, untrusted);
    }
    const pageRev = Number(await confirm.getAttribute("data-nm-terms-revision"));
    const fee = Number(await confirm.getAttribute("data-nm-fee-minor"));
    if ((await confirm.getAttribute("data-nm-contract")) !== input.contractId || pageRev !== input.approvedTermsRevision) {
      await snap(`Confirmation page shows revision ${pageRev}: stopped before submitting`);
      return finish({ kind: "TERMS_CHANGED", currentRevision: pageRev, dispatched: false }, untrusted);
    }
    if (fee !== 0) return finish({ kind: "FAILED_BEFORE_SEND", detail: `The page shows a fee of ${fee} bani that was not approved` }, untrusted);
    await snap("Provider confirmation page matches the approved contract, terms and 0 RON fee");
    const nav = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12_000 }).then(
      () => null,
      (e: any) => String(e?.message ?? e),
    );
    await page.locator('button[data-nm-action="confirm-stop-renewal"]').click({ noWaitAfter: true });
    const navError = await nav;
    if (formMismatch) return finish({ kind: "FAILED_BEFORE_SEND", detail: formMismatch }, untrusted);
    if (gateDenied) return finish({ kind: "GATE_DENIED", reason: gateDenied }, untrusted);
    if (!dispatched) return finish({ kind: "FAILED_BEFORE_SEND", detail: navError ?? "The final request was not sent" }, untrusted);
    const result = responseLost ? null : await page.locator("[data-nm-result]").getAttribute("data-nm-result", { timeout: 2_000 }).catch(() => null);
    if (responseLost || navError || !result) {
      await snap("The provider did not answer after the request was sent");
      return finish({ kind: "UNKNOWN", detail: responseLost || navError ? "Connection lost after the request was sent" : "No result on the provider page" }, untrusted);
    }
    await snap(`Provider result: ${result.replace(/_/g, " ").toLowerCase()}`);
    const el = page.locator("[data-nm-result]");
    if (result === "CONFIRMED") return finish({ kind: "CONFIRMED", reference: (await el.getAttribute("data-nm-reference")) ?? "", accessUntil: (await el.getAttribute("data-nm-access-until")) || null }, untrusted);
    if (result === "ALREADY_OFF") return finish({ kind: "ALREADY_OFF", reference: (await el.getAttribute("data-nm-reference")) || null }, untrusted);
    if (result === "PENDING_REVIEW") return finish({ kind: "PENDING" }, untrusted);
    if (result === "TERMS_CHANGED") return finish({ kind: "TERMS_CHANGED", currentRevision: Number(await el.getAttribute("data-nm-terms-revision")) || null, dispatched: true }, untrusted);
    return finish({ kind: "REFUSED", reason: ((await el.textContent()) ?? "Refused").trim().slice(0, 200) }, untrusted);
  } catch (e: any) {
    const detail = String(e?.message ?? e).split("\n")[0].slice(0, 200);
    return finish(dispatched ? { kind: "UNKNOWN", detail } : { kind: "FAILED_BEFORE_SEND", detail });
  }
}

function cssEscape(v: string) {
  return v.replace(/["\\]/g, "\\$&");
}
