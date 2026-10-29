# NextMove

A fictional mobile bank with a financial AI agent for personal and business decisions. Accounts, money, offers and merchant systems are synthetic; model inference, deterministic calculations, browser interactions and persisted outcomes actually run.

NextMove has its own yellow/ink/white identity inspired by the supplied banking references. It claims no Raiffeisen affiliation. This repository does not establish production banking readiness, legal certification or live merchant coverage, and no production deployment is authorized.

Built by team Mr Laziz (Teo, Eduard and Cosmin) for the Raiffeisen Bank challenge at NEXXT 2026.

## For reviewers: check it in about ten minutes

1. `npm install && npx playwright install chromium`, then `npm run demo`, and open http://127.0.0.1:3210.
2. **Core workflow (T2):** sign in as Alex with "Start a separate copy" ticked. Home flags the FitFlow trial before it charges. Then:
   - **Review my options:** a deterministic comparison (upcoming charges 242.00 → 163.00 RON).
   - **Review and approve:** an exact approval showing the operation, the route, the money and a 10-minute window.
   - **The provider page:** NextMove works on the simulated provider's own page in an isolated browser.
   - **The receipt:** read back independently, with the balance unchanged and 79.00 RON avoided.
3. **The agent:** on the Agent tab, ask in your own words, for example "Am I paying twice for cloud storage?" or "Cancel FitFlow and check whether rent clears". Each task shows which planner answered (the live model, or the labelled simulated planner), the typed tools it called, the deterministic calculations and an activity trail with an evidence level for every step. Nothing moves without your approval.
4. **Unexpected input:**
   - "cancel everything" asks what to stop;
   - "don't cancel anything, just show my balance" is read as a negation;
   - "block my card" gets an honest "this demo can't";
   - an invoice image containing instructions is treated as data.
5. **Tests:** `npm test` (unit and integration) and, with the stack running, `npm run test:e2e` then `npm run evidence:manifest`, which writes [evidence/MANIFEST.md](evidence/MANIFEST.md).

## Start here

- [Implementation brief](docs/IMPLEMENTATION-BRIEF.md) and [implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Architecture decisions](docs/adr/README.md)
- [Domain language](CONTEXT.md)
- [Accepted product scope](PRODUCT-SCOPE.md)
- [Security and scale contract](design/SECURITY-AND-SCALE.md)
- [Mobile UX](design/MOBILE-UX.md) and [design system](design/DESIGN-SYSTEM.md)
- [UI fixtures](design/ui-fixtures.json), [financial cases](demo/cases.json), [200-item acceptance fixture](demo/bulk-cancellations.json)

## Discord feature extension

The original 22 capability groups are extended with interactive agent charts/sliders; Trial Shield for a 0/1 RON card verification followed by a held charge; four hidden-cost analyses; an editable route to the home goal; and Cash Autopilot/Bill Vault/Overdraft Shield using approved internal transfers. Financial Airbag adds O9, bringing the catalogue to 31 distinct capability IDs. All provider, charge-hold and transfer operations remain synthetic. See [the feature notes](docs/DISCORD-PROPOSALS.md) and [ADR 0008](docs/adr/0008-scheduled-bank-internal-transfers.md).

The approved follow-up also adds [Simple mode (Bunic Mode)](docs/features/bunic-mode.md): larger text and controls, context-scoped saved preferences, optional read-aloud and editable voice drafts. Profile → Display and voice switches it on. Speech never sends a question or approves an action. Actual microphone/speaker behavior still needs a human device check; browser speech support varies.

[Financial Airbag](docs/features/financial-airbag.md) is on Alex Home. All services initially stay unchanged. Choose a supported pause or renewal-off, recalculate and review the exact selected actions before approval. Essential bills and data/student-tool dependencies stay protected. Confirmed future charges avoided do not increase current cash.

## Requirements

- Node >= 24 (developed on Node 26). Storage uses the built-in `node:sqlite`.
- `npm install`, then `npx playwright install chromium`.
- Optional: an authenticated Claude Code CLI (`claude`) for the live model. Without it, the planner falls back to a labelled simulated planner, and image reading returns an error that offers manual entry.

## Run

| Command | What it does |
| --- | --- |
| `npm run demo` | Production stack. Builds if needed, starts the simulated merchant (3211), seeds data, then starts the worker and Next.js (3210). Binds to 127.0.0.1 only; PIDs go to `.data/pids.json`. |
| `npm run dev` | Same stack with `next dev`. |
| `npm run stop` | Stops only the processes started by `demo`/`dev`. |
| `npm run reset` | Resets demo data and keeps `.data/local-secrets.json`. `npm run reset -- --all` deletes that file too. |

