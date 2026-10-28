// ext_* tables for the retention-offers module. Every table is named ext_* and has tenant_id TEXT NOT NULL.
// No secret material: a merchant key row holds only the public key and a keystore reference to the private half,
// which lives in a 0600 file owned by the Labs merchant simulation.
export const retentionOffersSchema = `
CREATE TABLE IF NOT EXISTS ext_offer_merchant (
  tenant_id        TEXT NOT NULL,
  merchant_id      TEXT NOT NULL,
  verified         INTEGER NOT NULL CHECK (verified IN (0, 1)),
  offers_enabled   INTEGER NOT NULL CHECK (offers_enabled IN (0, 1)),
  PRIMARY KEY (tenant_id, merchant_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_offer_merchant_key (
  tenant_id        TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  merchant_id      TEXT NOT NULL,
  algorithm        TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_pem   TEXT NOT NULL CHECK (public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'),
  private_ref      TEXT NOT NULL CHECK (private_ref LIKE 'keystore:%'),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_retention_offer (
  tenant_id        TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  offer_id         TEXT NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  merchant_id      TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  offer_digest     TEXT NOT NULL,
  -- The signed offer exactly as received; merchant text inside it is untrusted data.
  signed_json      TEXT NOT NULL CHECK (json_valid(signed_json)),
  status           TEXT NOT NULL CHECK (status IN ('VERIFIED','REJECTED','ACCEPTED')),
  rejection        TEXT,
  unsolicited      INTEGER NOT NULL CHECK (unsolicited IN (0, 1)),
  received_at      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, offer_id, revision),
  CHECK ((status = 'REJECTED') = (rejection IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS ext_retention_offer_sub ON ext_retention_offer (tenant_id, context_id, subscription_id, received_at);

CREATE TABLE IF NOT EXISTS ext_offer_acceptance (
  tenant_id        TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  offer_id         TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  offer_digest     TEXT NOT NULL,
  action_id        TEXT NOT NULL,
  reference        TEXT NOT NULL,
  accepted_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  -- Only one revision of an offer can ever be accepted.
  UNIQUE (tenant_id, offer_id),
  CHECK (idempotency_key = 'offer:' || offer_id || ':' || revision)
) STRICT;
`;
