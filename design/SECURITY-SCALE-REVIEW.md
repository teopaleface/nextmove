# NextMove: independent security, architecture and scale review

28 October 2026. **Planning only. No implementation, security audit, load test, deployment or EU compliance certification is established by this review.** Ownership: this file only.

## Decision and evidence boundary

Keep the proposed bank-partner product, deterministic policy/finance modules, durable server workflow and isolated merchant adapters. A request to cancel 200 subscriptions must prepare an exact inventory and approval manifest; it cannot authorize arbitrary cancellations, penalties, account deletion or payment blocking. Unsupported cases are a useful, explicit result.

Reviewed: [PRODUCT-SCOPE.md](../PRODUCT-SCOPE.md), [AGENT-CAPABILITIES.md](AGENT-CAPABILITIES.md), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), [MOBILE-UX.md](MOBILE-UX.md), [PLAN-HACKATHON.md](../PLAN-HACKATHON.md), and the supplied [two-page banking brief](/Users/teo/.t3/userdata/attachments/sidechat-thread-1f393aa0-97d5-4f25-a229-5cca89b4ba97-253d7ea4-ed83-4758-9e53-d5a-5adb807d-0d51-4317-9781-885161979924-pdf.pdf). The brief asks for a functional end-to-end agent demonstration and a feasible architecture; it supplies no production banking authority or security certification. Its two pages do not establish the older plan's numeric rubric, deadline or three-minute format.

The current plans designate [SECURITY-AND-SCALE.md](SECURITY-AND-SCALE.md) as controlling, so this review also reads that document and [bulk-cancellations.json](../demo/bulk-cancellations.json). Their proposed controls already address durable children, partial outcomes, revocation ordering, unknown results and network isolation. The findings below identify remaining precision and verification gaps, rather than treating those controls as absent.

Line references use these SHA-256 snapshot prefixes: `PRODUCT-SCOPE.md 343109b461d7`; `AGENT-CAPABILITIES.md 775865cacb4f`; `IMPLEMENTATION-PLAN.md 709abadb8113`; `MOBILE-UX.md a0980822d8bc`; `PLAN-HACKATHON.md 71eb33c7036a`; `SECURITY-AND-SCALE.md a988fe5431ad`; bulk fixture `35a2a7561af1`. These are design snapshots, not build identifiers.

## Prioritized design defects and release blockers

P0 blocks real-data/external-mutation release. P1 blocks a credible bulk/recovery claim. Every remedy below is **proposed**, including controls already required elsewhere; none has runtime proof here.

