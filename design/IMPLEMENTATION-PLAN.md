# NextMove implementation and delivery plan

Planning baseline: **28 October 2026, Europe/Bucharest**. Previously supplied submission target: **29 October 2026, 11:00; reconfirm with organizers**. Team: **Mr Laziz, two active people**. No application exists at this baseline. This document proposes work; it does not certify implementation, installed dependencies, API access, or a submitted entry.

**Security/scale revision:** the user selected a **feature embedded in a partner bank** for the real product. [SECURITY-AND-SCALE.md](SECURITY-AND-SCALE.md) now governs scoped permissions, durable batches, the 200-subscription acceptance scenario, recovery, mobile additions and the revised relative 24-hour delivery sequence. [EU regulatory boundaries](../research/eu-regulatory-boundaries.md) governs the research findings, with bank/legal validation still required. The supplied PDF calls for source code, a live end-to-end demonstration and a short concept/architecture presentation; numeric scoring weights and the exact video/submission format come from separate earlier materials and require confirmation.

NextMove is a fictional phone banking app for personal **and** business customers, with a functioning AI agent inside it. Financial accounts, offers, merchants and counterparties are synthetic. The model, calculations, browser interactions, persisted changes and generated preparation artifacts should actually run. There is no official Raiffeisen identity, bank integration or partnership claim.

This plan supplements [PRODUCT-SCOPE.md](../PRODUCT-SCOPE.md), [PLAN-HACKATHON.md](../PLAN-HACKATHON.md) and the [English pitch](../pitch/english-pitch.md). The accepted scope remains all five original capabilities, Teo's three inputs and all fourteen additional ideas. Implementation order is a delivery sequence, not a reduction of that scope. The [capability specification](AGENT-CAPABILITIES.md) defines permissions, state and feature acceptance in detail. Root owns the design system, image generation and integration into existing canonical documents; this document does not replace those files.

## 1. The deadline commitment

Build one complete vertical slice first: **a usage image and bank context lead to a comparison, an exact approval, a real browser action against a simulated merchant, independent confirmation, and a corrected upcoming-payment view**. Then prove the same state and calculation engine with phone/home and business decisions.

By the submission freeze, target these demonstrated outcomes:

1. A phone user sees accounts, transactions, upcoming charges, goals and agent activity, and can switch between personal and business contexts without mixing their funds.
2. A live model reads a supplied synthetic image, asks about missing usage/eligibility facts, selects typed tools and produces an inspectable proposal using deterministic calculations.
3. An approved FitFlow cancellation changes the merchant's persisted state through its rendered website, produces a verified receipt, and removes only the cancelled future charge from the bank forecast.
4. A changed bundle term invalidates an unexecuted proposal and approval. A refreshed comparison requires a new decision. An executed cancellation stays executed.
5. A persistent watch detects a due trial/changed term through the worker. It creates a finding and notification; it does not commit a purchase or cancellation autonomously.
6. The phone/home and business fixtures calculate correctly, replan on edited inputs and show conditions. Broader features are discoverable as relevant tasks and honestly labelled by their actual implementation level.
7. Refresh/restart recovery, denial, repeated approval, a pending merchant response and an ambiguous execution outcome are tested. The entry has a reproducible repository, an English video of at most three minutes and a six-slide deck.

Do not promise all twenty-two workflows are complete tomorrow. No workflow earns an “implemented” label from a mockup, a prompt response or a shared calculator alone.

## 2. Phone frontend contract

The client is **phone only**, with an approximately **390 × 844/852** design reference. A desktop may host development and the agent environment; it is not a second customer dashboard. Use the root design system: Raiffeisen-inspired yellow/ink, light neutral canvas, white surfaces, readable banking hierarchy, English copy, body text around 16 px and interactive targets at least 44 px. Exact tokens and generated visuals belong to root.

| Area | Required behavior |
|---|---|
| **Home** | Current and savings accounts, total liquid funds, upcoming payments, contextual agent findings; account/card/payment details drill into this banking area. Personal/business context remains visible. |
| **Activity** | Posted transactions, pending bank events and task outcomes with distinct statuses. A merchant cancellation receipt is not a bank credit transaction. |
| **Goals** | Home, purchase and business goals, protected reserves, assumptions and scenario comparisons. Forecasts link to their input version. |
| **Agent** | Conversation, image/document upload, relevant task starters, clarification, proposals, approval and task history. Contextual entry points also appear on Home and details. |

