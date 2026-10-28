# NextMove — phone client experience

Visual revision v2: use [the interactive mobile reference](mobile-preview.html) and [updated component rules](DESIGN-SYSTEM.md) for typography, spacing and contextual status treatment. The 16 native HTML views demonstrate selected flows with synthetic state. They do not replace the broader route/capability contract below or establish implemented agent tools.

Design specification for Teo / Mr Laziz, NEXXT, 28–29 October 2026. English interface; phone only. This describes the accepted experience and the mockups to generate. It does not establish that any screen, agent tool, monitoring job, or integration is implemented.

Scope follows [PRODUCT-SCOPE.md](../PRODUCT-SCOPE.md), [PLAN-HACKATHON.md](../PLAN-HACKATHON.md), [the English pitch](../pitch/english-pitch.md), and [the canonical planning fixtures](../demo/cases.json). The research notes inform the connected task flow and inspectable evidence; their earlier alternative figures do not replace the fixtures or the mockup figures supplied in the brief. The parent owns `DESIGN-SYSTEM.md`, `tokens.json`, implementation priorities, and generated images. This file defines UX and copy only.

## 1. Experience and hierarchy

NextMove opens as a banking app: money, accounts, everyday actions, upcoming charges. One prominent agent card explains something useful the customer can act on. The Agent tab provides a lasting home for conversations, tasks, evidence, approvals, and monitoring. No introduction carousel, AI orb, desktop dashboard, or screen containing all capabilities is needed.

The visual direction is an original NextMove wordmark, yellow actions, dark text, light neutral backgrounds, white surfaces, and generous spacing. Use the parent's design tokens. Do not reproduce the official Raiffeisen logo or imply a partnership. A compact `Demo · Simulated bank` label identifies the environment; merchant task views use `Simulated merchant`. Avoid repeating long disclaimers inside every card.

The recurring content order is:

1. **What is true now:** balance, status, source, date, account owner.
2. **What matters next:** one upcoming commitment or prioritized finding.
3. **What the agent recommends:** consequence, conditions, alternatives.
4. **What the user can do:** a specific next step, followed by an exact approval when required.
5. **What happened:** verified result and its effect on future charges, cash, or goals.

Amounts, dates, status, and approval scope remain legible without opening a tooltip. Supporting calculations and source extracts expand on demand. “How this was checked” contains observable operations and results, never a purported transcript of private model reasoning.

## 2. Navigation and 24 base screen templates

The bottom navigation is exactly **Home · Activity · Goals · Agent**, in that order. Business uses the same four destinations. Personal/business switching sits in the header's context selector, also reachable through Profile; it is not a fifth tab. Each context keeps its own balances, tasks, goals, and remembered preferences.

The four root screens retain the bottom bar. Nested screens use Back plus a clear title, with their primary action in a sticky bottom area when needed. Full-height review and task sheets can cover the bar. Closing a sheet returns to its originating screen without discarding the task. Route strings below express navigation intent; they are not application code.

