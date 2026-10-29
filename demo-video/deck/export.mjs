// Export the deck to PDF (one 1920x1080 slide per page) and a PNG per slide for review.
// Usage, from demo-video/: node deck/export.mjs
// Uses the repository's Playwright install (../node_modules/playwright).
import { chromium } from "../../node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../out");
mkdirSync(path.join(out, "deck-pages"), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(here, "index.html")).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const slides = page.locator("section.slide");
const n = await slides.count();
for (let i = 0; i < n; i++) {
  await slides.nth(i).screenshot({ path: path.join(out, "deck-pages", `slide-${String(i + 1).padStart(2, "0")}.png`) });
}
await page.emulateMedia({ media: "print" });
await page.pdf({ path: path.join(out, "nextmove-deck.pdf"), width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
console.log(`${n} slides -> out/nextmove-deck.pdf`);