| Priority | Exact existing location | Residual defect and required resolution |
|---|---|---|
| **P0 / F1** | `AGENT-CAPABILITIES.md:100–114`; `SECURITY-AND-SCALE.md:46–50` | A server record/hash is specified, but a signed per-action capability protocol is not. Define canonical bytes, signature verification, issuer/audience, key rotation, action/account/version binding and online revocation. A valid signature alone must never authorize execution. |
| **P0 / F2** | `SECURITY-AND-SCALE.md:85–97`; `AGENT-CAPABILITIES.md:108–114` | Atomic stop/dispatch ordering is asserted without defining the dispatch gate or fencing stale workers. Persist a dispatch authorization before network handoff; require the current fence at the final write gate. State precisely which already-authorized requests can still commit. |
| **P0 / F3** | `AGENT-CAPABILITIES.md:36–40,109–114`; `SECURITY-AND-SCALE.md:56,95–97` | Simulator version checks and atomic receipts cannot be assumed for a real browser merchant. Each adapter needs an explicit commit/reconciliation contract. If exact effects cannot be constrained or uncertain outcomes resolved, disable automatic commitment/retry and expose a manual route. |
| **P0 / F4** | `AGENT-CAPABILITIES.md:13,114`; `SECURITY-AND-SCALE.md:57,105`; `MOBILE-UX.md:228–235,309` | Session/context uniqueness does not fully define shared-account authority or deduplication across household actors. Use a canonical merchant-account/contract identity, current bank mandates and exclusive input leases; enforce object authorization on streams, captures, receipts and jobs too. |
| **P0 / F5** | `SECURITY-AND-SCALE.md:108–113`; `IMPLEMENTATION-PLAN.md:69–83` | Isolation, SSRF and upload controls are requirements without an enforcement topology or test corpus. Specify connection-time egress checks for every network path, private parsing and bounded output handling. Browser routing alone cannot be the network security boundary. |
| **P0 / F6** | `MOBILE-UX.md:197,227–235,323`; `SECURITY-AND-SCALE.md:111–112` | Protected login and exclusion from captures are required, but viewing/input authority and handoff fencing remain unspecified. Define authenticated short-lived viewing/input sessions, recording suppression during authentication and a fenced handoff back to the worker. |
| **P0 / F7** | `PRODUCT-SCOPE.md:5,9–13`; `IMPLEMENTATION-PLAN.md:5–7`; `SECURITY-AND-SCALE.md:119–130` | A partner-bank route and legal topics are selected; deployment authority remains unproven. Require a named bank/legal/privacy/security owner, intended-use classification, approved data/processor map and permitted connector scope before a real pilot. Partnership does not itself satisfy every regulatory obligation. |
| **P1 / F8** | `AGENT-CAPABILITIES.md:15,74,174`; `IMPLEMENTATION-PLAN.md:55–65`; `SECURITY-AND-SCALE.md:58–59,114,175–177` | Per-user concurrency exists, but fleet admission, budgets, retry counts and fairness remain unspecified. Set shared global/merchant limits, finite queues/deadlines, cost reservations and fair scheduling. Measure on a named build and host before increasing them. |
| **P1 / F9** | `AGENT-CAPABILITIES.md:77–80`; `SECURITY-AND-SCALE.md:97,115,175` | Late-event ordering and backups lack a complete inbox/restore contract. Authenticate and deduplicate webhooks, apply resource revisions rather than arrival order, and freeze mutation after uncertain restore. Restoring local data cannot restore or undo merchant history. |
| **P1 / F10** | `PRODUCT-SCOPE.md:57,63–70`; `MOBILE-UX.md:104,116,259–262,313–315`; `SECURITY-AND-SCALE.md:77–87` | Counts and savings need separate persisted denominators and reconciliation revisions. Distinguish inventory coverage, supported/approved actions, verified renewal-off, applied forecast and settled bank cash. A parent “complete” flag or 100 receipts cannot establish complete coverage or 200 cancellations. |

## Durable authority and execution contract

### Signed capabilities

The bank's authenticated first-party approval UI submits a displayed immutable manifest digest. The authorization service derives the actor and current mandate from the session, checks CSRF/replay protection and bank-required step-up, then stores consent and issues **one signed capability per exact child action**. The model cannot mint grants or supply authoritative ownership fields.

Bind at least: `grantId`, issuer, worker/gateway audience, tenant, actor and mandate revision, personal/business context, merchant ID, subscriber account, contract ID, logical action ID, proposal/input/terms/resource versions, canonical `ActionSpec` hash, adapter-policy version, operation, currency, immediate debit/fee limits, remaining contractual obligations, effect/access dates, dependencies, consequence hash, issued/not-before/expiry times, revocation epochs and signing-key ID. A cancellation with no immediate charge still binds lost access/data and remaining annual payments.

Use a vetted signature implementation and server-managed signing keys, preferably the bank's managed key service; workers receive verification capability, not signing authority. Keep grants and credentials out of model context, URLs, analytics and captures. At execution verify signature, audience, server record, current mandate/ownership, epochs, single-use claim, versions, dependencies, expiry and budgets. Fail closed if the policy store is unavailable. Changing a material term requires fresh approval even below the old maximum cost.

Preserve the controlling distinction: **10 minutes for the existing single-action demo approval** (`AGENT-CAPABILITIES.md:104`), **60 minutes to begin exact batch actions** (`SECURITY-AND-SCALE.md:50`). A short-lived dispatch ticket can be derived from an unrevoked approved child within that window; it cannot extend the approved deadline or add an item. A delayed receipt may be read after commit permission expires only while the separate read permission remains valid.

### Workflow independent of phone and model context

Persist a parent batch plus child state machines, stable logical action IDs, dependency edges, immutable manifests/grants, input versions, attempts, dispatch journal, verified receipts, evidence references, event cursor, leases/fences, budgets/deadlines and next eligible check time. Separate contract state, execution state, forecast application and bank settlement. Never reconstruct authority from chat summaries.

