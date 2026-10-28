import { describe, expect, it } from "vitest";
import type { MerchantContractView } from "../../src/shared/merchant-contract";
import { airbagProjection, airbagProtection } from "../../src/server/finance/financial-airbag";

const contract = (patch: Partial<MerchantContractView> = {}): MerchantContractView => ({
  merchantId: "video", merchantName: "Video", accountId: "me", contractId: "c1", planId: "standard", planName: "Standard", priceMinor: 4900, currency: "RON", billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true,
  nextChargeAt: "2026-11-10T09:00:00+02:00", accessUntil: "2026-11-10T09:00:00+02:00", termsRevision: 1, resourceVersion: 1, minimumTermUntil: null, exitFeeMinor: 0, ownerKind: "SELF", shared: false, protectedReason: null,
  benefits: {}, details: {}, pending: null, observedAt: "2026-10-28T09:41:00+02:00", ...patch,
});
const base = { category: "SUBSCRIPTION", localBenefits: {}, contract: contract(), keepPlayback: true };
const window = { startInclusive: "2026-10-28T09:41:00+02:00", endExclusive: "2026-11-27T09:41:00+02:00" };

describe("Financial Airbag protections", () => {
  it.each(["RENT", "UTILITY", "LOAN", "Insurance", "Healthcare", "TELECOM", "Cloud storage", "Education"])("excludes %s even with an optional-looking local category", (merchantCategory) => {
    expect(airbagProtection({ ...base, merchantCategory })).toMatch(/Protected/);
  });

  it("keeps storage, student tools and required benefits even when the live record omits or clears them", () => {
    for (const localBenefits of [{ cloudStorageGb: 100 }, { studyTools: true }, { requiredBenefits: ["work access"] }]) {
      expect(airbagProtection({ ...base, localBenefits, contract: contract({ benefits: { cloudStorageGb: 0, studyTools: false } }) })).toMatch(/dependencies separately/);
    }
  });

  it("protects playback by default; opting out does not bypass shared ownership or other dependencies", () => {
    const c = contract({ benefits: { tvAccess: true, offlinePlayback: true } });
    expect(airbagProtection({ ...base, contract: c })).toMatch(/TV and offline/);
    expect(airbagProtection({ ...base, contract: c, keepPlayback: false })).toBeNull();
    expect(airbagProtection({ ...base, contract: { ...c, shared: true }, keepPlayback: false })).toMatch(/owner review/);
    expect(airbagProtection({ ...base, contract: { ...c, benefits: { ...c.benefits, studyTools: true } }, keepPlayback: false })).toMatch(/dependencies/);
  });
});

describe("Financial Airbag dated costs", () => {
  const items = [
    { id: "rent", subscription_id: null, amount_minor: -220000, due_at: "2026-11-01T09:00:00+02:00" },
    { id: "video", subscription_id: "video", amount_minor: -4900, due_at: "2026-11-10T09:00:00+02:00" },
    { id: "later", subscription_id: "video", amount_minor: -4900, due_at: "2026-12-10T09:00:00+02:00" },
    { id: "food", subscription_id: "food", amount_minor: -2999, due_at: "2026-11-14T09:00:00+02:00" },
    { id: "income", subscription_id: null, amount_minor: 700000, due_at: "2026-11-01T09:00:00+02:00" },
    { id: "boundary", subscription_id: null, amount_minor: -999, due_at: window.endExclusive },
  ];
  it("starts unchanged, including pending/unknown outcomes with no confirmed effect", () => {
    expect(airbagProjection(items, [], window)).toMatchObject({ beforeMinor: 227899, afterMinor: 227899 });
  });
  it("combines explicit pause and renewal-off, preserving rent and excluding the end boundary", () => {
    const p = airbagProjection(items, [{ operation: "PAUSE", subscriptionId: "video", itemId: "video", resumesAt: "2026-12-10T09:00:00+02:00" }, { operation: "STOP_RENEWAL", subscriptionId: "food" }], window);
    expect(p).toMatchObject({ beforeMinor: 227899, afterMinor: 220000 });
    expect(p.rows.find((r) => r.item.id === "later")?.dueAfter).toBe("2026-12-10T09:00:00+02:00");
    expect(p.rows.find((r) => r.item.id === "rent")?.afterMinor).toBe(220000);
  });
  it("counts a paused charge that still resumes within the window; it does not invent savings", () => {
    const p = airbagProjection(items, [{ operation: "PAUSE", subscriptionId: "video", itemId: "video", resumesAt: "2026-11-26T09:00:00+02:00" }], window);
    expect(p.afterMinor).toBe(p.beforeMinor);
  });
});
