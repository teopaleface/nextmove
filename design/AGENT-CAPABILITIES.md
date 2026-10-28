# NextMove agent capabilities and execution contract

Specification baseline: 28 October 2026. **Accepted product scope, not implemented software.** NextMove serves personal and business customers inside a fictional phone banking app. The real parts to build are model/tool selection, image interpretation, deterministic calculations, browser interactions, persistent task state and verified changes to simulated bank/merchant records.

This document complements the [implementation plan](IMPLEMENTATION-PLAN.md), [approved scope](../PRODUCT-SCOPE.md) and [existing numeric fixtures](../demo/cases.json). It does not alter canonical fixtures or certify package/runtime behavior. All twenty-two accepted feature groups remain in scope, with separate evidence requirements below.

**Controlling revision:** [SECURITY-AND-SCALE.md](SECURITY-AND-SCALE.md) adds a bank-partner operating model, exact immutable batch approval, child workflows, revocation/dispatch ordering, resource-level concurrency and the 200-item acceptance fixture. It takes precedence for these subjects. [EU research](../research/eu-regulatory-boundaries.md) identifies legal triggers and application dates; no regulatory certification is claimed.

## Operating model

Use **one orchestrator**, with a context-specific typed tool allowlist and server-enforced policy. The model asks questions, chooses tools, compares their results, proposes an action and responds to changed evidence. Deterministic code owns money, permissions, state transitions, receipts and execution preconditions. The model cannot invent a tool, execute code, edit a ledger balance, grant its own approval or turn a web page's instructions into authority.

Each task belongs to one authenticated/opaque demo session and one explicit personal/business context. Its isolated server browser context, file references, jobs, proposals and receipts are not accessible to another session. The client is a phone; it can inspect browser progress in an expandable task sheet. Agent computation and browser execution run in the server environment, without requiring access to the client's computer.

Use a small default round budget, such as eight orchestrator steps and a configurable time limit. Persist before yielding for approval or clarification. A browser operation may have its own bounded internal steps, deadline and cancellation signal. A budget ending produces a resumable incomplete task, not a success claim. Serialize mutations of the same account/subscription, including across batches; unrelated resources can run with bounded concurrency. Concurrent reads must identify their input revisions. The workflow engine, rather than one long model conversation, owns a large batch.

## Capability surfaces

| Capability | Accepted behavior | Prototype proof and limit |
|---|---|---|
| **Direct banking tools** | Read balances, posted/pending transactions, upcoming commitments, subscriptions, goals and relevant business records. Prepare approved banking actions. | Real typed calls to the simulated bank. No real payment rails, card control, loan approval or account access. Any sandbox transfer is balanced and labelled; no real transfer claim. |
| **Vision and documents** | Extract usage, prices, renewal dates, benefits, invoices and relevant terms from a user-selected image/document. | Send actual supported image bytes to a vision model; show source and fields for correction. PDFs require a tested extraction adapter; otherwise request an image or manual reviewed fields. A filename or canned OCR response is not vision proof. |
| **Web search and extraction** | Find relevant source pages and extract comparable offers, policies and dates. | Store URL/title, observed time, locale/currency, exact relevant terms and missing facts. A versioned fictional catalog is the reproducible fallback, labelled fictional. Search results/snippets alone cannot establish full eligibility or a refund policy. |
| **Isolated browser** | Read a merchant account, prepare a change, execute the exact approved operation and collect its confirmation. | Real browser against fake merchant websites with their own persisted state. Use observation and permitted interactions, then independently read back state/receipt. No real credentials or Teo personal profile. |
| **Optional whole desktop** | Support a future workflow requiring a full isolated computer rather than a browser. | Optional adapter, disabled for the hackathon baseline. It would run in an isolated server environment with narrow task permission. No requirement to control the user's phone, laptop or desktop; no claim that browser use proves desktop support. |
| **Deterministic finance** | Forecast dated cash, reserve breaches, goal timing, inventory cost, funding cost, comparable commitments and savings categories. | Integer minor units, explicit currency/date/order and source trace; unknown inputs stay unknown. Model prose cannot overwrite a calculation. |
| **Persistent goals and preferences** | Remember user-confirmed goals, essential expenses, benefit preferences, risk/reserve constraints and monitoring choices. | Versioned, inspectable and correctable records with source/time. Inferred preferences are suggestions until confirmed. Reset/revoke is scoped to the user's synthetic session. |
| **Scheduled monitoring** | Check trials, renewals, term changes, missing refunds, invoices, credits and agreed conditions. | Durable due jobs and watches, deduplicated findings, current-state revalidation. Monitoring permission enables reads/notifications, not a financial commitment. Worker availability is explicitly local-prototype availability. |
| **Exact approval** | Approve a displayed action, subject, price/limit, terms, effect date and proposal version. | A server-created approval grant from a first-party user action. Chat history/model output is never sufficient. Changed material terms invalidate it. |
| **Execution verification** | Distinguish prepared, requested, pending, confirmed, refused and unknown outcomes, then reconcile the bank projection or ledger appropriately. | Structured authoritative receipt plus independent read-back. A successful click, screenshot or assistant message alone cannot establish completion. |

