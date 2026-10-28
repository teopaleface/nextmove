# NextMove end-to-end implementation brief

## Objective and authority

Implement the complete locally runnable NextMove application from the accepted product/design/security specifications. The user explicitly assigned implementation to **Claude Opus 5.5 with effort max**. Build working software, not another plan or a clickable mockup. The GitHub repository and ADRs must be published and collaborator invitations sent before implementation starts; the parent handles that prerequisite and final GitHub pushes.

Work in the current repository, preserve its reference documents/assets and unrelated work. The real product route is a feature inside a partner bank. The current implementation is local and synthetic: no production deployment, real bank credentials, real transfers, real merchant changes, external customer messages or invented compliance certification. Routine local dependencies, isolated test data, owned dev/worker processes, fixes and recordings are authorized. Record actual remaining limitations rather than presenting fallbacks as live capabilities.

## Read first

1. `docs/adr/README.md` and all seven ADRs; `CONTEXT.md` for domain language.
2. `PRODUCT-SCOPE.md` for all 22 capability groups.
3. `design/SECURITY-AND-SCALE.md` as controlling for approvals, batch execution, recovery, Labs and the bank route; `design/SECURITY-SCALE-REVIEW.md` for unresolved verification obligations.
4. `design/DESIGN-SYSTEM.md`, `design/tokens.json`, `design/MOBILE-UX.md`, and the final mockup boards listed in `design/README.md`. Inspect the images. The design reference is not an implemented interface.
5. `design/ui-fixtures.json`, `demo/cases.json`, `demo/bulk-cancellations.json` and existing finance verification helpers. Preserve the independent datasets and their stated windows.
6. `design/AGENT-CAPABILITIES.md`, `design/IMPLEMENTATION-PLAN.md` and `research/github-components.md` for detailed contracts. Use source-owned current documentation/package metadata for actual dependencies.

If descriptions conflict, preserve the latest user-approved security/bank/Labs direction and document the resolution in the existing ADR or a new narrowly justified ADR. Do not silently narrow the product to subscriptions or a single customer type.

## Build and working ownership

The implementation child owns application source, package/lock/build configuration, tests, local scripts and runtime documentation. The parent owns GitHub administration, final pushes and independent acceptance/recording evidence; coordinate through the task's returned checkpoint files/status, without racing edits to shared source. You may delegate disjoint implementation subtasks only with the same user-requested Opus 5.5 effort max using the live T3 catalog/options. Keep one integration owner and preserve concurrent changes.

Use a small modular Next.js/React/TypeScript application, deterministic finance, persistent SQLite and a durable local worker. Resolve compatible current package versions and commit the lockfile. Prefer a clear working dependency set over multiple overlapping agent frameworks. The local host has Node 26.8.1, npm, ffmpeg and an authenticated first-party Claude Code CLI 2.1.310. No Anthropic/OpenAI/OpenRouter API key was found in the process environment. Do not read unrelated project secrets or extract CLI credentials.

Use a server-only supported Claude CLI adapter as the orchestrator, with prompts through stdin, fixed argument arrays, bounded calls, current login and sanitized output, after an actual smoke test. The CLI calls the typed tools through a local NextMove MCP server, allowlist-only per ADR 0005: `config/agent-tools.allowlist.json` gives every tool its own allowlist (contexts, operations, merchant origins, adapters, limits and similar), all starting empty. A tool is enabled, and a value moved from `candidates` to `allow`, only after a test exercises it; record the verification in that file. Enforce the allowlist in the CLI flags, the MCP tool registration and the MCP call handler; never allowlist code-running, file-writing or network built-ins. Select a runtime model that works and disclose it; the coding agent remains Opus 5.5 max. The runtime model selects typed tools and handles changed/missing facts; code owns all permissions and money. Implement actual vision on supplied synthetic images if the supported CLI interface permits it, and test actual image bytes. A manual/OCR/replay path must carry an explicit evidence label and cannot replace a live-model claim. If the CLI is unavailable, make the limitation visible and retain a functional labelled simulator while informing the parent.

Choose unused fixed local ports, preferably bank 3210 and merchant 3211, and start only owned processes. Bind to loopback. Provide one documented command for the app/merchant/worker, a health/readiness path, clean test reset and teardown. Runtime databases, uploads, secrets, provider output and recordings remain ignored; `.env.example` contains names/defaults only. Never print prompts containing private data or raw model image payloads into logs.

## Mobile product