| ID | Screen / route | Entry and purpose | Main onward action |
| --- | --- | --- | --- |
| S01 | **Personal Home** `/home` | Default launch; liquid funds, accounts, Pay / Cards / Subscriptions, one agent finding, recent activity | Open relevant bank detail or `Review trial` |
| S02 | **Activity** `/activity` | Posted transactions first; filters for Scheduled and agent-related outcomes; refund tracker entry | Open transaction S17 or recovery S18 |
| S03 | **Goals** `/goals` | Saved personal or business goals, progress, assumptions, upcoming contribution | Open goal S20 or start decision S19 |
| S04 | **Agent** `/agent` | Prioritized tasks, one ask/upload composer, monitoring entry; new tasks start here | Continue task S10, add evidence S08, review S13 |
| S05 | **Account and card detail** `/home/accounts/:id` | Account balance and owner, linked card, transaction list, Pay / card controls | Payment or card-action draft → exact review S13 |
| S06 | **Upcoming and subscriptions** `/home/upcoming` | All / Subscriptions filter; dated charges and recurring-plan list; totals only for the selected known scope | Subscription S07 or `Ask about this charge` |
| S07 | **Subscription detail** `/home/subscriptions/:id` | Plan, price, billing date, renewal, access end, cancellation status, benefits, usage sources and past charges | `Review options`, `Track renewal`, or `Stop renewal` |
| S08 | **Add evidence / extraction review** `/agent/tasks/:id/evidence` | Photo, screenshot, document, or manual entry; show source previews and editable extracted facts before use | `Confirm details` → S09 or return to task |
| S09 | **Benefits and constraints** `/agent/tasks/:id/preferences` | Resolve missing context: TV/family/background use, required benefits, student status, reserve and preferences | `Compare plans` → S10 / S11 |
| S10 | **Task workspace / action plan** `/agent/tasks/:id` | Shared task view: customer request, relevant facts, findings, alternatives, proposed actions; conversation expands in place | Compare S11, simulate S19, review S13, or inspect task S15 |
| S11 | **Offer comparison** `/agent/tasks/:id/offers` | Vertically stacked alternatives; equal period, total cost, benefits, conditions, and source date | Inspect S12 or review an eligible action S13 |
| S12 | **Terms, eligibility and preparation** `/agent/tasks/:id/offers/:offerId` | Full terms, post-promo price, evidence needed, missing facts; bank products include fees and document checklist | Verify eligibility, prepare bank pack, or review exact commitment |
| S13 | **Exact approval** `/agent/tasks/:id/review/:actionId` | Concrete merchant/bank action, amounts, effects, terms, scope and expiry; decline is equally accessible | Approve → S15; decline → S10 |
| S14 | **Changed terms / conflict** `/agent/tasks/:id/changes` | Show old → new facts, changed consequences, and invalidated pending approval | `Review updated plan` → current S11 / S13 |
| S15 | **Agent task sheet** `/agent/tasks/:id/live` | Expanded phone sheet with progress, tools used, optional isolated-browser/computer viewport, takeover and pending confirmation | S16 after verification; S14 if terms change |
| S16 | **Outcome and receipt** `/agent/tasks/:id/result` | Confirmed, prepared, pending, or unsuccessful result; evidence and precise financial effect | View updated payments, transaction, goal, or prepared packet |
| S17 | **Transaction / issue detail** `/activity/transactions/:id` | Posted vs pending, merchant, amount, source, reference; ask about duplicate, refund, or price adjustment | Investigate in S10 or track in S18 |
| S18 | **Recovery tracker** `/activity/recoveries/:id` | Refund, possible duplicate, or price-adjustment case; expected dates, submitted evidence, merchant reply, matched bank credit | Review a follow-up S13; open confirmed credit S17 |
| S19 | **Decision simulator** `/goals/:id/decision` | Purchase, housing, travel, or business alternatives; visible inputs, consequences, costs and stress scenarios | Save comparison; update goal; compare finance S11 |
| S20 | **Goal detail and plan** `/goals/:id` | Target breakdown, funds counted, reserve, contribution plan, dependencies and actual vs projected progress | `Test a decision` S19 or edit assumptions |
| S21 | **Business Home** `/home?space=business` | Business account and reserve, one relevant agent finding; invoices, planned owner transfer, stock links | `Compare terms` → S22 |
| S22 | **Business decision workspace** `/goals/:id/business` | Same plan pattern with contextual sections for Stock, Receivables, Owner income, and Funding | Simulate S19; draft request S13; compare finance S11 |
| S23 | **Monitoring and preferences** `/agent/monitoring` | Watched items, check schedule, notification preferences, persistent constraints, source access, last check and failures | Edit / pause a monitor or open its task |
| S24 | **Profile, context and access** `/profile` | Personal/business selector, account ownership, authorized sources/tools, saved preferences, privacy controls | Switch context or review scoped access |

S05's payment entry is a short amount/recipient/date form sheet, followed by S13; S13 also covers direct bank-tool transfers and card actions. For payments show source account, recipient, currency, date, fees, and impact on reserves. A card freeze has its own clear effect and cannot mark a merchant contract cancelled.

S10 and S22 share one task pattern rather than separate specialist agents. Business sections appear only when relevant. A service business need not see stock; a new shop has setup assumptions rather than invented historical invoices. Tasks can also start from a deep link in a charge, transaction, goal, or notification, preserving that context.

## 3. Locked mockup data and explicit demo terms

All figures below are synthetic. The extra merchant terms in this section are design assumptions for coherent mockups, not verified real offers and not additions to `demo/cases.json`.

| Context | Values and interpretation |
| --- | --- |
| Personal bank snapshot | Alex: **110,000 RON total liquid funds = 12,480 current + 97,520 savings**. Label the aggregate `Total liquid funds`, not unrestricted spending money. Do not add the two balances to it again. |
| Home readiness | **130,000 RON = 90,000 down payment + 10,000 costs + 30,000 protected reserve**. Funds counted are 110,000; gap 20,000. The reserve is inside this target, not an additional 30,000 requirement. |
| Contributions | Pre-home savings capacity **6,000 RON/month**: baseline **4 monthly contributions**; a 6,000 phone leaves 104,000 and requires **5**; a 3,500 phone leaves 106,500 and still requires **4**. No calendar completion promise. |
| Post-home budget, a separate period | Income 12,000 − other spending 6,000 − fictional mortgage payment 3,400 = **2,600 RON/month**. Income lower by 3,000 makes this **−400**. Mortgage eligibility remains unconfirmed. |
| Subscription baseline | Next 30 days: StudyPlus **79** + Streamly **49** + CloudBox **35** + FitFlow trial conversion **79** = **242 RON**. Already-paid recurring plans total **163 RON/month**. This is a subscription forecast, not the total of all household bills. |
| Conditional full proposal | Student bundle **89** replaces StudyPlus + Streamly (128), reducing 39; included storage replaces CloudBox (35); stopping FitFlow avoids 79. **153 less due over the next 30 days; optimized forecast 89**. Of the 153, **74 is paid-plan reduction and 79 is trial conversion avoided**. No recovered-cash label and no automatic annualization. |
| Demonstrated action only | Only FitFlow cancellation executes in the depicted action flow: **242 → 163 next-30-day charges; 79 future charge avoided; bank funds remain 110,000**. Bundle and CloudBox changes remain unapproved. |
| Fictional trial terms | FitFlow converts on **30 Oct 2026, 09:00 Europe/Bucharest**. Stopping renewal before then costs **0 RON** and preserves access until that moment. These are labelled demo terms. Merchant host: `fitflow.example`. |
| Fictional bundle terms | Student bundle costs **89 RON/month through 30 Jun 2027, then 128 RON/month**; verified student status required. It includes equivalent StudyPlus + Streamly benefits and **100 GB** storage. CloudBox is assumed to provide the required 100 GB; safe migration and an active replacement are prerequisites to its removal. |
| Evidence illustration | The generated Screen Time preview can show Streamly **14 min over the last 7 days on this phone**. Alex confirms TV use. This synthetic measurement is a device-specific clue, not evidence of total non-use. |
| Business fixture | Separate context: opening cash **26,000**, business floor **8,000**, owner transfer **4,000 on Day 3**, bills **10,000 on Day 7**, invoice **12,000 on Day 12**, online receipts **10,000 on Day 15**. Order needs 1,000 units, 200 held, **800 to buy × 30 = 24,000 on Day 2**, receipt **40,000 on Day 30**. Use the canonical scenario results described below. |