### Browser use and whole-desktop control are different

The prototype browser adapter launches an ephemeral browser context in the agent environment and navigates only to allowlisted simulated merchant origins. Synthetic session identity is supplied by the demo host; it is never a real credential injected into a page. The phone task sheet may show screenshots and progress, but approvals happen in the NextMove phone interface.

Use a state-driven merchant workflow: observe the current account and terms, prepare the exact change, stop for approval, recheck the current version, then perform the allowed final interaction. The fake merchant validates the expected version at its mutation endpoint as well, catching a change between the last observation and click. For a browser claim, the committed command must originate from that rendered page's permitted interaction; do not mutate state through a direct adapter and then capture a confirmation page. Preserve the browser step/merchant request correlation as proof. A direct fake-merchant adapter is a distinct fallback, never described as a browser run.

The browser can read pages without a financial-action grant inside its allowed task scope. Mutation must occur only through an execution scope bound to the approved action. Do not expose a general `click`, script evaluation, terminal or HTTP-write tool that bypasses this check. Navigation to another origin, download of an executable, a payment or unrelated account change must fail closed.

A future whole-desktop adapter would need its own application/file allowlist and execution policy. Its presence does not expand the approved action. For this prototype it returns `UNSUPPORTED` rather than silently falling back to Teo's computer. Authentication, CAPTCHA and 2FA challenges produce `BLOCKED_REQUIRES_USER`; no bypass, credential scraping or passive CAPTCHA solving is in scope.

## Typed tool interface

Tool names below are proposed contracts, not existing functions. Keep the model-visible surface small. Internal browser steps, jobs and financial algorithms belong behind these interfaces. Schemas accept typed enums and IDs, never executable expressions. The server derives actor/session ownership, permitted context and current resource versions; it does not trust model-supplied ownership fields.

Common request fields: `taskId`, `contextId`, relevant `inputRevision`, and a request/correlation ID. A mutating command additionally needs `proposalId`, `proposalRevision`, `actionId`, `approvalId` and an idempotency key. Results carry `status`, authoritative resource revisions, provenance references, `observedAt`, and typed errors where relevant. Monetary amounts are bounded integers in minor units with an explicit currency.

