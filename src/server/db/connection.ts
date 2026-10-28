import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { BANK_SCHEMA, BANK_SCHEMA_VERSION } from "./schema";

export type Db = DatabaseSync;
export type Row = Record<string, any>;

const globalKey = Symbol.for("nextmove.bankdb");
type GlobalWithDb = typeof globalThis & { [globalKey]?: Map<string, DatabaseSync> };

function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=8000;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA synchronous=NORMAL;");
  return db;
}

export function migrate(db: DatabaseSync): void {
  // Runtime databases are disposable local state. An older layout is refused loudly instead of half-migrated.
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
  if (meta) {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='bank_schema_version'").get() as { value: string } | undefined;
    if (row && Number(row.value) !== BANK_SCHEMA_VERSION) {
      throw new Error(`Local bank database uses schema v${row.value}; this build needs v${BANK_SCHEMA_VERSION}. Run \`npm run stop && npm run reset\` to recreate local demo data.`);
    }
  }
  db.exec(BANK_SCHEMA);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('bank_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(BANK_SCHEMA_VERSION),
  );
}

/** Process-wide bank database handle (cached across Next.js dev reloads). */
export function bankDb(file: string = config.bankDbPath): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  g[globalKey] ??= new Map();
  const existing = g[globalKey]!.get(file);
  if (existing) return existing;
  const db = openDatabase(file);
  migrate(db);
  g[globalKey]!.set(file, db);
  return db;
}

export function closeBankDb(file: string = config.bankDbPath): void {
  const g = globalThis as GlobalWithDb;
  const db = g[globalKey]?.get(file);
  if (db) {
    db.close();
    g[globalKey]!.delete(file);
  }
}

export class ConflictError extends Error {
  status = 409;
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Run fn inside BEGIN IMMEDIATE (single writer). SQLite serializes writers, which gives the dispatch gate
 * and revocation a total order. Retries briefly when another process holds the write lock.
 */
let savepoints = 0;

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  // Re-entrant: an inner unit of work inside an open transaction becomes a savepoint of the outer one.
  if (db.isTransaction) {
    const name = `sp_${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err: any) {
      if (attempt < 20 && /locked|busy/i.test(String(err?.message))) {
        const until = Date.now() + 25 + attempt * 10;
        while (Date.now() < until) {
          /* short spin; busy_timeout normally handles this */
        }
        continue;
      }
      throw err;
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

export function one<T = Row>(db: DatabaseSync, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(db: DatabaseSync, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function json<T = any>(value: string | null | undefined, fallback: T = null as T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
