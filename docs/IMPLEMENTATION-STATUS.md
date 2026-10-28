# Implementation status

Living checkpoint for the NextMove local build. Each entry records what exists, how it was checked and what is still open.
Nothing here claims legal certification, bank partnership, real merchant support or production readiness.

## Checkpoint 1 — backend core running (2026-10-28)

### Runs locally

| Process | Address | Started by |
| --- | --- | --- |
| Bank app (Next.js 16, API + UI) | `http://127.0.0.1:3210` | `npm run demo` (production) or `npm run dev` |
| Simulated merchant origin | `http://127.0.0.1:3211` | same command |
| Durable worker | no port; SQLite leases | same command, restarted by the runner if it exits |

Health: `GET /api/health` (bank, merchant, worker PIDs, model status). PIDs: `.data/pids.json`. Stop: `npm run stop`. Reset: `npm run reset` (refuses while processes run).

### Done and exercised against the running stack

- Session per demo customer (HttpOnly cookie, CSRF token, same-origin checks); isolated tenant copies for authorization tests.
- All 22 capability analyses (O1–O5, T1–T3, A1–A14) return deterministic results from seeded synthetic data and the simulated merchant.
- Approval: immutable manifest digest, one mandate per proposal, per-action grant, a repeated approval returns the existing mandate without new authority.
- Single action through the isolated browser (T2 FitFlow): provider page → confirmation page → final POST through the dispatch gate → read-back → receipt; upcoming subscriptions 242 → 163 RON.
- 200-item batch from `demo/bulk-cancellations.json` (unchanged): inspection by per-item child work, then 120 approved → 100 confirmed / 8 waiting / 5 needs sign-in / 4 terms changed / 3 outcome unknown; 2,824 RON avoided; funds 110,000 RON before and after. Repeated on two isolated tenants with identical results.
- Reconciliation: the 3 unknown outcomes resolve to confirmed after the provider's 6 h read lag without resubmitting; the 8 waiting items confirm after the 48 h review.

### Defects found and fixed in this checkpoint

- Chromium re-sends a POST on its own when a reused keep-alive socket resets before response headers. That re-send bypassed the page-level gate and was then refused by the provider's one-time form token. The final POST is now forwarded by the gate itself (`route.fetch`, no retries, no redirects), so each grant produces one physical request and a lost response is recorded as unknown.
- Receipt, ledger source-event, forecast-event, inbox and finding keys were unique across all tenants, while each simulated world issues its own references. A second isolated tenant could be linked to another tenant's receipt. All of these keys are now tenant-scoped (schema v2; older local databases are refused with a reset instruction).

### Open at this checkpoint

- Phone UI (all screens), fixture images, live model and vision runs, automated integration and E2E suites, recordings, evidence manifest, README replacement.

## Checkpoint 2: phone UI, integration suite, production build (2026-10-28, end of this pass)

Teo narrowed the scope at 17:37 so this pass could finish quickly. Recordings, recorded flows, the evidence manifest and the long live-model E2E runs are **postponed to a later pass** (see "Postponed" below).

### Runs now

The production stack runs on loopback through `npm run demo` (`scripts/run-all.ts --mode=production`, planner `auto`). The current process IDs are in `.data/pids.json`; `npm run stop` ends them. `GET http://127.0.0.1:3210/api/health` reports the bank, the merchant, the worker PIDs and the model status.

The live model is `claude-sonnet-5-5` through the server-only Claude CLI adapter:
- The startup smoke test answered.
- An earlier smoke run also read a synthetic image (vision).
- The coding agent was Opus 5.5.

### Done in this checkpoint

**Phone UI.** All app routes build and render, 25 routes in `next build`:
- Sign-in and isolated copies.
- Home; Upcoming; subscription detail; account and card (freeze/unfreeze through exact approval); Pay a known bill.
- Activity (transactions, agent outcomes, refunds, subscriptions); transaction detail; refund tracker (accepted kept separate from credited).
- Goals and goal detail.
- Agent: composer, tasks, tools, the capability catalogue and a "Planned" row for computer control.
- Task workspace; 22 capability pages; exact-approval sheet; live action page with the isolated-browser view; receipts.
- Evidence: live vision, confirm or correct each value, manual fallback, and a notice when an image contains injected instructions.
- Monitoring: alerts, findings, watches, permission revocation, preferences.
- Batch review: inspection progress, exact-list approval, live progress, Stop, results, recheck, Labs clock, follow-up approvals for changed terms and for sign-in, CSV export.
- Business funding packet (prepared, never sent).
- Profile: contexts, mode, feature switches, model status, Labs clock and reset, developer view.

