import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomBytes } from "node:crypto";

export type PlannerMode = "live" | "simulated" | "auto";
export type RunMode = "labs" | "bank-demo";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function repoRoot(): string {
  return process.env.NEXTMOVE_ROOT ? path.resolve(process.env.NEXTMOVE_ROOT) : process.cwd();
}

export function dataDir(): string {
  const dir = path.resolve(repoRoot(), env("NEXTMOVE_DATA_DIR", ".data"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const config = {
  get bankPort() {
    return Number(env("NEXTMOVE_BANK_PORT", "3210"));
  },
  get merchantPort() {
    return Number(env("NEXTMOVE_MERCHANT_PORT", "3211"));
  },
  get bankBaseUrl() {
    return env("NEXTMOVE_BANK_BASE_URL", `http://127.0.0.1:${this.bankPort}`);
  },
  get merchantBaseUrl() {
    return env("NEXTMOVE_MERCHANT_BASE_URL", `http://127.0.0.1:${this.merchantPort}`);
  },
  get model() {
    return env("NEXTMOVE_MODEL", "claude-sonnet-5-5");
  },
  get planner(): PlannerMode {
    const v = env("NEXTMOVE_PLANNER", "auto");
    return v === "live" || v === "simulated" ? v : "auto";
  },
  get claudeBin() {
    return env("NEXTMOVE_CLAUDE_BIN", "claude");
  },
  /**
   * The CLI's config directory (its sign-in and settings), passed to it as CLAUDE_CONFIG_DIR. Empty: whatever
   * CLAUDE_CONFIG_DIR the server was started with, else the CLI's default (~/.claude). A leading ~ is the home folder.
   */
  get claudeConfigDir() {
    const v = env("NEXTMOVE_CLAUDE_CONFIG_DIR", process.env.CLAUDE_CONFIG_DIR ?? "");
    return v.startsWith("~") ? path.join(os.homedir(), v.slice(1)) : v;
  },
  /** Per-call timeout; an unreadable or out-of-range setting falls back to 90 s instead of timing out at once. */
  get modelTimeoutMs() {
    const v = Number(env("NEXTMOVE_MODEL_TIMEOUT_MS", "90000"));
    return Number.isFinite(v) && v >= 1000 && v <= 600_000 ? v : 90_000;
  },
  get modelMaxBudgetUsd() {
    return env("NEXTMOVE_MODEL_MAX_BUDGET_USD", "0.50");
  },
  /** Live-model calls allowed in any 24 hours, across every tenant. */
  get modelDailyCalls() {
    return Number(env("NEXTMOVE_MODEL_DAILY_CALLS", "300"));
  },
  /** Live-model spend allowed in any 24 hours, in USD; a call that reported no cost counts at its per-call maximum. */
  get modelDailyUsd() {
    return Number(env("NEXTMOVE_MODEL_DAILY_USD", "15"));
  },
  /** Live-model calls one tenant may start in any 24 hours. */
  get modelTenantDailyCalls() {
    return Number(env("NEXTMOVE_MODEL_TENANT_DAILY_CALLS", "60"));
  },
  get mode(): RunMode {
    return env("NEXTMOVE_MODE", "labs") === "bank-demo" ? "bank-demo" : "labs";
  },
  get bankDbPath() {
    return path.join(dataDir(), env("NEXTMOVE_BANK_DB", "bank.sqlite"));
  },
  get merchantDbPath() {
    return path.join(dataDir(), env("NEXTMOVE_MERCHANT_DB", "merchant.sqlite"));
  },
};

/**
 * Locally generated secrets (partner integration HMAC key, merchant admin token, token encryption key).
 * Generated on first use into the ignored data directory; never committed or logged.
 */
export interface LocalSecrets {
  partnerHmacKey: string;
  merchantAdminToken: string;
  tokenEncryptionKey: string; // base64, 32 bytes
}

let cachedSecrets: LocalSecrets | null = null;

export function localSecrets(): LocalSecrets {
  if (cachedSecrets) return cachedSecrets;
  const file = path.join(dataDir(), "local-secrets.json");
  if (fs.existsSync(file)) {
    cachedSecrets = JSON.parse(fs.readFileSync(file, "utf8")) as LocalSecrets;
    return cachedSecrets;
  }
  const fresh: LocalSecrets = {
    partnerHmacKey: randomBytes(32).toString("hex"),
    merchantAdminToken: randomBytes(24).toString("hex"),
    tokenEncryptionKey: randomBytes(32).toString("base64"),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600, flag: "wx" });
    cachedSecrets = fresh;
  } catch {
    // Another process created it first; read theirs so every process agrees.
    cachedSecrets = JSON.parse(fs.readFileSync(file, "utf8")) as LocalSecrets;
  }
  return cachedSecrets;
}
