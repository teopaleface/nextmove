# NextMove mobile design system

Version 2.0, 28 October 2026. Design specification for the fictional banking application and its financial agent. Client interface is a phone, with English copy. The [interactive mobile reference](mobile-preview.html) is the current visual source for the refined screens. It simulates interface state; it does not connect to AI, banking or merchant services.

### Revision direction

Applied the locally installed `frontend-design`, `apple-design` and `emil-design-eng` skills. The design question was how to make a broad financial agent feel like a trusted phone bank. Keep the existing Raiffeisen-inspired yellow, the bank's financial hierarchy and the accepted product scope. Spend the strongest visual emphasis on the next useful action. Use native phone typography, aligned amounts, flat financial lists and one distinctive opportunity surface. Remove the row of pastel status pills and interchangeable card treatments.

Review against the brief: a generic assistant dashboard would overemphasize the agent and fragment the bank into cards. The revision keeps money together, places contextual agent work beside it and uses a persistent four-tab bank shell. It adds no new product capabilities. Earlier ImageGen boards remain composition references; the v2 HTML, component rules and canonical data take precedence when they differ.

## 1. Visual direction

Borrow the clear money hierarchy, warm neutral canvas, white account cards and selective yellow actions seen in official Raiffeisen Smart Mobile screenshots. Use Smart Business as a reference for compact label/value groups and explicit account context. [Reference evidence and source assets](references/raiffeisen-references.md).

NextMove has its own identity: a simple wordmark, a small geometric N mark and a capable agent within a familiar bank. Use no official Raiffeisen mark or partnership claim. The colors and font below are proposed NextMove tokens, not an extracted official Raiffeisen specification.

The result should feel calm, precise and useful. Banking information leads; the agent's opportunities sit naturally beside accounts, payments and goals. Avoid purple gradients, glass panels, decorative 3D money, giant glowing AI orbs, dense desktop dashboards and oversized marketing headlines inside the phone.

Default theme is light. A secondary dark theme can follow the same semantic tokens after the light experience is implemented; it is not required for the first visual set.

## 2. Phone layout

- Reference viewport: 390 × 844 CSS px; verify 360–430px widths and text enlargement.
- Page padding 20px; 16px in compact detail groups; 16–24px vertical space between sections.
- Respect device top/bottom safe areas. Header content 56px, tab content 64px plus the actual bottom inset.
- Minimum target 44 × 44px; ordinary buttons 52px and main confirmation buttons 56px high.
- Scroll content vertically. A four-item bottom navigation stays stable: **Home, Activity, Goals, Agent**.
- Cards and payments are reached from Home/account details and Activity; they do not require extra root tabs.
- Full-screen forms and approval sheets can temporarily replace the tab bar. Their fixed action area includes enough content inset and moves above the keyboard.
- The agent browser opens inside a task sheet and can expand to full screen. Its viewport is zoomable; narrow-screen screenshots remain evidence, not tiny desktop controls that the customer must operate blindly.

## 3. Color tokens

Machine-readable source: [tokens.json](tokens.json).

- Canvas `#F7F7F2`; primary surface `#FFFFFF`; subtle surface `#F0F0EB`.
- Text/ink `#151515`; secondary text `#60605A`; borders `#E4E5DF`.
- Brand/action yellow `#FEE600`; pressed yellow `#E6D000`; action text `#151515`.
- Success `#067647`, warning `#854D0E`, danger `#B42318`, information `#175CD3`. Tinted surface tokens remain available for an exceptional callout; ordinary task states have no colored background.
- Inverse surface uses ink with white text. Brand yellow marks primary actions and a small agent signature. It does not decorate passive status labels.

Use yellow for primary actions and selected emphasis. Yellow alone does not communicate text, chart meaning or a state. Pair state color with an icon and explicit words. Ordinary input/card borders are visual grouping; interactive outlines and focus use ink so the weak border is not the only affordance.

## 4. Typography and numerals

Use the native/system phone family: `-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif`. This is a deliberate mobile choice, not a claim about Raiffeisen's font. Use tabular numerals for balances, prices and comparisons. English formatting in the UI: `110,000.00 RON`; shortened summary `153 RON` when precision is unnecessary. A smaller currency suffix can support a balance; keep full currency labels in approvals and source details.