**Screen QA.** `scripts/qa-screens.ts` covered 22 screens at 360, 390 and 430 px. It found no horizontal overflow, no console errors, no broken internal links and no tap targets under 40 px.

**Integration suite.** `tests/integration` has 30 tests in 6 files, written by a delegated Opus 5.5 child task:
- Cross-tenant 404s; CSRF and cross-site refusal; forged digest; tampered manifest.
- Expiry; revocation; changed terms; replayed approval and inbox event; refusals; dependencies; refund credited once.
- The 200-item totals across two workers and two tenants; serialised mutations per account.
- Response loss after commit; manual review; Stop mid-run; `kill -9` worker recovery; bank-demo refusal on both server and worker.

It found and fixed four defects:
- Action rows were not checked against the signed manifest.
- A demotion to EXPIRED or OUTDATED was rolled back by the thrown error.
- A terms change found by the worker left the grant active.
- A replayed batch approval restarted a stopped batch.

**Further fixes in this pass:**
- A grant left unused because its action settled before dispatch (sign-in needed, refused, already in place) is now invalidated.
- A second approval of a change already in flight is closed as not started instead of staying "approved".
- Lease recovery schedules reconciliation on the demo clock.
- Revoking a monitoring permission ends that provider's watches, matched on label, subject or condition.
- Watch results are written in plain English.
- The A2 hotspot answer is saved as a preference.
- Bank actions say "confirmed by NextMove bank".
- A multi-action plan screen now polls for progress after approval.
- Preference toggles respond immediately.
- Self-referencing capability links were removed, and the T1 link was fixed.

**E2E.** `tests/e2e` has 10 spec files with about 25 tests, plus `playwright.config.ts`, and records a video for every test. The specs that were run against the production build pass in their last run:
- Navigation at 390.
- T2: isolated-browser cancellation, receipt, funds unchanged, upcoming total 242 → 163 RON.
- T3 (four dependent actions), A1, A3/A5/A6, A4 preference gating, A2.
- Pay a bill and freeze the card.
- A11.

### Checks at this checkpoint

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` (unit and integration) | pass: 58 tests in 7 files (57.8 s) |
| `npm run build` | pass (Next.js 16.4.3, Turbopack) |
| `npm run demo` + `/api/health` | ok: merchant ok, worker live, model smoke ok |

### Postponed by Teo (2026-10-28, 17:37)

- Recordings under `evidence/recordings/` and the recorded flows.
- The evidence manifest. `npm run evidence:manifest` points at `scripts/evidence-manifest.ts`, which is not written yet.
- The long live-model E2E runs and the full E2E suite run, including the 360/430 `@layout` projects.

### Open

- E2E specs not run yet: `05-live-model`, `06-money-back`, `07-goals-purchases`, `08-business`, `09-batch` (full run, Stop, worker restart) and `10-security-terms`. They may need small selector fixes on their first run.
- Live tests (`tests/live`) are not written, so `npm run test:live` has nothing to run. Live text and vision are checked by `npm run smoke:model` and by the app at startup.
- The `web-design-guidelines` review of the UI has not been run.
- Not verified:
  - Preselecting a bill through `/pay?item=` on the statically prerendered production page.
  - Bank-demo mode in the browser. It is covered by the integration tests only.
- `/api/uploads/:id/extract` calls the live model even when `NEXTMOVE_PLANNER=simulated`; without the CLI it fails safely and the UI offers manual entry.
- Lease recovery stores `next_reconcile_at` in real time, but reconciliation compares it with the demo clock. Today it works only because the requeued job reschedules on the demo clock. A first fix broke the `kill -9` recovery test and was reverted, so this is still open.
- An untracked `jev-discord/` directory appeared in the repo root at 16:51 from another process. It is not part of this work and was left untouched.
- Nothing is committed; all of this work is in the working tree.

## Checkpoint 3 — Discord proposals integrated in the main checkout

The base Opus implementation was preserved in commit `1559120`. The exact 57-file Discord feature delta from snapshot tree `3a46066d8fff2a9613128bb087b04ae986c864e4` was applied with a clean three-way integration; no files under `/Users/teo/.t3/worktrees/` were modified. Its five packages add interactive agent simulations, Trial Shield, hidden-cost analyses A15–A18, the home-goal route, and Cash Autopilot/Bill Vault/Overdraft Shield. The registry now lists 30 distinct capability IDs.

Validation on the combined source:

- `npm run typecheck`: pass, including after the scheduled-transfer approval-copy correction.
- `npm test`: **136 passed in 15 files**, 71.30 seconds. This is the unit/integration suite, not the deferred full browser E2E run.
- `npx vitest run tests/integration/cash-autopilot.test.ts`: **10 passed**, 8.70 seconds after the approval display change.
- `npm run build`: pass, including the new `/goals/home-route` page.
- `git diff --check`: pass.

The approval UI now distinguishes immediate actions from scheduled internal transfers and discloses the existing fourteen-day scheduled-grant grace period; see ADR 0008. This changes disclosure, not transfer authorization logic.

Existing demo sessions/data were preserved. For the newly added provider fixtures, start Alex with **Start a separate copy** on the sign-in screen; a fresh copy contains all extension fixtures. Existing tenants created before the extension are not automatically reseeded.

Recordings, the evidence manifest and long/live browser E2E remain postponed by Teo. The earlier crash-recovery clock mismatch and the other open items above remain explicit; the full combined UI and long-lived scheduled behavior have not been revalidated in a browser in this pass. The untracked `jev-discord/` directory is unrelated and remains untouched.

Final local smoke after integration: app source build `c05cdd9` is running in production mode on 127.0.0.1:3210, merchant on 3211, worker healthy. The startup live-model smoke succeeded on `claude-sonnet-5-5` (3.8 seconds). A newly created isolated Alex copy exposes T4, A15–A18 and O6–O8; all eight analysis endpoints returned HTTP 200. This was a short API smoke, not a browser E2E or recording. Current process IDs remain in `.data/pids.json`.


## Checkpoint 4 — approved Financial Airbag and Bunic Mode

Review target: branch `wave2/approved-features` at `/Users/teo/.t3/worktrees/nextmove-wave2-combined`. It combines the isolated Financial Airbag and Bunic Mode branches. The local bank runs at `http://localhost:3290`, merchant at `127.0.0.1:3291`, through:

