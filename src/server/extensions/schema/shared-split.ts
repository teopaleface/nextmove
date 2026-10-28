// ext_* tables for the shared-split module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// A household bill shared with fictional members, and the payment requests sent for each cycle. Nobody is debited:
// members without a mandate (all of them in this build) only receive requests, and their payments arrive as credits.
export const sharedSplitSchema = `
CREATE TABLE IF NOT EXISTS ext_split_group (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  organizer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  account_id TEXT NOT NULL,       -- the organizer's account that pays the bill and receives the shares
  label TEXT NOT NULL,
  currency TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  cycle_starts_on TEXT NOT NULL,
  cycle_ends_on TEXT NOT NULL,
  due_days INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_split_group_tenant ON ext_split_group(tenant_id, context_id);
CREATE TABLE IF NOT EXISTS ext_split_member (
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  weight INTEGER NOT NULL,
  joined_on TEXT NOT NULL,
  left_on TEXT,
  bank_customer INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, group_id, member_id)
);
CREATE TABLE IF NOT EXISTS ext_split_request (
  idempotency_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  paid_minor INTEGER NOT NULL DEFAULT 0,
  due_on TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL,           -- REQUESTED | PAID
  action_id TEXT NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ext_split_request_group ON ext_split_request(tenant_id, context_id, group_id, cycle_id);
`;
