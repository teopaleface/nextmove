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

## Checkpoint 5 — extension modules wired into the app (branch `feat/extensions`, 2026-10-28)

The nine pure modules in `extensions/src` (commit `aa3d345`) are wired through one plug-in contract, `src/server/extensions/types.ts`. Each module supplies capabilities with server-built candidates, its own `ext_*` tables (each with `tenant_id`), and `EXT_*` operations. Those operations run only on `BANK_INTERNAL`, after the dispatch gate has consumed the grant. Modules may also add seed data (additive only), Labs simulations and authenticated `/api/ext/<module>` routes. No module can create authority: a candidate still becomes an exact proposal, approval still issues a grant, and the worker still runs the final gate.

### Delivered

- **E1 Cancellation guarantee** (Alex): a charge after a provider-confirmed stop (Labs) can be disputed. `EXT_FILE_DISPUTE` re-checks the evidence packet and posts a provisional credit, never more than the disputed amount. Card-network rulings come from Labs.
- **E2 Exit plan** (Alex): one exact, conditional stop of renewal, e.g. "stop FitFlow unless I used it 4 times". The worker holds it until 09:00 on the check day and then decides with the pure module. Enough use closes it unsent. Phone-only data asks the customer. Changed terms or a missed deadline close it unsent. A stop goes through the normal route and gate. The grant lasts until the provider deadline.
- **E3 Retention offers** (Alex): merchant offers carry Ed25519 signatures, and the private key is in a 0600 keystore file. Merchant text is quoted as untrusted data. Accepting re-verifies the offer and may withdraw only the stop that was shown at approval.
- **E4 Merchant insights** (Alex): synthetic cohort aggregates, read-only, with a minimum cohort of 20.
- **E5 Price consent gate** (Alex): a subscription ceiling. Labs charges above it are soft-declined, and the customer is asked.
- **E6 New card** (Alex): a KEEP/DROP list per merchant for the card updater. Merchants get only the new card reference and last 4 digits.
- **E7 / E7H Business move** (Laziz): consent on the household side, then repayment from the business side, using balanced internal transfers. The VAT note is labelled as information, not tax advice.
- **E8 Cancellation certificate** (Alex): an Ed25519 certificate with selective disclosure and per-tenant issuers. It is NextMove's statement, not the provider's.
- **E9 Shared split** (Laziz household): weighted split requests. No money moves without a payment from the member.

### Checks

- `npm run typecheck`: pass. `npm test`: **236 tests passed in 33 files** (after the second audit; 228 before). `extensions` package `npm run check`: 306 passed (304 before).
- An independent read-only security review raised six findings. Fixed:
  - accepting a retention offer could withdraw a stop approved later; the stop id is now bound into the approval
  - the price-ceiling copy overclaimed enforcement; it now says the check covers the simulated charges on its page
  - re-approving an expired business-move consent did not renew it
  - the exit plan read the provider on every poll while waiting for an answer
  - price ceilings were read across all contexts; they are now scoped to the context
  - E1's simulated charge ignored a frozen card
- Core hardening:
  - an unrecognised `BANK_INTERNAL` operation now settles BLOCKED instead of being confirmed
  - the PAYMENT source account is now scoped to the context
  - an `EXT_*` candidate must be `BANK_INTERNAL` at propose time

### Open

- Existing tenants created before this checkpoint need **Labs → Reset** (or a separate copy) for the extension seed data. The shared Alex and Laziz demo tenants were reset on 2026-10-28.
- ~~Per-run merchant key files are not deleted when a tenant is reset.~~ Fixed in the third pass: E3 removes the tenant's merchant key files through the new `reset` hook. The shared certificate key is kept on purpose.
- ~~The certificate GET route can write a revocation sweep.~~ Fixed in the third pass: the GET is read-only and serves the stored revocation list.
- The simulated merchant does not apply an accepted offer price or a price ceiling on its side; only bank records and the forecast change.
- The live-model browser E2E for E1–E9 has not been run.

