import { describe, expect, it } from "vitest";
import { CARD_CHECK_MAX_MINOR, HOLD_HOURS, decideAttempt, detectCardChecks, holdExpired, holdExpiresAt, type CardActivity } from "../../src/server/bank/trial-shield";

// Pure Trial Shield rules (T4): which authorisations count as card checks, and what the bank does with a charge.

const txn = (p: Partial<CardActivity> & Pick<CardActivity, "id" | "merchantId" | "amountMinor" | "status" | "bookedAt">): CardActivity => ({ merchantName: p.merchantId ?? "?", ...p });

describe("detectCardChecks", () => {
  it("finds reversed 0.00 and 1.00 RON authorisations from merchants that never charged the card", () => {
    const checks = detectCardChecks([
      txn({ id: "a", merchantId: "snapwise", amountMinor: 0, status: "RELEASED", bookedAt: "2026-10-21T21:30:00+03:00" }),
      txn({ id: "b", merchantId: "lingualeap", amountMinor: -100, status: "RELEASED", bookedAt: "2026-10-14T08:05:00+03:00" }),
    ]);
    expect(checks.map((c) => [c.merchantId, c.amountMinor])).toEqual([
      ["lingualeap", 100],
      ["snapwise", 0],
    ]);
  });

  it("ignores ordinary holds, settled charges, larger reversals and merchants already paid", () => {
    const checks = detectCardChecks([
      txn({ id: "1", merchantId: "freshmarket", amountMinor: -12840, status: "PENDING", bookedAt: "2026-10-27T18:05:00+02:00" }),
      txn({ id: "2", merchantId: "bigshop", amountMinor: -(CARD_CHECK_MAX_MINOR + 1), status: "RELEASED", bookedAt: "2026-10-20T10:00:00+03:00" }),
      txn({ id: "3", merchantId: "streamly", amountMinor: -4900, status: "POSTED", bookedAt: "2026-09-26T14:22:00+03:00" }),
      txn({ id: "4", merchantId: "streamly", amountMinor: 0, status: "RELEASED", bookedAt: "2026-10-26T14:22:00+02:00" }),
      txn({ id: "5", merchantId: null, amountMinor: 0, status: "RELEASED", bookedAt: "2026-10-26T14:22:00+02:00" }),
    ]);
    expect(checks).toEqual([]);
  });

  it("keeps one check per merchant, the earliest", () => {
    const checks = detectCardChecks([
      txn({ id: "late", merchantId: "snapwise", amountMinor: 0, status: "RELEASED", bookedAt: "2026-10-25T10:00:00+03:00" }),
      txn({ id: "early", merchantId: "snapwise", amountMinor: -100, status: "RELEASED", bookedAt: "2026-10-21T10:00:00+03:00" }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0].transactionId).toBe("early");
  });
});

describe("decideAttempt", () => {
  it("holds the first charge, declines while held or blocked, approves once allowed", () => {
    expect(decideAttempt("WATCHING")).toBe("HOLD");
    expect(decideAttempt("HELD")).toBe("DECLINE_ALREADY_HELD");
    expect(decideAttempt("BLOCKED")).toBe("DECLINE_BLOCKED");
    expect(decideAttempt("ALLOWED")).toBe("APPROVE");
  });
  it("a frozen card declines everything", () => {
    for (const s of ["WATCHING", "HELD", "BLOCKED", "ALLOWED"] as const) expect(decideAttempt(s, true)).toBe("DECLINE_CARD_FROZEN");
  });
});

describe("hold expiry (safe default: decline)", () => {
  it(`expires exactly ${HOLD_HOURS} hours after the hold`, () => {
    const heldAt = Date.parse("2026-10-28T09:41:00+02:00");
    const expiresAt = holdExpiresAt(heldAt);
    expect(expiresAt).toBe("2026-10-31T09:41:00+02:00");
    expect(holdExpired({ expiresAt }, Date.parse(expiresAt) - 1)).toBe(false);
    expect(holdExpired({ expiresAt }, Date.parse(expiresAt))).toBe(true);
    expect(holdExpired(null, Date.parse(expiresAt) + 1)).toBe(false);
  });
});
