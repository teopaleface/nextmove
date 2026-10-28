// ext_* tables for the merchant-insights module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// The cohort tables hold a SYNTHETIC demo cohort keyed only by pseudonymous customer keys (never an account,
// customer or tenant user id). The aggregate tables are what the bank publishes: no customer column at all, and a
// group below k carries no numbers.
export const merchantInsightsSchema = `
CREATE TABLE IF NOT EXISTS ext_mi_cohort_cancellation (
  tenant_id                  TEXT NOT NULL,
  obs_id                     TEXT NOT NULL,
  customer_key               TEXT NOT NULL CHECK (customer_key GLOB 'ck_*'),
  merchant_id                TEXT NOT NULL,
  cancellation_confirmed_at  TEXT NOT NULL,
  verified                   INTEGER NOT NULL CHECK (verified IN (0,1)),
  billed_after               INTEGER NOT NULL CHECK (billed_after IN (0,1)),
  PRIMARY KEY (tenant_id, obs_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_mi_cohort_charge (
  tenant_id     TEXT NOT NULL,
  obs_id        TEXT NOT NULL,
  customer_key  TEXT NOT NULL CHECK (customer_key GLOB 'ck_*'),
  merchant_id   TEXT NOT NULL,
  plan_key      TEXT NOT NULL,
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  charged_at    TEXT NOT NULL,
  recurring     INTEGER NOT NULL CHECK (recurring IN (0,1)),
  PRIMARY KEY (tenant_id, obs_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_mi_cohort_run (
  tenant_id               TEXT NOT NULL,
  run_id                  TEXT NOT NULL,
  customer_key            TEXT NOT NULL CHECK (customer_key GLOB 'ck_*'),
  merchant_id             TEXT NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN ('BROWSER_ADAPTER','PARTNER_API','MANUAL')),
  flow_revision           INTEGER NOT NULL CHECK (flow_revision >= 0),
  started_at              TEXT NOT NULL,
  finished_at             TEXT NOT NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('CONFIRMED','FAILED','NEEDS_CUSTOMER')),
  verified                INTEGER NOT NULL CHECK (verified IN (0,1)),
  steps                   INTEGER NOT NULL CHECK (steps >= 0),
  retention_screens       INTEGER NOT NULL CHECK (retention_screens >= 0),
  human_contact_required  INTEGER NOT NULL CHECK (human_contact_required IN (0,1)),
  PRIMARY KEY (tenant_id, run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_merchant_track_record (
  tenant_id               TEXT NOT NULL,
  merchant_id             TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('INSUFFICIENT_DATA','OK','FLAGGED')),
  customers               INTEGER,
  billed_after_customers  INTEGER,
  rate_bp                 INTEGER,
  lower_bound_bp          INTEGER,
  computed_at             TEXT NOT NULL,
  CHECK ((status = 'INSUFFICIENT_DATA') = (customers IS NULL)),
  CHECK (status = 'INSUFFICIENT_DATA' OR (customers >= 2 AND billed_after_customers BETWEEN 0 AND customers)),
  PRIMARY KEY (tenant_id, merchant_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_price_change_cluster (
  tenant_id      TEXT NOT NULL,
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
  PRIMARY KEY (tenant_id, merchant_id, plan_key, currency, old_minor, new_minor)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_cancellation_difficulty (
  tenant_id                 TEXT NOT NULL,
  merchant_id               TEXT NOT NULL,
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
  CHECK ((status = 'INSUFFICIENT_DATA') = (customers IS NULL)),
  CHECK ((status = 'INSUFFICIENT_DATA') = (grade IS NULL)),
  CHECK (status = 'INSUFFICIENT_DATA' OR (customers >= 2 AND median_steps IS NOT NULL AND median_seconds IS NOT NULL)),
  PRIMARY KEY (tenant_id, merchant_id)
) STRICT;
`;
