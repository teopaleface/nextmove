// Bank-side persistent schema. Merchant state lives in a separate database owned by the merchant process.
// Every customer-owned row carries tenant_id and context_id; ownership is checked on every read and write.

export const BANK_SCHEMA_VERSION = 2;

export const BANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Identity -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  base_customer TEXT NOT NULL,
  isolated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  display_name TEXT NOT NULL,
  initials TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('PERSONAL','BUSINESS')),
  name TEXT NOT NULL,
  subtitle TEXT,
  role TEXT NOT NULL DEFAULT 'OWNER',
  reserve_floor_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'RON',
  ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,            -- sha256 of the opaque cookie token
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  active_context_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Bank ledger ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- CURRENT | SAVINGS | BUSINESS_CURRENT | EXTERNAL_CLEARING
  iban_masked TEXT,
  currency TEXT NOT NULL DEFAULT 'RON',
  opening_minor INTEGER NOT NULL DEFAULT 0,
  ordinal INTEGER NOT NULL DEFAULT 0,
  card_json TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,  -- one posting per authoritative source event (per tenant)
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_event_id)
);
CREATE TABLE IF NOT EXISTS ledger_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_lines_account ON ledger_lines(account_id);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT,                  -- null while pending: holds never change the booked balance
  status TEXT NOT NULL CHECK (status IN ('POSTED','PENDING','RELEASED')),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor INTEGER NOT NULL,  -- signed: debits negative
  currency TEXT NOT NULL DEFAULT 'RON',
  merchant_id TEXT,
  merchant_name TEXT NOT NULL,
  category TEXT,
  reference TEXT,
  order_ref TEXT,
  card_last4 TEXT,
  booked_at TEXT NOT NULL,
  note TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS transactions_ctx ON transactions(tenant_id, context_id, booked_at);

-- Subscriptions, bills and the dated forecast ----------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  dataset TEXT NOT NULL,          -- ui | bills | bulk | scenario
  category TEXT NOT NULL,         -- SUBSCRIPTION | TELECOM | UTILITY | SOFTWARE
  merchant_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  subscriber_account_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL,    -- merchant|subscriber account|contract, shared across actors
  plan_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RON',
  billing_period TEXT NOT NULL DEFAULT 'MONTHLY',
  state TEXT NOT NULL,            -- ACTIVE | TRIAL | RENEWAL_OFF | PAUSED | CANCELLED
  next_charge_at TEXT,
  access_until TEXT,
  terms_revision INTEGER NOT NULL DEFAULT 1,
  observed_revision INTEGER NOT NULL DEFAULT 1,
  last_observed_at TEXT,
  benefits_json TEXT,
  data_json TEXT,
  UNIQUE (tenant_id, canonical_key)
);
CREATE TABLE IF NOT EXISTS forecast_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  subscription_id TEXT,
  kind TEXT NOT NULL,             -- RENEWAL | TRIAL_CONVERSION | BILL | PLANNED_TRANSFER | RECEIVABLE | SUPPLIER_PAYMENT | ORDER
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,  -- signed: outflows negative
  currency TEXT NOT NULL DEFAULT 'RON',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED | REMOVED | SUPERSEDED | SETTLED
  condition TEXT,                 -- conditional items stay visibly conditional
  source TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS forecast_ctx ON forecast_items(tenant_id, context_id, dataset, due_at);
CREATE TABLE IF NOT EXISTS forecast_events (
  id TEXT NOT NULL,               -- unique source event (e.g. receipt id) per tenant; applying twice is a no-op
  tenant_id TEXT NOT NULL,
  forecast_item_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Goals, preferences and business records ----------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_comparisons (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  goal_id TEXT,
  kind TEXT NOT NULL,
  input_revision INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  choice TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source TEXT NOT NULL,           -- USER_CONFIRMED | SUGGESTED
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, context_id, key)
);
CREATE TABLE IF NOT EXISTS business_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- INVOICE | INVENTORY | SUPPLIER_QUOTE | FUNDING_OFFER | OWNER_ARRANGEMENT | LICENSE_ROSTER
  data_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recoveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- REFUND | DUPLICATE_CLAIM | PRICE_ADJUSTMENT
  merchant_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'RON',
  state TEXT NOT NULL,            -- DRAFT | SUBMITTED | MERCHANT_ACCEPTED | AWAITING_CREDIT | CREDITED | DECLINED
  reference TEXT,
  expected_by TEXT,
  transaction_id TEXT,
  credit_transaction_id TEXT,
  timeline_json TEXT NOT NULL,
  data_json TEXT,
  updated_at TEXT NOT NULL
);