| Tool | Input → output | Permission and invariant |
|---|---|---|
| `loadContext` | Goal/task type and context → balances, obligations, goals, relevant merchant/business records and missing facts | Session-scoped read; personal/business records stay separated. Inventory/receivables tools are offered only when relevant. |
| `inspectEvidence` | Session-owned file/source reference and extraction kind → typed fields, source locations, ambiguities and questions | No automatic commitment or silent replacement of verified facts. User confirms material extracted facts. Page/document text remains untrusted data. |
| `findOptions` | Need, locale, constraints, horizon and source mode → dated fictional/sourced offer/policy records and missing terms | Read-only. No fabricated rate, eligibility, availability, policy or source date. Source records expire/revalidate when required. |
| `inspectMerchant` | Merchant/subscription/claim reference → observed plan, renewal, terms revision, available operations and preparation evidence | Browser or direct adapter identity is disclosed. Inspection does not cancel, submit a claim or purchase. |
| `simulateDecision` | Versioned context, dated events, allowed candidate actions, horizon and assumptions → balances/minima, reserve breaches, goal timing, cost and source trace | Pure calculation; does not post money or convert a conditional receipt into a settled receipt. |
| `compareOptions` | Versioned comparable offers, usage/needs, horizon and constraints → normalized total costs, benefit differences, savings categories and unresolved eligibility | Same period/currency; deduplicate overlapping benefits; mark incomplete comparisons. No best-choice claim from unknown material costs. |
| `preparePlan` | Referenced evidence/calculations and selected alternative → immutable proposal revision, exact actions, dependencies, changes/risks and expiry | No external mutation. Preserves unresolved conditions and their effect on feasibility. |
| `prepareBatch` | Session-owned inventory revision, selected IDs and constraints → immutable item manifest, per-item effects, exclusions, dependencies and summary | Preparation only. Exclude material unknown costs/ownership/data loss. Approval is a separate trusted bank UI/server operation; the model cannot issue it. |
| `inspectBatch` | Session-owned batch ID and result cursor/filter → paginated child states, verified counts, exceptions and receipts | Bounded read. Counts derive from persisted child states; a parent summary cannot convert pending/unknown into confirmed. |
| `executeApprovedAction` | Exact proposal/action, server approval and idempotency key → attempt/reference with confirmed, pending, refused or unknown outcome | Financial/contractual or external-message mutation requires the exact grant. Version-check, serialize, execute and verify; no arbitrary URL/payload from the model. |
| `verifyAction` | Existing attempt/action reference → authoritative receipt/status, state reconciliation and remaining checks | Read/reconciliation permission; never repeats the financial action. Only ledger posting uses a unique confirmed bank event. |
| `manageWatch` | Add/update/revoke a typed watch, source, trigger, horizon and notification preference → persisted watch and next check | Explicit monitoring permission; no hidden auto-execution. Jobs revalidate current state and honor revocation. |
| `recordReply` | Demo counterparty reply or confirmed user correction, linked source and expected revision → new fact/event revision and affected proposals | Distinguish a promise, partial payment, accepted refund and actual bank credit. Demo controls are clearly labelled and do not impersonate a real counterparty. |

An action result can return a local draft or onboarding packet as `PREPARED`; that is useful completion of a preparation task, not a sent message, submitted application, approved loan or purchased product. The application does not expose real bank/merchant execution adapters in the hackathon build.

## Persistent task and action state

Use separate task, proposal, approval, action-attempt and ledger states. One overloaded `done` flag cannot express a pending cancellation or an uncredited refund.

| Record | Minimum persisted fields |
|---|---|
| Context/goal/preference | Owner and personal/business context, currency, declared goal/reserve, value, source, confirmation status, revision and observation time |
| Evidence/fact | File/URL/catalog reference, relevant location, extracted/confirmed value, observed time, expiry if known, synthetic/live/replay mode, revision |
| Task | Owner/context, kind, `schemaVersion`, current state, `inputRevision`, current proposal, dependencies, next step, event cursor, budget/deadline, worker lease |
| Proposal | ID/revision, input/calculation/terms revisions and hashes, action IDs and dependencies, comparison horizon, costs/benefits, assumptions, expiry and immutable display summary |
| Approval | Actor/context, proposal/action revision and digest, permitted operation/recipient, amount/maximum debit and currency, effect/deadline, terms revision, issued/expiry times, status and execution claim |
| Attempt | Action/proposal reference, adapter mode, idempotency key, approved digest, external correlation ID, started/updated times, outcome, reconciliation state and evidence references |
| Receipt | Unique issuer/receipt ID, action/correlation reference, subject, operation, state/effect date, terms/version, money effect if any, observed/verified time and evidence reference |
| Ledger/forecast | Posted entry IDs with balanced lines and unique source event; separate pending/projection events with their conditions, due dates, sequence and revision |
| Watch/job | Scoped permission, trigger/source, next run, timezone, dedupe key, status, lease/attempt/backoff and last checked revision |

