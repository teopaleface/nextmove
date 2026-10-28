// ext_* tables for the cancellation-guarantee module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// A charge is disputed at most once per tenant, the bank never credits beyond the disputed amount, and every applied
// bank or network event is stored once, so a replayed decision changes nothing.
export const cancellationGuaranteeSchema = `
CREATE TABLE IF NOT EXISTS ext_dispute_case (
  packet_id          TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  context_id         TEXT NOT NULL,
  action_id          TEXT NOT NULL UNIQUE,
  tx_id              TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  subscription_id    TEXT NOT NULL,
  receipt_id         TEXT NOT NULL,
  merchant_id        TEXT NOT NULL,
  merchant_name      TEXT NOT NULL,
  manifest_json      TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_digest    TEXT NOT NULL UNIQUE,
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  disputable_minor   INTEGER NOT NULL CHECK (disputable_minor > 0),
  credited_minor     INTEGER NOT NULL DEFAULT 0 CHECK (credited_minor >= 0),
  provisional_minor  INTEGER NOT NULL DEFAULT 0 CHECK (provisional_minor >= 0),
  state              TEXT NOT NULL CHECK (state IN ('PREPARED','APPROVED','SUBMITTED','PROVISIONAL_CREDIT','AWAITING_FINAL_CREDIT','WON','LOST','MERCHANT_REFUNDED','DOUBLE_RECOVERY_REVIEW','EXPIRED')),
  grant_id           TEXT,
  network_ref        TEXT UNIQUE,
  applied_events_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(applied_events_json)),
  deadline           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (tenant_id, tx_id),
  CHECK (credited_minor <= disputable_minor),
  CHECK (provisional_minor <= credited_minor),
  CHECK (state IN ('PREPARED','EXPIRED') OR grant_id IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS ext_dispute_case_ctx ON ext_dispute_case (tenant_id, context_id);

CREATE TABLE IF NOT EXISTS ext_dispute_event (
  event_id         TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  packet_id        TEXT NOT NULL REFERENCES ext_dispute_case (packet_id),
  kind             TEXT NOT NULL CHECK (kind IN ('BANK_CREDIT_PROVISIONAL','BANK_CREDIT_FINAL','CREDIT_REVERSED','NETWORK_WON','NETWORK_LOST','MERCHANT_REFUND')),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor >= 0),
  ledger_source_id TEXT,
  applied_at       TEXT NOT NULL
) STRICT;
`;
