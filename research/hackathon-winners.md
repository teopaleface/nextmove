# Verified hackathon winners: lessons for a general financial decision agent

Research checked 2026-10-28. Illustrative sample of seven projects from seven distinct events, not a ranking or a representative study. Award claims below come from organizer announcements. Project descriptions are organizer or builder claims, not independently measured effectiveness. The transferable lessons and proposed demo are this researcher's inferences unless explicitly marked otherwise.

## Decision for Mr Laziz

Build and present a **general personal and business financial decision/action engine**: “Can I do this, under which conditions, and what needs to happen next?” Support phone purchases, buying a home, opening a covrigărie, and later other financial decisions through shared planning and simulation with context-specific tools. Do not turn the product into an SME-only app. The bakery example is a demanding demonstration of the engine, not an exclusive audience.

The most useful precedents are eCoino for changing a plan when reality changes, SalesShortcut for completing a business workflow, Shop It Easy for respecting practical constraints, Vigil for inspectable evidence, and GibberLink for a memorable change in behavior. None proves that a similar product will win this hackathon.

The five earlier concepts become optional capabilities: affordability/cash-flow simulation; stock planning for businesses that hold stock; protected personal income; receivables/collections for users with invoices; and financial-product comparison plus application preparation. A phone buyer should never be asked about inventory. The coherence comes from one decision, one shared financial state, one action plan, and one approval boundary.

## Seven verified examples

### 1. eCoino — overall top award, AI Agent Hackathon with Google Cloud, Japan

