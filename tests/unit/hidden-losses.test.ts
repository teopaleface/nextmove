import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { behavioralFootprint, coverageOverlap, deliveryMembershipValue, fxMarkup } from "../../src/server/finance/hidden-losses";

const root = path.resolve(__dirname, "../..");
const hl = JSON.parse(fs.readFileSync(path.join(root, "demo/hidden-losses.json"), "utf8"));
const NOW = "2026-10-28T09:41:00+02:00";
const debit = (t: any) => ({ id: t.id, bookedAt: t.bookedAt, amountMinor: -t.amountMinor, merchantName: t.merchant });
const txns = (pred: (t: any) => boolean) => hl.transactions.filter(pred).map(debit);

describe("A15 delivery membership", () => {
  const de = hl.dasheats;
  const charges = txns((t) => t.merchantId === "dasheats" && t.category === "Subscriptions");
  const orders = txns((t) => t.merchantId === "dasheats" && t.category === "Food delivery");
  const base = { membershipMinor: de.priceMinor, deliveryFeeMinor: de.standardDeliveryFeeMinor, freeDeliveryMinOrderMinor: de.freeDeliveryMinOrderMinor, charges, now: NOW };

  it("finds the loss in the fixture: 2 fees, 1 order in 60 days", () => {
    const r = deliveryMembershipValue({ ...base, orders });
    expect(r.chargesInWindow.map((c) => c.id)).toEqual(["txn-dasheats-plus-2026-09", "txn-dasheats-plus-2026-10"]);
    expect(r.paidMinor).toBe(5998);
    expect(r.ordersInWindow).toBe(1);
    expect(r.savedMinor).toBe(799);
    expect(r.netLossMinor).toBe(5199);
    expect(r.breakEvenOrdersPerMonth).toBe(4);
    expect(r.neededInWindow).toBe(8);
    expect(r.paysOff).toBe(false);
    expect(r.lastPaidOffMonth).toBe("2026-07");
  });

  it("does not flag a membership that is used often enough", () => {
    const busy = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, bookedAt: `2026-10-${String(1 + i * 3).padStart(2, "0")}T20:00:00+03:00`, amountMinor: 5000 }));
    const r = deliveryMembershipValue({ ...base, orders: busy });
    expect(r.paysOff).toBe(true);
    expect(r.netLossMinor).toBeLessThanOrEqual(0);
  });

  it("does not count small orders that would not get free delivery", () => {
    const small = [{ id: "s1", bookedAt: "2026-10-20T20:00:00+03:00", amountMinor: 3500 }];
    const r = deliveryMembershipValue({ ...base, orders: small });
    expect(r.ordersInWindow).toBe(1);
    expect(r.qualifyingOrders).toBe(0);
    expect(r.savedMinor).toBe(0);
  });
});

describe("A16 FX markup", () => {
  const charges = hl.transactions.filter((t: any) => t.data?.fx).map((t: any) => ({ ...debit(t), originalMinor: t.data.fx.originalMinor, currency: t.data.fx.originalCurrency }));

  it("measures each charge against the reference rate and annualises per merchant", () => {
    const r = fxMarkup({ charges, rates: hl.fx.rates });
    expect(r.rows).toHaveLength(6);
    const first = r.rows.find((x) => x.id === "txn-lingora-2026-08")!;
    // 9.99 EUR × 4.9710 = 49.66 RON at reference; charged 51.10 RON.
    expect(first.referenceMinor).toBe(4966);
    expect(first.markupMinor).toBe(first.amountMinor - 4966);
    expect(r.flagged.map((m) => m.merchantName).sort()).toEqual(["Lingora", "PixelForge"]);
    for (const m of r.flagged) {
      expect(m.annualMinor).toBe(m.avgMonthlyMinor * 12);
      expect(m.avgBasisPoints).toBeGreaterThanOrEqual(230);
      expect(m.avgBasisPoints).toBeLessThanOrEqual(300);
    }
    expect(r.observedMinor).toBe(r.rows.reduce((s, x) => s + (x.markupMinor ?? 0), 0));
    expect(r.annualMinor).toBe(r.flagged.reduce((s, m) => s + m.annualMinor, 0));
  });

  it("does not flag a charge converted at the reference rate", () => {
    const fair = [{ id: "f1", bookedAt: "2026-10-03T09:00:00+03:00", amountMinor: 4970, merchantName: "FairCo", originalMinor: 999, currency: "EUR" }];
    const r = fxMarkup({ charges: fair, rates: hl.fx.rates });
    expect(r.flagged).toHaveLength(0);
    expect(r.annualMinor).toBe(0);
  });

  it("leaves a charge unpriced when no reference rate exists for that day", () => {
    const r = fxMarkup({ charges: [{ id: "x", bookedAt: "2026-10-05T09:00:00+03:00", amountMinor: 5200, merchantName: "NoRate", originalMinor: 999, currency: "EUR" }], rates: hl.fx.rates });
    expect(r.rows[0].markupMinor).toBeNull();
    expect(r.flagged).toHaveLength(0);
  });
});

describe("A17 behavioural footprint", () => {
  const membership = txns((t) => t.merchantId === "pulsegym");
  const nearby = hl.transactions.filter((t: any) => t.merchantId !== "pulsegym" && t.data?.location === hl.pulsegym.location).map(debit);

  it("flags three silent membership months after an active start, as a risk not a certainty", () => {
    const r = behavioralFootprint({ membershipCharges: membership, related: nearby, now: NOW });
    expect(r.cycles.map((c) => c.signals)).toEqual([12, 7, 0, 0, 0]);
    expect(r.silentCycles).toBe(3);
    expect(r.silentPaidMinor).toBe(75000);
    expect(r.lastSignalAt).toBe("2026-08-02T19:40:00+03:00");
    expect(r.daysSinceLastSignal).toBe(86);
    expect(r.risk).toBe("HIGH");
  });

  it("stays low while the footprint continues", () => {
    const recent = [...nearby, { id: "n1", bookedAt: "2026-10-20T19:00:00+03:00", amountMinor: 1400, merchantName: "Ritm Café Floreasca" }];
    const r = behavioralFootprint({ membershipCharges: membership, related: recent, now: NOW });
    expect(r.silentCycles).toBe(0);
    expect(r.risk).toBe("LOW");
  });

  it("says it can't tell when there was never a footprint", () => {
    const r = behavioralFootprint({ membershipCharges: membership, related: [], now: NOW });
    expect(r.risk).toBe("UNKNOWN");
  });
});

describe("A18 cover you may already have", () => {
  it("lists every difference and never claims equivalence when gaps exist", () => {
    const r = coverageOverlap({ rows: hl.travelCover.rows, tripPaidWithCard: true });
    expect(r.equivalent).toBe(false);
    expect(r.gaps.map((g) => g.id)).toEqual(["medical", "activation", "length", "baggage", "cancellation", "wintersports"]);
    expect(r.overlap.map((g) => g.id)).toEqual(["region"]);
  });

  it("reports equivalence only when no row has a gap", () => {
    const rows = hl.travelCover.rows.map((x: any) => ({ ...x, gap: null }));
    expect(coverageOverlap({ rows, tripPaidWithCard: null }).equivalent).toBe(true);
  });
});
