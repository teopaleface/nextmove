import { describe, expect, it } from "vitest";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MERCHANT_SCHEMA } from "../../src/merchant/db";
import { accountKey, seedWorld } from "../../src/merchant/world";
import { executeOperation } from "../../src/merchant/ops";
import { addLocalMonths, fromLocal, localDaysBetween, toLocalIso, toMs, withLocalDay } from "../../src/shared/time";
import { billingDateOptions, pauseEffect } from "../../src/server/finance/capabilities";

// Pause and billing-date maths run on the Europe/Bucharest calendar: month ends clamp instead of overflowing into
// the next month, local time of day survives a DST change, and an earlier billing day still needs 3 days' notice.

const ROOT = path.resolve(__dirname, "../..");
const local = (iso: string) => toLocalIso(toMs(iso));

describe("calendar helpers", () => {
  it("adds months on the local calendar, clamping to the month's last day", () => {
    expect(toLocalIso(addLocalMonths(toMs("2027-01-31T00:00:00+02:00"), 1))).toBe("2027-02-28T00:00:00+02:00");
    expect(toLocalIso(addLocalMonths(toMs("2028-01-31T00:00:00+02:00"), 1))).toBe("2028-02-29T00:00:00+02:00");
    expect(toLocalIso(addLocalMonths(toMs("2026-12-31T14:22:00+02:00"), 2))).toBe("2027-02-28T14:22:00+02:00");
    expect(toLocalIso(addLocalMonths(toMs("2026-11-26T14:22:00+02:00"), 3))).toBe("2027-02-26T14:22:00+02:00");
  });

  it("keeps local midnight across both DST changes", () => {
    expect(toLocalIso(addLocalMonths(toMs("2027-03-15T00:00:00+02:00"), 1))).toBe("2027-04-15T00:00:00+03:00");
    expect(toLocalIso(addLocalMonths(toMs("2026-10-15T00:00:00+03:00"), 1))).toBe("2026-11-15T00:00:00+02:00");
    expect(toLocalIso(withLocalDay(toMs("2026-10-02T08:00:00+03:00"), 30))).toBe("2026-10-30T08:00:00+02:00");
  });

  it("moves to another day of the same local month, clamped", () => {
    expect(toLocalIso(withLocalDay(toMs("2026-11-02T08:00:00+02:00"), 5))).toBe("2026-11-05T08:00:00+02:00");
    expect(toLocalIso(withLocalDay(toMs("2026-11-10T08:00:00+02:00"), 31))).toBe("2026-11-30T08:00:00+02:00");
    expect(localDaysBetween(toMs("2026-11-02T08:00:00+02:00"), toMs("2026-11-01T08:00:00+02:00"))).toBe(-1);
    // 23:30 local on 1 Nov is still 1 Nov in Bucharest even though it is 21:30 UTC.
    expect(localDaysBetween(toMs("2026-11-01T00:30:00+02:00"), toMs("2026-11-01T23:30:00+02:00"))).toBe(0);
  });

  it("resolves a wall-clock time skipped by the spring change to the next valid instant", () => {
    expect(toLocalIso(fromLocal(2027, 3, 28, 3, 30))).toBe("2027-03-28T04:30:00+03:00");
  });
});

describe("bank-side previews", () => {
  it("A6 pause resume date clamps at month end", () => {
    const r = pauseEffect({ monthlyMinor: 4900, pauseStartsAt: "2027-01-31T00:00:00+02:00", months: 1, allowedMonths: [1, 2, 3], feeMinor: 0, window: { startInclusive: "2027-01-01T00:00:00+02:00", endExclusive: "2027-03-01T00:00:00+02:00" } });
    expect(r.resumesAt).toBe("2027-02-28T00:00:00+02:00");
    const two = pauseEffect({ monthlyMinor: 4900, pauseStartsAt: "2027-01-31T00:00:00+02:00", months: 2, allowedMonths: [1, 2, 3], feeMinor: 0, window: { startInclusive: "2027-01-01T00:00:00+02:00", endExclusive: "2027-04-01T00:00:00+03:00" } });
    expect(two.skippedCharges).toEqual(["2027-01-31T00:00:00+02:00", "2027-02-28T00:00:00+02:00"]);
    expect(two.resumesAt).toBe("2027-03-31T00:00:00+03:00");
  });

  it("A11 marks an earlier day inside the notice period as unavailable", () => {
    const r = billingDateOptions({
      balanceMinor: 1_000_000,
      flows: [],
      bill: { id: "ec", label: "ElectraCasa", amountMinor: 18000, currentDay: 2, nextChargeAt: "2026-11-02T08:00:00+02:00" },
      supportedDays: [1, 2, 5],
      failedPaymentFeeMinor: 2500,
      requestAt: "2026-10-29T12:00:00+02:00",
      minNoticeDays: 3,
    });
    const one = r.options.find((o) => o.billingDay === 1)!;
    expect(one).toMatchObject({ appliesToNextBill: false, newDateTooSoon: true, prorationMinor: 0, firstChargeAt: "2026-11-02T08:00:00+02:00" });
    const five = r.options.find((o) => o.billingDay === 5)!;
    expect(five).toMatchObject({ appliesToNextBill: true, newDateTooSoon: false, firstChargeAt: "2026-11-05T08:00:00+02:00", prorationMinor: 1800 });
  });
});