- Balance 36/42, weight 650.
- Screen title 28/34, weight 650.
- Detail heading 22/28, weight 650.
- Section title 18/24, weight 600.
- Body 16/24, weight 400.
- Labels/buttons 14/20, weight 600.
- Captions and small navigation text 12/16, weight 500; never shrink consequential terms below this to fit a card.

Allow wrapping and dynamic height. Keep long merchant names, negative values, large amounts and translated future copy from colliding with the amount column. Provide full values in details rather than truncating financial information.

## 5. Shape, icons and motion

Spacing is based on 4px: 4, 8, 12, 16, 20, 24, 32, 40 and 48. Financial row groups use 16px radius; the main opportunity surface uses 20px; controls 12px; small containers 8px; sheets 24px top corners. Passive task states have no container, padding or corner radius. Pill shapes are reserved for actual choice controls where appropriate. Borders are 1px. Financial groups are flat; reserve restrained shadow for sheets and the preview's device frame.

Use a single family of 24px outline icons with consistent optical weight. Icons support labels; important actions keep visible text. Merchant marks are fictional initials or simple flat geometric shapes. The N wordmark mark is independent of Raiffeisen's crossed-hammer identity.

Press feedback uses a subtle 0.98 scale over 140ms with `cubic-bezier(0.23, 1, 0.32, 1)`. Frequent navigation and keyboard actions are immediate. Gate hover effects behind pointer/hover support. Reduced motion removes transforms. Task steps change only with their real state. Show a named stage for an unknown duration; no fabricated progress percentage or looping decoration. Success uses a restrained check and readable receipt.

### Task state anatomy

Use a 14px outline icon, 5px gap and a 12/18px medium-weight label beside the task it describes. These labels are not buttons and do not inherit the 44px interactive target. Their parent action or row does.

| State | Treatment | Context and action |
| --- | --- | --- |
| Confirmed by FitFlow | Small green check; ordinary dark/secondary text | Link to the receipt and date. |
| Awaiting FitFlow | Neutral clock and text | Keep the renewal in the forecast until confirmation. |
| Needs another review | Amber warning icon; neutral explanatory text | Show the changed benefit and a specific review action. Changed terms alone are not a red error. |
| Draft prepared | Neutral document icon and text | State that nothing has been sent or purchased. |
| Demo | Quiet header metadata, without an icon or pill | Separate the environment label from task outcomes. |

Use red for an actual failure or blocked/error condition. Do not arrange unrelated statuses in a colorful strip in product screens. The component reference shows contextual rows so their meaning can be inspected.

## 6. Core component inventory

### Banking and discovery

**App header.** Small NextMove wordmark, profile/context selector and notifications. A quiet `Demo` tag establishes the fictional environment. Personal/business context is explicit before switching financial data.

**Balance block.** Strong amount with a smaller currency suffix; two aligned account columns on the shared canvas. Account breakdown stays visible. A balance-visibility toggle can live beside its label in implementation. Use a black demo debit card only in account/card detail, not as a decorative replacement for account data.

**Quick action.** Icon container with a 44px target and label: `Send`, `Request`, `Cards`. One yellow primary shortcut; secondary shortcuts stay neutral.

**Transaction row.** Fictional merchant mark, merchant/date or category, amount aligned right and pending/settled state where relevant. Credits and reversals have words as well as color. A pending authorization is distinct from a second settled debit.

**Opportunity card.** One white surface, small geometric agent signature, narrow yellow edge and one primary action. Example: `153 RON could stay with you.` with `3 options for your next 30 days of subscriptions` and `Review my options`. This is conditional avoidance of future charges, not cash credited to the account. Other findings use plain rows below it.

**Subscription row.** Merchant, plan, amount/period and next date. Distinguish `Active`, `Trial`, `Renewal off`, `Cancellation pending` and `Cancelled`. Paid subscriptions total and future trial conversions are separate.

### Agent work

**Goal composer.** One natural-language field with attachment button, suggestions and a clear send target. Allow text or image input without forcing a long chat. A task can also begin from a finding or bank event.