Use exactly four bottom navigation destinations: **Home, Activity, Goals, Agent**. Subscriptions, inventory, receivables, travel and the other accepted capabilities open through contextual cards, search or task starters; they do not become additional primary tabs.

The agent task sheet expands above the current phone view. Its collapsed form shows the current step and whether the user must act. Expanded content shows a readable progress timeline, the relevant merchant page snapshot, observed terms, approval summary and receipts. “How this was checked” exposes tool operations and source facts, never hidden model reasoning. It must work without displaying a tiny desktop dashboard. If the merchant browser uses a wider viewport, the sheet still presents a mobile-readable summary and optional zoomable capture.

Required task-sheet states: reading, needs information, comparing, awaiting approval, working, pending confirmation, confirmed, declined, outdated, blocked and outcome unknown. A user can leave the sheet and return to the same persisted task. An interrupted connection does not imply failure or authorize a repeat action.

## 3. Architecture: one orchestrator and deep modules

Choose a small standalone **Next.js / React / TypeScript** application, one Vercel AI SDK orchestrator, schema validation and a local persistent SQLite store. A small long-lived worker owns browser sessions and scheduled jobs. Use the candidates in [the source-checked stack note](../research/github-components.md); resolve, install, smoke-test and lock one compatible set. Its listed versions were statically inspected, not tested builds. Do not copy a large banking/chat template or combine multiple agent frameworks.

| Module | Small interface | Implementation responsibility |
|---|---|---|
| Phone application | Read view models; submit messages, facts, approvals and declines | Four-tab shell, upload review, comparison cards, task sheet and receipt views. Server state determines status and amounts. |
| Task engine | Start, inspect, resume, approve, decline and cancel a task | One model orchestrator; contextual tool allowlist; input revisions; step/time budgets; persisted transitions; scheduling and recovery. The model proposes actions, while server policy permits execution. |
| Finance engine | Simulate a versioned scenario; compare equivalent options | Integer money, dated cash events, reserves, quantities, obligations, total cost and non-overlapping savings. Pure deterministic functions with source traces. |
| Evidence and execution | Read evidence; prepare an exact action; execute and verify it | Vision, document, web and browser adapters; approval validation; receipts; idempotency; reconciliation. Adapter seams exist where live/synthetic/replay behavior actually varies. |
| Simulated bank and merchants | Query state; apply a permitted versioned command; retrieve receipt | Independently persisted account, subscription, offer, invoice, inventory and refund state. Browser pages and direct tools use the same merchant command implementation. |
| Persistent store | Transactional task/action/ledger operations | SQLite transactions, optimistic versions, unique keys, append-only events, worker leases and a restart-safe job queue. |

Deployment is not required to prove the local prototype. Keep the app, fake merchant origin and worker on one development host if this avoids extra infrastructure. They can be separate processes with one local database and logically separate tables. Browser contexts are isolated by demo session. Workers operate without an open phone page. The demo only runs scheduled monitoring while the host/worker is running; no claim of production availability follows.

### State that must survive a refresh and restart

Persist demo-session/user context; account and ledger records; goals/preferences with source and revision; uploaded-file references and confirmed extraction; merchant subscriptions and term versions; scenario inputs/results; tasks and events; proposals and approvals; action attempts; authoritative receipts; watches, scheduled jobs and delivered notifications.

The phone consumes an event stream with a cursor, then refetches authoritative state on reconnect. Polling a task read endpoint is the fallback if streaming fails. Chat history is a view over the task, not the source of approval or execution truth. A single-writer/lease policy serializes mutations for the same subject across single actions and batches. Different subjects can run with bounded per-user, per-merchant and global concurrency. A lease is not an external exactly-once guarantee; uncertain external outcomes must reconcile before retry.

Use explicit `schemaVersion`, `inputRevision`, `proposalRevision` and `termsRevision`. A stale dependency invalidates only affected unexecuted work. Never erase an executed action to make a revised plan appear consistent. Local SQLite is a deliberate hackathon choice; an ephemeral serverless filesystem is not durable storage. Hosting later requires a persistent database and a supported long-lived browser/job worker.