describe("merchant operations", () => {
  const seeded = (customer: "alex" | "laziz") => {
    const db = new DatabaseSync(":memory:");
    db.exec(MERCHANT_SCHEMA);
    const t = `t_${customer}`;
    seedWorld(db, ROOT, t, customer, toMs("2026-10-28T09:41:00+02:00"));
    return { db, t };
  };
  const account = (db: DatabaseSync, t: string, merchantId: string, contractId: string) => {
    const c = db.prepare("SELECT account_id FROM m_contracts WHERE tenant_id=? AND id=?").get(t, contractId) as any;
    return { tenantId: t, merchantId, accountId: c.account_id, holder: "test", details: {} };
  };
  const contract = (db: DatabaseSync, t: string, id: string) => db.prepare("SELECT * FROM m_contracts WHERE tenant_id=? AND id=?").get(t, id) as any;
  const setDetails = (db: DatabaseSync, t: string, id: string, patch: (d: any) => void, nextChargeAt?: string) => {
    const d = JSON.parse(contract(db, t, id).details_json);
    patch(d);
    db.prepare("UPDATE m_contracts SET details_json=?, next_charge_at=COALESCE(?, next_charge_at) WHERE tenant_id=? AND id=?").run(JSON.stringify(d), nextChargeAt ?? null, t, id);
  };
  let seq = 0;
  const op = (db: DatabaseSync, t: string, merchantId: string, contractId: string, operation: any, params: Record<string, unknown>) =>
    executeOperation(db, account(db, t, merchantId, contractId), contractId, { operation, params } as any, { channel: "API", correlationId: `corr-${++seq}`, idempotencyKey: `idem-${seq}` });

  it("PAUSE from 31 Jan resumes on the last day of February, at the same local time", () => {
    const { db, t } = seeded("alex");
    const id = `${t}:streamly-standard`;
    setDetails(db, t, id, (d) => (d.pause.startsAt = "2027-01-31T00:00:00+02:00"));
    const r = op(db, t, "streamly", id, "PAUSE", { months: 1 });
    expect(r.httpStatus).toBe(200);
    expect((r.response as any).receipt.details.resumesAt).toBe("2027-02-28T00:00:00+02:00");
    expect(contract(db, t, id).next_charge_at).toBe("2027-02-28T00:00:00+02:00");
  });

  it("PAUSE across the spring DST change keeps local midnight", () => {
    const { db, t } = seeded("alex");
    const id = `${t}:streamly-standard`;
    setDetails(db, t, id, (d) => (d.pause.startsAt = "2027-01-31T00:00:00+02:00"));
    const r = op(db, t, "streamly", id, "PAUSE", { months: 2 });
    expect((r.response as any).receipt.details.resumesAt).toBe("2027-03-31T00:00:00+03:00");
  });

  it("CHANGE_BILLING_DATE refuses an earlier day that falls inside the 3-day notice period", () => {
    const { db, t } = seeded("laziz");
    const id = `${t}:electracasa-home`;
    // Next bill on 2 Nov 08:00 is 3+ days away on 29 Oct 12:00, but the 1st at 08:00 is not.
    db.prepare("UPDATE m_clocks SET base_ms=?, anchor_real_ms=? WHERE tenant_id=?").run(toMs("2026-10-29T12:00:00+02:00"), Date.now(), t);
    const r = op(db, t, "electracasa", id, "CHANGE_BILLING_DATE", { billingDay: 1 });
    expect(r.httpStatus).toBe(409);
    expect((r.response as any).message).toMatch(/less than 3 days away/);
    expect(contract(db, t, id).next_charge_at).toBe("2026-11-02T08:00:00+02:00");
    expect(JSON.parse(contract(db, t, id).details_json).billingDay).toBe(2);
  });

  it("CHANGE_BILLING_DATE to a later day moves the bill and prorates the extra days", () => {
    const { db, t } = seeded("laziz");
    const id = `${t}:electracasa-home`;
    const before = contract(db, t, id);
    const r = op(db, t, "electracasa", id, "CHANGE_BILLING_DATE", { billingDay: 5 });
    expect(r.httpStatus).toBe(200);
    const details = (r.response as any).receipt.details;
    expect(details.firstBillAt).toBe("2026-11-05T08:00:00+02:00");
    expect(details.prorationMinor).toBe(Math.floor((before.price_minor * 3 * 2 + 30) / 60));
  });

  it("CHANGE_BILLING_DATE clamps to the month's last day instead of spilling into the next month", () => {
    const { db, t } = seeded("laziz");
    const id = `${t}:electracasa-home`;
    setDetails(db, t, id, (d) => {
      d.billingDay = 10;
      d.supportedBillingDays = [10, 31];
    }, "2027-02-10T08:00:00+02:00");
    const r = op(db, t, "electracasa", id, "CHANGE_BILLING_DATE", { billingDay: 31 });
    expect(r.httpStatus).toBe(200);
    expect((r.response as any).receipt.details.firstBillAt).toBe(local("2027-02-28T08:00:00+02:00"));
    expect(contract(db, t, id).next_charge_at).toBe("2027-02-28T08:00:00+02:00");
  });
});
