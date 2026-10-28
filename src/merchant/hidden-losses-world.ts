import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { MerchantOperation } from "../shared/merchant-contract";

// Provider side of the hidden-loss scenarios (A15 DashEats Plus, A17 PulseGym, A18 SafeTrip). Fictional merchants
// from demo/hidden-losses.json. Lingora and PixelForge (A16) have no linked account: the bank only sees their
// card payments, so they are not seeded here.

interface Helpers {
  merchant(m: { id: string; name: string; category: string; connector: "PARTNER_API"; readApi: boolean; operations: MerchantOperation[]; refPrefix: string }): void;
  account(merchantId: string, local: string): string;
  contract(c: {
    id: string;
    merchantId: string;
    accountId: string;
    planId: string;
    planName: string;
    priceMinor: number;
    billingPeriod: string;
    state: string;
    autoRenew: boolean;
    nextChargeAt: string | null;
    accessUntil: string | null;
    termsRevision: number;
    benefits?: object;
    details?: object;
  }): void;
}

export function seedHiddenLossWorld(root: string, t: string, h: Helpers) {
  const hl = JSON.parse(fs.readFileSync(path.join(root, "demo/hidden-losses.json"), "utf8"));
  const de = hl.dasheats;
  const pg = hl.pulsegym;
  const st = hl.safetrip;
  h.merchant({ id: "dasheats", name: "DashEats", category: "Food delivery", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL"], refPrefix: "DE" });
  h.merchant({ id: "pulsegym", name: "PulseGym", category: "Fitness", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL", "PAUSE"], refPrefix: "PG" });
  h.merchant({ id: "safetrip", name: "SafeTrip", category: "Insurance", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL"], refPrefix: "STP" });

  h.contract({
    id: `${t}:dasheats-plus`, merchantId: "dasheats", accountId: h.account("dasheats", de.subscriberAccountId), planId: "plus-monthly", planName: de.planName,
    priceMinor: de.priceMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true, nextChargeAt: de.nextChargeAt, accessUntil: de.nextChargeAt, termsRevision: de.termsRevision,
    benefits: { freeDelivery: true }, details: { standardDeliveryFeeMinor: de.standardDeliveryFeeMinor, freeDeliveryMinOrderMinor: de.freeDeliveryMinOrderMinor, cancellationFeeMinor: 0 },
  });
  h.contract({
    id: `${t}:pulsegym-full`, merchantId: "pulsegym", accountId: h.account("pulsegym", pg.subscriberAccountId), planId: "full-monthly", planName: pg.planName,
    priceMinor: pg.priceMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true, nextChargeAt: pg.nextChargeAt, accessUntil: pg.nextChargeAt, termsRevision: pg.termsRevision,
    benefits: { access: "All PulseGym clubs" }, details: { pause: pg.pause, cancellationFeeMinor: 0 },
  });
  h.contract({
    id: `${t}:safetrip-annual`, merchantId: "safetrip", accountId: h.account("safetrip", st.subscriberAccountId), planId: "annual-europe", planName: st.planName,
    priceMinor: st.priceMinor, billingPeriod: "ANNUAL", state: "ACTIVE", autoRenew: true, nextChargeAt: st.nextChargeAt, accessUntil: st.nextChargeAt, termsRevision: st.termsRevision,
    benefits: { travelInsurance: true }, details: { coverage: hl.travelCover.rows.map((r: any) => ({ id: r.id, label: r.label, value: r.policy })), cancellationFeeMinor: 0 },
  });
}
