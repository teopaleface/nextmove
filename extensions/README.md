# NextMove extensions

Ten features, written as pure TypeScript domain modules that the app can call. They are not wired into the app yet. None of them reads the clock, the database or the network. Each takes plain data plus `now` and returns a decision, a new state, and a list of **effects** for the app's durable worker to run. Every external effect follows ADR 0003 (persist the attempt, then dispatch, then reconcile an unknown outcome before any retry). Every money or merchant change carries an exact `ApprovalGrant` bound to a manifest digest. The model never approves anything.

The modules import nothing from the app, and the app imports nothing from them. Each one adds something the app does not already do. Where an app capability is close, its section says how the two differ.

```bash
cd extensions
npm ci
npm run check        # tsc --noEmit + node --test (304 tests)
```

Needs Node ≥ 24.8, which runs `.ts` natively, and has no runtime dependencies. `node:sqlite` prints an ExperimentalWarning during `schema.test.ts`. That warning is expected.

## Layout

| Path | What |
| --- | --- |
| `src/shared/` | Money in integer minor units (overflow-guarded, BigInt basis points). Bucharest-day time helpers. Canonical JSON, digests and HMAC. `checkGrant`. `MerchantReceipt` / `endingInForce`. |
| `src/cancellation-guarantee/` | 1. Auto-dispute of charges taken after a confirmed cancellation |
| `src/exit-plan/` | 2. "Cancel if I use it fewer than N times" rule agreed at sign-up |
| `src/retention-offers/` | 3. Signed, rate-limited merchant save offers compared by the bank |
| `src/merchant-insights/` | 4. k-anonymous merchant track record and price-rise radar; 10. measured cancellation difficulty (`difficulty.ts`) |
| `src/price-consent-gate/` | 5. Decline merchant-initiated charges above the price the customer approved |
| `src/card-reissue/` | 6. Choose which merchants follow the customer to a reissued card |
| `src/business-move/` | 7. Move a subscription from personal to business, with repayment and a VAT note |
| `src/cancellation-certificate/` | 8. Signed, selectively disclosable proof that a subscription ended |
| `src/shared-split/` | 9. Split a shared subscription between members by mandate or payment request |
| `schema.sql` | `ext_*` STRICT tables whose unique and check constraints back every idempotency rule |
| `test/` | One file per module, plus `schema.test.ts` (runs the schema on real SQLite) |

Import from a module's `index.ts`, e.g. `import { decideAuthorization } from '…/extensions/src/price-consent-gate/index.ts'`.

## Conventions the app must keep

- **Money** is integer minor units (bani) plus an ISO currency. Helpers throw `DomainError` with a stable `code` (`INVALID_AMOUNT`, `CURRENCY_MISMATCH`, …). Map `code` to the user-facing copy. Never show `message`.
- **Instants** must carry an offset (`2026-10-28T09:45:00+02:00`). **Dates** are `YYYY-MM-DD` Bucharest days.
- **Scope** is `{ ownerId, contextId }` with `contextId` `'PERSONAL'` or `'BUSINESS'`. Every rule, receipt and account is checked against it, so personal and business can never mix. Module 7 is the one deliberate crossing, and it needs a grant from each side.
- **Grants**: build the manifest, show it, have the customer approve, and store an `ApprovalGrant { manifestDigest, issuedAt, expiresAt }`. `checkGrant` refuses wrong owner or context, digest mismatch, revoked, not-yet-valid and expired grants (the expiry boundary is exclusive).
- **Receipts**: only `verification: 'INDEPENDENT_READ_BACK'` counts as proof. `MERCHANT_MESSAGE_ONLY` yields `WEAK_PROOF` / `NEEDS_REVIEW` instead of money moving.
- **Effects are instructions, not side effects.** Persist the returned state and its effects in one transaction, then let the worker execute each effect by its idempotency key.

## Module guide

### 1. Cancellation guarantee