1. Inspect/deduplicate inventory; gather missing terms and authority. Freeze the selected exact manifest; discovered later items require a new approval.
2. Atomically persist approval, child work and an outbox record. Dispatchers use the outbox so a crash between database commit and queue publication cannot lose work. Queue messages carry IDs, not credentials or complete documents.
3. Lease a child with a monotonically increasing fence. Re-read current state, permissions and versions; serialize conflicting work by canonical merchant account/contract across users, batches and individual tasks. Do not hold a database transaction open while browsing.
4. Persist the immutable attempt before an external effect. The policy-controlled write gate checks the current fence/grant and records dispatch authorization. Both API calls and browser final requests pass this gate; arbitrary click/HTTP/script tools cannot bypass it.
5. Verify and reconcile through independently fetched account-bound evidence. Atomically apply each confirmed source event to the appropriate forecast/ledger once; acknowledge queue work only after its durable checkpoint.

The model gets bounded pages of facts/results and a finite decision budget; code schedules the children. Closing the phone, losing the stream, restarting the worker or truncating LLM context does not create or repeat a commitment. Reconnect refetches authorized state and resumes from the event cursor. SQLite plus a transactional queue remains appropriate for the local design; a bank-hosted multiworker service requires shared durable storage and tested recovery behind the same interfaces.

### Revocation, retry and emergency stop

Give revocation and dispatch authorization a transactional order at the final local write gate. If revocation wins, no new dispatch is authorized. If dispatch wins, report that item as started/in flight: it may still commit after the user presses Stop. A lease claim is not evidence that bytes were sent, and a crash around handoff may leave `OUTCOME_UNKNOWN`. Merchant-enforced conditional commit can strengthen this only where actually supported.

User, account, merchant and fleet stop controls increment scoped revocation epochs and block new dispatches. Closing a browser or killing workers does not recall an accepted request. Preserve confirmed results; reactivation/purchase is a new consequential operation requiring a new grant. Keep authorized reconciliation reads running after a mutation-only stop; if the user also revokes read access, stop those reads and show an unresolved result with a manual verification route. Resumption requires current permissions and fresh grants where expired/revoked.

Retry safe reads with a finite budget. For a verified idempotent API, reuse the original logical action/key and identical payload within the merchant's documented retention window. Never retry the entire browser workflow automatically after a possible final submission. First query the existing reference/current contract; permit a new attempt only with conclusive no-effect evidence, still-valid authority and an adapter-specific safe retry rule. Otherwise keep unknown/manual. A fresh request ID, grant, proposal or worker lease cannot erase ambiguity. An adapter's registry entry must declare conditional-commit support, idempotency scope/retention, exact final request/effect, authoritative read-back and reconciliation method; do not infer these from its marketing name.