Task lifecycle: `QUEUED → READING → NEEDS_INPUT / COMPARING → PROPOSED → AWAITING_APPROVAL → EXECUTING → VERIFYING → COMPLETED`. It can enter `OUTDATED`, `BLOCKED`, `CANCELLED`, `FAILED` or `OUTCOME_UNKNOWN` as appropriate. `WAITING_EXTERNAL` covers a known accepted request awaiting merchant action. A terminal task remains inspectable; further work is a new revision or linked follow-up.

Proposal lifecycle: `DRAFT → READY → APPROVED / DECLINED / EXPIRED / OUTDATED`. Approval does not imply action completion. Action-attempt lifecycle: `NOT_STARTED → CLAIMED → SENT → PENDING / CONFIRMED / REFUSED / UNKNOWN`; a confirmed external effect may still have bank-projection reconciliation pending. Refund status can be merchant-confirmed while its separate bank credit is still absent.

An input/term change marks affected unexecuted proposals and grants outdated, preserves their history and creates a new revision. Do not re-run every completed action or reverse a confirmed cancellation. The user can cancel future agent work, but stopping the worker does not undo an already accepted merchant request. If an action may already have committed, verify it before permitting a repeat.

## Permission, approval and idempotency semantics

### Three permissions with different effects

1. **Read/use data:** access the selected synthetic banking context, user-selected uploads and permitted merchant sources for this task. Material inferred facts are reviewed before they drive a commitment.
2. **Monitor:** a specific source/condition, schedule, period and notification destination. Revocable. It permits checks and findings, not automatic purchases, plan changes, cancellations or outgoing messages.
3. **Commit:** the exact financial/contractual action or external message displayed now. Applies once to its action identity and approved version. A bundle has an explicit checklist of independently identified actions and dependencies; the user can approve just the trial cancellation.

Local drafts and read-only calculations can be prepared within the task's scope. Sending a prepared message, submitting a claim, changing a plan, reducing seats, moving money or stopping renewal needs the commit grant even when expected to save money. The business role must authorize the affected organization/seat change. A personal approval cannot operate a business record.

### What the approval card binds

Display the operation, merchant/payee/recipient, affected account or subscription, amount/maximum debit and currency where applicable, fees, billing period, loss of benefits/data, effective date, renewal/commitment terms, dependencies, proposal revision and expiration. A zero-immediate-debit cancellation still states access end date and remaining contractual charges. Unknown material terms block executable approval.

The server canonicalizes this `ActionSpec` and creates its digest. Approval is accepted only through the phone's session-protected endpoint; a message saying “approved”, an SDK chat part or the model's tool arguments cannot create a grant. Verify the server record against the current owner, context, action, digest, resource versions, prerequisites, expiry and revocation immediately before execution.

Use a short explicit approval lifetime, for example **ten minutes for this demo**, configurable on the server. It ends earlier if relevant terms expire/change, input facts change, permission is revoked or a prerequisite fails. A changed price within a broad maximum is not silently accepted if the displayed contract/benefits changed; prepare a new version. Monitoring can propose a later action but cannot reuse an expired grant.

### Execute once, reconcile after ambiguity

1. In a transaction, lock/compare the task and resource version, validate the grant and claim the unique action identity. Store the immutable approved payload, attempt and idempotency key before a side effect.
2. Recheck merchant terms and prerequisites. The simulated merchant command also enforces `expectedTermsRevision`/resource version at commit time, including browser form submission.
3. Submit through the approved adapter using a stable correlation/idempotency reference. Merchant commands atomically persist state and receipt under that reference.
4. Read the receipt and merchant state independently; then persist outcome and update the bank projection or ledger under its own unique source-event constraint.
5. Return the existing attempt/receipt for retries. A duplicate key with a different payload is a conflict. If the browser/network fails after a possible commit, mark `UNKNOWN`, look up the action reference, and reconcile. Do not click “confirm” again blindly.

