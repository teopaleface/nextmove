import path from "node:path";
import fs from "node:fs";
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
  get modelTimeoutMs() {
    return Number(env("NEXTMOVE_MODEL_TIMEOUT_MS", "90000"));
  },
  get modelMaxBudgetUsd() {
    return env("NEXTMOVE_MODEL_MAX_BUDGET_USD", "0.50");
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