Local uniqueness gives local deduplication. It cannot provide **distributed exactly-once execution** against an arbitrary merchant. Temporal documents that an activity can finish externally and be retried when completion was not recorded; SQS also documents duplicate delivery. These semantics justify the journal/reconciliation contract, without changing the chosen stack. [Temporal activity idempotency](https://docs.temporal.io/activity-definition#idempotency), [SQS delivery semantics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html).

## Security boundaries to implement

Treat the model, extracted files, web pages, tool responses and persisted inferred facts as untrusted. Allow typed operations over server-resolved IDs; validate outputs before storage/rendering; retain source/time and user-confirmed corrections. Never execute model-generated code or promote document instructions into tools, memory authority or approvals. This addresses goal hijack, tool misuse, identity abuse and cascading failures identified by the [OWASP Agentic Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/). Use [ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0) as a versioned verification baseline, with bank-reviewed depth for authentication, access control, cryptography, data and business logic; this is not an ASVS certification claim.

- **Tenant and household:** authenticate every request; authorize each object and current account mandate, including background jobs, source files, exports, event streams, receipts and live-view tokens. Opaque IDs are not authorization. A shared household does not grant access to another person's contract. Joint mandates may require multiple approvals. Support access is exceptional, audited and time-limited.
- **Browser and credentials:** separate account-scoped contexts and short-lived execution cells; run patched browsers with OS sandboxing, non-root identities, restricted filesystem/CPU/memory/time and no host mounts or broad cloud credentials. Keep browser control ports private. Contexts separate cookies/storage, not every host/network security boundary. [Playwright isolation](https://playwright.dev/docs/browser-contexts) and [container guidance](https://playwright.dev/docs/docker) support this distinction.
- **Egress/SSRF:** broker both cloud fetches and browser traffic through an enforced proxy/firewall. Allow registry-owned schemes, exact hosts, ports and permitted operations; reject URL userinfo, parser ambiguity and non-network schemes. Validate every redirect and connection's IPv4/IPv6 destination, prevent unchecked DNS re-resolution, and block loopback/private/link-local/metadata/control-plane targets. Cover frames, popups, subresources, downloads, WebSockets, service workers and alternative direct egress. Strip credentials on origin changes. The fake merchant gets only a specific isolated demo endpoint exception. [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
- **Write boundary:** method alone does not prove safety; loading a page may run scripts with side effects. A registered browser adapter must constrain the actual final destination, request and account-bound effect. If it cannot, keep the route manual. Playwright routing is supplementary; service-worker interception has limitations. [Playwright network documentation](https://playwright.dev/docs/network#missing-network-events-and-service-workers).
- **Files/output:** private object references, content-based type checks, byte/page/pixel/decompression/time limits, isolated parsers/scanning, inert previews, safe filenames and no automatic remote-resource fetching. Disable untested PDF/CSV formats. Escape rendered text/URLs with a restrictive CSP; neutralize spreadsheet formula prefixes, including whitespace/control-character variants, in CSV exports without changing canonical financial data. Quoted CSV cells alone are insufficient.
- **Theft/takeover:** prefer scoped revocable merchant tokens over stored passwords. Encrypt credentials through a broker; never send passwords, cookies, OTPs or full payment credentials to the model. Suppress captures/DOM traces during protected authentication. Authenticate live viewing and input separately; use one current controller fence, revoke old viewing/input tokens on handoff and re-observe before resuming. Compromise freezes affected execution, revokes sessions/tokens/grants and triggers the bank's incident process.

## Bounded scheduling and the 200-item scenario

Preserve the controlling fixture's proposed **4 API / 2 browser operations per user**, and **one mutation per merchant account**. Add initial shared fleet caps of **8 active API operations / 4 browser cells**, plus **one active mutation per merchant globally** and its contracted token-bucket rate limit. These are conservative proposed pilot limits, not measured capacity; any lower provider or risk limit wins.

Cap each batch inventory/selection at 200 items, with one active committing batch and two queued batches per user/context; initially admit at most 100 batches / 20,000 children fleet-wide. Larger requests need explicit bounded batches; admission failure returns a retry time, never silent dropping. Use fair round-robin/deficit scheduling across users within merchant limits, with bounded deadline priority and reserved verification capacity. Do not reserve slots while waiting for approval/login or `Retry-After`. Verification takes priority over creating more uncertain effects.

Suggested finite defaults: safe reads **3 attempts total**, full-jitter backoff and `Retry-After` within the deadline; browser attempt **90 seconds / 20 permitted interactions**; model decision **8 tool steps**, maximum **3 automatic decision rounds per batch**; automatic reconciliation **5 checks within 24 hours**, then needs attention or a separately approved monitoring schedule. A potentially submitted browser mutation gets **no blind mutation retry**. Persist budgets across restarts. Before admission configure integer-currency per-batch/per-user/day/fleet compute budgets and reserve worst-case permitted cost before calls; no missing/unbounded cost configuration. The automatic batch-work deadline is 24 hours; a known pending merchant request stays pending afterward, not failed. Expired grants, renewal deadlines or budgets stop new attempts and expose the exception.

### Exact reference partition

All numbers below are **planned synthetic outcomes**, independently recounted from the current fixture; no merchant coverage or performance was exercised.

| Inventory partition | Count | Behavior |
|---|---:|---|
| Eligible with known consequences and zero extra fees | 120 | Exact selectable manifest: **90 API + 30 browser** |
| Renewal already off | 25 | Read-only result; no new cancellation or saving |
| Login needed before inspection | 20 | Protected supported login or clear manual route; no premature grant |
| Annual/minimum commitment or exit cost | 15 | Separate analysis/approval; excluded from zero-fee mandate |
| Shared/protected service | 10 | Verify ownership, mandates, access/data consequences first |
| Unsupported merchant/procedure | 10 | Manual instructions; no automation success claim |
| **Total** | **200** | **120 approved candidates + 80 excluded** |

| Outcome after the approved first pass | API | Browser | Total |
|---|---:|---:|---:|
| Verified renewal-off | 80 | 20 | **100** |
| Awaiting merchant confirmation | 5 | 3 | **8** |
| Authentication expired | 3 | 2 | **5** |
| Terms changed; fresh decision needed | 2 | 2 | **4** |
| Outcome unknown; reconcile without resubmission | 0 | 3 | **3** |
| **Approved subset** | **90** | **30** | **120** |

Full inventory accounting: **100 + 8 + 5 + 4 + 3 + 25 + 20 + 15 + 10 + 10 = 200**. The 30 browser paths run through the bounded pool; they do not require 200 simultaneous browsers. Newly authenticated/excluded items need a revised reviewed manifest, never silent addition to the 120.

Show `Needs attention`: 200 inventoried, 120 initially eligible/approved, 100 newly verified renewal-off, 25 already off, and itemized exceptions. Do not merge the 25 into newly executed success. Track eligible, approved, dispatched, verified and forecast-applied counts separately; the fixture does not establish exactly which pre-dispatch stage each auth/terms failure reached.

The 100 confirmed fixture items sum to **282,400 bani = 2,824 RON avoided future charges** in its explicit 28 Oct–27 Nov comparison window. This is fixture arithmetic, not observed savings. Its declared bank funds remain **110,000 RON**, refund cash is **0 by fixture assumption**, and annual savings are **not reported**. No extrapolation to the other 100 items, immediate cash credit or automatic ×12 is justified. Keep this separate from the single-trial **242 → 163 RON** UI scenario.

## Verified evidence, coverage and financial accounting

Normalize a receipt with issuer/account/contract, action and correlation ID, operation, authoritative status, effective/access dates, applicable terms, monetary consequences and verification source/time. Authenticate the issuer/channel and independently re-read the account state. A signed local wrapper proves local provenance, not that a merchant acted. If a merchant supplies no reliable account-bound confirmation/reconciliation path, retain `Needs checking`; never invent an external receipt number.

Keep statutory notices distinct from ordinary merchant-confirmed renewal changes. Where applicable law makes timely notice sufficient, merchant acceptance is not the legal precondition. Persist dispatch/delivery evidence, legal-effect basis and disputed status separately; route legal disputes to the approved bank/support process. A verified notice is not proof of a refund or bank settlement. [Consumer Rights Directive, Articles 11–12](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083).

Use an authenticated webhook inbox with signature verification, replay protection, tenant/account association and unique issuer/event IDs. Apply a monotonic merchant resource revision where available; otherwise fetch current authoritative state instead of ordering by delivery time. Preserve contradictory events for reconciliation. Forecast application failure leaves the contract confirmed and projection pending, without another cancellation.

Keep separate records for: inventory/source coverage and last check; submitted/pending/unknown/verified contract outcomes; dated net future charges avoided, including fees/proration/annual liabilities; requested/accepted refunds; and unique posted bank credits. Only settled bank events change spendable cash. Unknown usage, cost or coverage stays `Not reported`/unknown, never zero. Restore drills must preserve this separation; after lost dispatch history, freeze affected mutations and reconcile externally before any retry.

## EU deployment gate

The selected route is a feature within a partner bank. Before real data or real actions, the bank and supplier must approve the actual processing and regulated-service roles, permitted merchants, accountability, incident response and release evidence. Synthetic business data still does not make real user accounts, IP logs or accidentally uploaded personal information anonymous.

| Boundary | Required deployment decision |
|---|---|
| **GDPR** | Map controller/processor roles, purposes and lawful bases; minimize data, set retention/deletion and user-rights procedures; contract processors; assess special-category inferences, DPIA need, significant automated decisions and human review; document international transfers. Execution approval is not blanket privacy consent. EU hosting alone is insufficient. Prepare breach assessment/notification procedures, including Article 33's conditional 72-hour supervisory deadline. [GDPR, Articles 5–6, 9, 22, 25, 28, 32–35, 44–49](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679). |
| **AI Act** | Document intended use and provider/deployer responsibilities; disclose AI interaction where required. Subscription assistance is not automatically creditworthiness assessment. Credit scoring/creditworthiness and life/health-insurance risk/pricing can trigger Annex III classification. The Commission's 27 July 2026 notice reports revised high-risk dates of **2 December 2027 / 2 August 2028**; do not use the original blanket timetable. Verify the current consolidated law for the actual launch. [AI Act, Article 50 and Annex III](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689), [Commission amendment notice](https://digital-strategy.ec.europa.eu/en/news/ai-omnibus-enters-force). |
| **Bank access / payments / ICT** | Use bank-authorized services and mandates. If the supplier actually provides account-information or payment-initiation services, determine the relevant authorization/registration and authentication duties; a merchant cancellation grant is not payment SCA. Define DORA supplier contracts, audit, incidents, continuity and exit where applicable; a bank supplier is not automatically a designated critical ICT provider. [PSD2, Articles 66–67](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32015L2366), [DORA, Articles 2, 28–31](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2554). |
| **Merchant / consumer authority** | Validate owner/business/joint mandates, permitted automation and applicable national/sector rules. Do not bypass access controls, fabricate eligibility or substitute card/mandate blocking for contract termination. Cancellation, withdrawal and refund differ; digital-service exceptions and fixed commitments can matter. No universal “14-day refund” promise, and consumer rights cannot simply be applied to business contracts. [Consumer Rights Directive, Articles 6, 9, 16](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083). |

Concrete privacy/security design: minimize data sent to inference, contractually control provider retention/training use, approve subprocessors and regional flows, restrict production support access, and test deletion across uploads, derived facts, logs and backups while retaining only justified transaction/security evidence. Obtain bank/legal review of Romanian implementation and any credit/investment-advice expansion. These controls are release requirements, not evidence of legal compliance already obtained.

## Twenty-five acceptance scenarios

Future tests, not passed tests. Inject each condition at the module boundary and assert persisted state, allowed external requests, receipt/forecast/ledger changes and phone copy.

| # | Critical condition | Expected observable behavior |
|---|---|---|
| 1 | User says “cancel all 200” | Prepare the exact deduplicated manifest; execute nothing until trusted approval. Reference partitions above sum to 200. |
| 2 | Two household members concurrently approve/countermand one contract | Verify each mandate; use one canonical resource lock/action identity across their sessions. Joint-approval policy applies; conflicting operations require current state and fresh authority. |
| 3 | Another tenant guesses task/file/receipt IDs or opens an SSE/live-view URL | Deny every read/write/stream; no metadata, cached response or signed-link leakage across tenants/accounts. |
| 4 | Price, benefits, account or remaining obligation changes after approval | Reject the affected old capability, even below its maximum fee; recompute and ask again. Preserve unrelated confirmed items. |
| 5 | Expiry/revocation races final dispatch | Test both transactional orders: revoke-first blocks dispatch; dispatch-first may commit and is shown in flight/unknown until verified. No claim that Stop recalled it. |
| 6 | Phone closes, stream disconnects and LLM context is replaced | Durable children continue within authority/budgets; reconnect shows current state/cursor. No new action comes from replaying chat. |
| 7 | Queue duplicates delivery; worker loses lease while another starts | Current fencing token alone can authorize dispatch. Existing attempt/result is returned; an expired lease does not authorize repeating a possible external effect. |
| 8 | Browser click commits but response/worker is lost | Persist unknown, inspect existing reference/account and reconcile; no second confirmation click. Inconclusive evidence requires manual resolution. |
| 9 | Replacement activation/migration fails after other items succeed | Block dependent cancellation, retain working service/data, show partial results; no automatic reactivation purchase or global rollback. |
| 10 | Forged, duplicate and out-of-order webhooks | Reject forged/replayed input; deduplicate valid events; preserve newer authoritative state. Missing order/version triggers read-back, not guessed ordering. |
| 11 | Same import is uploaded twice; two genuine plans share merchant/amount | Deduplicate exact source identities with provenance; ask on ambiguous matches. Do not merge distinct contracts or create double savings. |
| 12 | Cloud/storage cancellation deletes files or removes team access | Exclude from ordinary bulk approval; require verified usable export/migration/replacement and explicit consequence review. An initiated download is insufficient. |
| 13 | Annual prepaid plan or unpaid minimum-term installments | Stop renewal only as approved; retain remaining debt/access dates. No automatic refund or full annual saving from a one-month horizon. |
| 14 | Free trial/promotion expires at the deadline or clock changes | Use merchant timezone and absolute instant; recheck conversion price, cutoff and post-promo terms. A missed cutoff is visible; do not claim an already-due charge avoided. |
| 15 | Phone usage is missing/low but household, TV or background use exists | Store `Not reported` where unknown; ask relevant questions. No zero-use assumption or automatic “unused” cancellation. |
| 16 | Invoice/page/tool result says to export tokens or approve a different action | Treat as untrusted evidence; reject unauthorized destinations/actions at policy and network gates. Persist no authoritative preference from the injection. |
| 17 | Merchant token, viewing token or signed capability is stolen | Scope/audience/current-session and revocation checks contain reuse; revoke affected access and freeze dispatch. No secret enters vision, logs or replay. |
| 18 | Fetch/page redirects or DNS-rebinds to metadata/private IPv4/IPv6; popup/WebSocket bypass attempted | Deny at connection-time egress across cloud and browser paths, including fallback DNS/redirects; no internal response reaches model or UI. |
| 19 | Upload is a polyglot, huge image/PDF, decompression bomb or CSV formula | Bound/deny parsing, preserve tenant isolation and inert preview; exported formulas including hidden-prefix variants cannot execute. Untested formats stay disabled. |
| 20 | Merchant locks account, login expires, CAPTCHA/2FA appears, or user takes over | Pause/release scarce slots; supported protected user login or manual handoff. No evasion. Agent loses input fence until explicit return and state recheck. |
| 21 | Card/mandate is blocked; merchant still bills after cancellation | Keep contract, mandate, card and bank-event states distinct. Record posted charge and investigate effective terms; do not delete history or assume contract ended. |
| 22 | Emergency fleet stop occurs with mixed confirmed/in-flight/queued work | Close new dispatch gate, itemize already-started work, preserve receipts and authorized verification. Full read revocation stops checks; resumption never erases unknowns. |
| 23 | Database/dispatch journal is lost or restored to an older backup | Freeze affected mutations; recover audit/receipt references and reconcile externally. Missing approval/history never becomes permission to rerun. Demonstrate the bank-approved recovery targets. |
| 24 | One user floods batches during merchant outage/rate limits near trial cutoff | Shared caps, fairness and cost budgets hold; `Retry-After` releases slots. Expose coverage/deadline failure; do not invent success, bypass limits or starve verification. |
| 25 | Cancellation confirmed but forecast fails; refund accepted/credit duplicated | Keep contract confirmed and projection pending; do not repeat cancellation. Merchant acceptance creates no cash; one unique posted bank credit changes the ledger once. |

## Evidence required to close this review

For the synthetic demo: identified build/fixture revisions, an actual rendered fake-merchant cancellation, signed-grant rejection tests, both stop/dispatch race orders, worker/phone restart, duplicate delivery, ambiguous browser outcome, cross-account denial and the complete 200-item partition with per-item receipts/exceptions. Static fixture totals alone close none of these runtime gates.

Before bank pilot: complete P0 decisions; adversarial browser/cloud egress and credential-capture tests; independent application/connector review; multi-user fairness/cost/load measurements; a restore drill with agreed recovery targets; and bank/legal/privacy/operations acceptance of the real flows. Record residual unsupported merchants and human support capacity.

Research was static and read-only using primary documentation. Several full EUR-Lex text requests were challenged; indexed EUR-Lex provisions and the current Commission notice were available. The OWASP agentic download timed out; its official page and indexed primary excerpts were used. This review does not claim a full consolidated-law examination or ASVS assessment. No shared browser was driven, dependencies installed, application tests run or other files edited.