Uniqueness is scoped to session/context and logical action identity; each attempt is also bound to its approved proposal revision. Preserve that identity across retries and revisions that carry the same operation. A genuinely different operation needs a new action identity and approval. Generating a new client request ID or proposal revision does not authorize executing a completed logical action twice. Serialize concurrent attempts for the subject and keep a consumed grant associated with its attempt so recovery can finish verification. Do not advertise universal exactly-once execution; the prototype achieves one effect through atomic simulated-merchant idempotency and safe reconciliation.

## Deterministic money and receipt semantics

- Store RON in **bani**, use bounded safe integers and explicit rounding. Do not run arithmetic in assistant prose or silently coerce an ambiguous locale value. Reject mixed currency without a supplied conversion method/rate/time.
- Maintain balanced postings, unique bank event IDs and separate personal/business ledgers. An internal owner transfer is linked debit/credit, conserved across contexts. Its tax/payroll classification is not inferred.
- A projection is not a posted transaction. Cancellation changes future contractual payments only at its confirmed effective date. History and current funds remain unchanged unless a distinct posted money event occurs.
- Blocking a card payment does not cancel a subscription contract. A cancellation request, pending confirmation and confirmed end of renewal have different outcomes and may leave different future charges.
- A refund request/merchant acceptance is a receivable expectation. Only a unique confirmed simulated bank credit changes spendable funds. Polling a refund twice must not create two credits.
- Keep **paid-plan reduction**, **trial charge avoided**, **conditional estimate** and **credited recovery** separate. Compare the same horizon and include new fees, overlapping periods, lost benefits and post-promotion terms. Do not annualize a one-window opportunity by default.
- An invoice reminder is not cash. A promised payment can adjust a conditional forecast, while bank-confirmed receipt changes the ledger. Partial payment never clears the full invoice.
- Loans create cash and debt; draws are not revenue or profit. Financing in a mock catalog is an assumption to compare, not eligibility, approval or guaranteed funds. Preserve fee/repayment and same-day event ordering.
- Goal readiness uses the supplied target and protected reserve once. Do not count projected avoided spend as cash already saved, transfer it without approval, or merge unrelated scenarios silently.

