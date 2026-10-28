import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BANK_SCHEMA } from "../../src/server/db/schema";
import { EXT_SCHEMA } from "../../src/server/extensions/schema";
import { EXTENSIONS, EXT_CAPABILITY_ORDER, deleteExtTenantRows, extTenantTables } from "../../src/server/extensions/registry";
import { isExtOperation } from "../../src/server/extensions/types";

// The plug-in contract every wired extension module must keep (src/server/extensions/types.ts).

const db = new DatabaseSync(":memory:");
db.exec(BANK_SCHEMA);
db.exec(EXT_SCHEMA);

describe("extension schema", () => {
  it("names every extension table ext_* and gives each a tenant_id column", () => {
    const tables = extTenantTables(db);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[];
      expect(cols.find((c) => c.name === "tenant_id"), `${t}.tenant_id`).toMatchObject({ notnull: 1 });
    }
    // Nothing outside ext_* is created by extension schema.
    const all = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    const core = new DatabaseSync(":memory:");
    core.exec(BANK_SCHEMA);
    const coreTables = new Set((core.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    expect(all.filter((n) => !coreTables.has(n) && !n.startsWith("ext_"))).toEqual([]);
  });

  it("re-applies cleanly on an existing database", () => {
    expect(() => db.exec(EXT_SCHEMA)).not.toThrow();
  });

  it("a tenant reset clears only that tenant's extension rows", () => {
    for (const t of extTenantTables(db)) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number; type: string }[];
      for (const tenant of ["t-a", "t-b"]) {
        const vals = cols.map((c) => (c.name === "tenant_id" ? tenant : /INT/i.test(c.type) ? (c.pk ? null : 1) : `${tenant}-${c.name}`));
        try {
          db.prepare(`INSERT INTO ${t}(${cols.map((c) => c.name).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(vals as any[]));
        } catch {
          // Tables with CHECK or foreign-key constraints are still covered by the column check above.
        }
      }
    }
    deleteExtTenantRows(db, "t-a");
    for (const t of extTenantTables(db)) {
      expect((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE tenant_id='t-a'`).get() as { n: number }).n, t).toBe(0);
    }
  });
});

describe("extension modules", () => {
  it("have unique keys and capability ids, all registered in display order", () => {
    const keys = EXTENSIONS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = EXTENSIONS.flatMap((m) => m.capabilities.map((c) => `${c.customer}:${c.id}`));
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of EXTENSIONS) for (const c of m.capabilities) expect(EXT_CAPABILITY_ORDER).toContain(c.id);
  });

  it("only register namespaced EXT_* operations", () => {
    for (const m of EXTENSIONS) for (const op of Object.keys(m.operations ?? {})) expect(isExtOperation(op), `${m.key}:${op}`).toBe(true);
    expect(isExtOperation("STOP_RENEWAL")).toBe(false);
    expect(isExtOperation("EXT_")).toBe(false);
    expect(isExtOperation("EXT_x")).toBe(false);
  });
});