`assessPostCancellationCharge` → `prepareDisputePacket` → `openDispute` → `approveDispute(grant)` → `markSubmitted` → `recordBankCredit` / `recordNetworkDecision` / `recordMerchantRefund`; `expireIfLate` from a daily job.

- **Trigger**: every posted card charge at a merchant where the customer has a cancellation receipt.
- **Outcomes**: `NOT_APPLICABLE` (reversed, zero, no confirmed cancellation, other merchant, authorised before the cancellation), `ALREADY_HANDLED`, `WAIT` (still pending, recheck in 24 h), `NEEDS_REVIEW` (ambiguous subscription, unknown or overlapping service period, not recurring, weak proof, window expired, credit currency mismatch), or `ELIGIBLE` with `disputableMinor` net of refunds and a deadline.
- **Effects**: `SUBMIT_TO_NETWORK`, `POST_CREDIT` / `REVERSE_CREDIT` (the only money movers, each keyed by a unique bank event id), `WITHDRAW_DISPUTE`, `FLAG_DOUBLE_RECOVERY`, `NOTIFY_CUSTOMER`.
- **Persist**: `ext_dispute_case` and `ext_dispute_event`. Event ids already applied are ignored, a FINAL credit posts only the difference over the provisional one, and the bank never credits beyond the disputed amount (enforced in code and by a CHECK).

### 2. Exit plan

The app's A17 ("Paid but probably unused") finds a forgotten subscription after the fact. An exit plan is the rule the customer agrees at sign-up, so the stop happens on the agreed date without the customer having to notice anything.

`createExitPlan(terms, now)` → `activateExitPlan(grant)`; on `evaluateOn` call `runExitPlan(plan, snapshot, evidence, now)`; `answerExitQuestion` for the ASK path; `recordStopOutcome(receipt)`.

- **Outcomes, in priority order**: `INACTIVE`. `VOID` (subscription mismatch, already ended, terms or currency changed, price above ceiling). Each VOID means the mandate is gone and the customer is asked again. `MISSED_DEADLINE`, `TOO_EARLY`, `KEEP`, `ASK` (no evidence, or only single-device evidence), `STOP`.
- **Effect**: `REQUEST_STOP_RENEWAL` with key `exit:<ruleId>:<termsRevision>`. Hand it to the app's normal stop-renewal action (`PARTNER_API` or browser route, whichever the merchant supports).
- **Usage evidence** counts only data the customer chose to share. Counts are summed within a source and maxed across sources, so device and merchant counts are never double-counted.
- **Persist**: `ext_exit_plan`, which allows one live plan per subscription.

### 3. Retention offers

`verifyOffer(signed, ctx)` → `compareOffer(offer, current, horizonMonths)` → optional `prepareCounter` → `offerWindow` → `acceptOffer(verified, grant, ctx)`.

- **Rejections**: unknown, retired or wrong-merchant key, bad signature, merchant not verified or offers not enabled, not this customer's subscription, invalid terms, issued in the future, expired, validity too long, rate-limited (1 unsolicited offer per 30 days). Replies to the customer's own counter are exempt from the rate limit.
- The merchant message is **untrusted data**. Show it quoted, and use `MESSAGE_LOOKS_LIKE_INSTRUCTIONS` / `MESSAGE_CONTAINS_LINK` to warn. Never feed it to the agent as instructions.
- **An offer never pauses an approved cancellation** (`cancellationContinues: true`). Accepting while the cancellation is still only APPROVED emits `WITHDRAW_CANCELLATION` and then `ACCEPT_OFFER`. Once the cancellation is in flight, acceptance is refused.
- **Persist**: `ext_retention_offer` (as received, signature included), `ext_offer_counter`, `ext_offer_acceptance`. Only one revision of an offer can ever be accepted.

### 4. Merchant insights

A batch job that is not customer-triggered: `merchantTrackRecords(observations, now)`, `detectPriceChanges(charges, now)`, then per customer `priceAlertsFor(subscriptions, clusters, now)`.

