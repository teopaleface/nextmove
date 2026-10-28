// ext_* tables for the card-reissue module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// Cards are referenced by an opaque card reference and the last 4 digits only; no full card number is ever stored.
export const cardReissueSchema = `
CREATE TABLE IF NOT EXISTS ext_card_on_file (
  tenant_id                TEXT NOT NULL,
  context_id               TEXT NOT NULL,
  account_id               TEXT NOT NULL,
  merchant_id              TEXT NOT NULL,
  merchant_name            TEXT NOT NULL,
  brand_id                 TEXT,
  credential_kind          TEXT NOT NULL CHECK (credential_kind IN ('PAN','NETWORK_TOKEN')),
  token_ref                TEXT,
  token_status             TEXT CHECK (token_status IN ('ACTIVE','SUSPENDED')),
  participates_in_updater  INTEGER NOT NULL CHECK (participates_in_updater IN (0,1)),
  added_at                 TEXT NOT NULL,
  CHECK ((credential_kind = 'NETWORK_TOKEN') = (token_ref IS NOT NULL AND token_status IS NOT NULL)),
  PRIMARY KEY (tenant_id, context_id, merchant_id)
) STRICT;

-- Cancellations the bank read back before this demo period, for merchants with no subscription row any more.
CREATE TABLE IF NOT EXISTS ext_card_prior_ending (
  tenant_id         TEXT NOT NULL,
  context_id        TEXT NOT NULL,
  receipt_ref       TEXT NOT NULL,
  merchant_id       TEXT NOT NULL,
  subscription_ref  TEXT NOT NULL,
  confirmed_at      TEXT NOT NULL,
  access_until      TEXT NOT NULL,
  verification      TEXT NOT NULL CHECK (verification IN ('INDEPENDENT_READ_BACK','MERCHANT_MESSAGE_ONLY')),
  PRIMARY KEY (tenant_id, receipt_ref)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_card_reissue (
  tenant_id      TEXT NOT NULL,
  context_id     TEXT NOT NULL,
  reissue_id     TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  old_card_ref   TEXT NOT NULL,
  old_last4      TEXT NOT NULL CHECK (length(old_last4) = 4),
  new_card_ref   TEXT NOT NULL,
  new_last4      TEXT NOT NULL CHECK (length(new_last4) = 4),
  reason         TEXT NOT NULL CHECK (reason IN ('EXPIRY','LOST','STOLEN','COMPROMISED','CUSTOMER_REQUEST')),
  status         TEXT NOT NULL CHECK (status IN ('STARTED','PLAN_APPROVED')),
  plan_id        TEXT,
  started_at     TEXT NOT NULL,
  CHECK (old_card_ref <> new_card_ref),
  CHECK ((status = 'PLAN_APPROVED') = (plan_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, reissue_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ext_card_reissue_one_per_card ON ext_card_reissue (tenant_id, context_id, old_card_ref);

CREATE TABLE IF NOT EXISTS ext_reissue_plan (
  tenant_id        TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  plan_id          TEXT NOT NULL,
  reissue_id       TEXT NOT NULL,
  old_card_id      TEXT NOT NULL,
  new_card_id      TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('EXPIRY','LOST','STOLEN','COMPROMISED','CUSTOMER_REQUEST')),
  manifest_digest  TEXT NOT NULL,
  plan_json        TEXT NOT NULL CHECK (json_valid(plan_json)),
  effects_json     TEXT NOT NULL CHECK (json_valid(effects_json)),
  action_id        TEXT NOT NULL,
  grant_id         TEXT NOT NULL,
  reference        TEXT NOT NULL,
  approved_at      TEXT NOT NULL,
  CHECK (old_card_id <> new_card_id),
  PRIMARY KEY (tenant_id, plan_id)
) STRICT;
-- One approved filter per replaced card.
CREATE UNIQUE INDEX IF NOT EXISTS ext_reissue_plan_one_approved ON ext_reissue_plan (tenant_id, reissue_id);

CREATE TABLE IF NOT EXISTS ext_reissue_decision (
  tenant_id    TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  merchant_id  TEXT NOT NULL,
  group_key    TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('KEEP','DROP')),
  basis        TEXT NOT NULL CHECK (basis IN ('CUSTOMER_CHOICE','ALL_SUBSCRIPTIONS_CANCELLED','ACTIVE_SUBSCRIPTION','UNANSWERED_KEEPS_SERVICE','UNANSWERED_AFTER_FRAUD')),
  PRIMARY KEY (tenant_id, plan_id, merchant_id)
) STRICT;

-- Updater requests from merchants. plan_id is NULL when no plan was approved: nothing is shared then.
CREATE TABLE IF NOT EXISTS ext_updater_inquiry (
  tenant_id    TEXT NOT NULL,
  context_id   TEXT NOT NULL,
  inquiry_id   TEXT NOT NULL,
  reissue_id   TEXT NOT NULL,
  plan_id      TEXT,
  merchant_id  TEXT NOT NULL,
  answer       TEXT NOT NULL CHECK (answer IN ('PROVIDE','WITHHOLD')),
  signal       TEXT CHECK (signal IN ('REQUEST_AFTER_CANCELLATION','MERCHANT_NOT_ON_FILE','NO_APPROVED_PLAN')),
  received_at  TEXT NOT NULL,
  CHECK (answer = 'WITHHOLD' OR (signal IS NULL AND plan_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, inquiry_id)
) STRICT;
`;
