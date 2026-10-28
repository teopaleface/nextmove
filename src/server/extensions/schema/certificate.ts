// ext_* tables for the cancellation certificate (E8). Every table is named ext_* and has tenant_id TEXT NOT NULL.
// No secret material: a key row holds the public key and a keystore reference; the private half is a file under the
// data directory. holder_copy is the customer's own signed certificate (claims and salts), never key material.
export const certificateSchema = `
CREATE TABLE IF NOT EXISTS ext_certificate_key (
  tenant_id        TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  issuer           TEXT NOT NULL,
  algorithm        TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_spki  TEXT NOT NULL,
  private_key_ref  TEXT NOT NULL CHECK (private_key_ref GLOB 'keystore:*'),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED','COMPROMISED')),
  created_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key_id)
) STRICT;

CREATE TABLE IF NOT EXISTS ext_certificate (
  cert_id          TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  action_id        TEXT NOT NULL UNIQUE,
  subscription_id  TEXT NOT NULL,
  receipt_id       TEXT NOT NULL,
  bank_receipt_id  TEXT NOT NULL,
  merchant_name    TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  issued_at        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT,
  revoked_reason   TEXT,
  holder_copy      TEXT NOT NULL,
  FOREIGN KEY (tenant_id, key_id) REFERENCES ext_certificate_key (tenant_id, key_id)
) STRICT;
CREATE INDEX IF NOT EXISTS ext_certificate_ctx ON ext_certificate (tenant_id, context_id, subscription_id);

CREATE TABLE IF NOT EXISTS ext_certificate_revocation (
  tenant_id        TEXT NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 0),
  issuer           TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  issued_at        TEXT NOT NULL,
  next_update      TEXT NOT NULL,
  revoked_json     TEXT NOT NULL CHECK (json_valid(revoked_json)),
  signed_text      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
) STRICT;
`;