- Inputs use a **pseudonymous, per-run `customerKey`** (a salted hash). Outputs never contain one. Groups with fewer than k = 20 distinct customers return `INSUFFICIENT_DATA` and no numbers.
- A merchant is `FLAGGED` only when the Wilson 95% lower bound of its billed-after-cancellation rate is ≥ 2%, so one unlucky customer can't flag a merchant. Only verified, matured (≥35 days), in-window (180 days) cancellations count.
- Price radar keeps plans and currencies separate. It ignores one-offs, zero amounts, gaps over 45 days and future-dated charges. Alerts go only to customers who still pay the old price and whose next charge falls within 14 days.
- **Persist**: `ext_merchant_track_record`, `ext_price_change_cluster`. These are aggregates only, and the schema has no customer column.

### 5. Price-rise consent gate

This extends the app's T4 Trial Shield. T4 holds the *first* charge after a free trial. This gate covers every later renewal that comes in above the price the customer approved. The app's A4 ("Price went up") explains a rise after it has been paid, and this gate stops the charge before it is paid.

`createPriceCeiling(terms)` → `activatePriceCeiling(grant)`. On every card authorisation call `decideAuthorization(ceilings, request, history, now)`. When the customer answers a notice, call `answerPriceRise(ceiling, rise, { kind: 'ACCEPT', grant } | { kind: 'REJECT' }, now)`. The ACCEPT grant is bound to `priceRiseManifest(...)`.

- Only **merchant-initiated** charges are gated. A customer-present charge is always `CUSTOMER_PRESENT`. The gate compares the merchant's price in the transaction currency, so card-side FX never trips it. Incremental authorisations are judged on the running total. When several ceilings cover the merchant, the tightest one wins.
- **Declines**: `ABOVE_CEILING`, `CURRENCY_CHANGED`, `RISE_REJECTED`. A retry storm produces one `NOTIFY_PRICE_RISE` per `riseKey`. After `maxSoftDeclines` (3), the advice turns from `RETRY_LATER` to `DO_NOT_RETRY`. A rejection also emits `SUGGEST_STOP_RENEWAL`.
- The gate runs inside the authorisation path, so it must stay a pure, fast lookup. Load the customer's live ceilings and the decline count for the rise key, and nothing else.
- **Persist**: `ext_price_ceiling` (one live ceiling per subscription), `ext_price_rise_notice` (one per rise key), `ext_price_gate_decline` (the soft-decline budget survives restarts).

### 6. Card reissue filter

`planReissue({ scope, oldCardId, newCardId, reason, cardsOnFile, receipts, answers, now })` → show `questionsFor(...)` → `approveReissuePlan(plan, grant, now)`. When a merchant or network asks for the new card, answer with `answerUpdaterInquiry(plan, merchantId, ...)`.

