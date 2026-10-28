# NextMove

A fictional mobile bank with a financial AI agent for personal and business decisions. Accounts, money, offers and merchant systems are synthetic; model inference, deterministic calculations, browser interactions and persisted outcomes actually run.

NextMove has its own yellow/ink/white identity inspired by the supplied banking references. It claims no Raiffeisen affiliation. This repository does not establish production banking readiness, legal certification or live merchant coverage, and no production deployment is authorized.

## Start here

- [Implementation brief](docs/IMPLEMENTATION-BRIEF.md) and [implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Architecture decisions](docs/adr/README.md)
- [Domain language](CONTEXT.md)
- [Accepted product scope](PRODUCT-SCOPE.md)
- [Security and scale contract](design/SECURITY-AND-SCALE.md)
- [Mobile UX](design/MOBILE-UX.md) and [design system](design/DESIGN-SYSTEM.md)
- [UI fixtures](design/ui-fixtures.json), [financial cases](demo/cases.json), [200-item acceptance fixture](demo/bulk-cancellations.json)

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

On the sign-in screen, choose Alex (personal) or Laziz (business plus household). "Start a separate copy" gives you an isolated tenant. Labs controls (demo clock, provider simulations, reset) are under Profile and on each capability page.

## Configuration

Copy values from [`.env.example`](.env.example) as needed. It defines:

- `NEXTMOVE_MODEL`: runtime model, default `claude-sonnet-5-5`.
- `NEXTMOVE_PLANNER`: `auto` (live when the CLI smoke test passes), `live` or `simulated`.
- `NEXTMOVE_MODE`: `labs` or `bank-demo`. In `bank-demo`, execution is refused on both the server and the worker.
- `NEXTMOVE_CLAUDE_BIN`, `NEXTMOVE_MODEL_TIMEOUT_MS`, `NEXTMOVE_MODEL_MAX_BUDGET_USD`: CLI adapter path, per-call timeout and spend bound.
- `NEXTMOVE_BANK_PORT`, `NEXTMOVE_MERCHANT_PORT`, `NEXTMOVE_BANK_BASE_URL`, `NEXTMOVE_MERCHANT_BASE_URL`: loopback ports and origins.
- `NEXTMOVE_DATA_DIR`: runtime data directory, default `.data`.

No API key is needed. `npm run smoke:model` runs one live text call and one live vision call against the configured model.

## Tests and QA

| Command | Notes |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Vitest unit and integration tests (about 60 s). The integration suite starts its own isolated stack on random loopback ports. |
| `npm run test:live` | Live-model tests; sets `NEXTMOVE_LIVE_TESTS=1` and needs the CLI. `tests/live` is empty, so live tests are not written yet. |
| `npm run test:e2e` | Playwright phone E2E in `tests/e2e`, against an already running stack. Runs at 390x844, plus 360 and 430 for tests tagged `@layout`. |
| `node --import tsx scripts/qa-screens.ts --widths=360,390,430` | Screenshots every phone route into `.data/qa/` and reports horizontal overflow, console errors, broken links and small tap targets. |

Full E2E runs, recordings and the evidence manifest are postponed to a later pass: the E2E suite exists but has not been run end to end yet. The `evidence:manifest` script points at `scripts/evidence-manifest.ts`, which does not exist yet.

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