All comparison periods and “less due” amounts use the same next-30-day window. A current plan might have access paid through a later date: the engine must check effective dates before including its removal in that window. The full 89 RON outcome stays conditional until all dependencies are verified and actions complete.

The 6,000 monthly contribution is an existing planning assumption. A future charge avoided does not immediately add money to savings or increase that contribution. A budget revision must be explicit and recalculated; an already-cancelled trial must not be counted again in another optimization.

## 4. Core task flows

### Daily banking → useful agent action

S01 shows accounts first, then `Your trial becomes 79 RON` with `Review trial`. That deep link opens FitFlow S07 with the exact upcoming charge and access terms, then its task S10. The customer can also reach it through S06, Activity's Scheduled filter, or Agent. Home shows one prioritized agent finding, not a list of 22 features.

Bank reads, calculations, and authorized preparation can happen directly through bank/deterministic tools; a browser is not required for every action. A bank transfer or other financial commitment reaches S13 with its own exact details. The result uses bank confirmation, not a chatbot assertion.

### Image/documents → confirmed facts → relevant recommendation

S04 `Add screenshot or document` → S08 picker → extraction in progress → editable review. Support multiple attachments, a crop preview, field-to-source links, currency, period, merchant, and document date. Distinguish `Read from image`, `Matched to bank record`, `You entered`, and `Needs checking`. Confirm a suggested match; do not silently merge uncertain records or count the same charge twice. Unreadable/unknown fields stay blank with a request to correct them; manual entry is the fallback.

`Confirm details` saves facts, not action approval. S09 asks only relevant missing questions: “Do you use Streamly on TV?”, “Which benefits should I keep?”, “Can student eligibility be verified?” User-confirmed constraints persist in the correct context and remain editable. S10 forms the plan; S11 compares offers. Screenshots of low phone use alone never trigger cancellation.

### Compare → approve one action → observe merchant → verify

S10 presents three findings with conditions. S11 shows the conditional 242 → 89 comparison. Student eligibility is unresolved until S12 verifies it; the bundle cannot be committed while it remains unresolved. The customer chooses **only the independent FitFlow action** for the demonstration.

S13 specifies service/account, action, next charge, effective/access dates, fee, price/terms version, effect on forecast, and approval expiry. The mockup can show `Expires in 10 min` as a proposed session rule. Any relevant term or input change expires the approval immediately. Financial commitments need the user's decision; a chat message such as “looks good” is not a substitute for this exact review.

Approve → S15. Show progress based on actual operations: `Checking terms` → `Sending cancellation request` → `Awaiting merchant confirmation`. Only a merchant-side confirmed renewal-off state, checked with its effective date, permits S16 `Renewal stopped`. A submitted request, blocked card, closed browser, or success toast is insufficient. Refresh upcoming charges and link the merchant receipt. Prior posted charges remain in history.

Each action is individually scoped. A multi-action review must enumerate every action, cost, dependency, and consequence with per-item choices. Approving FitFlow does not approve the bundle, CloudBox removal, or a bank transfer. Execute dependent changes in safe order: verify eligible replacement → confirm activation and access/migration → stop redundant plan. If one item fails, show the actual partial result.

### Changed terms → revised plan, without repeating completed work

For the changed-condition moment, the unexecuted bundle's new terms no longer include offline playback, a benefit Alex explicitly requires. S14 shows the old and new benefit, marks the affected comparison and pending approval `Out of date`, and requests a fresh comparison. The89RON price may be unchanged, but the bundle no longer fits the user's constraint. Do not invent a different price or claim the required benefit remains included. A separate promo-expiry scenario can later compare full-period costs.

`Review updated plan` recalculates S11 before S13 can approve the current version. FitFlow's already-confirmed cancellation remains completed. If the user declines a proposal, record that choice, preserve the current service, and do not repeatedly request the same approval.

### Transactions → recovery, with a separate bank-credit milestone

S02 / S17 → `Track a refund`, `Check possible duplicate`, or `Check price adjustment` → S10 gathers evidence → S18 tracks progress. A possible duplicate compares merchant, amount, timing, order identifiers, and pending vs posted status before proposing a claim. Price adjustment checks the documented/demo policy and deadline. S13 previews the exact claim or follow-up before submission to the simulated merchant.