### Proposed phone-to-server contract

The following route shapes are implementation targets, not existing endpoints. All enforce an opaque server-validated session, context ownership and input schemas. Approval/decline routes require same-origin request protection. Keys and merchant session credentials stay server-side.

| Interface | Purpose |
|---|---|
| `GET /api/bank/home?contextId=…` | Balances, commitments, upcoming payments and contextual findings. |
| `POST /api/uploads` | Size/type-limited image/document ingestion; returns a session-bound reference. |
| `POST /api/tasks` | Start a typed goal/task or message using a current context revision. |
| `GET /api/tasks/:id` and `/events?after=…` | Current task and resumable operational events. |
| `POST /api/tasks/:id/facts` | Confirm or correct extraction/assumptions; creates a new input revision. |
| `POST /api/proposals/:id/approve` | Approve the displayed revision/digest and specific action IDs; server creates the grant. |
| `POST /api/proposals/:id/decline` | Persist refusal and suppress identical automatic re-requests. |
| `GET /api/actions/:id/receipt` | Verified outcome, effect date, evidence and bank/merchant reconciliation state. |
| `POST /api/watches` and `DELETE /api/watches/:id` | Explicitly scoped monitoring permission and revocation. |

The browser worker uses an internal command interface, not an unrestricted public endpoint. Demo seed/reset and changed-term controls are developer-only and visibly labelled. Expose neither arbitrary code evaluation nor a tool for the model to edit the ledger directly.

## 4. Numeric contracts for UI and tests

Existing [demo/cases.json](../demo/cases.json) remains the canonical source for the earlier business/phone/home fixtures. Its [verification script](../demo/verify_cases.py) does not validate the new agent or merchant execution. The additional scenario is now defined separately in [ui-fixtures.json](ui-fixtures.json); implementation must consume or explicitly map that versioned data.

### Alex: balances and home readiness

| Value | Agreed design data |
|---|---:|
| Current account | 12,480 RON |
| Savings | 97,520 RON |
| Total liquid funds | **110,000 RON** |
| Home target | **130,000 RON**: 90,000 down payment + 10,000 costs + 30,000 protected reserve |
| Before-home monthly contribution | 6,000 RON, a stated assumption |
| Without phone | Four monthly contributions |
| Phone costing 6,000 RON | Five contributions; modeled liquid funds after purchase 104,000 RON |
| Alternative phone costing 3,500 RON | Four contributions; modeled liquid funds after purchase 106,500 RON |

Use `ceil(max(0, target − modeledLiquidFunds) / monthlyContribution)` with validated positive contribution. These are contribution counts, not guaranteed calendar dates. Do not add the protected reserve to the balance: it is part of the target allocation. A scenario is not a purchase, and the demo must not post a phone debit merely because the user compared options.

### Separate subscription scenario: one next-30-day window

| Charge/change | Amount and interpretation |
|---|---|
| StudyPlus | 79 RON paid-plan charge |
| Streamly | 49 RON paid-plan charge |
| CloudBox | 35 RON paid-plan charge |
| FitFlow | Trial converting to a 79 RON charge within the comparison window |
| Baseline upcoming total | **242 RON**, including the trial conversion |
| Student bundle | **89 RON** replaces StudyPlus + Streamly: potential reduction **39 RON** |
| Redundant storage | Potential reduction **35 RON**, only after equivalent included storage and retention/migration conditions are established |
| Stop FitFlow renewal | **79 RON future trial charge avoided**, after merchant confirmation |
| All proposed changes | Potential reduction **153 RON**; optimized upcoming total **89 RON** |
| Paid-plan reduction within that total | **74 RON** = 39 + 35; separate from the 79 RON trial conversion avoided |
| After only confirmed FitFlow cancellation | Upcoming total **163 RON**; bank balance still **110,000 RON** |

Bind all values to the same explicit date window and offer revision. The 89 RON offer is fictional; fixture authors must specify its billing period, benefits, eligibility evidence, duration, post-promotion terms, fees and activation date. Unknown terms make the proposal conditional. Do not claim a student discount is verified from a persona name. If included storage depends on the new bundle, verify activation and data migration before cancelling CloudBox. Model overlap/proration/cancellation timing if these are not immediate in the synthetic terms.