**Upload and extraction review.** Show the uploaded thumbnail/file, observed fields, evidence period and editable values. For Screen Time, show `Phone only` and ask about other devices. Do not convert one week of phone usage into a definitive monthly value judgment.

**Preference chips.** User-declared constraints such as `Keep offline playback`, `Protect my reserve`, `Use on TV`. Selected chips have words and a checked state. Changing a constraint invalidates dependent unexecuted proposals.

**Comparison card.** Same period and same relevant benefits across options. Show current total, proposed total, difference, eligibility/expiry and a visible `Why this fits` disclosure. A cheaper option missing a required benefit is marked incompatible, not recommended.

**Approval sheet.** Exact action, merchant, price/cost, date, effect on access, important conditions and resulting state. Main CTA names the action, e.g. `Confirm cancellation`; alternative `Keep trial`. Cancel/close does not grant consent. A bundle that adds a paid commitment has its own review.

**Agent task card.** Concise stages: `Checking`, `Needs your input`, `Ready to review`, `Waiting for confirmation`, `Completed`, `Could not finish`. Show elapsed activity and a stop control. Stopping the agent does not undo an already executed action.

**Browser evidence.** Merchant, page title, viewport thumbnail, current step, `Open live view`, `Pause` and `Take over`. On takeover the agent pauses. A login or challenge can request user action. Product UI says what is happening; internal API names and raw model/tool payloads stay in an optional developer view.

**Receipt.** Merchant confirmation, reference, effective date, access-until date, future charge effect and a link to the evidence. `79 RON charge avoided` after trial cancellation does not alter today's balance. A requested refund uses pending language until credit appears.

### Planning and business

**Goal card.** Current planning amount, target, progress, scope of money and next useful action. A planning goal is not an additional account. Avoid counting the same reserve and savings twice.

**Decision simulator.** Two or three alternatives, editable inputs, commitments affected, projected timing and explicit assumptions. A compact chart has labels and a text result. Rounding and calculation details are inspectable.

**Business context.** Persistent company name, account and actor. Inventory quantities, receivables and planned owner transfers are grouped, with dates beside amounts. Household and business balances remain separate.

**Refund/claim timeline.** Requested, accepted, pending and credited are distinct states, with dates and a next action. A claim or merchant promise is not a bank credit.

## 7. One canonical visual dataset

[ui-fixtures.json](ui-fixtures.json) is the single source for the generated screen numbers.

- Alex has total liquid cash 110,000 RON: Daily 12,480 and Savings 97,520.
- Home readiness target is 130,000 RON, including reserve. Four monthly contributions of 6,000 cover the current gap; a 6,000 phone moves this to five. It is a planning model, not mortgage approval.
- Current paid subscriptions: StudyPlus79 + Streamly49 + CloudBox35 = 163 RON/month. FitFlow is currently a free trial, with a 79 RON conversion due 30 October.
- Next-30-day baseline, with aligned billing dates assumed, is 242 RON.
- Proposed student bundle89 replaces StudyPlus+Streamly128: 39 RON reduction. Removing duplicate CloudBox contributes35. Avoiding the trial charge contributes79. Total potential reduction153; modeled optimized charges89.
- After **only** FitFlow cancellation, next-30-day charges are163 and the bank balance stays110,000. Confirmation reference `NF-1047`; access lasts until30October.
- If the bundle loses required offline playback, invalidate the unexecuted proposal and recompare. The completed FitFlow cancellation stays completed.

All merchants/terms are fictional. Future charges avoided, existing recurring reduction and refunded money remain separate. Do not annualize the 153 RON or promise all actions completed from a single cancellation.

The existing [financial fixtures](../demo/cases.json) remain authoritative for their business/home arithmetic. These design fixtures add the subscription story, not a replacement accounting engine.

## 8. Screen/state scope

The detailed map and feature coverage live in [MOBILE-UX.md](MOBILE-UX.md). The generated boards should cover the banking shell, active subscriptions, agent entry and evidence intake, comparison, exact approval, live task, confirmed result, goal/purchase planning and business/refund context. No feature gets its own root tab merely because it exists.