S18 distinguishes `Draft`, `Submitted`, `Merchant accepted`, `Awaiting credit`, `Credited`, and `Declined`. Unknown refund amount or date is `Not confirmed`, never zero. Merchant acceptance changes the tracker, not spendable funds. Only a matched, posted credit changes the bank balance and links back to S17. If the date passes, propose a follow-up rather than silently claiming recovery.

### Goals → decision simulator → realistic next steps

S03 → S20 Home readiness → S19 `Test a purchase`. Compare no purchase, 6,000 phone, and 3,500 phone with the fixed contributions above. Select the cheaper recommendation only when preserving home timing is the confirmed priority. `Save comparison` stores the decision; it does not purchase a phone or move savings.

Goal detail includes target components, funds counted, reserve policy, gap, contribution timing, and assumption date. Expand `After buying the home` for the separate 2,600 / −400 monthly budget stress scenario. Missing closing costs cause a question, not a zero. `Compare financing` opens S11/S12 with supplied/mock fees, total cost, conditions, eligibility unknowns, and an onboarding checklist. `Prepare bank pack` yields a prepared artifact; an application is not described as submitted or approved.

Purchase comparisons also support total ownership cost over an explicit horizon: upfront payment, required services, consumables, upkeep, fees, and remaining obligations. Monthly installments alone cannot represent total cost.

### Business context → stock, receipts and owner commitments

S24 switches to Business → S21 → S22 `Can we take this order?`. Preserve bank navigation and use the same agent; activate stock, receivables, owner income, and funding only when needed. Use Day 0–30 for this closed fixture.

Baseline minimum cash is **12,000**, closing **34,000**. Accepting unchanged requires the stock payment and reaches **−12,000 on Day 7**, closing **50,000**. The suggested **12,000 deposit on Day 1 plus full invoice collection on Day 5** has a conditional minimum **10,000**. Approving a request does not confirm either cash receipt.

The partial invoice reply of **4,000 on Day 5 / 8,000 on Day 12** reduces the minimum to **4,000**, below the 8,000 floor. Show that reply and replan. Conditional mock funding A draws **4,200 on Day 6**, repays **4,300 on Day 12 after the receipt**, yielding minimum **8,200** and closing **49,900**; offer B costs **350** rather than **100**. Eligibility/availability remain unknown until confirmed. If unavailable, explore supplier staging, revised order terms, a smaller order, or decline.

Owner transfer **4,000 on Day 3** remains a business outflow and one linked personal inflow through an existing confirmed arrangement. It is not new consolidated income or personally spendable company cash. Personal essentials **3,500 on Day 4** belong to the linked personal scenario, not a claim that Alex's separate 110,000 snapshot has just changed. New-shop planning uses its own canonical setup-cost fixture and does not inherit this shop's invoices or inventory.

### Monitoring → timely task, with remembered scope

S07 or any dated task can offer `Watch this`; S23 shows item, purpose, authorized sources, frequency, next check, last successful check, and notification preference. Read-only monitoring can flag trial conversions, price changes, credit expiry, refund deadlines, billing mismatches, travel needs, and unused seats. A finding becomes a contextual S10 task; it does not automatically create a financial commitment.

Remembered goals and preferences are visible and editable, separate between personal and business. Changes identify affected plans. Notification deep links open the exact task, and quiet hours affect delivery rather than the financial deadline. Pausing a monitor stops future checks; it does not undo a submitted request or completed action. If a source/check is unavailable, show when it was last checked rather than implying continuous coverage.

## 5. Every accepted capability has a contextual entry

These are task types and triggers, not navigation items. Agent's composer can find any of them; no home screen needs to display this table.

| ID | Accepted capability | Discoverable entry → working screens | Required distinction |
| --- | --- | --- | --- |
| O1 | Financial goals, purchases, housing, business decisions | Goals `Test a decision` S03/S20 → S19; Business opportunity S21 → S22 | Readiness, affordability and lender approval are different |
| O2 | Inventory and purchases | Order/stock finding in S21 → S22 Stock → S19/S13 | Existing stock, additional units, lead time and payment date |
| O3 | Personal/owner income and reserves | Goal `Protected commitments` S20; Business `Owner income` S22 | Separate ledgers; confirmed transfer counted once per side |
| O4 | Receivables | Business invoice row S21 → S22 Receivables → exact message S13 / receipt S16 | Draft/sent reminder, promised payment and credited cash differ |
| O5 | Financial products and onboarding preparation | S19/S22 `Compare financing` → S11/S12 → prepared pack S16 | Costs, unknown eligibility, prepared vs submitted vs approved |
| T1 | Screen Time + subscription image analysis | S04 upload or S07 `Add usage` → S08/S09 | Other-device, family and background use; confirmed extraction |
| T2 | Trial warning + approved merchant cancellation | Home finding S01, S06/S07 or notification → S13/S15/S16 | Merchant confirmation required; charge avoided is not refunded cash |
| T3 | Offer / student / bundle comparison | S07 `Review options` → S09/S11/S12 | Eligibility, equivalent benefits, promo duration and later price |
| A1 | Duplicate benefits | Overlap finding S10 → S09/S11/S07 | Equivalent access and active replacement before removal |
| A2 | Right-size plan | S07 usage/limits → S09/S11 | Show lost benefits, limits and overage risk |
| A3 | Monthly vs annual | S11 `Compare billing` → S19/S12 | Whole-period cost, break-even, commitment, renewal and exit terms |
| A4 | Price increases | S23 monitor → S07 price history → S10/S11 | Previous/new price and effective date with source |
| A5 | Content-based rotation | S04 request or S07 `Plan around content` → S19/S23 | Desired content, dated availability, access overlaps and renewal terms |
| A6 | Pauses | S07 `Review options` → S12/S13/S15 | Provider permits pause; access, restart date and restart price |
| A7 | Refund tracking | S17 return/transaction → S18 | Accepted, pending credit and posted credit remain distinct |
| A8 | Possible duplicate charge | S02/S17 flag → S10/S18 | Authorization hold vs two settled purchases; do not accuse prematurely |
| A9 | Price-adjustment claims | Purchase S17 → S10/S12/S18 | Policy, window, evidence, request and confirmed credit |
| A10 | Total ownership cost | Goals purchase S19 → cost breakdown | Explicit horizon and all known costs; unknown costs stay unknown |
| A11 | Billing-date alignment | S06 calendar mismatch → S10/S11/S13 | Merchant permits change; transition bill/proration and effect date |
| A12 | Expiring credits | S23 watch / S10 finding → S12/S19 | Intended purchase, actual credit usable, expiry and extra cash required |
| A13 | Unused business seats | S21 finding → S22 operating costs → S08/S09/S13 | Staff/use evidence, responsible approver, reassignment and access loss |
| A14 | Travel cost optimization | Goals trip S03/S19 or S04 request → S09/S11/S12 | Existing benefits, dates, connectivity, supplied FX/payment fees and extra commitments |