```sh
NEXTMOVE_BANK_PORT=3290 NEXTMOVE_MERCHANT_PORT=3291 npm run demo
```

The original checkout and its existing demo data are separate. Historical `discord-proposals` and `dp-*` worktrees were preserved. No remote push, deployment or real financial operation was performed.

### Delivered

- **O9 Financial Airbag:** Alex Home opens a review with all services kept unchanged. Explicit supported one-month pause or renewal-off choices produce an exact existing approval manifest. Essential bills, data/student dependencies and required playback remain protected. Each approved item retains its own outcome and receipt. Pending/unknown outcomes keep their costs due; disabled execution contributes no hypothetical reduction. The catalogue now has 31 distinct capability IDs.
- **Simple mode (Bunic Mode):** Profile → Display and voice. Larger text, larger controls, stacked financial rows and screen guides across the existing four tabs. Boolean preference uses the existing tenant/context table and CSRF-protected endpoint. It persists on reload and remains separate between customers and between personal/business contexts.
- **Optional voice:** user-initiated screen summary and editable spoken draft. No automatic task submission or financial approval. Stop, errors, edits, route/context/session changes, hidden tabs and unmount release the owned voice session. Same-origin microphone policy permits a browser request, without granting permission or starting audio.

### Checks and corrections

- Focused feature checks passed: 17 Airbag tests, 24 display/voice lifecycle tests and four preference API tests. A further disabled-execution regression was added after review.
- Combined `npm test`: **182 tests passed in 21 files**, 75.59 seconds. These are unit/integration checks, including simulated-provider execution; they are not the postponed live-model browser E2E suite.
- `npm run build`: pass, including TypeScript. A real local dependency installation was needed because Turbopack refuses the initial node_modules symlink outside the worktree.
- `npm run typecheck` and `git diff --check`: pass.
- Two independent read-only reviews found three P2 issues, all corrected: disabled Airbag actions reduced the comparison; inline styles defeated enlarged metric stacking/labels; failed preference saves lost visible error feedback after navigation.
- Browser QA confirmed the Airbag pause + renewal-off workflow with two separate confirmed receipts. This isolated Alex copy's recorded 30-day costs changed **2,036.99 → 1,958.00 RON**, with cash **110,000 RON** before and after.
- Simple mode's four tabs were checked at **360 and 390px** without horizontal overflow. Financial metrics stack to one column and detail labels use 18px. The existing 4px review action-bar overflow was corrected and checked against the final build at 360px.
- Reload persistence, separate-customer display state, business/personal context isolation and restoration, and visible failed-save feedback after navigation were exercised in the browser. The settings retry path recovered.
- Browser speech mocks verified no audio starts automatically, draft text preserves typed input, Enter does not submit a voice draft, editing stops recognition and ignores late results, and read-aloud has a working Stop action. Test mocks were removed by reloading before the final UI checks.

### Remaining verification

Real microphone capture, speech-service availability and audible speaker output were not exercised. They need a human device check; no claim of real audio acceptance is made. Recordings, the evidence manifest and long/live-model E2E remain postponed as instructed. The earlier unrelated open items in checkpoints 2–3 remain tracked there.
