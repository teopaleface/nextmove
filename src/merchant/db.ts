import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// The simulated merchant origin owns this database. The bank never opens it.

export const MERCHANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS m_tenants (id TEXT PRIMARY KEY, customer TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS m_clocks (tenant_id TEXT PRIMARY KEY, base_ms INTEGER NOT NULL, anchor_real_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS m_merchants (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
  connector TEXT NOT NULL, read_api INTEGER NOT NULL, operations_json TEXT NOT NULL, manual_route TEXT,
  ref_prefix TEXT NOT NULL, next_ref INTEGER NOT NULL, policy_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS m_accounts (
  tenant_id TEXT NOT NULL, merchant_id TEXT NOT NULL, id TEXT NOT NULL, holder TEXT NOT NULL,
  token_hash TEXT NOT NULL, token_state TEXT NOT NULL, expire_after_reads INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, merchant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS m_accounts_token ON m_accounts(token_hash);
CREATE TABLE IF NOT EXISTS m_contracts (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, merchant_id TEXT NOT NULL, account_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, price_minor INTEGER NOT NULL, billing_period TEXT NOT NULL,
  state TEXT NOT NULL, auto_renew INTEGER NOT NULL, next_charge_at TEXT, access_until TEXT,
  terms_revision INTEGER NOT NULL, resource_version INTEGER NOT NULL DEFAULT 1,
  minimum_term_until TEXT, exit_fee_minor INTEGER, owner_kind TEXT NOT NULL DEFAULT 'SELF', shared INTEGER NOT NULL DEFAULT 0,
  protected_reason TEXT, benefits_json TEXT NOT NULL DEFAULT '{}', details_json TEXT NOT NULL DEFAULT '{}', pending_json TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS m_faults (
  tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, contract_id, kind)
);
CREATE TABLE IF NOT EXISTS m_requests (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, merchant_id TEXT NOT NULL, account_id TEXT NOT NULL, contract_id TEXT,
  operation TEXT NOT NULL, correlation_id TEXT, idempotency_key TEXT, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL, receipt_ref TEXT, reason TEXT, channel TEXT NOT NULL, params_json TEXT NOT NULL,
  created_at TEXT NOT NULL, resolve_at TEXT, resolve_to TEXT, resolved_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS m_requests_idem ON m_requests(tenant_id, merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS m_requests_corr ON m_requests(tenant_id, correlation_id);
CREATE TABLE IF NOT EXISTS m_receipts (
  tenant_id TEXT NOT NULL, ref TEXT NOT NULL, merchant_id TEXT NOT NULL, account_id TEXT NOT NULL, contract_id TEXT,
  request_id TEXT, operation TEXT NOT NULL, status TEXT NOT NULL, effective_at TEXT, access_until TEXT,
  terms_revision INTEGER, correlation_id TEXT, channel TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, visible_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ref)
);
CREATE TABLE IF NOT EXISTS m_offers (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, merchant_id TEXT NOT NULL, revision INTEGER NOT NULL,
  terms_json TEXT NOT NULL, published_at TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id, revision)
);
CREATE TABLE IF NOT EXISTS m_cases (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, merchant_id TEXT NOT NULL, account_id TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL, amount_minor INTEGER, reference TEXT, details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS m_messages (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, counterparty_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  correlation_id TEXT, received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS m_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, issuer TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE IF NOT EXISTS m_web_forms (token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT);
`;

let instance: DatabaseSync | null = null;

export function merchantDb(file: string): DatabaseSync {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA synchronous=NORMAL;");
  db.exec(MERCHANT_SCHEMA);
  instance = db;
  return db;
}

export function mtx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function mget<T = any>(db: DatabaseSync, sql: string, ...p: any[]): T | undefined {
  return db.prepare(sql).get(...p) as T | undefined;
}
export function mall<T = any>(db: DatabaseSync, sql: string, ...p: any[]): T[] {
  return db.prepare(sql).all(...p) as T[];
}
export function mrun(db: DatabaseSync, sql: string, ...p: any[]) {
  return db.prepare(sql).run(...p);
}