Financial-product, travel, billing, and subscription comparisons reuse S11/S12. Rotation, annual billing and ownership cost reuse S19's horizon/assumption controls. Contextual option lists show only applicable choices; a small `Other options` row can disclose the remainder for that service.

## 6. Sixteen selected mockups in four boards

The completed visual set follows the root's final selection below. It expands the initial twelve-screen proposal while preserving the 24 reusable templates above. The generated boards establish style and composition; exact copy, amounts and states come from [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) and [ui-fixtures.json](ui-fixtures.json). Reference implementation viewport is 390×844; raster boards are conceptual approximations, not exact CSS geometry.

These are different moments in a flow. K01–K07 describe the pre-cancellation state; K08 is pending; K09 is confirmed. K10–K12 retain the existing planning assumption rather than crediting avoided charges. K13 is a separate company context; K14 is an uncredited refund; K15 is a fictional travel comparison; K16 changes an unexecuted bundle proposal after FitFlow completed.

### Board 1 — Banking and agent entry

**K01 / S01 — Home.** Header NextMove, Demo, Alex. `Hello, Alex`; `Total balance110,000.00RON`; account breakdown `Daily12,480.00` and `Savings97,520.00`. Shortcuts Send, Request, Cards. Agent card `153RON`, `Potential reduction · next30days`, `Review3options`. A First home planning card shows110,000/130,000. Home selected. The aggregate is the two liquid accounts once; it is not a claim that all funds are unrestricted spending money.

**K02 / S02 — Activity.** Transactions and Upcoming controls, subscription entry163RON/month, one trial ending soon, and posted rows Streamly−49, StudyPlus−79, CloudBox−35 and Fresh Market−128.40. Refunds & claims links to S18. Activity selected; trial conversion belongs to upcoming, not posted history.

**K03 / S06 — Subscriptions.** Current paid plans163RON/month, separate FitFlow trial79RON due30Oct, active-plan rows and an agent finding about potentially included storage. `Find better options` starts the task. Activity selected. A suggestion is not verified benefit equivalence.

**K04 / S04 — Agent.** `Your next move`, task starters Review subscriptions, Plan a purchase, Explore a home, Grow my business. Active task `Subscription review`, `Ready to review`, three options and153RON potential in the comparison window. Ask/attachment composer and Add screenshot. Agent selected; no claim that every starter is already implemented.

### Board 2 — Evidence, comparison and action

**K05 / S08 + S09 — Review evidence.** Screen Time and Subscription previews; Streamly14min this week, Phone only,49RON/month. Confirm TV use and Keep offline playback, then `Compare options`. Extraction confirmation records facts; it is not approval of a merchant action.

**K06 / S11 — Compare options.** Current242RON versus Proposed89RON, both explicitly next30days. Potential reduction153 if all three actions confirm: FitFlow79 future trial charge avoided; bundle39 replacing StudyPlus+Streamly; CloudBox35 after active equivalent replacement storage and migration checks. `View terms & calculations`; `Review actions`. The proposal remains conditional on all relevant evidence and dates.

**K07 / S13 — Approve action.** `Cancel FitFlow trial`; next charge79RON on30Oct, cancellation cost0, access until30Oct and renewal-stop effect. `Confirm cancellation` and `Keep trial`. The exact review authorizes only FitFlow, and current balance stays unchanged. Expand the date to2026-10-30 09:00 Europe/Bucharest in implementation details.

**K08 / S15 — Agent browser.** `Stopping FitFlow renewal`, Waiting for confirmation. The merchant page says Cancellation request received / Processing. Timeline records account opened, approved request sent and merchant response pending. Pause, Take over and Open live view remain available. A received request is not a completed cancellation.

### Board 3 — Result and financial decisions

