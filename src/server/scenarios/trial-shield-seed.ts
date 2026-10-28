import type { DatabaseSync } from "node:sqlite";
import { run } from "../db/connection";
import { shortId } from "../canonical";
import { FIXTURE_INSTANT } from "../clock";
import { SHIELD_PERMISSION_SOURCE, ensureShieldWatches } from "../bank/trial-shield";

// Additive Alex seed for Trial Shield (T4). Card checks are authorisations the merchant reversed, so they are
// stored as RELEASED with no ledger entry: balances, forecasts and every existing scenario number stay the same.
// All merchants are fictional; Snapwise Pro and LinguaLeap are known to the bank only through these card checks.

const CARD_CHECKS = [
  { id: "txn-check-lingualeap", merchantId: "lingualeap", merchant: "LinguaLeap", category: "Language app", amountMinor: -100, bookedAt: "2026-10-14T08:05:00+03:00", note: "Card check 1.00 RON, reversed by the merchant" },
  { id: "txn-check-snapwise", merchantId: "snapwise", merchant: "Snapwise Pro", category: "Photo app", amountMinor: 0, bookedAt: "2026-10-21T21:30:00+03:00", note: "Card check 0.00 RON" },
  { id: "txn-check-fitflow", merchantId: "fitflow", merchant: "FitFlow", category: "Subscriptions", amountMinor: 0, bookedAt: "2026-10-23T09:00:00+03:00", note: "Card check 0.00 RON at trial sign-up" },
];

export function seedTrialShield(db: DatabaseSync, t: string, ctx: string, accountId: string) {
  for (const c of CARD_CHECKS) {
    run(
      db,
      `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, card_last4, booked_at, note, data_json)
       VALUES (?,?,?,?,NULL,'RELEASED','DEBIT',?,'RON',?,?,?,?,'4821',?,?,?)`,
      `${t}:${c.id}`, t, ctx, accountId, c.amountMinor, c.merchantId, c.merchant, c.category, `CHK-${c.merchantId.toUpperCase()}`, c.bookedAt, c.note, JSON.stringify({ authId: `CHK-${c.merchantId.toUpperCase()}`, authType: "CARD_CHECK" }),
    );
  }
  run(
    db,
    "INSERT INTO permissions(id, tenant_id, context_id, kind, source, scope, status, granted_at, expires_at, last_checked_at) VALUES (?,?,?,?,?,?, 'ACTIVE', ?, NULL, ?)",
    shortId("perm"), t, ctx, "MONITOR", SHIELD_PERMISSION_SOURCE, "Daily card: hold the first full charge after a card check until you decide", FIXTURE_INSTANT, FIXTURE_INSTANT,
  );
  ensureShieldWatches(db, t, ctx);
}
