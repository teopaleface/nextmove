import { describe, expect, it } from "vitest";
import { HARDENING_FLAGS, cliArgs, hardeningProblems } from "../../src/server/model/claude-cli";

// ADR 0005: every CLI call runs with no tools, no MCP servers, no project settings and no permission prompts.

describe("Claude CLI argv", () => {
  const argv = cliArgs("claude-test", "system", { type: "object" });

  it("carries every hardening flag with its exact value", () => {
    const at = (f: string) => argv[argv.indexOf(f) + 1];
    expect(at("--tools")).toBe("");
    expect(at("--setting-sources")).toBe("user");
    expect(at("--permission-prompts")).toBe("none");
    for (const f of ["--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) expect(argv).toContain(f);
    expect(hardeningProblems(argv)).toEqual([]);
    expect(HARDENING_FLAGS.length).toBe(7);
  });

  it("never loads an MCP server, a tool allowlist or another sign-in", () => {
    for (const f of ["--mcp-config", "--allowedTools", "--allowed-tools", "--settings", "--bare", "--restricted", "--dangerously-skip-permissions"]) expect(argv).not.toContain(f);
    expect(argv.slice(-2)).toEqual(["--json-schema", JSON.stringify({ type: "object" })]);
  });

  it("reports a missing or widened flag", () => {
    expect(hardeningProblems(argv.filter((a) => a !== "--strict-mcp-config"))).toEqual(["missing --strict-mcp-config"]);
    const i = argv.indexOf("--tools");
    expect(hardeningProblems([...argv.slice(0, i + 1), "Bash", ...argv.slice(i + 2)])).toEqual(['missing --tools']);
    expect(hardeningProblems([...argv, "--mcp-config", "x.json"])).toEqual(["unexpected --mcp-config"]);
  });
});
