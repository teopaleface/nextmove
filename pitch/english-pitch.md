# NextMove in a partner bank — proposed three-minute pitch

Revision: 28 October 2026. This is a script to rehearse against the implemented build, not a recording. The user chose a bank partnership for the real product. The hackathon uses fictional accounts, merchants and money. The supplied PDF requires a live end-to-end demonstration and a short concept/architecture presentation, without a numeric time limit; 180 seconds is our rehearsal target and may also be required by separate event materials.

[SECURITY-AND-SCALE.md](../design/SECURITY-AND-SCALE.md) governs execution and the revised build order. All 22 accepted capability groups remain in the product direction. Describe only the demonstrated level of each.

## 0–20 seconds — the customer problem

“Your bank shows where your money went. NextMove helps you act on what happens next.

It finds avoidable charges, checks what you actually need, and prepares actions you can review. Today, our working environment is a fictional mobile bank with simulated merchants.”

Screen: phone Home, upcoming charges and a financial goal. Identify synthetic data.

## 20–60 seconds — one useful action, completed

“Alex uploads subscription details and a usage screenshot. The agent asks about television and family use before recommending changes.

Alex approves stopping one trial renewal. NextMove uses the merchant website, then checks the merchant's confirmation. Upcoming charges fall from 242 to 163 RON. Alex's balance stays the same: this avoids a future charge.”

Screen: real extraction/tool selection if implemented, exact approval, permitted browser interaction, independent merchant read-back and bank forecast. A canned answer or success toast cannot prove these steps.

## 60–90 seconds — make the large request reviewable

“What if there are 200 subscriptions? NextMove reviews the inventory before acting. Some are already stopped; others need a login, have contract costs, protect important services, or require a manual route.

Alex reviews 120 eligible cancellations and approves that exact list, with zero additional fees. The other 80 stay outside the permission.”

Screen: independent synthetic stress fixture, grouped exclusions, inspectable individual rows, trusted batch approval. Do not merge these subscriptions or sums into Alex's single-trial dataset.

## 90–120 seconds — show honest progress

“Each cancellation has its own persistent job and result. Closing the phone does not restart the batch.

Here, 100 are confirmed. Eight await the merchant, five need sign-in, four have changed terms, and three have an unknown outcome. The agent shows what still needs attention.”

Screen: counts derived from persisted child states. The fixture is a target for implementation, not proof that it runs. If the build cannot execute this scenario, label it a designed stress case and show the actual working result instead.

## 120–150 seconds — prove control when something changes

“A lost response might mean the merchant already acted. NextMove checks before sending the request again. Changed terms need a fresh review.

Instructions hidden in a merchant page cannot add another cancellation or a transfer. Stopping the agent prevents new actions; requests already started may still finish.”

Screen: demonstrate one actual interruption or changed-term path, plus a rejected out-of-scope operation if tested. Show authoritative merchant state and the backend denial, not only assistant reassurance.

## 150–170 seconds — connect actions to the goal

“Confirmed avoided charges update the financial forecast, with their dates and evidence. Refunds enter the balance only when money actually arrives.

The same financial engine supports a phone purchase, a home goal, or a business decision, using the relevant tools and assumptions.”

Screen: inspectable updated goal calculation. Briefly show a verified personal/business calculation if implemented; otherwise call that scope planned. The independent batch fixture has 2,824 RON in avoided charges, not cash credited or annual savings.

## 170–180 seconds — the route forward

“Our next step is a pilot with a partner bank: test useful financial outcomes, customer control, and reliable execution. You choose what matters. NextMove prepares the next move.”

## Six proposed slides

1. Customer problem and a useful outcome.
2. Evidence of the problem from actual interviews, if collected.
3. Live mobile flow: evidence, recommendation, approval and merchant confirmation.
4. Large batch, one exception, recovery and observable authority boundaries.
5. Overlapping alternatives, bank-partner distribution and pilot hypotheses.
6. What the submitted build demonstrates, what is simulated and what a bank pilot must validate.

## Q&A to prepare

- **Are you EU compliant?** We mapped applicable duties and designed controls; the prototype is not certified. A bank pilot needs legal classification, real data-flow/vendor review and security evidence.
- **Can you cancel any subscription?** Only supported provider/account workflows with authority and confirmed terms. Unsupported or blocked items remain explicit manual tasks. Stopping a card payment does not cancel a contract.
- **Why does one approval cover many actions?** It covers a fixed, inspectable manifest, with exact targets, effects, cost limits, versions and expiry. New or materially changed actions require a new decision.
- **What happens after a timeout?** Reconcile the uncertain operation first; do not blindly repeat an action that may have succeeded.
- **Does stop undo the batch?** It prevents new dispatch authority. Started requests can finish; confirmed actions need a separately supported and approved reversal.
- **Where are bank passwords stored?** The model does not receive them. The real bank feature uses bank-controlled identity, services and permissions; merchant authentication needs an approved protected handoff.
- **Does this approve a loan or recommend investments?** The prototype calculates scenarios with fictional terms. Credit decisions and regulated advice require separately assessed functions and controls.
- **Why not Origin or ERIC?** Both overlap parts of the vision. Demonstrate the exact connected financial decision-and-execution loop; do not claim the category is new.
- **How do you scale?** Persistent child workflows, bounded concurrency and explicit per-provider coverage. A 200-record fixture is not a production throughput benchmark.

Time the script with the actual clicks and pauses. Cut narration before removing verification. No screenshots, design prototype or research report establishes implementation.