-- Evidence ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,            -- opaque
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  task_id TEXT,
  mode TEXT NOT NULL,             -- LIVE_MODEL | MANUAL_INPUT | REPLAY
  model TEXT,
  status TEXT NOT NULL,           -- EXTRACTED | CONFIRMED | FAILED
  fields_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  task_id TEXT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  provenance TEXT NOT NULL,       -- READ_FROM_IMAGE | MATCHED_BANK_RECORD | YOU_ENTERED | NEEDS_CHECKING | MERCHANT | CATALOG
  source_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Agent tasks --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  subject_ref TEXT,
  input_revision INTEGER NOT NULL DEFAULT 1,
  planner_mode TEXT,
  model TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  step_budget INTEGER NOT NULL DEFAULT 8,
  rounds INTEGER NOT NULL DEFAULT 0,
  request_text TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_ctx ON tasks(tenant_id, context_id, updated_at);
CREATE TABLE IF NOT EXISTS task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  evidence TEXT,                  -- evidence level label for this event
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, seq);
CREATE TABLE IF NOT EXISTS task_blocks (
  task_id TEXT NOT NULL,
  block_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, block_key)
);
CREATE TABLE IF NOT EXISTS task_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer_json TEXT,
  status TEXT NOT NULL,           -- OPEN | ANSWERED | CLOSED
  created_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE (task_id, question_key)
);
CREATE TABLE IF NOT EXISTS action_candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,        -- server-built ActionSpec; the model can only reference the id
  status TEXT NOT NULL,           -- AVAILABLE | BLOCKED | USED | OUTDATED
  blocked_reason TEXT,
  created_at TEXT NOT NULL
);

-- Authority ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  task_id TEXT,
  batch_id TEXT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,           -- READY | APPROVED | DECLINED | EXPIRED | OUTDATED
  scope TEXT NOT NULL,            -- SINGLE | BATCH
  manifest_json TEXT NOT NULL,    -- immutable canonical manifest
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ready_expires_at TEXT NOT NULL,
  decided_at TEXT,
  outdated_reason TEXT
);
CREATE TABLE IF NOT EXISTS proposal_actions (
  id TEXT PRIMARY KEY,            -- logical action identity
  proposal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  operation TEXT NOT NULL,
  route TEXT NOT NULL,            -- PARTNER_API | ISOLATED_BROWSER | BANK_INTERNAL | LOCAL_PREPARATION
  merchant_id TEXT,
  canonical_key TEXT,
  logical_key TEXT NOT NULL,      -- stable identity of the effect across proposal revisions
  subject_ref TEXT,
  spec_json TEXT NOT NULL,
  spec_digest TEXT NOT NULL,
  terms_revision INTEGER,
  status TEXT NOT NULL,           -- PROPOSED | APPROVED | EXECUTING | CONFIRMED | PENDING | REFUSED | UNKNOWN | BLOCKED | TERMS_CHANGED | REVOKED | EXPIRED | NOT_STARTED | OUTDATED | PREPARED
  result_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposal_actions_prop ON proposal_actions(proposal_id, ordinal);
CREATE INDEX IF NOT EXISTS proposal_actions_logical ON proposal_actions(tenant_id, logical_key);
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE, -- one mandate per immutable proposal revision: repeat approvals return it
  scope TEXT NOT NULL,
  status TEXT NOT NULL,           -- ACTIVE | REVOKED | EXPIRED | COMPLETED
  revocation_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  start_expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,            -- opaque
  mandate_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  canonical_key TEXT,
  spec_digest TEXT NOT NULL,
  terms_revision INTEGER,
  max_debit_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'RON',
  status TEXT NOT NULL,           -- ACTIVE | CONSUMED | REVOKED | EXPIRED | INVALIDATED
  epoch_at_issue INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by_attempt TEXT,
  invalid_reason TEXT
);
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- READ | MONITOR
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,           -- ACTIVE | REVOKED
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  last_checked_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS merchant_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  subscriber_account_id TEXT NOT NULL,
  token_cipher TEXT NOT NULL,     -- AES-256-GCM encrypted delegated merchant token
  status TEXT NOT NULL,           -- LINKED | NEEDS_SIGN_IN | REVOKED
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, merchant_id, subscriber_account_id)
);

