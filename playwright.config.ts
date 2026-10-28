import { defineConfig } from "@playwright/test";

// Phone E2E against the running local stack (start it first with `npm run demo`). Every test records a video at the
// 390 x 844 reference size; the layout checks also run at 360 and 430. `npm run evidence:manifest` turns the results
// into the committed evidence manifest and copies the videos to evidence/recordings/ (ignored by Git).

const baseURL = process.env.NEXTMOVE_BANK_URL ?? "http://127.0.0.1:3210";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "test-results/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  use: {
    baseURL,
    colorScheme: "light",
    locale: "en-GB",
    timezoneId: "Europe/Bucharest",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "phone-390", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true, video: { mode: "on", size: { width: 390, height: 844 } } } },
    { name: "phone-360", grep: /@layout/, use: { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, video: { mode: "on", size: { width: 360, height: 780 } } } },
    { name: "phone-430", grep: /@layout/, use: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, hasTouch: true, video: { mode: "on", size: { width: 430, height: 932 } } } },
  ],
});