- **Exact award/date:** 最優秀賞, the event's overall top award. Decided at the March 13, **2025** pitch contest; official final-results update March 15, 2025. The event ran December 19, 2024–February 10, 2025, so calling this simply a “2024 winner” is misleading. [Organizer results](https://zenn.dev/hackathons/2024-google-cloud-japan-ai-hackathon?tab=updates).
- **Problem/mechanism:** Supply-chain plans drift when demand or supply changes. The implementation compares scenarios in BI and uses a facilitator agent to develop countermeasures. Its builder explicitly says scenario management, comparison, and countermeasure discussion were implemented; automatic master-data generation was a further feature, not completed scope. The agent mixes function calls to deterministic and generative components. [Builder explanation, February 10, 2025](https://zenn.dev/nayus/articles/45d29a213c4213).
- **Project evidence:** [Demo link](https://www.youtube.com/watch?v=JGx_V2XdMeE); [linked source repository](https://github.com/takesei/namapn-council), including [workflow template](https://github.com/takesei/namapn-council/blob/master/webcli/templates/workflow_strategy.md). Videos linked, not watched in this research.
- **Stated reason versus inference:** The results page confirms the award, but does not give an individualized judge explanation. **Our lesson:** show the agent repairing a plan after one changed fact. For a household that might be a lower down payment; for a shop, a late invoice. This directly demonstrates orchestration and testability.

### 2. SalesShortcut — Grand Prize, Google Cloud ADK Hackathon

- **Exact award/date:** Grand Prize, distinct from the regional winners and honorable mentions listed below it. The fetched organizer page displays September 3, 2025; search indexing displays September 2. Use “September 2025” when a one-day publication discrepancy is immaterial; do not invent an award-ceremony date. [Organizer announcement](https://cloud.google.com/blog/products/ai-machine-learning/adk-hackathon-results-winners-and-highlights/).
- **Problem/mechanism:** Manual sales prospecting for small service businesses. The submission connects lead discovery, research, tailored proposals, voice/email outreach, and follow-up in one workflow. The builders describe 34 agents and five services; those are architecture claims, not evidence that agent count caused the win. [Submission](https://devpost.com/software/salesshortcut).
- **Project evidence:** [Public code](https://github.com/merdandt/SalesShortcut); the submission contains its demo and architecture. Current commercial-site positioning has evolved, so use the hackathon submission to describe the winning build.
- **Stated reason versus inference:** Google gives general praise, not project-specific scoring. **Our lesson:** several functions can feel like one product when they move one goal toward completion. For Mr Laziz, evidence intake → alternatives → simulation → decision → prepared actions should persist one case state. Do not copy 34 agents or five deployments into a two-person, 24-hour build.

### 3. GibberLink — Global top prize, ElevenLabs Worldwide Hackathon

- **Exact award/date:** Global top prize and London first place, not merely a sponsor prize. Official announcement February 28, 2025. [Organizer announcement](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon).
- **Problem/mechanism:** Two voice agents in a hotel-booking conversation identify each other as AI and switch from spoken English to ggwave data-over-sound. [Builder repository and reproduction instructions](https://github.com/PennyroyalTea/gibberlink).
- **Project evidence:** Repository includes a demo folder, video link, and reproduction wiki. The source is public; runtime was not reproduced here.
- **Organizer-stated reaction:** ElevenLabs explicitly connects the intriguing demo with unanimous judge agreement. This is useful evidence of the organizer's reaction, not proof that virality generally causes wins.
- **Our lesson:** create one instantly understandable behavioral turn. For example: “The phone is affordable monthly, but this installment plan breaks your emergency-buffer target”; or “This profitable order would leave you unable to pay next week's obligations.” Then show the agent change the plan and the cash curve. The financial insight must carry the surprise; sound effects or voice alone do not demonstrate decision quality.

### 4. FutureCommit — first place in Theme 1, Descope Global MCP Hackathon

- **Exact award/date:** First place in **Build a purposeful AI Agent**, one of three themes; not an asserted overall champion. Organizer announcement September 29, 2025. [Organizer results](https://www.descope.com/blog/post/global-mcp-hackathon-winners).
- **Problem/mechanism:** Fragmented developer onboarding, documentation, and team updates. LangGraph pipelines analyze repositories and produce onboarding documents/release notes, then distribute relevant updates through connected services with Descope authentication.
- **Project evidence:** [Organizer-embedded demo](https://www.youtube.com/watch?v=HutRhzc0rd4). A confidently matched public repository was not verified in the timebox.
- **Organizer-stated reason:** The organizer explicitly cites a familiar developer pain point, practical automation, authentication, creativity, and immediate usefulness in its “Why it won” section.
- **Our lesson:** finish with usable artifacts and a clear permission boundary. A homebuyer should receive a comparison with assumptions and a document checklist; a business owner might receive supplier/payment-term proposals and collection drafts. The engine prepares the next action, then gets approval for consequential execution. A folder of generated prose without a verified financial decision is weaker evidence.

### 5. Shop It Easy, HEB — Grand Prize/first place, Databricks Generative AI Hackathon

- **Exact award/date:** Grand Prize/first place. Official announcement April 26, 2024; it also has a spelling inconsistency, “Shop is Easy” in the winners list and “Shop It Easy” in the description. [Organizer announcement](https://www.databricks.com/blog/announcing-winners-databricks-generative-ai-hackathon).
- **Problem/mechanism:** Personalized shopping lists account for event needs, lifestyle, budget, and brand preferences while checking retailer inventory. The event evaluated technical excellence, creativity, and potential impact; the announcement does not publish individualized judge scores.
- **Project evidence:** [Organizer-linked project demo](https://www.youtube.com/watch?v=wPBXnpLLAjc). No public project repository verified here; video fetch was throttled.
- **Our lesson:** recommendations must survive feasibility constraints. Phone advice should compare total purchase/finance cost against available cash and a user-set buffer; shop planning should respect available stock and payment dates. A compelling recommendation should visibly change when a constraint changes. The retail connection is instructive; this company's proprietary data and incumbent distribution do not transfer to a new team.

### 6. Vigil — Grand Winner, Elastic Forge the Future Hackathon 2026

- **Exact award/date:** Grand Winner, Team Frustrated Engineers. Official announcement September 30, 2026, after a Bengaluru finale and recognition at Elastic{ON} Mumbai. The article does not provide an exact finale day. [Organizer announcement](https://www.elastic.co/blog/mumbai-forge-the-future-hackathon-2026).
- **Problem/mechanism:** Financial-sales compliance review. The system transcribes multilingual calls, retrieves SEBI/AMFI guidance, and links a suspected violation to an audio timestamp and regulatory clause. These are organizer descriptions; this report does not validate its compliance accuracy or performance.
- **Project evidence:** Organizer has the award and mechanism, but no confidently matched public code or standalone demo was found in the bounded search.
- **Organizer-stated criteria:** The author sat on the judging panel and explicitly stresses reliability, live flows, complex queries, and edge cases across the event. The article does not isolate a causal explanation for Vigil's win.
- **Our lesson:** show the provenance of every consequential conclusion: transaction IDs, product-catalog field, assumption, calculator result. For a mock mortgage, label approval/eligibility unknown and show the assumed rates. Do not transfer Indian regulatory rules to Romania or claim legally validated advice.

### 7. MariaDB MCP integration, David Ramos — Integration track winner, MariaDB AI RAG Hackathon

- **Exact award/date:** Integration track winner, not an overall winner. Award announced at Helsinki Python's May 27, 2025 meetup; organizer recap published May 28 and project deep dive May 30. [Organizer award recap](https://mariadb.org/helsinki-python-meetup-with-mariadb/), [deep dive](https://mariadb.org/model-context-protocol-mcp-hackathon-integration-track-winner/).
- **Problem/mechanism:** Exposes MariaDB vector-store operations as MCP tools. The described demo creates a vector store, inserts quiz questions/answers through tool calls, then retrieves relevant entries to answer questions.
- **Project evidence:** [Original repo](https://github.com/DavidRamosSal/mcp-server-mariadb-vector), [subsequent MariaDB repository](https://github.com/mariadb/mcp), [organizer-linked 3:41 demo](https://www.youtube.com/watch?v=hK01fknlBJQ). Video fetch was throttled.
- **Organizer-stated evaluation:** Impact and code elegance; the recap specifically praises documentation and tests. The deep dive explicitly says user-specific access restrictions were beyond the original demo.
- **Our lesson:** reproducibility can be substantive evidence: a documented seeded case, readable tools, and checks that reproduce the decision. Do not build an MCP server just for its label. A protocol connector alone does not satisfy the Raiffeisen requirement for meaningful multi-step financial assistance.

## Five recurring actionable patterns — design inferences, not causal winner claims

| Pattern and evidence | Apply to the broad engine | Show in the Raiffeisen submission | What does not transfer |
| --- | --- | --- | --- |
| **One outcome connects several operations.** [SalesShortcut](https://devpost.com/software/salesshortcut), [FutureCommit](https://www.descope.com/blog/post/global-mcp-hackathon-winners). | One case state contains the goal, financial facts, constraints, alternatives, decision and next steps. Tools are selected by context. | A visible sequence of real tool calls leading to a decision/action pack; strongest fit with agent design/orchestration 25%. | Agent quantity, service quantity, or connecting unrelated functions is not evidence of quality. |
| **A changed fact changes the plan.** [eCoino](https://zenn.dev/nayus/articles/45d29a213c4213), [GibberLink mechanism](https://github.com/PennyroyalTea/gibberlink). | Re-evaluate when price, deposit, salary, receipt date or business demand changes. Keep earlier assumptions visible. | Inject one unexpected change and show recalculation, an alternative or a justified stop; completeness/testability 20% and originality 15%. | A scripted animation or hardcoded dialogue does not prove adaptation. |
| **Domain constraints make personalization meaningful.** [Shop It Easy](https://www.databricks.com/blog/announcing-winners-databricks-generative-ai-hackathon), [eCoino](https://zenn.dev/nayus/articles/45d29a213c4213). | Shared cash timeline and constraints; phone, home and shop tools supply different alternatives. | Show why a superficially appealing option fails and what condition makes it feasible; domain/problem 15%. | Inventory does not belong in every case. Do not infer legal/tax/credit rules from generic prompts. |
| **Recommendations have inspectable evidence and a human decision.** [Vigil](https://www.elastic.co/blog/mumbai-forge-the-future-hackathon-2026), [eCoino's human-in-loop design](https://zenn.dev/nayus/articles/45d29a213c4213). | Link claims to supplied data, catalog terms and deterministic calculations; mark unknowns. Stage consequential actions for approval. | Clicking a conclusion reveals its inputs and calculation; export prepared action artifacts. | Neither citations nor a hackathon award establish regulated-product readiness or credit approval. |
| **Reviewers can reproduce the claimed capability.** [MariaDB organizer evaluation](https://mariadb.org/helsinki-python-meetup-with-mariadb/), [GibberLink repro](https://github.com/PennyroyalTea/gibberlink/wiki/Repro-steps-for-demo). | Seeded personal and business cases, a reset path, tool traces and a few meaningful invariant checks. | README that runs the submitted build, explicit mocks, recorded evidence and failure-case fixtures; architecture/reproducibility 15%. | Public code is not necessarily licensed for reuse, maintained, secure, or runnable unchanged. |

The mentoring 10% is not explained by these examples. For this event, use mentor conversations to challenge the problem, evidence and sponsor fit, then accurately record feedback and the resulting decision in the deck. George Farauanu's availability is supplied context, not independently researched biography or an endorsement.

## A surprising three-minute demonstration for the broad vision

This is a proposed presentation structure, not a claim about an implemented product. With two active teammates, no code and 24 hours, prove a shared engine across three cases rather than build every possible category. One teammate can own seeded data, mentor questions, adversarial runs and English narration while Teo owns implementation/design; reassess division of work once actual abilities are known.

1. **0:00–0:20 — Ask the same question three ways.** “Can I buy this phone?”, “Can we afford this home?”, “Can I open this covrigărie?” Show they enter the same decision workspace. State that financial profiles/catalogs are synthetic.
2. **0:20–1:30 — Deep case, business opportunity.** A good-margin opportunity still creates a dated cash shortfall. Show intake → data checks → simulation → alternatives involving order size, supplier terms, receivables and suitable mock finance → protected owner-income constraint → prepared actions. Use a clearly labeled existing-shop order scenario to exercise invoices/stock; do not silently give a brand-new shop pre-existing receivables.
3. **1:30–1:55 — Change one material fact.** The customer cannot pay the proposed deposit or an invoice will arrive later. Recompute and show whether a different plan works. An honest “not feasible under these assumptions” is an acceptable outcome.
4. **1:55–2:25 — Prove transfer to personal decisions.** Replay a phone case and a home case with their own data and tool traces. They should not be prewritten cards. Phone: total cost, timing and buffer. Home: cash needed at purchase, recurring burden and stress scenario, with explicit mock terms and unknown approval status. Neither case invokes stock/collections.
5. **2:25–3:00 — Show the output and evidence.** A decision, conditions that must hold, alternatives, next actions, and source/calculation links. Show one reproducible fixture and distinguish simulated execution, prepared actions, and any actual integration.

Allocate most recording time to one trace so judges can understand it; demonstrate breadth with real short runs, not an assertion of universal coverage. The product can remain broad while evidence is bounded and honest.

## Audience and distribution implications

The product audience is personal **and** business users facing consequential financial choices. Initial testing/distribution can be sequenced without narrowing that vision: recruit one phone buyer, one prospective homebuyer and one aspiring/existing small-business owner to test whether the same engine asks useful questions and produces actionable results. These are test cohorts, not an invented exclusive ICP or a claim of product-market fit.

Use bank/fintech mentors to test integration, product-data provenance and handoff feasibility; consumer groups and founder/merchant communities can later be separate distribution experiments. The winner sample offers no reliable evidence for pricing, customer acquisition cost, conversion or market size. It also does not establish a differentiation claim against ERIC or Origin; that needs the parent's dedicated competitor research. “Personalized advice,” “what-if,” “proactive,” and “many categories” alone should not be assumed unique.

## Reuse and research limitations

- **Runtime:** no apps installed, dependencies executed, accounts connected, external messages sent, or projects reproduced. Source text was read using public web tools and read-only GitHub API requests. Helium was not relaunched; the supplied debugging-port block was respected. Videos were linked from first-party sources, not visually reviewed. Two YouTube requests returned `Online fetch throttled`.
- **License screening:** GitHub's public repository metadata detected MIT for GibberLink and LGPL-2.1 for the original MariaDB integration. It returned no detected license for SalesShortcut or namapn-council. SalesShortcut's README claims MIT, so do not treat its README alone as confirmed reusable licensing. [GibberLink API](https://api.github.com/repos/PennyroyalTea/gibberlink), [MariaDB entry API](https://api.github.com/repos/DavidRamosSal/mcp-server-mariadb-vector), [SalesShortcut API](https://api.github.com/repos/merdandt/SalesShortcut), [eCoino-linked repo API](https://api.github.com/repos/takesei/namapn-council). Exact files/history and compatibility still need review before copying. This report recommends mechanisms, not wholesale reuse of old submissions.
- **Event rules:** the parent's newly supplied rulebook requires challenge work from the official start and rights/licenses for third-party materials. It reportedly does not settle template versus prebuilt-project reuse; ask onsite about the concrete component intended for reuse. This is supplied context, not an independent legal interpretation. No mandatory sponsor API is inferred here.
- **Selection bias:** this sample deliberately sought winners with understandable mechanisms and public evidence. It omits unsuccessful teams, private judging deliberations and many other winners. Organizer posts promote their ecosystems; their impact, performance and production-readiness language is not independently validated. No statistical “winning formula,” unsupported impact number, or reason for winning is claimed.
- **Time horizons differ:** eCoino and the MariaDB event allowed substantially more than a single day; enterprise entrants may have had privileged data. Transfer the demo structure, evidence and interface principles, not their complete implementation scope.
- **Subscriptions:** no assumption that Claude/Codex subscriptions provide application API credits. Model/provider setup is outside this winner-research assignment.