### Second full audit (2026-10-28)

Four read-only reviewers covered the core server, bank and merchant, the extensions, and the agent, model and UI. Also: `npm audit --omit=dev` found 0 vulnerabilities; a secret scan of the full git history was clean.

**Fixed** (regression tests in `tests/integration/audit-fixes.test.ts`, `tests/unit/agent-numbers.test.ts`, and the E8, trial shield and E1 suites):

- Text in a numeric capability input produced NaN plans (O7/O8) and could crash the server. It now falls back to the default, and `*Minor` inputs are rounded.
- Trial Shield could post an allowed charge with no money in the account; it now declines with "not enough money". Its decision is one transaction, so two concurrent decisions cannot lose an update.
- `postCardOrTransfer` now checks that the account belongs to the tenant and context.
- An expired payment draft blocked paying the same bill indefinitely. Expired drafts no longer count, and approving one after expiry closes its actions.
- Revoking a permission now revokes its watches in the permission's own context, not the session's.
- A lost worker lease settled the action and stranded the approval. The job is now requeued under the same fence.
- An inbox credit needs a transfer id and cannot exceed the amount being recovered.
- Watches for offer terms and price changes are scoped to the context.
- The model's CLI error text is shown only on `/dev/status`, and that page lists only the tenant's own model calls.
- Agent stop races: a stopped task closes its open questions, refuses late answers, and does not run a tool or prepare a proposal after the stop.
- Numbers chosen by the model are kept only if the customer wrote them. The final-answer number check reads English and Romanian formats and the "k" suffix, and allows day numbers and years only in prose.
- E8: a certificate must be on the bank's register (`NOT_ON_RECORD` otherwise). A revoked certificate no longer verifies again after a Labs reset.
- E1: a final credit below the provisional one is reversed. A partial merchant refund goes to review instead of withdrawing the dispute.
- `EXT_*` handlers run in one transaction. A failure rolls back and settles BLOCKED ("nothing was changed") instead of UNKNOWN plus a merchant reconcile.
- E3: an offer claiming to reply to a counter-offer is refused; the bank never sends counter-offers, so this closed a way around the unrequested-offer limit.
- The Trial Shield copy names the real paying account and no longer claims that own-account transfers are unsupported. The merchant's offers list is filtered by merchant.
- Capability inputs from the model pass a per-capability allowlist (`src/server/agent/planner-inputs.ts`): numbers and text count only if the customer wrote them, and Airbag stop/pause and the A17/A18 answers only from the customer's answer to that capability's own question. Inputs that lower a protection are never set by the model. The review screen lists the inputs used, and the task's calculation link opens with them.
- The model's final answer is withheld if it claims something was cancelled, paid, paused or otherwise carried out.
- ADR 0005 now describes what is built: schema-bound decisions, no CLI tools or MCP servers. The CLI also gets `--setting-sources user` and `--permission-prompts none`; a call without the hardening flags is refused and the worker reports `MISCONFIGURED`.
- Vision errors show a generic message; the CLI detail stays in the server log and `model_calls`.
- The review page's money totals count only the selected actions. The voice summary keeps every action, each cut between whole lines.

**Not fixed (accepted for the demo, or later work):**

- Merchant `/m/<id>/login` needs no credentials or tenant (simulated merchant). `/__inspect` is protected only by loopback.
- The inbox issuer is self-declared under a shared HMAC key (no per-issuer keys).
- `/labs/reset` does not revoke the old session. `/session/demo` can create unlimited tenants.

These are credentials and logins, left out on purpose: NextMove is a demo, not a product. Every other item from this audit was fixed in the third pass below.

### Third pass: remaining audit items, chat sweep and story flows (2026-10-28)

**Fixed from the second audit's open list** (tests: `tests/unit/merchant-calendar.test.ts`, `tests/integration/partner-signature.test.ts`, `tests/integration/core-boundary.test.ts`, `tests/unit/planner-inputs.test.ts`, `tests/integration/planner-inputs.test.ts`, and the extension suites):

