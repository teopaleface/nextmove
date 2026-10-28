# Additional verified hackathon winners: a NextMove bulk-action demo

Checked **2026-10-28**. Seven additional projects across four events. This supplements [the earlier report](hackathon-winners.md); it excludes eCoino, SalesShortcut, GibberLink, FutureCommit, Shop It Easy, Vigil, and David Ramos's MariaDB MCP integration. Award evidence, builder descriptions, published selection rationales, and our design interpretations are identified separately. No winning project was run or independently performance-tested.

**Recommendation:** Present NextMove, the fictional mobile bank, through a financial outcome: a user reduces recurring outgoings and sees the effect on their next-month plan. Make review of a 200-subscription inventory, followed by exact approval and partial execution, the stress case. The memorable moment is a batch that survives a malicious instruction and an interrupted response, then reports exactly what happened. Safety supports useful execution; this sample provides no evidence that safety alone wins.

## What the supplied Raiffeisen brief actually asks for

Both pages of the [supplied participant guide](/Users/teo/.t3/userdata/attachments/sidechat-thread-1f393aa0-97d5-4f25-a229-5cca89b4ba97-253d7ea4-ed83-4758-9e53-d5a-5adb807d-0d51-4317-9781-885161979924-pdf.pdf) were text-extracted and visually inspected. Page 1 makes the financial-banking challenge open-ended and emphasizes an original, useful idea implemented in a functioning agent architecture. Its evaluation focus is concept/usefulness, execution depth, a live functioning prototype, and technical architecture/feasibility. Deliverables are source code, a real-time end-to-end demonstration, and a short explanation of the problem, distinctiveness, and architecture. Page 2 contains the closing encouragement.

**This two-page PDF supplies no numerical scoring weights or mandatory 180-second limit.** The timing below is our proposed presentation format. A generic cancellation chatbot needs a stronger financial proposition and a demonstrated workflow to meet the stated emphasis on originality and depth. A security architecture slide by itself supplies neither.

## Seven additional projects and their exact awards

