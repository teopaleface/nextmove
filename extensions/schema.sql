-- Persistence for the NextMove extensions. SQLite >= 3.37 (STRICT tables).
-- Every table is prefixed ext_ so it cannot collide with the core app schema.
-- Money is INTEGER minor units; instants are ISO-8601 TEXT with offset; dates are YYYY-MM-DD.
-- The domain code already refuses duplicates; these constraints are the last line of defence
-- when two workers race or a job is replayed.

PRAGMA foreign_keys = ON;

-- 1. Cancellation guarantee -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_dispute_case (
  packet_id          TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  owner_id           TEXT NOT NULL,
  context_id         TEXT NOT NULL,
  tx_id              TEXT NOT NULL,
  receipt_id         TEXT NOT NULL,
  manifest_digest    TEXT NOT NULL UNIQUE,
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  disputable_minor   INTEGER NOT NULL CHECK (disputable_minor > 0),
  credited_minor     INTEGER NOT NULL DEFAULT 0 CHECK (credited_minor >= 0),
  provisional_minor  INTEGER NOT NULL DEFAULT 0 CHECK (provisional_minor >= 0),
  state              TEXT NOT NULL CHECK (state IN ('PREPARED','APPROVED','SUBMITTED','PROVISIONAL_CREDIT','AWAITING_FINAL_CREDIT','WON','LOST','MERCHANT_REFUNDED','DOUBLE_RECOVERY_REVIEW','EXPIRED')),
  grant_id           TEXT,
  network_ref        TEXT UNIQUE,
  deadline           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- A charge is disputed at most once, ever.
  UNIQUE (tenant_id, tx_id),
  -- The bank never credits more than it disputed.
  CHECK (credited_minor <= disputable_minor),
  CHECK (provisional_minor <= credited_minor),
  -- Anything past PREPARED was approved by the customer.
  CHECK (state IN ('PREPARED','EXPIRED') OR grant_id IS NOT NULL)
) STRICT;

