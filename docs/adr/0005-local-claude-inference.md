# Local Claude Code CLI inference with schema-bound decisions and no CLI tools

No application API key is present, while the developer's first-party Claude Code CLI is signed in. For this local developer-operated demo, the server runs the CLI headlessly, after a bounded smoke test. Prompts go through stdin with fixed argument arrays; read only supported CLI output, never credentials or OAuth tokens. Keep requests scoped, bounded and separate from execution authority.

**What is built.** The CLI never calls a tool. Each planner turn is one CLI call whose answer must match a JSON schema (`--json-schema`): the model picks exactly one of NextMove's typed tools (`overview`, `find_capability`, `analyze`, `ask_user`, `prepare_proposal`, `show_simulation`, `final_answer`) with its arguments. The server checks that decision, runs the tool itself in `src/server/agent/orchestrator.ts`, records the step and sends the history with the next call. No MCP server is loaded, so the CLI holds no NextMove capability of its own. Vision extraction uses the same adapter with images in the stdin message.

`src/server/model/claude-cli.ts` builds the argv; `HARDENING_FLAGS` lists what every call must carry:

- `--tools ""`: no built-in tool (no Bash, file, web or agent tools);
- `--strict-mcp-config` with no `--mcp-config`: no MCP server from any settings file;
- `--disable-slash-commands`, `--safe-mode`, `--no-session-persistence`;
- `--setting-sources user`: project and local settings are not loaded, so a checkout cannot add hooks, permissions or servers;
- `--permission-prompts none`: anything that would ask for permission is denied.

The CLI runs in an empty sandbox directory with a minimal environment, a per-call budget (`--max-budget-usd`), a timeout, an output cap and at most two concurrent calls. `callModel` refuses to start the CLI if the argv lacks a hardening flag or carries `--mcp-config`, `--allowedTools`, `--settings`, `--bare` or `--dangerously-skip-permissions`; the worker checks the same at startup and reports the planner `MISCONFIGURED` instead of ready. `tests/unit/claude-cli-args.test.ts` asserts the flags.

**Left out on purpose.** `--bare` reads only `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed with `--settings`, never the OAuth or keychain sign-in this demo uses. `--restricted` ignores user settings, where a CLI sign-in through `apiKeyHelper` can live. User settings could still add hooks or MCP servers; with `--tools ""`, `--strict-mcp-config` and `--permission-prompts none` no tool can run, and the developer controls that file.

**What the model may decide.** The model chooses tools and arguments; code owns permissions, numbers and money. `analyze` accepts only the inputs listed for that capability in `src/server/agent/planner-inputs.ts`, and only values the customer gave: numbers they wrote, text they wrote, or their answer to that capability's own question (`ask_user` with `capabilityId` and `inputKey`, which shows the capability's wording and options). Inputs that lower a protection are never settable by the model. The review screen lists the inputs used. The final answer is withheld if it cites a number no calculation produced or claims something was done. Mutating actions still need the server-issued approval grant from ADR 0003, and money stays with ADR 0004.

**Not built.** An earlier version of this decision planned a local NextMove MCP server with per-tool allowlists in `config/agent-tools.allowlist.json`, enforced through `--allowedTools` and `--mcp-config`. Nothing loads that file; it is kept as the design record for that path, and every tool in it is disabled. If MCP tools are added later, they start from that file under the rules it states.

An explicit API adapter may be enabled later through privately supplied configuration; no secret is committed or silently sourced from unrelated projects. If live inference is unavailable, expose that fact and offer a clearly labelled deterministic simulation. A scripted fallback must never be presented as a live model decision. This developer adapter is not a public hosted authentication design or an assumption of API credits from subscriptions.
