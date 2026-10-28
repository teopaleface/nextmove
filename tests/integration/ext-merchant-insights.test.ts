import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { funds, startStack, type Stack } from "./harness";

// E4 Merchant insights through the production router: a read-only capability over a synthetic, pseudonymous cohort.
// Groups below k = 20 customers show "not enough data", the page never exposes customer keys, and nothing is executable.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const table = (e4: any, title: string) => e4.blocks.find((b: any) => b.kind === "table" && b.title.startsWith(title));
const row = (tbl: any, name: string) => tbl.rows.find((r: any) => r.cells[0] === name)?.cells;

describe("E4 merchant insights", () => {
  it("labels the cohort as synthetic and reports track record, price radar and difficulty honestly", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const e4 = await a.json("/api/capabilities/E4");
    expect(e4.blocks[0]).toMatchObject({ kind: "note", tone: "info" });
    expect(e4.blocks[0].text).toContain("Synthetic demo cohort");
    expect(e4.candidates).toEqual([]);
    expect(e4.inputs).toEqual([]);
    expect(e4.numbers).toMatchObject({ merchants: 8, covered: 3, flagged: 1, priceAlerts: 1, hard: 1, k: 20 });

    const track = table(e4, "Track record");
    expect(row(track, "PulseGym")?.[3]).toBe("Flagged");
    expect(row(track, "PulseGym")?.[1]).toBe("30");
    expect(row(track, "Streamly")?.[3]).toBe("No pattern");
    expect(row(track, "CloudBox")?.[3]).toBe("No pattern");
    for (const m of ["DashEats Plus", "StudyPlus", "FitFlow", "MobileNet", "SafeTrip"]) {
      const r = track.rows.find((x: any) => x.cells[0].startsWith(m.split(" ")[0]))?.cells;
      expect(r?.[3], m).toContain("Not enough data");
    }

    const radar = table(e4, "Price radar");
    const pulse = radar.rows.find((r: any) => r.cells[0] === "PulseGym");
    expect(pulse.cells[2]).toContain("→");
    expect(pulse.highlight).toBe(true);
    expect(radar.rows.find((r: any) => r.cells[0] === "Streamly").cells[2]).toContain("you already pay this");
    // DashEats' change was seen by 8 customers only: suppressed, not shown as a number.
    expect(radar.rows.find((r: any) => r.cells[0].startsWith("DashEats")).cells[2]).toContain("No change seen");

    const diff = table(e4, "Cancellation difficulty");
    expect(row(diff, "PulseGym")?.[1]).toBe("Hard");
    expect(row(diff, "Streamly")?.[1]).toBe("Easy");
    expect(row(diff, "CloudBox")?.[1]).toBe("Moderate");
    expect(diff.rows.find((r: any) => r.cells[0].startsWith("DashEats")).cells[1]).toContain("Not enough data");

    expect(e4.headline).toContain("PulseGym");
    expect(e4.links.map((l: any) => l.href)).toContain("/capabilities/A17");
    // Pseudonymous keys never leave the bank, and the published aggregates carry no customer column.
    expect(JSON.stringify(e4)).not.toMatch(/ck_[0-9a-f]/);
    expect(stack.q1<any>("SELECT status, customers FROM ext_merchant_track_record WHERE tenant_id=? AND merchant_id='dasheats'", t)).toEqual({ status: "INSUFFICIENT_DATA", customers: null });
    expect(stack.q1<any>("SELECT grade FROM ext_cancellation_difficulty WHERE tenant_id=? AND merchant_id='pulsegym'", t)!.grade).toBe("HARD");
    expect(stack.q<any>("SELECT merchant_id FROM ext_price_change_cluster WHERE tenant_id=? ORDER BY merchant_id", t).map((r) => r.merchant_id)).toEqual(["pulsegym", "streamly"]);
    expect(funds(stack, t, `${t}:personal`)).toBe(11_000_000);
  });

  it("is idempotent and tenant-scoped: each tenant's aggregates come only from its own rows", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    await a.json("/api/capabilities/E4");
    await a.json("/api/capabilities/E4");
    expect(stack.q<any>("SELECT COUNT(*) n FROM ext_merchant_track_record WHERE tenant_id=?", a.tenantId)[0].n).toBe(5);
    // Tenant A's cohort changes; tenant B's view does not.
    stack.exec("UPDATE ext_mi_cohort_cancellation SET billed_after=1 WHERE tenant_id=? AND merchant_id='streamly'", a.tenantId);
    expect((await a.json("/api/capabilities/E4")).numbers.flagged).toBe(2);
    expect((await b.json("/api/capabilities/E4")).numbers.flagged).toBe(1);
    expect(stack.q1<any>("SELECT status FROM ext_merchant_track_record WHERE tenant_id=? AND merchant_id='streamly'", b.tenantId)!.status).toBe("OK");
  });

  it("does not exist for Laziz and cannot be proposed", async () => {
    const l = await stack.login("laziz");
    expect((await l.call("GET", "/api/capabilities/E4")).status).not.toBe(200);
    expect(stack.q1("SELECT 1 FROM ext_mi_cohort_run WHERE tenant_id=?", l.tenantId)).toBeUndefined();
    const a = await stack.login("alex");
    const r = await a.post("/api/capabilities/E4/propose", { keys: ["anything"], inputs: {} });
    expect(r.status).not.toBe(200);
  });
});