**K09 / S16 — Confirmed result.** Renewal stopped / Confirmed by FitFlow.79RON future charge avoided; access until30Oct; cost0; referenceNF-1047. Upcoming subscriptions163RON next30days; bank balance110,000 unchanged. Only FitFlow changed; other options await review. Open updated payments or confirmation. For implementation, preserve the origin tab or use a full-height receipt sheet; the raster's root-tab highlight is not a routing contract.

**K10 / S03 + S20 — Goals.** Home readiness110,000/130,000, gap20,000,6,000/month and4monthly contributions. The130,000 target already includes a30,000 reserve. `Test a decision` opens the simulator. Goals selected; this is a planning measure rather than an additional bank account or mortgage approval.

**K11 / S19 — Purchase decision.** Priority: keep home timing. No purchase requires4contributions; a6,000phone requires5; a3,500phone requires4 and fits the declared priority. `Save comparison` stores a plan, without purchasing or moving funds. The79trial avoidance is not silently added to monthly savings.

**K12 / S20 — Home plan.** Target breakdown90,000down +10,000costs +30,000reserve =130,000. Gap20,000 and4contributions. After-purchase budget12,000income −6,000other spending −3,400supplied fictional payment =2,600/month. Income lower by3,000 makes−400. `Prepare bank checklist`; illustrative payment and eligibility-not-assessed labels remain visible.

### Board 4 — Business, recovery and changed conditions

**K13 / S21 — Business.** Explicit company Laziz Products, business cash26,000, floor8,000. Order40,000 may create−12,000minimum cash. Stock800units/24,000, invoice12,000, owner transfer4,000. `Compare terms`; Home selected in Business context. The separate canonical business fixture governs these calculations; personal funds do not become company funds.

**K14 / S18 — Refund tracker.** StudioMart249RON, Awaiting bank credit; requested24Oct, merchant accepted25Oct, expected credit by31Oct. ReferenceSM-2048; Current balance unchanged. Pending bank-credit milestone is visually distinct from completed merchant acceptance. `Check status` and View return details. These added dates/terms are fictional design data.

**K15 / S19 — Travel plan.** Barcelona12–16Nov, budget1,500RON. Fictional DataPass29 and RoamPack49 each offer5GB/7days;20RON lower nominal data cost for the equivalent stated options. Existing card-benefit eligibility and payment fees remain unknown. `Review travel plan` prepares a choice, not a booked trip or an executed purchase.

**K16 / S14 — Changed terms.** The89RON/month bundle no longer includes required offline playback. Mark the unexecuted proposal out of date and incompatible with Alex's preference. FitFlow remains confirmed; current upcoming total stays163RON until further approved changes. `Compare alternatives` or Keep current plans. Do not change completed history or invent savings from an incompatible offer.

## 7. Agent task-sheet behavior

S15 uses a compact task bar when minimized: task name, state, and `Open task`. Expanding shows the goal, current step, observed events, and only the tool surface actually in use. Bank-tool-only tasks show bank results and progress without a pretend browser. Web search/extraction tasks show source pages, checked times, and extracted terms; simulated catalogs say so explicitly.

| State | Visible copy / behavior | User control |
| --- | --- | --- |
| Reading / calculating | `Checking your subscription` / `Comparing total costs`; progress tied to completed operations | Minimize; stop before the next action |
| Ready for a commitment | `Your approval is needed`; exact action summary | Open S13; agent waits |
| Browser working | `Agent is working`; isolated merchant viewport; current observed step | `Pause agent`, `Take over`, minimize |
| User takeover | **`You're in control`**; agent input paused; viewport expands with touch/keyboard controls | `Return to agent`; re-read state before resume |
| Authentication needed | `Your input is needed on the merchant page`; agent pauses | User interacts inside the viewport, not in chat; no secret echoed into the task log |
| Request submitted | **`Awaiting merchant confirmation`**; request/effect status remains pending | `Check status`, `Stop checking`; submission cannot be undone by closing |
| Terms differ | `Terms changed. Review before continuing.`; affected operation stops | Open S14; previous unexecuted approval expires |
| Verified result | Exact confirmed outcome, time, effective date, source reference | Receipt S16 and refreshed bank view |
| Failure / unknown result | Explain whether merchant refused, page failed, or confirmation is unknown | Verify status first; retry only a safe step, never blindly repeat a submitted action |

Takeover is explicit and exclusive: the agent cannot click while the user controls the page. On return, check the current merchant/bank state and invalidate affected approvals if terms changed. The user may resize the viewport or open it nearly full-screen; a long page scrolls inside a clearly bounded area. Optional full-computer work uses the same sheet with a `Computer` label, zoom/pan and input controls. It does not create a desktop product layout or a fifth navigation destination. These controls describe the accepted capability, not a claim that computer takeover is built.

Final outcomes have distinct words: **Prepared**, **Submitted**, **Awaiting confirmation**, **Confirmed**, **Declined**, **Failed**, **Needs checking**. A request with unknown outcome is not automatically Failed or Confirmed. The activity history stores completed actions; a new condition affects remaining work rather than rewriting history.

## 8. Useful non-happy states