| Project | Event and time evidence | Verified award level | Organizer award evidence |
| --- | --- | --- | --- |
| **AegisAgent** | AWS AI Agent Global Hackathon, 2025 edition | **2nd Place overall** | [Official results recap](https://aws-agent-hackathon.devpost.com/updates/38140-congratulations-to-the-winners-of-the-aws-ai-agent-global-hackathon) |
| **Province** | Same AWS event | **3rd Place overall** | [Official results recap](https://aws-agent-hackathon.devpost.com/updates/38140-congratulations-to-the-winners-of-the-aws-ai-agent-global-hackathon) |
| **AI-driven, multi-agent fraud alert triage system** | Same AWS event; results shorten its name to AI-Driven, Multi-Agent Triage System | **Best Amazon Bedrock AgentCore Implementation**, a category prize | [Official recap links directly to the matching submission](https://aws-agent-hackathon.devpost.com/updates/38140-congratulations-to-the-winners-of-the-aws-ai-agent-global-hackathon) |
| **Sheeter**, Team sarthak647_7427 | Descope Global MCP Hackathon; results published September 29, 2025 | **1st in Theme 2: Deploy a secure MCP server** | [Descope results](https://www.descope.com/blog/post/global-mcp-hackathon-winners) |
| **AI Fitness Agent**, Team Confickers | Same Descope event and results date | **1st in Theme 3: Design secure agent-to-agent systems** | [Descope results](https://www.descope.com/blog/post/global-mcp-hackathon-winners) |
| **Afterlogin: The Hunt** | Microsoft Agents League, AI Skills Fest 2026; recap displays July 23, 2026 | **Best Overall, $15,000 Grand Prize**; entered Creative Apps | [Microsoft organizer recap](https://techcommunity.microsoft.com/blog/educatordeveloperblog/%F0%9F%8F%86-agents-league-celebrating-the-builders-who-made-agents-battle-for-glory/4538007/replies/4540516) |
| **Litmus: secure NANDA** | NandaHack, HCLTech and MIT Media Lab; finale July 11, 2026 | **Third prize overall** | [Official event results](https://nandahack.media.mit.edu/), [MIT Media Lab confirmation](https://www.media.mit.edu/posts/mit-media-lab-and-hcltech-host-nandahack-to-advance-agentic-ai-innovation/) |

Date qualification: AWS's [updated official rules](https://aws-agent-hackathon.devpost.com/rules), available in indexed first-party text, specify submissions September 8-October 22, 2025 and an announcement **on or around December 5, 2025** at re:Invent. That is a scheduled date, not independently verified ceremony timing. The opened recap confirms the awards and refers to the re:Invent reveal; its relative publication label is unsuitable for establishing an exact day.

### 1. AegisAgent: resolve ambiguity and resume with more evidence

**Builder-described mechanism:** Evidence Curator extracts claim facts; Policy Interpreter retrieves relevant clauses; Compliance Reviewer challenges unsupported assumptions. Blocking objections can pause the process and produce a packet for resuming with additional evidence. The final decision packet contains supporting citations and unresolved objections. These are submission claims. [Hackathon submission](https://devpost.com/software/aegisagent-an-insurance-claim-app-fully-developed-by-kiro).

**Artifacts and inspection:** Read the submission's workflow, build explanation, and award badge. It links a [YouTube demo](https://www.youtube.com/watch?v=FNWsFtOX4d4) and an [App Runner deployment](https://3vhp3hyhxz.us-east-1.awsapprunner.com). The video fetch returned `Online fetch throttled`; it was not watched. The app was not opened or exercised. No repository link appeared in the fetched submission text.

**Our NextMove lesson:** An interrupted cancellation response should produce a resumable job with an explicit unknown outcome. Resolve the provider state before sending another cancellation. A second model opinion can help identify ambiguity; backend state and provider receipts must establish whether an action occurred. The award does not prove this project's pause/resume behavior or our proposed cancellation design correct.

### 2. Province: finish the workflow with an inspectable artifact

**Builder-described mechanism:** Conversational intake and document extraction feed tax calculations and a pipeline mapping data into IRS PDF fields. The submission describes separate intake, planning, form-mapping, and review agents. We did not validate its tax accuracy. [Hackathon submission](https://devpost.com/software/province).

**Artifacts and inspection:** Read the submission's intake, extraction, mapping, calculation, and architecture descriptions, plus its award badge. It links a [YouTube demo](https://www.youtube.com/watch?v=_ipE3EZEw40) and [Province deployment](https://www.provincetax.com). The video fetch returned `Online fetch throttled`; the app was not tested. No repository link appeared in the fetched submission text.

**Our NextMove lesson:** Finish with a cancellation receipt set and an updated financial forecast. Clicking one projected saving should reveal the subscription amount, billing cadence, effective cancellation date, and confirmation status. A conversational answer saying it has handled everything is weaker evidence than a result that can be checked against the fixture ledger. Do not import US tax assumptions into this banking demo.

### 3. Fraud alert triage: classify exceptions before taking action

**Builder-described mechanism:** A triage agent enriches alerts and routes them to dismissal, analyst review, or investigation. An investigation agent analyzes suspicious relationships; a report agent prepares SAR summaries for compliance review. The builder combines deterministic rules with model assessments. Claimed pilot improvements were not independently checked. [Hackathon submission](https://devpost.com/software/ai-driven-multi-agent-fraud-alert-triage-system).

**Artifacts and inspection:** Read the workflow, implementation, challenges, and category award badge. The embedded [Vimeo demo](https://player.vimeo.com/video/1129659581) resolved to an empty extracted page; no video frames were inspected. No public repository link appeared in the fetched submission text.

**Our NextMove lesson:** Route each subscription to a supported cancellation action, a protected item, or a manual handoff before dispatch. After dispatch, keep confirmed, failed, and unknown outcomes distinct. A deterministic rule should enforce the approved target set even when the model's recommendation is wrong. The organizer confirms the category award; it does not publish an individualized reason for awarding this project.

### 4. Sheeter: make the useful operation understandable immediately

**Organizer-described mechanism:** OAuth-protected spreadsheet CRUD is exposed through MCP and the Cequence AI Gateway. **Artifact inspected:** the organizer's award, mechanism, and rationale text, including its [embedded demo link](https://www.youtube.com/watch?v=9vPN5gtgChY). Video fetch was throttled. A confidently matched public repository was not established. [Organizer account](https://www.descope.com/blog/post/global-mcp-hackathon-winners).

**Our NextMove lesson:** Make a large reviewed plan understandable through totals, exceptions, and searchable rows. One approval can authorize the exact batch; the interface need not ask for 200 identical confirmations. Keep a simple planner/executor interface rather than copying spreadsheet infrastructure or adding MCP solely for presentation.

### 5. AI Fitness Agent: relate delegated permissions to a user benefit

**Organizer-described mechanism:** A FastAPI orchestrator routes requests to Trainer, Nutrition, and Recovery agents; scoped JWTs govern their interactions. **Artifact inspected:** the organizer's award, mechanism, and rationale text and [embedded demo link](https://www.youtube.com/watch?v=h4sFMewQ8GA). Video fetch was throttled. A confidently matched public repository was not established. [Organizer account](https://www.descope.com/blog/post/global-mcp-hackathon-winners).

**Our NextMove lesson:** Explain the permission in user terms: permission to cancel these selected subscriptions, for this approved job. The cancellation executor should have no authority to add a transfer, access another user's subscriptions, or expand the batch. A permission diagram is useful only if the demo shows an unauthorized action being rejected.

### 6. Afterlogin: make the human decision part of the interaction

**Builder-described mechanism:** A security-training game uses investigating agents to gather identity evidence and make a cited recommendation; the player makes the final decision. The submission describes both live-agent and scripted fallback modes, which must not be confused when evaluating it. [Repository README](https://github.com/jlynch160/afterlogin-the-hunt), [submission description](https://github.com/jlynch160/afterlogin-the-hunt/blob/master/SUBMISSION.md).

**Artifacts and inspection:** Read the repository listing, rendered README, and submission description. The repository contains [demo media](https://github.com/jlynch160/afterlogin-the-hunt/blob/master/afterlogin-demo.webm), an [architecture document](https://github.com/jlynch160/afterlogin-the-hunt/blob/master/ARCHITECTURE.md), and a [video script](https://github.com/jlynch160/afterlogin-the-hunt/blob/master/VIDEO-SCRIPT.md). The latter document pages were opened but not treated as a code audit; the video was not played and the deployed app was not run. Award and selection-rationale evidence comes from Microsoft's recap, not the builder's entry text.

**Our NextMove lesson:** Give the user one meaningful decision over a visible, fixed plan, followed by execution evidence. For a bulk operation, permission can cover the batch rather than requiring a decision for every row. Display whether the running prototype uses a real model, fixture-backed adapters, or a recorded fallback.

### 7. Litmus: test behavior when retrieved material contains instructions

**Verified scope:** Third prize at NandaHack, whose main format was a hosted service plus a skill document used by a stock agent. The event's published judging criteria are general criteria, not individualized reasons for Litmus's placement. [Official event description and results](https://nandahack.media.mit.edu/).

**Builder-described mechanism:** A web-reader service doubles as an instrumented agent-safety test, using injected instructions and tripwires to produce scorecards. **Artifacts inspected:** its cards in the [organizer-linked registry](https://nandatown.projectnanda.org/skills), [repository README and file listing](https://github.com/varuni7/nanda-litmus), and [raw skill document](https://raw.githubusercontent.com/varuni7/nanda-litmus/main/skill.md). No test endpoints were invoked, no scorecards reproduced, and no demo video reviewed. The registry's historical reachability badges are not current service verification.

**Our NextMove lesson:** Put an adversarial instruction in a synthetic merchant note and show it cannot extend the approved plan. Measure the actual rejected tool request and unchanged ledger. One successful trap demonstration is evidence for that fixture, not a general prompt-injection immunity claim. The project won a prize; the sources do not say this particular mechanism caused its placement.

## Three published selection rationales, with attribution limits

The sources publish three project-specific explanations below. **They are organizer accounts, not individually attributed jury quotations or scoring sheets.** No set of three named-juror explanations was established. Do not upgrade these into claims that a particular judge endorsed a feature or that a feature caused a win.

| Project | Published reason, paraphrased | Who actually states it |
| --- | --- | --- |
| **Sheeter** | Removing setup friction made the idea practical and easy to understand; clarity and implementation speed were praised. | Descope's explicit **Why it won** section. [Source](https://www.descope.com/blog/post/global-mcp-hackathon-winners) |
| **AI Fitness Agent** | Delegated access served a relatable use case, combining technical execution with a plausible adoption path. | Descope's explicit **Why it won** section. [Source](https://www.descope.com/blog/post/global-mcp-hackathon-winners) |
| **Afterlogin** | Creative presentation, a concrete security-training purpose, and polished execution were praised together. | Microsoft's explicit **Why it won** paragraph. [Source](https://techcommunity.microsoft.com/blog/educatordeveloperblog/%F0%9F%8F%86-agents-league-celebrating-the-builders-who-made-agents-battle-for-glory/4538007/replies/4540516) |

The AWS recap describes the winning builds but supplies no individualized jury scoring. NandaHack publishes its process and general criteria but no Litmus-specific selection explanation. Our lessons above are interpretations, not additional jury reasons.

## Proposed 180-second NextMove demonstration

Root synthesis after the user's bank-partnership decision: [SECURITY-AND-SCALE.md](../design/SECURITY-AND-SCALE.md) and [bulk-cancellations.json](../demo/bulk-cancellations.json) are the canonical batch contract. This is a **200-item inventory, 120-item approval, 100 confirmed-result** scenario. It does not contain 202 subscriptions or promise all 200 can be cancelled. These are designed fixtures, not measured execution results.

1. **0:00–0:20: State a financial goal.** The customer wants to reduce recurring outgoings while keeping important benefits and protecting a savings goal. Identify synthetic bank/merchant data.
2. **0:20–1:00: Prove one end-to-end action.** Read the supplied evidence, ask about other-device use, compare options, then execute only the exact approved trial cancellation in the fake merchant. Independently verify the result: upcoming charges 242 → 163 RON, with balance unchanged.
3. **1:00–1:30: Review the large inventory.** Show all 200 items, with 120 ready, 25 already off, 20 needing authentication, 15 with contract conditions, 10 requiring shared/essential-service review and 10 unsupported. The user inspects and approves only the exact 120-item manifest; the rest stay excluded.
4. **1:30–2:00: Expose partial outcomes.** The independent stress fixture expects 100 confirmed, eight waiting for the merchant, five needing renewed authentication, four with changed terms and three unknown outcomes. Restore the same state after refresh. Report what actually ran; do not present a frontend counter as a backend workflow.
5. **2:00–2:30: Demonstrate a consequential exception.** Use one lost response after provider commit or one changed-term case. Read provider evidence before retrying an ambiguous action. Separately show that a merchant-note instruction cannot expand the approved target set. Keep unfinished states visible rather than forcing a perfect ending.
6. **2:30–3:00: Close on the financial result and distribution.** The batch fixture's confirmed items imply 2,824 RON in avoided charges in its stated 30-day window, without crediting cash. Do not add this independent stress result to the single-trial example. Connect the verified scenario to a financial goal and explain the chosen future route: a feature inside a partner bank. State actual demonstrated scope and the pilot ask.

The opening and closing sell a useful financial change. The middle supplies depth: exact authority, real tools over controlled merchant systems, exceptions, recovery and inspectable outputs. These are our proposed responses to the supplied brief, not a formula extracted from winners. The implementation may use a shorter scene selection after timed rehearsal; all runtime claims depend on the submitted build.

## What must actually work for that demo to be credible

- **Persisted execution:** Backend records, not frontend counters, determine each subscription's state. The mixed fixture must preserve all 80 exclusions and correctly track the 120 approved items; the interruption case must establish recovery without inventing universal completion. An unsupported-provider fixture should visibly remain a manual task.
- **Enforced authority:** Replaying an approval, changing target IDs, or accessing another user's item must not expand authority. The merchant-note attack should be checked at the executor boundary even if the model proposes the wrong action. Revoking or expiring authority must stop further dispatch.
- **Observable effects:** Compare provider ledger state before and after the retry. An idempotency key printed in a log is not proof of deduplication. Confirm that each approved operation has at most one cancellation effect and every protected item is unchanged.
- **Honest completion:** A timeout is unknown until reconciled; request acceptance is not cancellation confirmation. Summaries and projected savings must be computed from the confirmed result set. Show partial outcomes if the provider cannot be reconciled.
- **Bounded claims:** Describe exactly which mock adapter operations are implemented. A bank payment-control action, a drafted cancellation request, and a merchant-confirmed subscription cancellation need separate statuses. Offer an undo action only for adapters with an implemented compensating operation.
- **Runnable evidence:** Include a resettable seed, instructions, an end-to-end trace, and a few checks of these failure modes. Rehearse the 180-second flow with measured timings. Label recordings and fixture-controlled delays; do not present them as measured live-provider performance.

These are suggested acceptance checks for subsequent implementation. This research task did not build NextMove, run those checks, establish third-party cancellation access, or validate production financial/security readiness.

## Research and browser status

**Exactly one bounded Jev launch was attempted**, after reading `/Users/teo/Documents/LLM-Wiki/wiki/codebases/jev-ultrafast.md`. It invoked `~/.local/bin/jev-ultrafast python examples/run.py` with `TYPESAFE_MODEL=jev-1.14.0 JEV_VISION=1 DECISION_PROVIDER=typesafe`, starting at `https://developers.googleblog.com/`. The narrow read-only goal was to identify named awards in the official Gemini competition announcement, with at most ten navigation/click actions, a 45-second goal bound, and a 55-second process timeout. Restart was disabled and no alternate profile was supplied.

The launcher exited with code **1** before research navigation. Exact stderr:

```text
Helium is already running, but without remote debugging on port 9333.
A running Chromium instance cannot be given new flags, and starting a
second profile would open an empty Helium without Teo's logins.
Quit Helium, relaunch it with:
  "/Applications/Helium.app/Contents/MacOS/Helium" --remote-debugging-port=9333 --restore-last-session
then re-run jev-ultrafast (or set JEV_RESTART_HELIUM=1 to do this automatically).
```

The launcher's suggested restart/retry was not followed. No second UI attempt, browser restart, tab closure, login, new profile, or site mutation was performed. Research continued through read-only public web search/open tools, as authorized.

**Inspection limits:** Award claims were checked against organizer-owned results. Descope's page initially timed out, then opened successfully. Microsoft's full award/rationale text was available in indexed organizer-page results; opening its discussion URL exposed the Microsoft author, date, and an abbreviated article body. The canonical parent URL returned an empty extraction. Accordingly, Microsoft's award/rationale is verified from indexed first-party text, not a rendered full-page browser inspection. The opened page identifies Lee Stott as a Microsoft author. AWS rules returned 403 when opened; their dates were read from indexed official rules. Videos were not watched, apps were not exercised, source implementations were not audited, and no licenses were cleared for reuse.

This is a deliberately selected set of relevant winners, not a comparison with losing teams. Organizer descriptions are promotional and do not validate accuracy, security, scalability, or commercial outcomes. Different event lengths, rules, sponsor incentives, and entrant resources limit transfer to this hackathon. Only this follow-up Markdown file was authored.
