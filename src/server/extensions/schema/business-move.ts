// ext_* tables for the business-move module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// A personally paid cost the business uses, its past charges (bank-posted), the company profile, dated VAT rule sets
// for the accountant note, each side's consent to one exact plan, and the repayments (one per charge, ever).
export const businessMoveSchema = `
CREATE TABLE IF NOT EXISTS ext_bizmove_subscription (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,       -- the household (PERSONAL) context that pays today
  account_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  merchant_country TEXT NOT NULL,
  channel TEXT NOT NULL,          -- MERCHANT_DIRECT | APP_STORE
  supports_billing_profile INTEGER NOT NULL,
  plan_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_bizmove_subscription_tenant ON ext_bizmove_subscription(tenant_id, context_id);
CREATE TABLE IF NOT EXISTS ext_bizmove_charge (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  posted_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0,
  invoice_id TEXT,
  invoice_issued_to TEXT          -- PERSONAL_NAME | BUSINESS_NAME
);
CREATE INDEX IF NOT EXISTS ext_bizmove_charge_sub ON ext_bizmove_charge(tenant_id, subscription_id);
CREATE TABLE IF NOT EXISTS ext_business_profile (
  context_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  vat_registered INTEGER NOT NULL,
  card_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_business_profile_tenant ON ext_business_profile(tenant_id);
CREATE TABLE IF NOT EXISTS ext_vat_rule_set (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  rule_set_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  home_country TEXT NOT NULL,
  eu_countries_json TEXT NOT NULL,
  UNIQUE (tenant_id, rule_set_id, version)
);
CREATE TABLE IF NOT EXISTS ext_business_move (
  plan_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  household_context_id TEXT NOT NULL,
  business_context_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  inputs_json TEXT NOT NULL,      -- { chargeIds, businessUseBp }: what the household approved
  status TEXT NOT NULL,           -- HOUSEHOLD_APPROVED | COMPLETED
  household_action_id TEXT NOT NULL,
  household_grant_id TEXT NOT NULL,
  household_approved_at TEXT NOT NULL,
  consent_expires_at TEXT NOT NULL,
  business_action_id TEXT,
  repaid_minor INTEGER,
  future_json TEXT,
  vat_note_json TEXT,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, plan_id)
);
CREATE TABLE IF NOT EXISTS ext_business_repayment (
  idempotency_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  ledger_entry_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, subscription_id, charge_id)
);
`;