| Situation | Concise English copy | Correct behavior |
| --- | --- | --- |
| Loading bank data | `Updating your accounts…` | Stable skeleton / previous labelled snapshot; never animate unknown money from zero |
| Empty activity filter | `No transactions in this period` | Show the selected dates and `Change dates`; do not claim there are no future bills |
| No goals | `What are you working towards?` | One `Create a goal` action with purchase, home, trip or business entry choices |
| No active agent tasks | `Nothing needs your approval` | Offer ask/upload; show actual monitoring status rather than claiming everything has been checked |
| Extracting an upload | `Reading your images…` | Show attachment progress; cancel/remove attachment; no fabricated facts |
| Unreadable required field | `I couldn't read the renewal price.` | Mark that field `Needs checking`; `Enter manually`; don't guess a price |
| Ambiguous bank match | `Which payment belongs to this subscription?` | Show candidates and `None of these`; no automatic merge |
| Benefit/eligibility unknown | `Student status is not verified` | Keep comparison conditional and commitment unavailable; independent trial action remains possible |
| Offline | `Offline · Showing your last update` | Show actual last-updated time; preserve drafts; require refreshed terms/status before a new financial commitment |
| Stale plan / expired approval | `This plan needs a fresh check` | Explain changed price/date/input; disable old approval; update S14 → S11 |
| Conflicting evidence | `These renewal dates don't match` | Show both sources and dates; ask or refresh authoritative merchant state before proposing action |
| User declines | `You kept the current plan` | Preserve charges; no duplicate approval prompt; allow an explicit later revisit |
| Merchant refuses | `FitFlow did not accept the cancellation` | Keep renewal due unless a later confirmation changes it; show reason and relevant next steps |
| Timeout after submission | `Confirmation hasn't arrived yet` | Keep Pending; `Check status`; no repeat submission that might duplicate the action |
| Refund accepted, not credited | `Accepted by merchant · Waiting for bank credit` | Tracker updates; balance unchanged; show promised date only if supplied |
| Refund overdue | `The expected credit date has passed` | Prepare a factual follow-up; exact review before simulated sending |
| Source/monitor unavailable | `Last checked [actual time] · Check failed` | State coverage gap and next retry; never show “Protected” from a stale check |
| Business plan infeasible | `Cash falls below your 8,000 RON reserve` | Show minimum/date, assumptions and alternatives; no invented financing approval |
| Profile switched mid-task | `This task belongs to Personal` | Keep task bound to its owner/context; open there before approving |
| Partial multi-action outcome | `1 change confirmed · 1 needs review` | Itemized receipts and pending conditions; no single all-success total |

## 9. Phone ergonomics and accessibility

- Design at 390 × 844; tolerate 390 × 852 and narrower phones through scrolling and wrapping, not scaled-down text. Use safe-area insets at top/bottom. The sticky footer and bottom navigation must never cover the final row or each other.
- Parent tokens define exact typography and spacing. Keep body and editable input text at least16logical pixels; short button labels may use the14px label token and metadata the12px caption token while touch targets remain44px or larger. Financial figures and approval consequences receive the clearest hierarchy. Allow system text enlargement, two-line labels, and longer merchant names without losing amount/status.
- Tap targets are at least 44 × 44 logical pixels, including Back, attachment, disclosure, and Close controls. Place the main action within thumb reach. A secondary decline/back action remains visible; do not rely on swipes or color alone.
- Root navigation stays fixed; nested pages scroll vertically. Avoid horizontal financial tables and swipe-only alternatives. Three choices become stacked cards with consistent fields. A selected card uses label, border/check and state text, not yellow alone.
- Composer/input focus moves above the software keyboard. Keep the active field and error visible; use suitable numeric/currency keyboards and explicit currency labels. `Done` dismisses the keyboard before the full review. Final approval always shows the whole action summary outside keyboard editing mode.
- Upload uses phone photo/file pickers; show preview, Replace and Remove. Ask for the relevant document, not an entire gallery. Dates use `30 Oct 2026`; disclose Europe/Bucharest on deadlines. RON values use a consistent English format (`12,480 RON`).
- Expandable browser content has its own labelled viewport and obvious scroll boundary. Takeover exposes focus/keyboard controls without a tiny desktop cursor being the only input method. Close/minimize and approval actions stay outside merchant page content.
- Status has an icon plus words; support screen-reader labels, logical reading/focus order, progress announcements and reduced motion. Receipt verification cannot depend on animation. After approval, disable duplicate activation and announce the actual new state.

## 10. Handoff checks for the parent

The sixteen generated screens follow K01–K16; the 24 templates define the full reusable experience, including additional non-happy states. Check account sums, consistent navigation and labels, next-30-day scope, conditional offer terms, and the pending → confirmed transition visually. Check that the 163 RON result occurs only after FitFlow confirmation and that the 110,000 RON funds never increase from an avoided charge.

The generated images are static design artifacts. Merchant execution, image extraction, scheduling, persistence, tool traces, bank updates and takeover require separate implementation and runtime evidence before the demo can claim them as working. Preserve the broad accepted capabilities while describing only the tested build in the final presentation.


## Forecast calendar alignment

The canonical subscription forecast runs from 28 October 2026 09:41 to 27 November 2026 09:41 Europe/Bucharest, end-exclusive. The three paid-plan transactions shown in Activity are historical 26 October charges, with their next renewals on 26 November. The fictional replacement bundle activates and bills 89 RON on 26 November 08:00 before those renewals; stopping old renewals preserves already-paid access and prevents their next charges. FitFlow would convert on 30 October 09:00. No extra immediate bundle charge, proration, refund or overlap fee is assumed. Those explicit demo terms produce 242 RON baseline, 89 RON conditional optimized charges and 163 RON after only FitFlow cancellation. A different effective/activation date must be recalculated.