- Merchant PAUSE and CHANGE_BILLING_DATE use Bucharest calendar helpers (`fromLocal`, `addLocalMonths`, `withLocalDay`, `localDaysBetween` in `src/shared/time.ts`), so month ends and DST no longer shift dates. A change inside the notice period is refused with 409, and the A11 table marks days that are too late for the next bill.
- The partner signature covers the method and path.
- `BANK_INTERNAL` actions reconcile against bank records: a receipt means CONFIRMED, no receipt and no effect means BLOCKED ("nothing was changed"), and records that disagree stay UNKNOWN, then ask the customer to contact the bank after five checks.
- Request bodies are read with limits while streaming (256 KB JSON, 5 MB uploads, 64 KB inbox) and answer 413 `TOO_LARGE`.
- A PLACE_ORDER charged above the approved amount ends UNKNOWN with `CHARGE_ABOVE_APPROVED` and no receipt.
- E1 and E8 are keyed on the bank receipt id; the merchant reference is display only. Approvals made before this change are refused as changed and must be prepared again.
- Accepting an offer during an E2 hold works. `recordStopOutcome` needs the same merchant, an ending operation and a CONFIRMED receipt checked by independent read-back. E1 refuses negative amounts.
- Month labels in goals and simulations use local calendar months.

**Chat sweep.** 45 chat requests, one per capability and simulation, each in an isolated tenant through the real router and worker on the simulated planner: all 45 route to the right capability, and every prepared proposal approves and settles. Found and fixed:

- T3 crashed (`Cannot read properties of undefined`) when the bundle was prepared without its eligibility check. An action whose prerequisite is not ready now waits with it, and the answer says what is missing.
- A17 and A18 now ask their own question in the chat, then prepare from the answer.
- When a capability offers actions but none is a safe default (T4 block or allow, E3 accept or stop, E5 accept the new price or stop), the chat asks which one to prepare, with a "Nothing for now" option. Only the chosen action is prepared (test in `tests/integration/trial-shield.test.ts`).
- Headlines now state the result: O1 home date, A10 total cost, O9 services that can be paused, T4 trials watched, E1 dispute outcome, E2 plan state, E3 offer and verdict, E5 declined price rise, E8 stops to certify.
- "FitFlow charged me after I cancelled" now goes to E1 instead of T2, and T2 no longer shows an empty date once renewal is off.

**Story flows** (chained, each in an isolated tenant): stop FitFlow → certificate → charge after the stop → dispute → network rules for the customer; T4 hold → block; E3 signed offer → accept; E5 ceiling → higher charge declined → accept the new price; E6 card reissue → merchant list; E2 exit plan → check day → customer asked; E7 household and business approvals → repayment. All seven run end to end.

**Live model.** In a later sweep run the live model was answering again: 36 of the 45 requests ran on the LIVE planner, the rest fell back. Two live answers came before any tool had run ("the analysis tools did not respond"). A final answer before NextMove has read anything is now replaced, for that step, by the deterministic read, labelled as such in the task log; the model then continues with real data (test in `tests/integration/planner-inputs.test.ts`). Prerequisites are followed through the whole chain, so T3 no longer offers a renewal stop that needs the unverified student bundle.

**Checks:** `npx tsc --noEmit`: pass. `npm test`: **286 tests passed in 41 files**. `extensions` `npm run check`: **310 passed**. `git diff --check`: clean.

### Edge-case pass (2026-10-28)

92 edge-case tests in five new files: `tests/integration/edge-agent.test.ts` (23), `edge-execution.test.ts` (20), `edge-extensions.test.ts` (30), `edge-inputs.test.ts` (5, over 500 hostile analyses), `tests/unit/edge-money.test.ts` (14). Bugs found and fixed:

- **Execution:** a 5xx, a non-JSON or empty body, or an unknown error code from the provider was recorded as REFUSED, although the change may have been applied. Only the provider's definitive 4xx codes (`VALIDATION`, `NOT_FOUND`, `NOT_SUPPORTED`, `IDEMPOTENCY_CONFLICT`, `BAD_SIGNATURE`, `UNAUTHENTICATED`) are refusals now. Anything else is UNKNOWN and is read back with the same idempotency key, never resent.
- **Chat agent:**
  - A task whose last allowed step was a question stayed RUNNING forever after the answer.
  - Cutting text at 600 or 80 characters could split an emoji, which was then stored as U+FFFD.
  - An empty answer to a free-form question was accepted.
  - The model could prepare a proposal for a capability it had not analysed; that analysis now runs first.
  - A number or an object sent as task text or as an answer became "42" or "[object Object]".
  - An answer arriving while the worker still held the job's lease left the task QUEUED with no job. The job is now re-queued when it finishes (reasoned fix, no deterministic test).
- **Inputs:**
  - Numeric inputs accepted `1e309`, `0x10`, booleans and huge values (O7/O8 showed 1e120-scale amounts).
  - T3, A3, A6 and O1 returned 500 for a numeric student id, a horizon outside 1–60, an unoffered pause length, or a contribution of 0 or less.
  - A14 data needs are clamped to 1–50 GB.
  - A17/A18 echoed any text as the answer.
  - O1 save stored NaN, negatives and 1e300 in the goal, after which every O1 analysis returned 500. It now answers 400 `BAD_INPUT`.
- **Extensions:**
  - E5: raising the ceiling above a declined price rise now settles the request.
  - E2: a revoked or expired plan showed "Waiting for the check day".
  - E9: a single-member group said "Everyone paid".
- **UI:** the E4 page overflowed at 360 px (542 px). `.stack` and `.split` grid columns are now `minmax(0, 1fr)`, so wide tables scroll inside their wrapper. A 360 px crawl of every page, in light and dark, after pressing each feature's Labs triggers, shows no overflow and no 5xx.

Still open (judged acceptable):
- The execution-claim filter misses "is cancelled" and Romanian phrasing.
- A choice is dropped when the step budget is already spent.
- The household cannot withdraw an E7 consent once given.
- A merchant refund after a dispute is filed is not simulated.
- `formatPct` uses a hyphen for negatives (no caller passes one).

**Checks:** `npx tsc --noEmit`: pass. `npm test`: **378 tests passed in 46 files**. `extensions` `npm run check`: **310 passed**. `git diff --check`: clean.

### Rate limits and abuse checks (2026-10-28)

There was no request limiting before this pass. `src/server/api/rate-limit.ts` adds in-memory token buckets in the bank server process; `handleApi` charges each request before any auth check or work.

- **Keys.** Every request is charged to its client IP. Once signed in, it is also charged to its account (tenant + user). The costly routes also draw on one global ceiling.
  - Next.js fills `X-Forwarded-For` only when the request has none, so a client talking to the server directly can forge it and rotate its IP key. It cannot rotate past a per-account limit or a global ceiling.
  - `NEXTMOVE_TRUSTED_PROXY_HOPS` (0–5, default 0) tells the server how many proxies to trust. Behind them, the client is the entry the outermost trusted proxy appended, and forged entries further left are ignored.
  - IPv6 is keyed by /64. Ports, `::ffff:` and zones are stripped. Anything that is not an address shares one `invalid` key.
- **Budgets (per minute unless stated).** Requests are classed by route pattern, so changing the id in a path never changes the budget.

  | Class | Per IP | Per account | Global |
  |---|---|---|---|
  | Reads | 1200 | 600 | — |
  | Writes | 300 | 120 | — |
  | Approvals, declines, stops, revokes | 60 | 20, and 300 a day | — |
  | Agent requests and answers | 30 | 8, and 120 a day | 600 an hour |
  | Uploads | 60 an hour | 30 an hour | — |
  | Image reading (live model) | 20 an hour | 10 an hour | 100 an hour |
  | Labs | 300 | 120 | — |
  | Labs reset | 20 per 10 min | 10 per 10 min | — |
  | Sign-ins | 30 per 10 min | — | 300 per 10 min |
  | Isolated demo copies | 20 an hour | — | 300 a day |
  | Merchant inbox | 600 | — | — |
  | Health | 120 | — | — |

  Merchant `/health` results are cached for 2 s, so health polling never fans out to the merchant.
