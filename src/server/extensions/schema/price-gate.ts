// ext_* tables for the price-gate module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
export const priceGateSchema = `
CREATE TABLE IF NOT EXISTS ext_price_ceiling (
  tenant_id           TEXT NOT NULL,
  ceiling_id          TEXT NOT NULL,
  context_id          TEXT NOT NULL,
  subscription_id     TEXT NOT NULL,
  merchant_ids_json   TEXT NOT NULL CHECK (json_valid(merchant_ids_json) AND json_type(merchant_ids_json) = 'array' AND json_array_length(merchant_ids_json) > 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  approved_minor      INTEGER NOT NULL CHECK (approved_minor >= 0),
  manifest_digest     TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','REVOKED')),
  grant_id            TEXT,
  rejected_minor      INTEGER,
  rejected_currency   TEXT,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ceiling_id),
  CHECK (status IN ('DRAFT','REVOKED') OR grant_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ext_price_ceiling_one_live
  ON ext_price_ceiling (tenant_id, context_id, subscription_id)
  WHERE status IN ('ACTIVE','PAUSED');

-- One notice per requested price (rise key), however often the merchant retries.
CREATE TABLE IF NOT EXISTS ext_price_rise_notice (
  tenant_id           TEXT NOT NULL,
  rise_key            TEXT NOT NULL,
  context_id          TEXT NOT NULL,
  subscription_id     TEXT NOT NULL,
  ceiling_id          TEXT NOT NULL,
  current_minor       INTEGER NOT NULL CHECK (current_minor >= 0),
  requested_minor     INTEGER NOT NULL CHECK (requested_minor >= 0),
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('OPEN','ACCEPTED')),
  created_at          TEXT NOT NULL,
  answered_at         TEXT,
  PRIMARY KEY (tenant_id, rise_key)
) STRICT;

-- The soft-decline budget per rise key survives restarts.
CREATE TABLE IF NOT EXISTS ext_price_gate_decline (
  tenant_id           TEXT NOT NULL,
  rise_key            TEXT NOT NULL,
  declines            INTEGER NOT NULL CHECK (declines >= 0),
  last_at             TEXT NOT NULL,
  PRIMARY KEY (tenant_id, rise_key)
) STRICT;

-- Every merchant-initiated authorisation the gate judged, with its outcome.
CREATE TABLE IF NOT EXISTS ext_price_gate_auth (
  tenant_id           TEXT NOT NULL,
  auth_id             TEXT NOT NULL,
  context_id          TEXT NOT NULL,
  subscription_id     TEXT NOT NULL,
  merchant_id         TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency            TEXT NOT NULL,
  initiator           TEXT NOT NULL CHECK (initiator IN ('MERCHANT','CUSTOMER')),
  decision            TEXT NOT NULL CHECK (decision IN ('APPROVE','DECLINE')),
  reason              TEXT NOT NULL,
  advice              TEXT,
  rise_key            TEXT,
  transaction_id      TEXT,
  at                  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, auth_id)
) STRICT;
`;