## 11. Bank-partner revision: bulk review, permissions and exceptions

The real product is a feature inside a partner bank, as selected by the user. [SECURITY-AND-SCALE.md](SECURITY-AND-SCALE.md) governs the execution rules; the [200-item fixture](../demo/bulk-cancellations.json) is an independent stress scenario, not an extension of Alex's 242/163 RON monthly example. Four additional reusable templates bring the specification to **28**, with no new generated mockup boards.

| ID | Screen / route | Customer task | Primary action |
|---|---|---|---|
| S25 | **Review subscription batch** `/agent/batches/:id/review` | Review groups, search individual contracts, compare dates/costs/lost benefits, select or exclude exact items | `Review 120 cancellations` after the customer actually selects those items |
| S26 | **Agent access and permissions** `/agent/access` | See connected sources, read/monitor permissions, pending execution mandates, scope/expiry and current checks | `Manage access`; `Stop new actions` for a specific mandate |
| S27 | **Batch progress and results** `/agent/batches/:id` | See all inventory, approved set, confirmed/pending/blocked/unknown children, receipts and dated financial effects | `Review issues`; prominent `Stop new actions` while the mandate can dispatch |
| S28 | **Resolve one exception** `/agent/batches/:id/items/:itemId` | Understand expired login, new terms, unknown outcome, ownership/data-loss risk or manual provider route | Relevant `Sign in securely`, `Review changed terms`, `Check status`, or `Open provider instructions` |

These are nested Agent screens. The Home · Activity · Goals · Agent navigation remains unchanged. S25 opens from S06 multi-selection or a prepared S10 batch. S13 renders the trusted final approval of the immutable selected manifest. S26 lives under profile/Agent settings; S27 persists when the phone closes; S28 returns to the same batch with its original results intact.

### S25: a review that works for 200 rows

Show `200 subscriptions checked` with visible groups: `120 ready to review`, `25 already off`, `20 need sign-in`, `15 have contract conditions`, `10 need ownership or essential-service review`, `10 need a manual route`. All item details stay available through search, filters, pagination or an accessible virtual list. Do not silently preselect risky/unknown items or make the customer confirm 200 duplicate dialogs.

Each row names merchant/account, current plan, proposed operation, next charge, effective/access dates, fee, lost benefits and unresolved facts. Exact approval has a summary plus access to every selected row; a downloaded list alone is not the approval UI. Screen reader users can inspect all rows and their selection state, not just the viewport.

S13 copy: `Stop renewal for 120 subscriptions` → `No additional fees · Access ends on each service's listed date · Start permission expires in 60 minutes`. CTA `Confirm 120 cancellations`, secondary `Back to review`. Scope, consequences and amount limits are plain language. Creating a proposal or clicking a group checkbox does not create approval. Additional bank authentication follows bank policy; do not label a prototype button as production SCA.

### S26: distinct permissions

Separate `Read selected account data`, `Monitor these renewal dates`, and exact action mandates. Show source, account, granted scope, expiry, last successful check and how to revoke. `Stop new actions` revokes dispatch rights for that mandate. Disconnecting all access is a different operation and explains any effect on verification/monitoring; never silently keep scraping after full disconnection. Data deletion is a separate, explained request.

### S27: partial success is useful information

For the reference fixture: `100 confirmed · 8 waiting for provider · 5 need sign-in · 4 need a new review · 3 outcome unknown`, plus `80 outside this approval`. Parent status is `Needs attention`. Savings label: `2,824 RON in future charges avoided · 28 Oct–27 Nov, end-exclusive`. It uses confirmed items and their effective dates, not all 120 approved or all 200 discovered. The balance card remains unchanged.

Show count labels from persisted states, not an elapsed-time progress percentage. Each status is a filter; each item opens its receipt or reason. No optimistic `All cancelled` toast. Leaving the screen, refreshing or reconnecting restores the same batch. Notifications reveal minimal information on the lock screen and deep-link to the authenticated task.

Stopping copy: `New actions stopped. Requests already started may still finish.` Keep known results and identify in-flight/unknown items. `Resume` rechecks authority and changed facts, then asks for a fresh mandate where required. It does not resend confirmed or ambiguous actions.

### S28: ask only for the decision that is actually missing

- Unknown response: `The provider may have received this request. We are checking before sending anything again.` Offer status check/support, never an unguarded retry.
- Changed terms: show old → new cost/date/benefits, explain why approval no longer applies, and review just the affected remaining work.
- Login: open a bank/provider-approved protected handoff. Credentials, OTPs and sensitive input are excluded from model context, screenshots and recordings. Hand control back explicitly after authentication.
- Unsupported provider: show the exact manual route, deadline and evidence needed; keep `Manual action needed` until a verified result exists.
- Fixed-term/data-loss/shared-account: explain the specific consequence and missing authority. Do not present a generic yellow confirmation as a substitute for resolving it.

The new screens remain designed behavior. They require separate authorization, queue, recovery, accessibility and runtime checks in the implemented build.