English UI, NextMove own yellow/ink/white identity, 390px reference with checks at 360px and 430px, readable type, safe-area support and accessible controls. Four stable tabs: **Home, Activity, Goals, Agent**. Include accounts, cards/payment drafts, transaction detail, upcoming/subscription detail, evidence upload/review, preferences, comparison, exact approval, live task/browser view, receipts, goals/simulators, business context, monitoring, permissions, batch review/results and exception resolution. Use the 28 templates as reusable patterns, not 28 disconnected pages. Every shown action must navigate or perform its advertised behavior; planned capability tiles must say planned instead of pretending to execute.

The UI should feel like the supplied mobile bank design, with useful default synthetic data, not a generic chatbot/dashboard. Keep technical payloads in an optional evidence/developer view; customer language describes effects, conditions and next steps. A visible Demo/Labs marker establishes synthetic resources. Provide explicit personal/business context switching and separate ledgers. Provide account/session switching or an isolated second-session fixture for authorization tests.

## Required working capabilities

Implement each of these against meaningful controlled data, with actual calculations/state changes where its contract calls for action:

| ID | Capability and completion criterion |
|---|---|
| O1 | Phone/home/business goals: editable financial inputs, dated alternatives, reserve/goal impact and assumptions. Canonical phone/home contribution results and business conditions agree with fixtures. No loan approval claim. |
| O2 | Inventory/purchases: derive required stock and supplier cost, compare terms and prepare/approve a synthetic order where relevant. |
| O3 | Personal/owner income and reserves: separate personal/business obligations; proposed transfers differ from confirmed balanced postings; funds are conserved. |
| O4 | Receivables: prepare and approve a simulated reminder, receive partial/promised payment evidence, replan and credit only an actual synthetic bank receipt. |
| O5 | Financial products: compare fictional terms, cost and same-day ordering; prepare an accurate application/discussion packet with unknown eligibility preserved. |
| T1 | Screen Time/document analysis: upload actual synthetic image bytes, extract and confirm fields, match bank facts, ask about TV/family/background use and show provenance. |
| T2 | Trials: durable due watch, warning, exact approved merchant renewal-off through its rendered site, independent confirmation and forecast update. |
| T3 | Offers/student/bundles: compare equivalent benefits/periods, verify or preserve unknown eligibility and invalidate affected approval when terms change. |
| A1 | Duplicate benefits: detect overlap without double-counted savings; protect replacement activation, migration and access dependencies. |
| A2 | Right-size plan: compare actual/peak usage and required benefits, approve and verify a supported plan change. |
| A3 | Monthly/annual: compute break-even and total commitment/cash impact for chosen horizon; do not assume annual is better. |
| A4 | Price increases: detect changed recurring price from dated evidence and compare/prepare alternatives. |
| A5 | Content schedule: use a versioned fictional content catalog and chosen dates to prepare subscription/renewal timing with terms. |
| A6 | Pause: exact approved supported pause with access/resumption dates, persisted merchant result and future commitment effect. |
| A7 | Refund tracker: requested/accepted/pending/credited states; only unique bank credit increases funds. |
| A8 | Possible duplicate payment: distinguish pending authorization, two real purchases and a possible settled duplicate; prepare approved synthetic claim with evidence. |
| A9 | Price adjustment: evaluate the synthetic merchant policy/window and purchase evidence, then submit/track approved eligible request. |
| A10 | Total cost of ownership: compare purchase plus consumables/maintenance/required plans over editable usage/horizon. |
| A11 | Billing date: compare timing effect/fees/proration, approve supported date change and verify its effective cycle. |
| A12 | Expiring benefits: evaluate expiry and intended eligible purchase, show uncovered cost and approve/verify supported redemption. |
| A13 | Business licenses: inspect roster/activity/roles/minimums, protect data and required access, approve exact seat reduction and update future invoice only. |
| A14 | Travel: compare fictional all-in connectivity/payment/FX costs and existing benefits for dates/destination, then prepare/approve supported synthetic option. |

These capabilities may share deep modules and UI patterns. A static card or canned response alone does not satisfy a row. Separate simulated-provider execution, live model assistance, deterministic calculation and manual/replay labels precisely. Preserve all feature groups even if the first integrated slice starts with a trial.

## Authority, merchant execution and recovery

Session ownership is derived by the server for every read, file, task, event stream, proposal, receipt and mutation. Use opaque server-managed approvals tied to immutable action manifests, actor/mandate, canonical contract/account, operation, input/terms version, monetary/consequence limits and expiry; client/model flags cannot approve. Protect confirmation routes against CSRF/replay. Changed terms, wrong user/context, expiry and revocation fail closed before effects. Apply authorization on the worker as well as the request route.

