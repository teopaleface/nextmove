import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../src/server/config";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["NEXTMOVE_CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "NEXTMOVE_MODEL_TIMEOUT_MS"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("model CLI settings", () => {
  it("chooses the CLI's config directory: the setting, else the one the server started with, else none", () => {
    delete process.env.NEXTMOVE_CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(config.claudeConfigDir).toBe("");
    process.env.CLAUDE_CONFIG_DIR = "/tmp/started-with";
    expect(config.claudeConfigDir).toBe("/tmp/started-with");
    process.env.NEXTMOVE_CLAUDE_CONFIG_DIR = "~/.claude-businice";
    expect(config.claudeConfigDir).toBe(path.join(os.homedir(), ".claude-businice"));
  });

  it("an unreadable or out-of-range timeout falls back to 90 s instead of timing out every call", () => {
    for (const [v, want] of [["abc", 90_000], ["0", 90_000], ["-5", 90_000], ["999999999", 90_000], ["1500", 1500], ["30000", 30_000]] as const) {
      process.env.NEXTMOVE_MODEL_TIMEOUT_MS = v;
      expect(config.modelTimeoutMs, v).toBe(want);
    }
  });
});