-- Execution ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  UNIQUE (topic, ref_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- ACTION | AGENT | RECONCILE | INSPECT_BATCH
  ref_id TEXT NOT NULL,
  route TEXT,
  status TEXT NOT NULL,           -- QUEUED | LEASED | DONE | PARKED | FAILED
  priority INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  concurrency_key TEXT,
  user_key TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at, priority);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL,           -- CLAIMED | DISPATCH_AUTHORIZED | SENT | CONFIRMED | PENDING | REFUSED | UNKNOWN | BLOCKED | TERMS_CHANGED | REVOKED | EXPIRED | NOT_DISPATCHED | FAILED_BEFORE_SEND
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  outcome_json TEXT,
  evidence_json TEXT,
  reconcile_checks INTEGER NOT NULL DEFAULT 0,
  next_reconcile_at TEXT
);
CREATE INDEX IF NOT EXISTS attempts_action ON attempts(action_id);
CREATE INDEX IF NOT EXISTS attempts_logical ON attempts(tenant_id, logical_key);
CREATE TABLE IF NOT EXISTS dispatch_journal (
  attempt_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  authorized_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  action_id TEXT,
  attempt_id TEXT,
  issuer TEXT NOT NULL,
  issuer_reference TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_at TEXT,
  access_until TEXT,
  terms_revision INTEGER,
  money_effect_json TEXT,
  verification_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE (tenant_id, issuer, issuer_reference)
);
CREATE TABLE IF NOT EXISTS inbox_events (
  issuer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  result TEXT,
  PRIMARY KEY (tenant_id, issuer, event_id)
);

-- Batches --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  task_id TEXT,
  proposal_id TEXT,
  status TEXT NOT NULL,           -- INSPECTING | REVIEW | APPROVED | RUNNING | STOPPED | NEEDS_ATTENTION | COMPLETED
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT
);
CREATE TABLE IF NOT EXISTS batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  review_status TEXT,             -- READY | ALREADY_OFF | NEEDS_AUTH | FIXED_COMMITMENT | PROTECTED_OR_SHARED | UNSUPPORTED
  review_detail_json TEXT,
  route TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  action_id TEXT,
  outcome TEXT,                   -- latest execution outcome (mirrors the action/attempt record)
  outcome_detail TEXT,
  receipt_id TEXT,
  forecast_applied INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, subscription_id)
);

-- Monitoring -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- TRIAL_CONVERSION | OFFER_TERMS | PRICE_CHANGE | REFUND_DUE | CREDIT_EXPIRY | SEAT_USAGE
  subject_ref TEXT NOT NULL,
  label TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  status TEXT NOT NULL,           -- ACTIVE | PAUSED | REVOKED | DONE
  consent_revision INTEGER NOT NULL DEFAULT 1,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_result TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  watch_id TEXT,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  subject_ref TEXT,
  task_kind TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  data_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  finding_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

-- System -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_clocks (
  tenant_id TEXT PRIMARY KEY,
  base_ms INTEGER NOT NULL,       -- demo instant at the anchor
  anchor_real_ms INTEGER NOT NULL,-- real time when the base was set
  frozen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  beat_at TEXT NOT NULL,
  info_json TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  task_id TEXT,
  purpose TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,           -- OK | ERROR | TIMEOUT | UNAVAILABLE
  duration_ms INTEGER,
  input_chars INTEGER,
  image_count INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_status (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