Include both positive and interrupted states: empty, loading, extraction uncertain, permission required, stale offer, incompatible benefit, merchant pending/refused, browser timeout, offline, takeover and completion. A component state specification is part of the full design even where no separate generated raster screen is necessary.

## 9. Accessibility and phone behavior

Text should reach at least 4.5:1 contrast for ordinary text and 3:1 for qualifying large text. Controls and focus require visible boundaries; muted separators alone do not suffice. Verify chosen token combinations numerically and inspect them at phone size.

Keep action targets at least44px, legible12px minimum captions and16px body. Interactive rows have semantic labels; screen readers get action, merchant, amount, date and state. Charts have text summaries. Do not rely on red/green alone.

Keep a review summary visible above a consequential CTA. The user can return to the full conditions. Keyboard focus, error messages and a bottom action bar must not hide required fields. Expanded font sizes may scroll; they should not trigger smaller text or clipped amounts.

## 10. Delivery and implementation handoff

- `tokens.json`: proposed design values.
- `ui-fixtures.json`: canonical fictional screen data.
- `MOBILE-UX.md`: routes, flow coverage, copy and states.
- `IMPLEMENTATION-PLAN.md` and `AGENT-CAPABILITIES.md`: build sequence and actual agent/browser architecture.
- `IMAGE-PROMPTS.md` and `mockups/`: generated visual boards and exact prompts.
- `design-system.html`: local visual reference for colors, type and components.
- `mobile-preview.html`: 16 interactive native HTML views plus the approval sheet. Demo replies are controls outside the app; no external action runs.

ImageGen boards establish art direction and screen composition. Exact copy, amounts, accessibility and state semantics come from these specifications. A raster mockup is not an editable production screen or a tested browser automation. Implementation must keep those distinctions visible in evidence supplied to the jury.


## Forecast calendar alignment

The canonical subscription forecast runs from 28 October 2026 09:41 to 27 November 2026 09:41 Europe/Bucharest, end-exclusive. The three paid-plan transactions shown in Activity are historical 26 October charges, with their next renewals on 26 November. The fictional replacement bundle activates and bills 89 RON on 26 November 08:00 before those renewals; stopping old renewals preserves already-paid access and prevents their next charges. FitFlow would convert on 30 October 09:00. No extra immediate bundle charge, proration, refund or overlap fee is assumed. Those explicit demo terms produce 242 RON baseline, 89 RON conditional optimized charges and 163 RON after only FitFlow cancellation. A different effective/activation date must be recalculated.

## 11. Components for safe batches and agent access

This revision adds the S25–S28 behaviors in [MOBILE-UX.md](MOBILE-UX.md#11-bank-partner-revision-bulk-review-permissions-and-exceptions), under [SECURITY-AND-SCALE.md](SECURITY-AND-SCALE.md). Keep the existing colors, type, four tabs and 44px minimum targets. No new raster boards were generated for this revision.

**Batch review group.** A labelled count, brief common consequence, explicit select/exclude control and expandable item list. Disabled groups state the missing information or authority. Different fees, contract terms or lost benefits remain inspectable per row.

**Batch approval summary.** Number and exact selected set, operation, cost limit, access dates, dependencies and start-permission expiry. A sticky CTA names the count/action; consequential details remain above it at readable sizes. Provide navigation to the whole list. Review selection never silently grants execution permission.

**Result counts.** Text-labelled confirmed, pending, needs input, changed and unknown states. Use semantic colors with words and icons. In the independent 200-item fixture, 100 confirmed does not become a completed lot. Counts and the financial result come from the same authoritative item set.

**Permission card.** Source/account, read versus monitor versus exact execution authority, scope, expiry, last checked time and revocation control. Permissions are separate from marketing consent, privacy choices and a data-deletion request.

**Exception panel.** One concrete problem, the original approved operation, the facts now known and the next safe action. Do not put a generic `Try again` button on a possibly committed action. Stop copy explains that already-started requests can still finish; a reversal is not implied.

The numerical stress scenario is separate from the 242 → 163 RON UI dataset. Its 2,824 RON avoided future charges are a designed fixture result, with no cash credited. A mockup or interactive design illustration does not prove secure approval or merchant execution.
