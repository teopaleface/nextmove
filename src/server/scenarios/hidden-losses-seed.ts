import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { one, run } from "../db/connection";
import { repoRoot } from "../config";
import { FIXTURE_INSTANT } from "../clock";
import { clearingAccountId, post } from "../bank/ledger";
import { addForecastItem } from "../bank/forecast";
import { canonicalKey, merchantAccountId, merchantContractId } from "../../shared/ids";

// Bank-side seed for the hidden-loss detectors (A15–A18), from demo/hidden-losses.json (fictional).
// Additive only: the new card history is posted to Alex's daily account and the opening balance is moved by the
// same amount, so every existing balance stays unchanged. New subscriptions and forecast items use the "hidden"
// dataset, so the 30-day subscription total (dataset "ui", 242 → 163 RON) is not affected.

export const HIDDEN_DATASET = "hidden";

export function hiddenLossFixture() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), "demo/hidden-losses.json"), "utf8"));
}

export function seedHiddenLosses(db: DatabaseSync, t: string, ctx: string, accountId: string) {
  const hl = hiddenLossFixture();
  let posted = 0;
  for (const tx of hl.transactions) {
    const { entryId } = post(db, {
      tenantId: t,
      sourceEventId: `fixture:${t}:${tx.id}`,
      kind: "DEBIT",
      description: tx.merchant,
      postedAt: tx.bookedAt,
      lines: [
        { accountId, amountMinor: tx.amountMinor },
        { accountId: clearingAccountId(t), amountMinor: -tx.amountMinor },
      ],
    });
    posted += tx.amountMinor;
    run(
      db,
      `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, order_ref, card_last4, booked_at, note, data_json)
       VALUES (?,?,?,?,?,'POSTED','DEBIT',?,'RON',?,?,?,NULL,?,'4821',?,?,?)`,
      `${t}:${tx.id}`, t, ctx, accountId, entryId, tx.amountMinor, tx.merchantId, tx.merchant, tx.category, tx.data?.orderRef ?? null, tx.bookedAt, tx.note ?? null,
      JSON.stringify({ authId: null, ...(tx.data ?? {}) }),
    );
  }
  const acct = one<any>(db, "SELECT opening_minor FROM accounts WHERE id=?", accountId);
  run(db, "UPDATE accounts SET opening_minor=? WHERE id=?", acct.opening_minor - posted, accountId);

  const subs = [
    { local: "dasheats", d: hl.dasheats, name: hl.dasheats.subscriptionName, contract: "dasheats-plus", category: "SUBSCRIPTION", benefits: { freeDelivery: true }, data: { lastChargeAt: "2026-10-14T08:00:00+03:00" } },
    { local: "pulsegym", d: hl.pulsegym, name: hl.pulsegym.merchant, contract: "pulsegym-full", category: "SUBSCRIPTION", benefits: { access: "All PulseGym clubs" }, data: { location: hl.pulsegym.location, lastChargeAt: "2026-10-05T07:00:00+03:00" } },
    { local: "safetrip", d: hl.safetrip, name: hl.safetrip.merchant, contract: "safetrip-annual", category: "INSURANCE", benefits: { travelInsurance: true }, data: { lastChargeAt: "2026-01-15T10:00:00+02:00" } },
  ];
  for (const s of subs) {
    const id = `${t}:sub:${s.local}`;
    const acctId = merchantAccountId(t, s.d.merchantId, s.d.subscriberAccountId);
    const contractId = merchantContractId(t, s.contract);
    run(
      db,
      `INSERT INTO subscriptions(id, tenant_id, context_id, dataset, category, merchant_id, merchant_name, subscriber_account_id, contract_id, canonical_key, plan_name, amount_minor, currency, billing_period, state, next_charge_at, access_until, terms_revision, observed_revision, last_observed_at, benefits_json, data_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'RON', ?, 'ACTIVE', ?,?,?,?,?,?,?)`,
      id, t, ctx, HIDDEN_DATASET, s.category, s.d.merchantId, s.name, acctId, contractId, canonicalKey(s.d.merchantId, acctId, contractId), s.d.planName, s.d.priceMinor,
      s.d.billingPeriod ?? "MONTHLY", s.d.nextChargeAt, s.d.nextChargeAt, s.d.termsRevision, s.d.termsRevision, FIXTURE_INSTANT, JSON.stringify(s.benefits), JSON.stringify(s.data),
    );
    addForecastItem(db, { tenantId: t, contextId: ctx, dataset: HIDDEN_DATASET, subscriptionId: id, kind: "RENEWAL", label: `${s.name} renewal`, amountMinor: -s.d.priceMinor, dueAt: s.d.nextChargeAt, source: "fixture:hidden-losses" });
  }
}