Open http://127.0.0.1:3210. Health is at `/api/health`; merchant health is at http://127.0.0.1:3211/health.

To run a second copy alongside (for example, for E2E runs while you use the first), give it its own ports, data folder and build folder:

```sh
NEXTMOVE_BANK_PORT=3290 NEXTMOVE_MERCHANT_PORT=3291 NEXTMOVE_DATA_DIR=.data-2 NEXTMOVE_NEXT_DIST_DIR=.next-2 npm run demo
```

Then point the E2E suite at it with `NEXTMOVE_BANK_URL=http://127.0.0.1:3290`.

On the sign-in screen, choose Alex (personal) or Laziz (business plus household). "Start a separate copy" gives you an isolated tenant. Labs controls (demo clock, provider simulations, reset) are under Profile and on each capability page.

## Configuration

Copy values from [`.env.example`](.env.example) as needed. It defines:

- `NEXTMOVE_MODEL`: runtime model, default `claude-sonnet-5-5`.
- `NEXTMOVE_PLANNER`: `auto` (live when the CLI smoke test passes), `live` or `simulated`.
- `NEXTMOVE_MODE`: `labs` or `bank-demo`. In `bank-demo`, execution is refused on both the server and the worker.
- `NEXTMOVE_CLAUDE_BIN`, `NEXTMOVE_MODEL_TIMEOUT_MS`, `NEXTMOVE_MODEL_MAX_BUDGET_USD`: CLI adapter path, per-call timeout and spend bound.
- `NEXTMOVE_BANK_PORT`, `NEXTMOVE_MERCHANT_PORT`, `NEXTMOVE_BANK_BASE_URL`, `NEXTMOVE_MERCHANT_BASE_URL`: loopback ports and origins.
- `NEXTMOVE_DATA_DIR`: runtime data directory, default `.data`. `NEXTMOVE_NEXT_DIST_DIR`: Next.js build folder, default `.next`; a second copy needs its own.
- `NEXTMOVE_CLAUDE_CONFIG_DIR`: the Claude Code config folder the CLI signs in from, when it isn't the default `~/.claude`. Put it in `.env.local`, which Git ignores.

No API key is needed. `npm run smoke:model` runs one live text call and one live vision call against the configured model.

## Tests and QA

| Command | Notes |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Vitest unit and integration tests: 678 tests in 55 files, about 60 s. The integration suite starts its own isolated stack on random loopback ports. |
| `npm run test:live` | Reserved for live-model Vitest tests (`tests/live`, not written yet). The live model is exercised by `tests/e2e/05-live-model.spec.ts` instead. |
| `npm run test:e2e` | Playwright phone E2E in `tests/e2e` (26 scenarios, about 2.5 min), against an already running stack. Runs at 390x844, plus 360 and 430 for tests tagged `@layout`. Records a video of every test. |
| `npm run evidence:manifest` | Turns the last E2E run into [evidence/MANIFEST.md](evidence/MANIFEST.md): each scenario's result, test, reproduce command and video timestamps. Copies the videos to `evidence/recordings/` (ignored by Git). |
| `cd extensions && npm run check` | The extension domain modules: typecheck plus 310 tests. |
| `node --import tsx scripts/qa-screens.ts --widths=360,390,430` | Screenshots every phone route into `.data/qa/` and reports horizontal overflow, console errors, broken links and small tap targets. |

The last full E2E run passed all 26 scenarios, live-model tests included; see the [evidence index](evidence/MANIFEST.md). E2E tests that use the live model need an authenticated Claude Code CLI.

## Layout

- `src/app`: phone UI routes and the API route handlers.
- `src/ui`: UI kit and client helpers.
- `src/server`: API router, authority, execution, capabilities, agent, model adapter, bank, evidence, monitoring and db.
- `src/merchant`: simulated merchant origin.
- `src/worker`: durable worker.
- `scripts`: run, stop, reset, seed, model smoke test and QA tools.
- `tests`: `unit`, `integration`, `live` and `e2e`.
- `demo` and `fixtures`: scenario data and fixture images. The app does not edit fixtures.

## Safety

- Everything is fictional and runs on loopback only.
- No real bank, merchant, card or payment exists.
- Runtime data under `.data/` is ignored by Git.
- The model never gets URL, shell, script or write tools.
- Auth, CAPTCHA and 2FA on provider pages return blocked/manual and are never bypassed.

## Collaboration

Main contains reviewable decisions and verified application changes. Preserve unrelated work, use branches for concurrent code, keep credentials and runtime databases outside Git, and attach evidence to functional claims.