- **Penalties.** These budgets are checked before any work is done.
  - Probing, per IP: 60 a minute. It counts 401s, CSRF, origin and signature 403s, and unknown `/api` routes. Once it is spent, that IP is refused everywhere, even with a valid session.
  - Guessing ids, per account: 200 per 10 minutes. It counts 404s on routes that take an id. Once it is spent, only id routes are refused.
- **Concurrency.**
  - Live event streams: 16 per IP and 4 per account. A slot is freed when the stream ends or the client disconnects.
  - Open agent requests (queued, running or waiting for an answer): at most 10 per account (`TOO_MANY_OPEN_TASKS`).
- **Storage.** A tenant may hold at most 200 uploads or 100 MB of uploads; past that, uploads get 413 `QUOTA`. Request bodies were already capped (256 KB JSON, 64 KB events, 5 MB uploads).
- **Live-model spend.** Before each CLI call, `modelBudgetProblem` checks the last 24 hours.
  - The limits are `NEXTMOVE_MODEL_DAILY_CALLS` (300), `NEXTMOVE_MODEL_DAILY_USD` (15) and `NEXTMOVE_MODEL_TENANT_DAILY_CALLS` (60 per customer).
  - It counts only calls that reached the CLI. It skips calls that provably cost nothing: a reported cost of 0, or the CLI's account-level "You've hit your … limit" refusal. A call with no reported cost counts at its per-call maximum. An invalid setting fails closed.
  - Failed calls now record the cost the CLI reports, not just successful ones.
  - Over a limit, the agent continues with the labelled deterministic planner, and image reading asks for the details by hand.
- **Responses.** A refusal is 429 with `Retry-After` and a body of exactly `{error, message}`. A refused request spends nothing from the other buckets and creates nothing. The UI's polling now waits as long as `Retry-After` asks instead of retrying every 3 s.
- **Tests.** `tests/unit/rate-limit.test.ts` covers the bucket arithmetic on a fake clock, address parsing and route classes. `tests/integration/rate-limit.test.ts` (13 tests) drives the real router at real scale and covers:
  - account, IP and global budgets;
  - proxy-hop handling;
  - both penalties;
  - stream slots;
  - the open-request cap;
  - the upload quota;
  - the model budget, including that the CLI is never started over budget.

  With the limiter call commented out of the router, 6 of the 13 integration tests fail. The harness runs the other suites at scale 1000.

Found while checking this pass:
- On 2026-10-28 the Claude account behind the CLI hit its monthly spend limit at about 17:17 UTC. All 215 live-model calls after that failed in about 0.5 s with that message, and the planner fell back to the labelled deterministic one. Counted naively, those refusals would have blocked the live model until the next afternoon, even once the limit was raised; they are now skipped (see above).
- A stale Turbopack dev cache (`.next/dev`) made every fresh page load reload forever ("HMR hash mismatch"). Moving the cache aside and restarting fixed it. If pages keep reloading after a restart, stop the stack and remove `.next/dev`.

Known limits (demo scope):
- The counts live in one process's memory. They reset on restart and are not shared across several server processes.
- The fake merchant server (port 3211) is not limited. Its sign-in has no password, so there is nothing to brute-force.
- In direct mode the per-IP key can be forged. The per-account limits and global ceilings are the backstop.

**Checks:** `npx tsc --noEmit`: pass. `npm test`: **404 tests passed in 48 files**. `extensions` `npm run check`: **310 passed**. `git diff --check`: clean.