For the design subscription scenario, assert baseline **242 RON**, fully optimized conditional **89 RON**, potential reduction **153 RON** split into **74 + 79**. After only confirmed FitFlow cancellation, upcoming becomes **163 RON**, posted total remains **110,000 RON**. The [implementation plan](IMPLEMENTATION-PLAN.md#4-numeric-contracts-for-ui-and-tests) specifies the agreed values and conditions. These inputs are now defined in [ui-fixtures.json](ui-fixtures.json), separately from `demo/cases.json`; neither fixture establishes implemented app behavior.

## Accepted feature coverage

All rows are accepted scope. At this document's baseline **none is an implemented app workflow**. The slice column names the earliest implementation family, not a completion claim. **S1–S3** are the hero; **S4** proves the original shared engine; **S5** incrementally completes additional workflows after critical gates pass.

| ID / accepted feature | Inputs and agent behavior | Proof needed to call this feature implemented | Slice |
|---|---|---|---|
| **O1 — Financial goals, purchases, housing, starting/growing a business** | Confirm goal, funds, timing, costs and reserves; compare options and downside. | Phone/home contribution counts are 4/5/4 for agreed choices; missing housing costs produce clarification; business-start fixture calculates setup/reserve/break-even with assumptions. No purchase or loan-approval claim. | S0, S4 |
| **O2 — Inventory and purchases** | Required units, stock on hand, supplier terms, order timing and receipts; derive shortage and cash consequences. | Canonical order needs 800 units costing 24,000 RON; cash minimum is checked. A purchase draft is distinct from an approved synthetic order and a posted payment. | S4 |
| **O3 — Owner/personal income and reserves** | Separate household/business essentials, transfer policy, variable-income stress and protected floors. | Linked owner debit/credit conserves funds; each reserve is evaluated in its own context; no tax/dividend rule is invented. Proposed income is not credited until confirmed. | S4 |
| **O4 — Receivables** | Invoice, due date, previous contacts, reply and actual receipts; prepare exact collection request and replan. | Reminder alone changes no cash. Partial 4,000 RON early reply leaves 8,000 later and changes the relevant minimum to 4,000. A simulated outgoing request needs approval and a send receipt. | S4 |
| **O5 — Financial-product comparison and onboarding preparation** | Need, offered costs/dates, requirements and unknown eligibility; normalize cost and prepare an information/checklist packet. | Compare canonical fictional funding cost and conditions, including day-12 ordering; downloadable packet matches approved inputs. No “eligible”, “approved”, “funded” or actual application claim from a simulation. | S4 |
| **T1 — Screen Time + subscription image analysis** | Actual uploaded images, recurring bank charges and cross-device/family/background use; confirm extracted fields and preferences. | A live extraction is corrected/confirmed; low phone use triggers a relevant question and can change the recommendation. No claim of OS Screen Time access or total use from one screenshot. | S1 |
| **T2 — Trial warnings + approved merchant cancellation** | Trial deadline, conversion price, merchant terms and monitoring preference; warn, propose stop-renewal, execute approved action. | Durable warning; exact grant; real browser interaction with fake FitFlow; independent cancellation receipt/effective date; upcoming 242 → 163 with unchanged balance. Pending/refused behavior also passes. | S2, S3 |
| **T3 — Offer/student/bundle comparison** | Equivalent benefits, eligibility evidence, promo/full-price duration, fees and horizon. | Compute the conditional 89 RON bundle and 39 RON replacement reduction; unknown status stays conditional. Changed term invalidates pending approval and recalculates from new fixture data. | S1, S3 |
| **A1 — Duplicate benefits** | Existing included benefits, caps, devices/users, storage needs and replacement dependencies. | Identify equivalent storage and the 35 RON potential reduction without double counting. If replacement is not active or data migration unsafe, cancellation stays blocked/conditional. | S1, S5 |
| **A2 — Right-size plan** | Actual usage, limits, peaks, essential benefits and cheaper alternatives. | Deterministic capacity/usage comparison; show what is lost. A plan change requires exact approval and merchant confirmation; missing peak/other-device use asks a question. | S5 |
| **A3 — Monthly versus annual** | Full annual charge, monthly rate, expected use horizon, refund/cancellation and auto-renewal terms. | Break-even and dated cash impact are reproducible; annual commitment/reserve effect is visible. No unapproved annual purchase or annualized saving from an assumed twelve months. | S5 |
| **A4 — Price increases** | Prior/current settled bill or explicit notice, plan identity, tax/currency/quantity and terms. | Detect a genuine comparable increase rather than a tax/seat/plan difference; propose alternatives. A watch emits one finding per price revision. No unexplained invented increase cause. | S3, S5 |
| **A5 — Content-based subscription rotation** | Desired content, region, sourced/catalog availability, planned dates and cancellation/renewal constraints. | A dated calendar preserves required access, avoids overlapping savings and labels unverified availability. Every resulting subscribe/cancel action has its own exact grant and receipt. | S5 |
| **A6 — Pauses** | Merchant pause support, access loss, fee, duration and automatic resumption terms. | Confirmed pause receipt and resumption date update future charges correctly. Pause is never mislabeled cancellation; resumption commitments are displayed and approved. | S5 |
| **A7 — Refund tracking** | Return/refund case, accepted amount, expected timeline, merchant status and bank credits. | Expected/overdue tracker; approved follow-up request with receipt if sent. Only matching confirmed bank credit increases funds, once; accepted-but-unpaid remains outstanding. | S5 |
| **A8 — Possible duplicate charge** | Two transaction IDs, posted/pending status, amount/date, merchant references and user purchase confirmation. | Distinguish hold + settlement from two settled purchases; ask when ambiguous. Prepare evidence/approved simulated claim; never delete history or promise recovery. | S5 |
| **A9 — Price-adjustment claims** | Receipt, current comparable price, policy source, purchase window, exclusions and claim terms. | Deterministic policy/window check with provenance; approved synthetic submission gets case reference. Submitted/accepted case is distinct from money credited. Unknown policy blocks eligibility claim. | S5 |
| **A10 — Total ownership cost** | Purchase, consumables, maintenance, required services, horizon and residual-value assumptions if supplied. | Same-period total and dated cash comparison with visible unknowns, not just sticker price. Reuse phone/business calculators without presenting an incomplete cost model as complete. | S4, S5 |
| **A11 — Billing-date alignment** | Income calendar, current/provider-permitted billing dates, fees/proration and next-cycle rules. | Show cash-timing effect separately from cost saving; approve exact change and verify merchant effective cycle. Never move an invoice date merely by editing the bank forecast. | S5 |
| **A12 — Expiring credits and benefits** | Balance, expiry/timezone, restrictions and a purchase already intended by the user. | Match an intended eligible expense, calculate uncovered cost, show expiry; no manufactured saving from unnecessary spending. Redemption/purchase needs approval and receipt. | S3, S5 |
| **A13 — Unused business seats** | Authorized organization, seat roster/activity, invoice period, minimums, data/role impact and owner permission. | Identify candidates without treating a recent inactivity gap as proof. Exact seat list/period/benefit loss approved by responsible user; confirmed seat reduction updates future invoice, not history. | S5 |
| **A14 — Travel cost optimization** | Destination/dates, existing benefits, usage needs, connectivity and supplied/sourced payment/FX/roaming terms. | Comparable all-in period cost and explicit FX/time assumptions; no guessed live rate or benefit eligibility. Chosen synthetic plan/purchase needs grant and verification; no trip booking claim. | S5 |

Discover these through relevant Home findings, detail actions and Agent task starters. A starter can say “Plan this” for a future capability; it cannot show an “Activate” or “Completed” state without the implementing workflow. Personal/business relevance changes the available tools, not the product audience.

### Implementation labels

- **Designed:** requirements and mockups exist.
- **Calculated:** a deterministic computation passes its fixtures; no agent/execution claim follows.
- **Agent-assisted:** a live model selects the implemented tools and handles changed/missing information; external action may still be preparation only.
- **Executed in simulation:** an exact approved command actually changes a simulated merchant/bank record and has independently verified evidence.
- **Monitored:** a persisted due watch actually runs and produces a deduplicated finding while its host is available.
- **Replay/manual input:** explicitly identifies a recorded trace or user-entered fields replacing a live capability.

A feature can combine these labels, such as “Agent-assisted comparison; merchant execution planned.” Mark **implemented** only when that feature's stated input, calculation, permission/action where relevant, persisted outcome and failure behavior have all been demonstrated. A fully implemented preparation-only feature can produce a packet; it still cannot claim execution of a loan or purchase.

## Scheduled monitoring contract

Watch record: user/context, entity/source, condition, timezone, horizon/deadline, next check, permitted notification channel, consent revision and enabled/expiry status. Use a persisted SQLite job queue with a small worker for the local build; no additional hosted scheduler is required. Lease each due job, re-read current permission and terms, then persist a finding/next run atomically. Deduplicate on watch, entity/term revision and trigger threshold. Transient read failures back off; a breached deadline is visible.

Trial checks can run at configurable thresholds, for example two days and one day before conversion. A watch cannot promise timely cancellation after an expired deadline. Cancellation completion disables the relevant warning only after effective terms are reconciled. Refund checks distinguish merchant expected date from confirmed bank credit. Price/credit/seat checks need their own source and consent. Notification delivery is not action execution.

To demonstrate scheduling without waiting a day, advance an isolated **demo clock** and label it visibly. Show that the worker reads a due persisted job and creates exactly one event after a restart. Do not describe a developer button directly inserting a finding as a scheduled check. Background push/SMS/email are optional integrations, not implied by an in-app notification. No external messages are sent outside fake counterparties.

## Error and recovery contract

| Typed result | Required handling |
|---|---|
| `NEEDS_INPUT` / `INCOMPLETE_TERMS` | Ask for the missing material fact or return an incomplete comparison; no zero/default eligibility. |
| `STALE_INPUT` / `TERMS_CHANGED` / `APPROVAL_EXPIRED` | Mark unexecuted proposal/grant outdated, recompute and seek a new exact decision. |
| `DENIED` / `REVOKED` / `NOT_AUTHORIZED` | Do not execute or re-request the same declined operation automatically; offer a different user-initiated path. |
| `PENDING_EXTERNAL` | Show accepted request and next check; preserve charges until terms/effective date justify changing them. |
| `MERCHANT_REFUSED` | Explain the structured reason; no success state or invented alternate cancellation. |
| `OUTCOME_UNKNOWN` | State that the action may have occurred, disable duplicate commitment and reconcile by external action reference. |
| `SOURCE_UNAVAILABLE` / `PROVIDER_UNAVAILABLE` / `RATE_LIMITED` | Bounded retry for safe reads, visible incomplete state; offer labelled catalog/manual/calculator/replay mode where available. |
| `VALIDATION_ERROR` / `CONFLICT` | Reject malformed money/date/context or mismatched idempotency payload; preserve existing state. |
| `BLOCKED_REQUIRES_USER` / `UNSUPPORTED` | Explain authentication/CAPTCHA/application limitations; do not bypass or operate the user's computer. |

Retries never expand permissions. An action timeout has different semantics from a read timeout. Reconciliation is a read/update-of-local-evidence task, not a second cancellation/purchase. The phone always offers a readable status and a return path instead of leaving an unexplained spinner.

## Critical acceptance scenarios

These are required future tests, not tests run by this planning task.

1. **Only the trial:** approve just FitFlow; browser executes one fake-merchant cancellation; independently verified effective date removes 79 RON from the same next-30-day forecast. 242 → 163; 110,000 RON and posted history remain unchanged. Bundle/storage actions remain unexecuted.
2. **Pending and refused:** merchant returns each state. The UI never shows confirmed cancellation; eligible charges remain until authoritative terms/effect justify removal. Blocking a simulated card does not alter subscription status.
3. **Changed contract:** approve a bundle proposal, then change its price/eligibility/end date before mutation. Both task policy and merchant version check reject the old payload; a new proposal is required. Prior confirmed FitFlow cancellation remains intact.
4. **Double tap and network loss:** two concurrent approvals/retries create one action effect and receipt. Lose the response after merchant commit; restart and reconcile the existing action, without a duplicate click/credit.
5. **Forged/expired approval:** fabricated chat approval, modified amount/recipient/context, expired grant and revoked consent all fail before a side effect. Denial does not produce repeated identical requests.
6. **Refund accounting:** accepted refund leaves balance unchanged; one confirmed bank-credit event increases it; replaying that event does not increase it again. A refund screenshot cannot post money.
7. **Evidence correction:** alter an extracted price/date; create a new revision and recompute. Include malicious instructions in a fake invoice/page; they cannot grant permission, change destination or trigger code execution.
8. **Savings categories:** all proposed changes compute 153 = 74 + 79 in one window, with overlap/activation conditions. Only trial execution yields 163 upcoming. No recovered-cash label or automatic ×12 total appears.
9. **Goal consistency:** account split sums to 110,000, target to 130,000; contributions are 4/5/4. A comparison does not post a debit, and a conditional subscription opportunity does not move funds to savings.
10. **Business conditions:** use canonical order fixtures, partial invoice reply, separate owner-transfer postings and same-day settlement ordering. Requesting an advance does not confirm it; mock financing remains unapproved.
11. **Scheduler and isolation:** restart around a due watch and run two workers; one finding appears. Revoke watch consent before the job; no later check/notification occurs. Another session cannot read task/files/receipts or use the approval.
12. **Phone recovery:** leave/reopen the task sheet, refresh and interrupt the event stream during execution. The final state comes from the persisted task/receipt, with readable approval/evidence and no automatic repeat commitment.

For every claimed feature, retain sanitized evidence linked to the actual build: relevant input/term revisions, model-selected tool events, calculation trace, approval digest, attempt/receipt and resulting bank/merchant state. Screenshots supplement these records. Do not expose secrets, real credentials, full raw uploads or hidden reasoning. The delivered video and deck must describe the demonstrated level precisely.