Keep the rendered fake merchant and its state independently inspectable. For a browser execution claim, the final committed request originates from permitted actual page interaction. Enforce known account/target/action/version at the final request gate, independently read back the merchant receipt/state, and correlate page/request/attempt. Direct fake-merchant execution is a separate labelled adapter. The server browser has isolated synthetic contexts and controlled network destinations, no personal profile. Block arbitrary URL/shell/script/write tools from the model. Auth/CAPTCHA/2FA returns blocked/manual rather than bypassing.

Persist task children, grants, attempts, outbox/inbox events, receipts, leases/fences and reconciliation separately from chat. Stop blocks new dispatch authority; already-started requests can finish. A lost response after possible commit remains unknown and reconciles before retry. Repeated approvals/delivery do not duplicate effects. Browser requests are not universally idempotent. Updates to forecast/ledger use unique source events; refund acceptance does not credit cash. Revocation, expiry and process restart preserve these invariants.

Enforce server-side feature availability for the synthetic Labs mode and real-operation-disabled bank demo. A frontend badge or IP geofence is not an authorization boundary. Keep raw files private and bounded; validate formats/content, escape rendered data, constrain egress including redirects/private targets, use safe generated exports and suppress sensitive authentication captures.

## The 200-item acceptance scenario

Use `demo/bulk-cancellations.json` unchanged as the independent mixed scenario: 120 ready, 25 already off, 20 need authentication, 15 fixed commitments, 10 protected/shared and 10 unsupported. The approved 120 have 90 API / 30 browser routes; first-pass expected outcomes are 100 confirmed, 8 waiting, 5 auth expired, 4 terms changed and 3 unknown. All 80 exclusions remain visible and outside authority.

Fixture future avoided charges from the 100 confirmations are 282,400 bani = 2,824 RON in its stated window; 110,000 RON bank funds remain unchanged. The 120 approved candidates total 3,388.80 RON potential avoided charges. Keep this dataset independent from the single-trial 242 → 163 RON case. Do not turn expected counters into runtime proof: run durable child work that produces the statuses. Exercise real page execution for supported browser paths, bounded concurrency, interruption, stop and reconciliation. Preserve unknowns instead of forcing a perfect all-cancelled ending.

## Verification and screen recordings

Use focused finance/policy/state integration tests and rendered end-to-end tests through public interfaces, including altered data, negative cases and process restart. Required checks cover wrong session, forged/expired/revoked approval, changed terms, duplicate request/event, response loss after commit, pending/refused result, protected service/dependency, refund accounting, 200-item totals and phone recovery. Tests should assert actual persisted results, not mirror implementation counters.

Use T3 preview for interactive local browser QA and recording; call preview_status then preview_open, target your own returned tab ID and preserve other tabs. This is local dev-server QA, so the known Helium/public-site Jev blocker does not apply. Playwright end-to-end tests may additionally record repeatable feature flows against isolated test data. Capture actual UI motion; screenshots alone do not satisfy the user's recording request.

Produce recordings covering every implemented feature group, with reusable grouped videos allowed only when the evidence index gives clear per-feature timestamps/scenarios. Also cover primary navigation, live model/image flow, exact merchant cancellation, 200-item batch, changed terms, stop/recovery and isolation denial. Keep videos local under `evidence/recordings/`, commit a concise evidence manifest with source/build hash, route, scenario, result, evidence level, recording path and test command. Do not record auth/keys or include fake success edits. Provide at least one readable screen capture for each major customer area.

Run type checking, appropriate tests, production build/start smoke and `git diff --check`. Fix failures and rerun affected checks. Test the final rendered build at phone sizes, including overflow/console/server errors. Record the actual model/provider status and a real successful model response; avoid an all-fixture agent claim.

## Delivery and checkpoints

Work through complete vertical slices until all required rows have runnable proof. Preserve a concise `docs/IMPLEMENTATION-STATUS.md` checkpoint with completed areas, exact running commands/ports, current check results and real blockers; this lets the parent independently verify without interrupting source work. Replace the initial README status with verified setup, architecture, scripts, evidence, reset/cleanup and limitations. Add `.env.example` only with documented non-secret names/defaults.

Return a concise final report containing changed areas, exact commands/results, local URL and owned process IDs, feature evidence map, recording paths, actual model/vision/browser verification, remaining gaps and Git status. Do not claim legal certification, bank partnership completion, universal merchant support, unseen videos or unrun tests. The parent handles the final repository push and user handoff. Continue routine local work without repeatedly seeking permission already supplied by the implementation request.
