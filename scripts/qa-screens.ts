import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

// Local screen QA against the running stack (npm run dev or npm run demo). Signs in a separate demo copy, opens every
// phone route at the given widths, saves full-page screenshots under .data/qa/<width>/, and reports horizontal
// overflow, console errors and internal links that do not resolve. Read-only apart from creating the demo copy.
//
//   node --import tsx scripts/qa-screens.ts [--widths=360,390,430] [--only=home,batch]

const BASE = process.env.NEXTMOVE_BANK_URL ?? "http://127.0.0.1:3210";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const widths = (arg("widths") ?? "390").split(",").map(Number);
const only = arg("only")?.split(",");
const outRoot = path.join(process.cwd(), ".data", "qa");

type Screen = { name: string; path: string; customer?: "alex" | "laziz"; context?: "BUSINESS" | "PERSONAL"; wait?: string };

async function api(page: Page, p: string) {
  const r = await page.request.get(`${BASE}/api${p}`);
  if (!r.ok()) throw new Error(`${p} -> ${r.status()}`);
  return r.json();
}

async function signIn(page: Page, customer: "alex" | "laziz") {
  const r = await page.request.post(`${BASE}/api/session/demo`, { data: { customer, isolated: true } });
  if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
  return r.json();
}

async function switchTo(page: Page, kind: "BUSINESS" | "PERSONAL", csrf: string) {
  const s = await api(page, "/session");
  const ctx = s.contexts.find((c: any) => c.kind === kind);
  if (!ctx || ctx.id === s.context.id) return;
  const r = await page.request.post(`${BASE}/api/session/context`, { data: { contextId: ctx.id }, headers: { "x-csrf-token": csrf } });
  if (!r.ok()) throw new Error(`context switch failed: ${r.status()}`);
}

async function main() {
  const browser = await chromium.launch();
  const report: string[] = [];
  let failures = 0;
  for (const width of widths) {
    const dir = path.join(outRoot, String(width));
    fs.mkdirSync(dir, { recursive: true });
    for (const customer of ["alex", "laziz"] as const) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
      const sess = await signIn(page, customer);
      const screens: Screen[] = [];
      if (customer === "alex") {
        const home = await api(page, "/home");
        const up = await api(page, "/upcoming");
        const act = await api(page, "/activity");
        const goals = await api(page, "/goals");
        screens.push(
          { name: "home", path: "/home", wait: "Coming up" },
          { name: "upcoming", path: "/home/upcoming", wait: "Scheduled" },
          { name: "subscription", path: `/home/subscriptions/${encodeURIComponent(up.subscriptions.find((x: any) => x.merchant_name === "Streamly")?.id ?? up.subscriptions[0].id)}`, wait: "Details" },
          { name: "account", path: `/home/accounts/${encodeURIComponent(home.accounts[0].id)}`, wait: "Transactions" },
          { name: "pay", path: "/pay", wait: "Choose a bill" },
          { name: "activity", path: "/activity", wait: "Transactions" },
          { name: "transaction", path: `/activity/transactions/${encodeURIComponent(act.transactions[0].id)}`, wait: "Details" },
          ...(act.recoveries[0] ? [{ name: "recovery", path: `/activity/recoveries/${encodeURIComponent(act.recoveries[0].id)}`, wait: "Timeline" }] : []),
          { name: "goals", path: "/goals", wait: "Your goals" },
          { name: "goal", path: `/goals/${encodeURIComponent(goals.goals[0].id)}`, wait: "Open the calculation" },
          { name: "agent", path: "/agent", wait: "What NextMove can help with" },
          { name: "evidence", path: "/agent/evidence", wait: "Try a sample" },
          { name: "monitoring", path: "/agent/monitoring", wait: "Permissions" },
          { name: "batch", path: "/batch", wait: "Recurring payments" },
          { name: "profile", path: "/profile", wait: "Contexts" },
          { name: "cap-T2", path: "/capabilities/T2", wait: "What NextMove can do" },
          { name: "cap-O1", path: "/capabilities/O1", wait: "Assumptions you can change" },
        );
      } else {
        await switchTo(page, "BUSINESS", sess.csrfToken);
        screens.push(
          { name: "biz-home", path: "/home", wait: "Coming up" },
          { name: "biz-goals", path: "/goals", wait: "Business plans" },
          { name: "biz-packet", path: "/business/packet", wait: "Funding packet" },
          { name: "biz-cap-O2", path: "/capabilities/O2", wait: "Stock" },
          { name: "biz-agent", path: "/agent", wait: "Tools" },
        );
      }
      for (const s of screens) {
        if (only && !only.includes(s.name)) continue;
        errors.length = 0;
        await page.goto(`${BASE}${s.path}`, { waitUntil: "domcontentloaded" });
        try {
          if (s.wait) await page.getByText(s.wait, { exact: false }).first().waitFor({ timeout: 20_000 });
          await page.waitForTimeout(400);
        } catch {
          failures++;
          report.push(`FAIL ${width} ${s.name}: "${s.wait}" not shown`);
        }
        const m = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          links: [...new Set([...document.querySelectorAll<HTMLAnchorElement>("a[href^='/']")].map((a) => a.getAttribute("href")!))],
          small: [...document.querySelectorAll<HTMLElement>("a, button, input, select, summary, label.row")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const st = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && r.height < 40 && st.visibility !== "hidden" && !el.closest(".dev") && el.tagName !== "INPUT";
            })
            .map((el) => `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}(${Math.round(el.getBoundingClientRect().height)})`)
            .slice(0, 6),
        }));
        await page.screenshot({ path: path.join(dir, `${s.name}.png`), fullPage: true });
        const bad: string[] = [];
        for (const href of m.links) {
          if (href.startsWith("/api/")) continue;
          const r = await page.request.get(`${BASE}${href}`, { maxRedirects: 0 }).catch(() => null);
          if (!r || r.status() >= 400) bad.push(`${href} (${r?.status() ?? "error"})`);
        }
        if (m.overflow > 0 || bad.length || errors.length) failures++;
        report.push(
          `${m.overflow > 0 || bad.length || errors.length ? "WARN" : "ok  "} ${width} ${s.name.padEnd(13)} overflow=${m.overflow} links=${m.links.length}${bad.length ? ` broken=${bad.join(" ")}` : ""}${errors.length ? ` console=${errors.join(" | ")}` : ""}${m.small.length ? ` small=${m.small.join(", ")}` : ""}`,
        );
      }
      await context.close();
    }
  }
  await browser.close();
  console.log(report.join("\n"));
  console.log(`\nScreenshots in ${path.relative(process.cwd(), outRoot)}/<width>/. ${failures ? `${failures} screen(s) need attention.` : "No problems found."}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