-- Bank, network and merchant events already applied; a replayed event id is rejected.
CREATE TABLE IF NOT EXISTS ext_dispute_event (
  event_id      TEXT PRIMARY KEY,
  packet_id     TEXT NOT NULL REFERENCES ext_dispute_case (packet_id),
  kind          TEXT NOT NULL CHECK (kind IN ('BANK_CREDIT_PROVISIONAL','BANK_CREDIT_FINAL','NETWORK_WON','NETWORK_LOST','MERCHANT_REFUND')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  applied_at    TEXT NOT NULL
) STRICT;

-- 2. Exit plan --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_exit_plan (
  rule_id          TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  terms_revision   INTEGER NOT NULL CHECK (terms_revision >= 0),
  terms_json       TEXT NOT NULL CHECK (json_valid(terms_json)),
  manifest_digest  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','STOP_REQUESTED','KEPT','STOPPED','VOID','REVOKED')),
  grant_id         TEXT,
  idempotency_key  TEXT UNIQUE,
  closed_reason    TEXT,
  created_on       TEXT NOT NULL,
  CHECK (status IN ('DRAFT','REVOKED') OR grant_id IS NOT NULL),
  CHECK (status <> 'STOP_REQUESTED' OR idempotency_key IS NOT NULL)
) STRICT;

-- At most one live exit plan per subscription.
CREATE UNIQUE INDEX IF NOT EXISTS ext_exit_plan_one_live
  ON ext_exit_plan (owner_id, context_id, subscription_id)
  WHERE status IN ('ACTIVE','STOP_REQUESTED');

-- 3. Retention offers -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_retention_offer (
  offer_id         TEXT NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  owner_id         TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  merchant_id      TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  offer_digest     TEXT NOT NULL UNIQUE,
  -- The signed offer exactly as received; merchant text inside it is untrusted data.
  signed_json      TEXT NOT NULL CHECK (json_valid(signed_json)),
  verdict          TEXT CHECK (verdict IN ('INCOMPLETE','LOSES_REQUIRED_BENEFIT','NOT_CHEAPER_THAN_CURRENT','CHEAPER_THAN_CURRENT')),
  unsolicited      INTEGER NOT NULL CHECK (unsolicited IN (0, 1)),
  received_at      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  PRIMARY KEY (offer_id, revision)
) STRICT;

-- Feeds the rate limit: unsolicited offers per merchant and customer in a window.
CREATE INDEX IF NOT EXISTS ext_retention_offer_rate
  ON ext_retention_offer (owner_id, context_id, merchant_id, received_at)
  WHERE unsolicited = 1;

CREATE TABLE IF NOT EXISTS ext_offer_counter (
  counter_id       TEXT PRIMARY KEY,
  offer_id         TEXT NOT NULL,
  offer_revision   INTEGER NOT NULL,
  monthly_minor    INTEGER NOT NULL CHECK (monthly_minor >= 0),
  months           INTEGER NOT NULL CHECK (months BETWEEN 1 AND 120),
  currency         TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  FOREIGN KEY (offer_id, offer_revision) REFERENCES ext_retention_offer (offer_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_offer_acceptance (
  idempotency_key  TEXT PRIMARY KEY,
  offer_id         TEXT NOT NULL UNIQUE,
  revision         INTEGER NOT NULL,
  offer_digest     TEXT NOT NULL,
  grant_id         TEXT NOT NULL,
  accepted_at      TEXT NOT NULL,
  -- Only one revision of an offer can ever be accepted.
  FOREIGN KEY (offer_id, revision) REFERENCES ext_retention_offer (offer_id, revision),
  CHECK (idempotency_key = 'offer:' || offer_id || ':' || revision)
) STRICT;

-- 4. Merchant insights (aggregates only: no customer keys are ever stored) -------------

CREATE TABLE IF NOT EXISTS ext_merchant_track_record (
  merchant_id             TEXT PRIMARY KEY,
  status                  TEXT NOT NULL CHECK (status IN ('INSUFFICIENT_DATA','OK','FLAGGED')),
  customers               INTEGER,
  billed_after_customers  INTEGER,
  rate_bp                 INTEGER,
  lower_bound_bp          INTEGER,
  computed_at             TEXT NOT NULL,
  -- Suppressed groups carry no numbers at all.
  CHECK ((status = 'INSUFFICIENT_DATA') = (customers IS NULL)),
  CHECK (status = 'INSUFFICIENT_DATA' OR (customers >= 2 AND billed_after_customers BETWEEN 0 AND customers))
) STRICT;

CREATE TABLE IF NOT EXISTS ext_price_change_cluster (
  merchant_id    TEXT NOT NULL,
  plan_key       TEXT NOT NULL,
  currency       TEXT NOT NULL,
  old_minor      INTEGER NOT NULL CHECK (old_minor > 0),
  new_minor      INTEGER NOT NULL CHECK (new_minor > 0 AND new_minor <> old_minor),
  direction      TEXT NOT NULL CHECK (direction = CASE WHEN new_minor > old_minor THEN 'INCREASE' ELSE 'DECREASE' END),
  change_bp      INTEGER NOT NULL,
  customers      INTEGER NOT NULL CHECK (customers >= 2),
  first_seen_on  TEXT NOT NULL,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (merchant_id, plan_key, currency, old_minor, new_minor)
) STRICT;

-- 5. Price-rise consent gate -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_price_ceiling (
  ceiling_id          TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
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
  CHECK (status IN ('DRAFT','REVOKED') OR grant_id IS NOT NULL),
  CHECK ((rejected_minor IS NULL) = (rejected_currency IS NULL)),
  CHECK (rejected_minor IS NULL OR rejected_minor > approved_minor OR rejected_currency <> currency)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ext_price_ceiling_one_live
  ON ext_price_ceiling (owner_id, context_id, subscription_id)
  WHERE status IN ('ACTIVE','PAUSED');

-- One customer notice per requested price, however many times the merchant retries.
CREATE TABLE IF NOT EXISTS ext_price_rise_notice (
  rise_key     TEXT PRIMARY KEY,
  notified_at  TEXT NOT NULL
) STRICT;

-- Every gate decline, so the soft-decline budget survives restarts.
CREATE TABLE IF NOT EXISTS ext_price_gate_decline (
  auth_id     TEXT PRIMARY KEY,
  rise_key    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('ABOVE_CEILING','CURRENCY_CHANGED','RISE_REJECTED')),
  advice      TEXT NOT NULL CHECK (advice IN ('RETRY_LATER','DO_NOT_RETRY')),
  decided_at  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ext_price_gate_decline_by_key ON ext_price_gate_decline (rise_key);

-- 6. Card reissue filter ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_reissue_plan (
  plan_id          TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  old_card_id      TEXT NOT NULL,
  new_card_id      TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('EXPIRY','LOST','STOLEN','COMPROMISED','CUSTOMER_REQUEST')),
  manifest_digest  TEXT NOT NULL UNIQUE,
  grant_id         TEXT,
  approved_at      TEXT,
  CHECK (old_card_id <> new_card_id),
  CHECK ((grant_id IS NULL) = (approved_at IS NULL))
) STRICT;

-- One approved filter per replaced card.
CREATE UNIQUE INDEX IF NOT EXISTS ext_reissue_plan_one_approved
  ON ext_reissue_plan (old_card_id)
  WHERE grant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ext_reissue_decision (
  plan_id      TEXT NOT NULL REFERENCES ext_reissue_plan (plan_id),
  merchant_id  TEXT NOT NULL,
  group_key    TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('KEEP','DROP')),
  basis        TEXT NOT NULL CHECK (basis IN ('CUSTOMER_CHOICE','ALL_SUBSCRIPTIONS_CANCELLED','ACTIVE_SUBSCRIPTION','UNANSWERED_KEEPS_SERVICE','UNANSWERED_AFTER_FRAUD')),
  PRIMARY KEY (plan_id, merchant_id)
) STRICT;

-- Updater requests from merchants; REQUEST_AFTER_CANCELLATION is evidence for module 1.
CREATE TABLE IF NOT EXISTS ext_updater_inquiry (
  inquiry_id   TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES ext_reissue_plan (plan_id),
  merchant_id  TEXT NOT NULL,
  answer       TEXT NOT NULL CHECK (answer IN ('PROVIDE','WITHHOLD')),
  signal       TEXT CHECK (signal IN ('REQUEST_AFTER_CANCELLATION','MERCHANT_NOT_ON_FILE')),
  received_at  TEXT NOT NULL,
  CHECK (answer = 'WITHHOLD' OR signal IS NULL)
) STRICT;

-- 7. Personal -> business move ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_vat_rule_set (
  rule_set_id         TEXT NOT NULL,
  version             INTEGER NOT NULL CHECK (version >= 1),
  effective_from      TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  home_country        TEXT NOT NULL CHECK (length(home_country) = 2 AND home_country = upper(home_country)),
  eu_countries_json   TEXT NOT NULL CHECK (json_valid(eu_countries_json) AND json_type(eu_countries_json) = 'array'),
  PRIMARY KEY (rule_set_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_business_move (
  plan_id              TEXT PRIMARY KEY,
  personal_owner_id    TEXT NOT NULL,
  personal_context_id  TEXT NOT NULL CHECK (personal_context_id = 'PERSONAL'),
  business_owner_id    TEXT NOT NULL,
  business_context_id  TEXT NOT NULL CHECK (business_context_id = 'BUSINESS'),
  subscription_id      TEXT NOT NULL,
  business_use_bp      INTEGER NOT NULL CHECK (business_use_bp BETWEEN 1 AND 10000),
  manifest_digest      TEXT NOT NULL UNIQUE,
  vat_note_json        TEXT NOT NULL CHECK (json_valid(vat_note_json)),
  personal_grant_id    TEXT,
  business_grant_id    TEXT,
  approved_at          TEXT,
  -- Approved means both sides consented, with two different grants.
  CHECK ((approved_at IS NULL) OR (personal_grant_id IS NOT NULL AND business_grant_id IS NOT NULL)),
  CHECK (personal_grant_id IS NULL OR business_grant_id IS NULL OR personal_grant_id <> business_grant_id)
) STRICT;

-- A month is repaid once per subscription, whichever plan repaid it.
CREATE TABLE IF NOT EXISTS ext_business_repayment (
  idempotency_key  TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL REFERENCES ext_business_move (plan_id),
  subscription_id  TEXT NOT NULL,
  charge_id        TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  ledger_tx_id     TEXT UNIQUE,
  posted_at        TEXT,
  UNIQUE (subscription_id, charge_id)
) STRICT;

-- 8. Cancellation certificates ---------------------------------------------------------

-- Public keys are stored in full; private keys only by reference.
CREATE TABLE IF NOT EXISTS ext_certificate_key (
  key_id           TEXT PRIMARY KEY,
  issuer           TEXT NOT NULL,
  algorithm        TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_spki  TEXT NOT NULL,
  private_key_ref  TEXT NOT NULL CHECK (private_key_ref GLOB 'env:*' OR private_key_ref GLOB 'keystore:*'),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED','COMPROMISED')),
  created_at       TEXT NOT NULL
) STRICT;

-- Only one key signs at a time per issuer.
CREATE UNIQUE INDEX IF NOT EXISTS ext_certificate_key_one_active
  ON ext_certificate_key (issuer)
  WHERE status = 'ACTIVE';

-- Holds no claim values: the certificate itself stays with the customer.
CREATE TABLE IF NOT EXISTS ext_certificate (
  cert_id          TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  receipt_id       TEXT NOT NULL,
  key_id           TEXT NOT NULL REFERENCES ext_certificate_key (key_id),
  issued_at        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT,
  CHECK (expires_at > issued_at)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_revocation_list (
  issuer       TEXT NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  issued_at    TEXT NOT NULL,
  next_update  TEXT NOT NULL,
  signed_text  TEXT NOT NULL CHECK (signed_text GLOB 'NMR1.*'),
  PRIMARY KEY (issuer, seq),
  CHECK (next_update > issued_at)
) STRICT;

-- 9. Shared subscription split ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS ext_split_group (
  group_id         TEXT PRIMARY KEY,
  organizer_id     TEXT NOT NULL,
  subscription_id  TEXT NOT NULL UNIQUE,
  currency         TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency))
) STRICT;

CREATE TABLE IF NOT EXISTS ext_split_member (
  group_id       TEXT NOT NULL REFERENCES ext_split_group (group_id),
  member_id      TEXT NOT NULL,
  weight         INTEGER NOT NULL CHECK (weight >= 1),
  joined_on      TEXT NOT NULL,
  left_on        TEXT,
  bank_customer  INTEGER NOT NULL CHECK (bank_customer IN (0, 1)),
  PRIMARY KEY (group_id, member_id),
  CHECK (left_on IS NULL OR left_on >= joined_on)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_split_mandate (
  mandate_id       TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  member_id        TEXT NOT NULL,
  currency         TEXT NOT NULL,
  max_share_minor  INTEGER NOT NULL CHECK (max_share_minor > 0),
  manifest_digest  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','REVOKED')),
  grant_id         TEXT,
  FOREIGN KEY (group_id, member_id) REFERENCES ext_split_member (group_id, member_id),
  CHECK (status <> 'ACTIVE' OR grant_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ext_split_mandate_one_active
  ON ext_split_mandate (group_id, member_id)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS ext_split_request (
  idempotency_key  TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  cycle_id         TEXT NOT NULL,
  member_id        TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('DEBIT','REQUEST')),
  mandate_id       TEXT REFERENCES ext_split_mandate (mandate_id),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_minor       INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  due_on           TEXT NOT NULL,
  reminded         INTEGER NOT NULL DEFAULT 0 CHECK (reminded IN (0, 1)),
  FOREIGN KEY (group_id, member_id) REFERENCES ext_split_member (group_id, member_id),
  UNIQUE (group_id, cycle_id, member_id),
  -- A debit always names the member's own mandate; a request never does.
  CHECK ((method = 'DEBIT') = (mandate_id IS NOT NULL)),
  CHECK (paid_minor <= amount_minor)
) STRICT;

-- 10. Cancellation difficulty (aggregates only) ----------------------------------------

CREATE TABLE IF NOT EXISTS ext_cancellation_difficulty (
  merchant_id               TEXT PRIMARY KEY,
  flow_revision             INTEGER NOT NULL CHECK (flow_revision >= 0),
  status                    TEXT NOT NULL CHECK (status IN ('INSUFFICIENT_DATA','MEASURED')),
  customers                 INTEGER,
  grade                     TEXT CHECK (grade IN ('EASY','MODERATE','HARD')),
  median_steps              INTEGER,
  p90_steps                 INTEGER,
  median_retention_screens  INTEGER,
  median_seconds            INTEGER,
  human_contact_bp          INTEGER CHECK (human_contact_bp BETWEEN 0 AND 10000),
  completion_bp             INTEGER CHECK (completion_bp BETWEEN 0 AND 10000),
  computed_at               TEXT NOT NULL,
  -- Suppressed merchants carry no numbers at all.
  CHECK ((status = 'INSUFFICIENT_DATA') = (customers IS NULL)),
  CHECK ((status = 'INSUFFICIENT_DATA') = (grade IS NULL)),
  CHECK (status = 'INSUFFICIENT_DATA' OR (customers >= 2 AND median_steps IS NOT NULL AND median_seconds IS NOT NULL))
) STRICT;
