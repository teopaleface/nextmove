// ext_* tables for the exit-plan module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// The plan's terms live in the approved, digested STOP_RENEWAL spec; this table only tracks the evaluation state.
export const exitPlanSchema = `
CREATE TABLE IF NOT EXISTS ext_exit_plan (
  action_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- ACTIVE | ASKED | STOP_REQUESTED | KEPT | VOID
  outcome_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_exit_plan_tenant ON ext_exit_plan(tenant_id, context_id);
CREATE TABLE IF NOT EXISTS ext_exit_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- MERCHANT_REPORTED | DEVICE_SCREEN_TIME | CUSTOMER_REPORTED
  coverage TEXT NOT NULL,         -- ALL_DEVICES | THIS_DEVICE_ONLY
  shared_by_customer INTEGER NOT NULL,
  uses INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_exit_usage_sub ON ext_exit_usage(tenant_id, context_id, subscription_id);
`;
