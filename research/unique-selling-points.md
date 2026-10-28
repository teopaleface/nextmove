# Unique selling points — competitor check

Checked **28 October 2026** from public pages and press coverage. This describes what competitors publicly say they do, not their full product behaviour. "Not found" means not found in what we checked, so the pitch must not say "first" or "only". Earlier competitor notes (Origin, ERIC, Sidekick, Float) are in [product-and-gtm.md](product-and-gtm.md).

## What the market already has

| Product | What it publicly does | Gap NextMove can use |
|---|---|---|
| **Rocket Money — Rowan** (US, launched 25 Aug 2026, built with Anthropic) | Watches finances, texts the customer about a forgotten trial; the customer replies "cancel" and Rowan cancels and says it's done. [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/this-ai-agent-ends-subscriptions-without-a-phone-call/) | A one-word SMS is the whole approval. No published account of how completion is verified, of bulk handling or of limits. It sits outside the bank. |
| **Rocket Money app** | Cancellation concierge (Premium, not every provider) and bill negotiation for ~35–60% of first-year savings. [Rocket Money](https://rocketmoney.com/feature/manage-subscriptions), [fee review](https://www.fincomparelab.com/?p=717) | Savings are not tied to the customer's goals; humans and fees behind the scenes. |
| **Revolut AIR** (UK first, April 2026) | In-app assistant that manages cards and subscriptions and plans trips. [Revolut](https://www.revolut.com/news/revolut_enters_new_era_of_money_intelligence_with_launch_of_ai_assistant/) | Its terms say answers are "as is"; an August 2026 report describes the AI charging users to cancel. [Subscription Insider](https://www.subscriptioninsider.com/blog/revolut-ai-misfires-as-subscribers-try-to-downgrade-after-plan-change) Revolut blocks recurring card payments, which does not end the contract. [next.ink](https://next.ink/brief-article/revolut-permet-de-suivre-les-abonnements-recurrents-et-de-les-bloquer/) |
| **Meta Muse** (Sept 2026) | Personal agent; users gave it bank and card statements to cancel subscriptions. [CNBC](https://www.cnbc.com/2026/09/27/meta-muse-ai-personal-agent.html) | Runs outside the bank on shared statement access — exactly what banks are now blocking. |
| **Emma, Snoop, Cleo** | Find subscriptions; Emma publishes how-to-cancel guides. [Which?](https://www.which.co.uk/news/article/how-apps-can-help-you-spot-subscriptions-a0ag58e0gyOY) | Detection and instructions, not verified execution. |
| **Raiffeisen Smart Mobile** | "Manage recurring payments": shows active subscriptions with options to manage them. ERIC is a business coach in Smart Business that plans and prepares bank conversations. [wall-street.ro](https://www.wall-street.ro/articol/banking/raiffeisen-lanseaza-un-agent-ai-pentru-antreprenori.html) | Payment-level control and advice; no agent that changes the merchant contract and proves it. |
| **Visa Intelligent Commerce / Mastercard Agent Pay** | Network rails for agent *purchases*, with signed consumer-consent records ("Verifiable Intent"). [Overview](https://stellagent.ai/insights/visa-mastercard-agentic-commerce-strategy) | They authorise paying, not stopping or changing contracts. They validate the idea of an exact, recorded mandate. |

**Market moment:** In October 2026, major US banks started restricting third-party AI agents in customer accounts. Their reasons: shared credentials, actions customers didn't ask for, and being unable to tell what the customer actually authorised. Most banks are moving to read-only access. [Naked Capitalism, citing Axios/Reuters](https://www.nakedcapitalism.com/2026/10/us-banks-scramble-to-shut-down-ai-access-to-customer-accounts.html)

## Proposed USPs, strongest first

### 1. The agent banks can let in
Competitors act from outside the bank using shared credentials or statements, and banks are now blocking them. NextMove runs inside the bank, holds no customer passwords, and acts only on an exact, expiring approval. Each tool has its own tested allowlist. This answers the problem banks raised this month, and the sponsor is a bank.
**Demo proof:** approval screen with the exact action list; a forged or expired approval rejected by the server; a merchant page's hidden instruction failing to add an action.

### 2. "Done" means proven
Rowan "confirms when done" and Revolut's AI answers "as is". NextMove never shows a cancellation as done until the merchant's own record is read back. It keeps confirmed, pending, refused and unknown apart. It treats an avoided future charge differently from money actually credited. An unknown result is checked before any retry.
**Demo proof:** browser cancellation, then independent merchant read-back; one lost-response case reconciled instead of repeated.

### 3. Cancel the contract, not just the card
Blocking a card payment (Revolut, bank "manage recurring payments") leaves the contract running, and the merchant can still bill or chase the debt. NextMove turns off the renewal with the merchant and keeps the access already paid for. For Raiffeisen this upgrades a feature they already ship.
**Demo proof:** the 242 → 163 RON forecast change, with the paid period still active and the balance untouched.

### 4. Every saving moves a goal
Subscription apps report savings, and goal apps plan. In what we checked, none links a verified cancellation to a dated goal, for example showing the first-home deposit date moving earlier because a merchant confirmed a renewal-off. Only confirmed avoided charges count, and conditional savings are shown separately.
**Demo proof:** Home card "153 RON could stay with you" → goal timeline updates after the merchant confirms.

### 5. Decides on use, not just on spend
Competitors find subscriptions from transactions. NextMove reads a Screen Time screenshot and asks about TV and family use. It spots benefits already included in a bundle, then suggests downsizing, pausing or switching to annual billing where that fits better than cancelling.
**Demo proof:** live image extraction, a follow-up question, and a recommendation that changes after the answer.

### 6. 200 at once, with honest partial results
No consumer app we checked shows a bulk action with a fixed approved list, visible exclusions, per-item outcomes, stop and recovery. NextMove expects 100 confirmed, 8 waiting, 5 need sign-in, 4 with changed terms and 3 unknown. It doesn't fake a perfect ending.
**Demo proof:** counts read from stored results; closing the phone doesn't restart the batch.

### 7. One agent for the person and their business
Rowan, AIR and Muse are consumer tools; ERIC is business-only and advisory. NextMove uses one engine with separate ledgers, from trial cancellation to cutting unused software seats and chasing invoices.
**Demo proof:** switch to the business context and show a seat reduction that changes only the next invoice.

## How to use this in the pitch

- **Lead with 1 + 2 + 4.** They match the jury's heaviest areas: agent design (25%) and working functionality (20%). They are also timely and they suit a bank sponsor.
- **Opening line candidate:** "Banks are blocking AI agents. We built the one a bank can let in — and it proves every result."
- Show 3 and 5 inside the demo flow rather than as separate claims. Keep 6 as the stress test and 7 as a closing glimpse.
- **Never say:** "first", "only", "no other app", "cancels any subscription", "EU compliant". Instead say: "In the products we checked, none publicly shows…".
- **Regulatory hook, use carefully:** from 19 June 2026 the EU online withdrawal function (Directive 2023/2673) applies during the withdrawal period. It does not create a general right to cancel at any time. See [eu-regulatory-boundaries.md](eu-regulatory-boundaries.md) §7.

## Gaps in this check

- Rowan's verification mechanism, AIR's subscription actions and Muse's details came from press reports; the official pages returned 403.
- bunq, Monzo, Klarna, BT Pay, George (BCR) and ING Romania showed no subscription-cancelling agent in our searches.
- The bank-blocking story rests mostly on one Axios report.
- Re-check Rowan and Revolut AIR just before the pitch, since both are moving quickly.