- **Defaults**: every subscription at the merchant verifiably cancelled → `DROP`. Any live one → `KEEP`. Unknown purpose → `KEEP` after `EXPIRY` / `CUSTOMER_REQUEST`, `DROP` after `LOST` / `STOLEN` / `COMPROMISED`. Mixed live and cancelled → a question. Receipts match across a brand's merchant IDs (`brandMerchantIds`).
- **Warnings**: `KEEPING_CANCELLED_MERCHANT`, `MANUAL_UPDATE_NEEDED` (the merchant doesn't use the updater).
- **Effects**: `ALLOW_UPDATER`, `BLOCK_UPDATER`, `SUSPEND_TOKEN` (network tokens follow the account, not the card number, so a dropped merchant's token must be suspended too), `TELL_CUSTOMER_TO_UPDATE`.
- A merchant that asks for the new card after a confirmed cancellation gets `WITHHOLD` with signal `REQUEST_AFTER_CANCELLATION`. Feed that signal to module 1 as evidence.
- **Persist**: `ext_reissue_plan` (one approved filter per old card), `ext_reissue_decision`, `ext_updater_inquiry`.

### 7. Personal → business move

`normalizeCui(input)` to validate the company's CUI (check digit, optional `RO` prefix) → `planBusinessMove({ ..., ruleSet: ruleSetFor(date) })` → `approveBusinessMove(plan, personalGrant, businessGrant, ...)`.

- **Repayment**: the business repays the personal account its share (`businessUseBp`, floored) of each past charge as balanced postings, keyed `bizmove:<subscription>:<charge>`. Charges are excluded with a reason: `UNKNOWN_CHARGE`, `NOT_THIS_SUBSCRIPTION`, `OTHER_ACCOUNT`, `REFUNDED`, `ALREADY_REPAID`, `FUTURE_DATED`, `CURRENCY_MISMATCH`, `ZERO_SHARE`.
- **Future billing**: `UPDATE_BILLING_PROFILE` (the merchant supports it), `MANUAL_STEPS`, or `NOT_MOVABLE_APP_STORE`.
- **VAT note**: always carries `INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE`. The rule set is dated and versioned. The case is one of `DOMESTIC_SUPPLY`, `EU_B2B_REVERSE_CHARGE_CANDIDATE`, `EU_SUPPLY_BUYER_NOT_VAT_REGISTERED`, `NON_EU_SUPPLY`, `NO_MERCHANT_INVOICE`, `NO_RULES_FOR_DATE`. Flags: `NO_INVOICE_ON_FILE`, `INVOICE_ISSUED_TO_PERSONAL_NAME`, `PARTIAL_BUSINESS_USE`. Show it as information for the accountant and never as advice.
- **Approval** needs two different grants, one from the personal scope and one from the business scope. Refusals: `PERSONAL_GRANT_INVALID`, `BUSINESS_GRANT_INVALID`, `SAME_GRANT_TWICE`, `INSUFFICIENT_FUNDS`.
- **Effects**: `UPDATE_BILLING_PROFILE`, `SHOW_MANUAL_STEPS`, `POST_TRANSFER`, `FILE_VAT_NOTE`.
- **Persist**: `ext_business_move`, `ext_business_repayment` (unique per subscription and charge, whichever plan repaid it), `ext_vat_rule_set`.

### 8. Cancellation certificate

`issueCertificate({ scope, subscriptionId, receipts, merchantName, key, validityDays, now })` → the customer chooses what to show with `present(compact, claims)` → anyone checks it with `verifyCertificate(compact, { trustedKeys, revocationList, now })`. A daily job runs `certificatesToRevoke(records, receipts, now)` and `signRevocationList(...)`.

- The signature is Ed25519 (`node:crypto`). Wire format: `NMC1.<payload>.<signature>~<disclosure>…`. Disclosure follows the SD-JWT pattern: salted claim digests are signed and the customer reveals any subset of `merchant`, `subscriptionRef` and `effectiveDate`. The certificate carries no amounts, account IDs or customer IDs.
- **Issuing** needs an `INDEPENDENT_READ_BACK` ending still in force. Otherwise it refuses with `WEAK_PROOF` or `NO_CONFIRMED_ENDING`.
- **Verification** refuses `MALFORMED`, `UNSUPPORTED_VERSION`, `UNKNOWN_KEY`, `KEY_COMPROMISED`, `ISSUER_MISMATCH`, `BAD_SIGNATURE`, `NOT_YET_VALID`, `EXPIRED`, `DISCLOSURE_MISMATCH`, `DUPLICATE_DISCLOSURE`, `REVOCATION_LIST_INVALID`, `REVOCATION_LIST_STALE`, `REVOKED`. A retired key still verifies what it signed.
- A reactivation, or a newer ending, revokes the old certificate.
- **Persist**: `ext_certificate_key` (public key in full, private key by `env:` / `keystore:` reference only, one active key per issuer), `ext_certificate` (no claim values), `ext_revocation_list`.

### 9. Shared subscription split

The organizer pays the merchant. Each member calls `createMandate(group, memberId, maxShareMinor)` → `activateMandate(mandate, grant)`, and the grant must come from that member's own personal scope. Each billing cycle, `planCycle({ group, cycle, mandates, now })`. A daily job calls `assessCollections(requests, now)`.

- Shares are weight × active days, split with largest-remainder rounding (`splitByWeight`), so the parts always add up to the bill.
- **Effects**: `DEBIT_MEMBER` only with an active mandate whose cap covers the share. Otherwise `SEND_PAYMENT_REQUEST` (why: `NO_MANDATE`, `ABOVE_MANDATE`, `NOT_A_BANK_CUSTOMER`). A share above the cap also emits `ASK_PRICE_CONSENT`. The request key is `split:<group>:<cycle>:<member>`.
- Collections only remind (`SEND_REMINDER`, once) and suggest (`SUGGEST_REMOVE_MEMBER`). They never debit without a mandate and never move a shortfall onto other members.
- **Persist**: `ext_split_group`, `ext_split_member`, `ext_split_mandate` (one active per member), `ext_split_request` (unique per group, cycle and member; a debit always names a mandate).

### 10. Cancellation difficulty

A batch job alongside module 4: `cancellationDifficulty(runs, now)`.

- Measured from the bank's own **browser-adapter** runs. Partner-API and manual cancellations bypass the merchant's flow and are excluded. Only the merchant's latest `flowRevision` counts, so a fixed flow starts clean.
- Each customer contributes one run, their latest verified confirmation, so a heavy user cannot skew the medians. Runs outside 180 days, in the future, or longer than an hour (abandoned sessions) are dropped. Fewer than k = 20 customers gives `INSUFFICIENT_DATA`.
- **Output**: grade `EASY` / `MODERATE` / `HARD`, nearest-rank median and p90 steps, median retention screens and seconds, how often human contact was demanded, and the completion rate.
- **Persist**: `ext_cancellation_difficulty`. These are aggregates only, with no customer column.

## Plug-in checklist

1. Run `schema.sql` in the app's migration step. Tables are `ext_`-prefixed, `CREATE … IF NOT EXISTS`.
2. Map the app's transaction, receipt and account rows onto the input types: `CardTransaction`, `MerchantCredit`, `MerchantReceipt`, `AccountView`, `SubscriptionSnapshot`, etc.
3. Register effect handlers in the durable worker: `SUBMIT_TO_NETWORK`, `POST_CREDIT`, `REVERSE_CREDIT`, `WITHDRAW_DISPUTE`, `REQUEST_STOP_RENEWAL`, `WITHDRAW_CANCELLATION`, `ACCEPT_OFFER`, `NOTIFY_PRICE_RISE`, `SUGGEST_STOP_RENEWAL`, `ALLOW_UPDATER` / `BLOCK_UPDATER` / `SUSPEND_TOKEN` / `TELL_CUSTOMER_TO_UPDATE`, `UPDATE_BILLING_PROFILE` / `POST_TRANSFER` / `FILE_VAT_NOTE`, `DEBIT_MEMBER` / `SEND_PAYMENT_REQUEST` / `SEND_REMINDER`. Each handler is keyed by the effect's idempotency key.
4. Add approval screens that render each manifest and create the `ApprovalGrant`: dispute packet, exit plan, offer acceptance, price ceiling and price-rise acceptance, reissue plan, business move (personal and business screens, two grants), split mandate (shown to the member, not the organizer).
5. Call `decideAuthorization` from the card authorisation path, before the issuer's approve or decline. It is the only module that runs synchronously in that path.
6. Expose read-only MCP tools for the agent only after adding them to `config/agent-tools.allowlist.json`. Approval and execution stay outside the model (ADR 0005).
7. Use synthetic data only. The test secrets in `test/` are dummy strings, and the Ed25519 test keys are generated per run. The CUIs in the business-move tests are synthetic.