The 153 RON figure is potential future-charge reduction, not recovered cash. Do not multiply it by twelve, count it again as income, or immediately advance the home goal with it. A durable recurring forecast must separately model paid-plan reductions, trial avoidance, promo expiry, one-off fees and the user's decision to leave the money unspent. The home and subscription scenarios stay separate until such a combined forecast is explicitly constructed.

## 5. Delivery slices and completion gates

| Order | Slice | Completion gate |
|---|---|---|
| **S0: foundation** | Phone shell, synthetic bank, persisted task/ledger, deterministic core | The four destinations work at phone width; balances sum to 110,000; phone/home and business functions reproduce existing fixtures; refresh retains context. |
| **S1: understand and compare** | Live model + image extraction + clarification + subscription comparison | Actual image bytes reach the chosen vision-capable model; reviewed fields and bank records feed typed tools; the 242/153/89 breakdown is computed, not stored as assistant prose; unknown eligibility asks a question. |
| **S2: execute and verify** | Exact approval + isolated merchant browser + receipts | A real browser reaches the fake merchant, performs only the approved cancellation, and independent state/receipt verification shows its effective date. Upcoming charges become 163; balance/history stay intact. Duplicate clicks create one action. |
| **S3: change and monitor** | Changed terms, durable jobs, recovery | A term revision rejects an old approval; an explicitly enabled due watch creates one finding; restart/reconnect resumes safely; pending/unknown outcomes remain unresolved until reconciled. |
| **S4: shared personal/business engine** | Goals, stock/order, receivables, reserves, financial-product preparation | Existing phone/home/business results appear in the phone UI; partial payment changes the business minimum from 10,000 to 4,000 RON in the relevant scenarios. A request alone never creates a receipt; mock financing stays conditional. |
| **S5: accepted feature families** | Other optimizations, recovery, cost/benefit planning and business-seat/travel tasks | Implement one candidate at a time using the [feature-specific gates](AGENT-CAPABILITIES.md#accepted-feature-coverage). Each needs its own input, computation, action/receipt where applicable and negative-path proof. Others remain clearly planned. |

The default three-minute path uses S1–S3 plus a brief S4 result. Preserve S0–S4 ahead of optional visual flourishes, a second agent framework, voice, full-desktop control or extra imports. Full-desktop capability is an optional future adapter; a real isolated browser against fake merchant pages is the prototype requirement.

By 18:30 there must be an end-to-end action, not only a chat interface. If the browser is unavailable, a direct simulated-merchant adapter may keep the task working, but the UI and video must say **“Simulated merchant API”** and cannot claim browser execution. The browser completion gate remains unmet. An API outage can leave a useful calculator or labelled replay; neither is a live agent substitute.

## 6. Two-person work packages and ownership

The schedule works with **one confirmed developer**. Teo owns app/agent integration; the second person owns synthetic inputs, independent testing, mentor/customer evidence, English narration, deck and submission. Do not assume the absent third teammate or an overnight work shift. If the active teammate can code, transfer only the phone presentation package after the interface is agreed; do not give both people the same files.

Paths below are proposed implementation packages, not files created by this planning task.

| Owner | Exclusive work package | Handoff |
|---|---|---|
| Teo | `src/agent/`, `src/domain/`, `src/store/`, `src/adapters/`, `src/app/api/`, `src/worker/`; critical integration/ledger tests; package manifest and lockfile | Typed view models, task events, fixture schema and route contracts. Teo alone integrates shared changes. |
| Teo by default; coding teammate only after explicit transfer | `src/app/(phone)/`, `src/components/phone/` | Use root design tokens; consume server view models; no independent calculations or direct merchant writes in components. |
| Active teammate | New synthetic merchant/image fixtures and their descriptions, `tests/acceptance/`, future `pitch/slides/`, narration and submission fields | Agree schemas first. Preserve existing `demo/cases.json` and its verifier; add new fixture data separately when root integrates this plan. Test result records identify the build and actual outcome. |
| Root/document integrator | Existing scope/plan/pitch documents, design system and generated mockups | Integrate these two planning documents; review numerical/copy consistency before implementation. Root ownership is document coordination, not a third active delivery person. |

For a noncoding teammate, provide a written acceptance script and developer-controlled input/term toggles. They can run manual tests, edit agreed synthetic JSON under the schema and prepare delivery materials without sharing core source files. API-key entry is a private setup step for its owner; never place credentials in fixtures, screenshots, chat, logs or video.

### Timetable: Europe/Bucharest

| Local time | Teo: app and agent | Active teammate: product and delivery | Gate |
|---|---|---|---|
| **Oct 28, 13:00–13:30** | API/tool/vision smoke test; choose compatible packages; agree schema and browser host | Confirm deadline, submission fields, component reuse/sponsor requirements and mentor checkpoints onsite; prepare synthetic input/terms | Working provider response or an honestly declared blocker; file ownership fixed |
| **13:30–14:15** | S0: deterministic calculations, seed, persisted tasks and minimal bank reads | Check fixture arithmetic independently; prepare labelled subscription/usage assets and merchant terms | Numeric/state foundation; protect existing fixtures |
| **14:15–15:30** | Phone shell and S1 live extraction/comparison; simple React cards first | Exercise other-device use, unknown eligibility and missing data; seek one personal and one business conversation | A real selected tool call and an inspectable comparison |
| **15:30–17:00** | Fake merchant pages, browser worker, approval validation, idempotency and receipts | Test merchant cancellation/pending/refusal states; draft six-slide story and capture only actual feedback | S2 cancellation can complete through rendered merchant UI |
| **17:00–18:30** | Connect full hero; changed terms and reapproval; start critical integration tests | Run the phone journey independently, including double tap and refusal; mentor feedback | End-to-end checkpoint; identify unmet gates explicitly |
| **18:30–18:45** | Review failures and scope labels; stop new optional work if hero is unstable | Capture actual mentor advice and resulting changes | One agreed repair list |
| **18:45–20:00** | S3 worker/watch, restart recovery and reconciliation | Adversarial tests; prepare README setup/limitation text and attribution inventory | One durable scheduled finding; safe unknown-outcome behavior |
| **20:00–21:15** | S4 phone/home and business view; partial-reply replanning | Validate personal/business separation and existing fixture results; finalize pitch with demonstrated scope | Breadth is calculated and honestly labelled |
| **21:15–22:15** | Fix failed critical tests; phone legibility/accessibility and loading/error states | Time the 180-second rehearsal; compare UI, captions, deck and build claims | Recordable build; decide whether any S5 task truly qualifies |
| **22:15–23:15** | Clean-start rehearsal, persist/reconnect proof, dependency/setup corrections | Record a complete backup video; check slide and repository access requirements | A usable backup delivery exists |
| **23:15–00:00** | Critical defects only; checkpoint known limitations | Finish documentation and media; save submission draft | No new feature work |
| **Oct 29, 00:00–06:30** | Flexible repair window; add a selected S5 workflow only after core gates pass, with time left for stabilization | Acceptance checks, optional workflow evidence, media and rotation/breaks according to availability | Keep the recording/submission buffer intact; claim only what passes |
| **06:30–07:30** | Clean checkout/start, critical test rerun, phone check | Independently follow README; verify disclosure and links | Reproducible release candidate |
| **07:30–08:30** | Fix only a demonstrated release blocker; support final capture | Record final English video, at most 180 seconds; finish deck | Final media matches actual build |
| **08:30–09:00** | Freeze submitted commit, fixture revisions and lockfile | Compare video/deck/README to frozen build | Identified submission candidate |
| **09:00–10:15** | Verify repository can be accessed and started; assist uploads | Submit repo, deck and video; check permissions and processing; retain submission confirmation | Aim to have complete submission by 10:15 |
| **10:15–11:00** | Submission contingency only | Submission contingency and Q&A rehearsal | **Hard deadline 11:00** |

If implementation starts late, remove optional S5 work and reduce polish before consuming the final recording/submission buffer. If the app API cannot run, report that early and preserve a labelled calculator/replay entry rather than a fabricated live demo. Confirm onsite checkpoints; the table uses the existing plan's 18:30 and 09:00 targets, not an independently verified event schedule.

## 7. API, environment and setup prerequisites

Within the first thirty minutes, confirm:

- One app inference provider credential and usable model, separately from coding subscriptions. Prove a typed tool call and a small image extraction, then measure whether the flow fits a rehearsal. A text-only model cannot satisfy the vision gate.
- A compatible local Node/package-manager runtime, a clean dependency install with lockfile, SQLite write access and a worker that can restart. Use the researched manifests as candidates; exact installed versions belong in the eventual README.
- An isolated browser runtime able to load the local fake merchant origin, capture a page and submit its synthetic form. Prefer a small browser adapter with a reproducible installation step. Do not attach to Teo's personal browser profile or require the client's phone/computer to run the agent environment.
- Explicit fictional terms and synthetic image/document inputs. A subscription image may need a separate Screen Time image; phone usage alone cannot establish household/TV/background use.
- Optional web-search access for sourced external comparison. The default reproducible run uses a versioned fictional offer catalog. Source dates, terms and missing values remain visible.

Proposed server-only configuration names: `MODEL_PROVIDER`, `MODEL_ID`, `MODEL_API_KEY`, `DATABASE_URL`, `APP_BASE_URL`, `MERCHANT_BASE_URL`; optional browser executable/search-provider configuration as selected. Implementers must document the actual names they adopt, without example secret values. A public client bundle never receives a model key. No real merchant/bank credentials are required.

The eventual repository should expose setup scripts for dependency installation, database initialization/migration, seeding, app launch, worker launch and critical tests. For example, `pnpm install --frozen-lockfile`, followed by project-owned `db:setup`, `demo:seed`, `dev`, `worker` and `test:critical` scripts. **These scripts do not exist at this planning baseline.** README must give exact tested commands, ports, browser install step, environment variable names and reset instructions once implemented. Reset is restricted to the isolated synthetic session and must not erase another run's evidence.

| Setup problem | Acceptable fallback | Honest product/demo label |
|---|---|---|
| Optional chat UI add-on costs time | Plain React + the chosen SDK React adapter | Same functionality; no integration claim for the unused library |
| Browser install/runtime fails | Direct fake-merchant command adapter; preserve approval/receipt rules | “Simulated merchant API”; browser gate not passed |
| Web/search key missing or source unavailable | Versioned fictional catalog; stale sources marked | “Fictional offer” / “Source unavailable”; no live-search claim |
| Vision unavailable | Reviewed manual fields or a previously captured trace | “Manual input” or “Replay”; live-image-analysis gate not passed |
| Model/API unavailable | Deterministic calculator and, if available, labelled recorded execution | “Calculator” / “Recorded run”; no live-agent claim |
| Streaming drops | Refetch task plus cursor-based polling | Preserve actual task status; do not replay a write |
| Ephemeral hosting cannot persist or run worker | Run the complete stack locally for the video | Local prototype; no always-on monitoring or hosted durability claim |

## 8. Three-minute hero flow

Use the [English pitch](../pitch/english-pitch.md) as the narrative base, adapted to the build. Record from the phone client. The expanded browser sheet supplies evidence without a desktop cutaway. A developer changes a synthetic term outside the client only when narrating that controlled demo intervention.

| Time | User-visible action and proof |
|---|---|
| **0–15 s** | Home: 110,000 RON total liquid funds, 242 RON upcoming in the subscription scenario, clear synthetic-bank label. Open an agent finding. |
| **15–45 s** | Upload synthetic Screen Time/subscription images. Show confirmed extracted fields and a real clarification about TV/family use or a missing eligibility fact. |
| **45–80 s** | Compare the fictional 89 RON student bundle, duplicate storage and trial conversion. Show **153 RON potential next-30-day reduction**, separated into 74 paid-plan reduction + 79 trial charge avoided, with conditions. |
| **80–110 s** | Approve **only** “Stop FitFlow renewal” on the exact card. Expand the task sheet: real fake-merchant page interaction, verified cancellation reference and effective date. Upcoming becomes **163 RON**, bank balance remains **110,000 RON**. |
| **110–140 s** | A controlled catalog change removes required offline playback from the unexecuted bundle (or changes a separately defined price/eligibility scenario). The unexecuted bundle proposal becomes outdated. Recompute using the explicit new fixture term and ask for approval of the revised version. Do not invent a revised total in the pitch before that fixture exists. |
| **140–165 s** | Goals: compare the separate 6,000 RON phone choice (four → five contributions) with 3,500 RON (four). Briefly show the tested business cash-flow result/context if the capture remains legible and timed. Do not credit the 153 RON as cash. |
| **165–180 s** | Close with demonstrated scope, user control and the personal/business pilot hypothesis. Anything unimplemented is described as planned. |

Use a pre-seeded session and bounded model/tool rounds to avoid setup during the video. An edited recording may remove waiting time if it remains truthful about what ran. Keep an unambiguous distinction between a recording of a real execution and a live run/replay. Before recording, rehearse once with changed facts so the model/tool path is not merely a fixed answer sequence.

## 9. Verification and evidence required before claims

Test at the module interfaces used by the app. Focus effort on money, consent, external state and recovery; avoid broad snapshot coverage of decorative UI.

| Verification | Required evidence |
|---|---|
| Deterministic arithmetic | Existing fixture verifier; application finance engine compared against canonical fixture outputs; new subscription/goal assertions checked independently. Integers in bani, explicit rounding/date ordering. |
| Ledger invariants | Balanced postings; unique external event IDs; no duplicate refund credit; owner transfer conserves consolidated funds; no balance mutation from a forecast, reminder or cancellation alone. |
| Proposal/approval policy | Forged chat approval rejected; altered terms/amount/recipient/context rejected; expired/declined/revoked grant cannot execute; transaction-time version check catches a term change after preparation. |
| Idempotency and recovery | Concurrent/repeated approve produces one merchant effect; response lost after commit is reconciled by action ID; different payload with the same key is rejected; restart resumes from persisted attempt. |
| Merchant semantics | Pending/refused cancellation keeps appropriate future charges; confirmed cancellation removes only eligible future charges at its effective date; card blocking never cancels the contract; independent receipt read verifies effect. |
| Refunds and duplicate charges | Requested/accepted refund does not change bank balance; confirmed unique bank credit does; authorization hold is distinguishable from two settled purchases. |
| Forecast/business semantics | Missing costs stay unknown; unconfirmed deposit stays conditional; partial invoice reply replans; same-day settlement ordering is preserved; loan proceeds are not profit and offered financing is not approved funding. |
| Scheduler | Due job survives restart, uses current terms and one lease, emits one finding for a dedupe key, honors revocation and never spends/cancels from monitoring permission. Advance demo time only with a visible synthetic-clock label. |
| Vision/web/browser | Image extraction can be corrected; malicious page/document text is treated as data; disallowed destination or write is blocked; browser timeout produces unknown/blocked status and reconciliation rather than fabricated success. |
| Phone UI and runtime loop | Four-tab flow at ~390 px, readable approval/receipt without horizontal scrolling, keyboard/safe-area handling, touch targets, other-device-use clarification, background/reconnect and actual model tool events. |

Record proof against an identified commit and fixture revision: pass/fail summary, sanitized tool/event trace, merchant before/after state and receipt, bank projection/ledger checks, and phone captures of approval, receipt and changed terms. This is a future implementation evidence package; no such app evidence is produced by these planning documents. A receipt screenshot alone does not replace persisted state assertions.

Judge-facing emphasis follows the supplied plan: agent/orchestration **25%**, functionality/testability **20%**, architecture/reproducibility **15%**, originality **15%**, domain understanding **15%**, mentoring **10%**. Show the real action/revision loop and its tests before spending time on extra comparison screens. Include actual mentor feedback and interview sample sizes only if obtained.

Submission exit: all claimed critical gates pass; limitations are explicit; repository starts from its documented setup; reused code/licenses are attributed; video is at most 180 seconds; video, deck and repository links work for the jury; the submitted commit is identified; and submission confirmation is retained before **29 October, 11:00 Europe/Bucharest**. This plan authorizes no production bank/merchant access or deployment.


## Forecast calendar alignment

The canonical subscription forecast runs from28October2026 09:41 to27November2026 09:41 Europe/Bucharest, end-exclusive. The three paid-plan transactions shown in Activity are historical26October charges, with their next renewals on26November. The fictional replacement bundle activates and bills89RON on26November08:00 before those renewals; stopping old renewals preserves already-paid access and prevents their next charges. FitFlow would convert on30October09:00. No extra immediate bundle charge, proration, refund or overlap fee is assumed. Those explicit demo terms produce242RON baseline,89RON conditional optimized charges and163RON after only FitFlow cancellation. A different effective/activation date must be recalculated.
