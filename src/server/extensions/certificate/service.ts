import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../../db/connection";
import { sha256Hex } from "../../canonical";
import { nowIso, nowMs } from "../../clock";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { HttpError, type Session } from "../../auth/session";
import { toLocalIso } from "../../../shared/time";
import type { ExtActionContext } from "../types";
import { iso, stopReceipts } from "../cancellation-guarantee/stop-receipts";
import { KEY_REF, publicKeyOf, signingKey } from "./keystore";
import {
  CLAIM_NAMES,
  certificatesToRevoke,
  issueCertificate,
  present,
  signRevocationList,
  verifyCertificate,
  type ClaimName,
  type IssuedCertificate,
  type SigningKey,
  type TrustedKey,
} from "../../../../extensions/src/cancellation-certificate/index.ts";
import { endingInForce } from "../../../../extensions/src/shared/receipts.ts";

// E8 bank side. Issuing, revocation and verification are the module's; this file supplies keys, the issued
// records and the signed revocation list, all scoped to one tenant. Each tenant has its own issuer name, so a
// certificate is only accepted by the verifier of the tenant whose bank observed the stop.

export const VALIDITY_DAYS = 365;
export const MAX_PRESENTED_LENGTH = 4096;
const LIST_HOURS = 24;

export const STATEMENT = "This certificate is NextMove's signed statement of what the bank observed when it read back the provider's state. It is not a document issued by the provider.";

export const issuerOf = (tenantId: string) => `NextMove demo bank #${sha256Hex(`cert-issuer:${tenantId}`).slice(0, 12)}`;

/** The tenant's signing key: the data directory's keystore key, registered for this tenant's issuer. */
export function tenantKey(db: DatabaseSync, tenantId: string): SigningKey {
  const k = signingKey();
  const issuer = issuerOf(tenantId);
  if (!one(db, "SELECT 1 FROM ext_certificate_key WHERE tenant_id=? AND key_id=?", tenantId, k.keyId)) {
    // A regenerated keystore (new data directory) retires the old key: it still verifies what it signed.
    run(db, "UPDATE ext_certificate_key SET status='RETIRED' WHERE tenant_id=? AND status='ACTIVE'", tenantId);
    run(db, "INSERT INTO ext_certificate_key(tenant_id, key_id, issuer, algorithm, public_key_spki, private_key_ref, status, created_at) VALUES (?,?,?,'Ed25519',?,?, 'ACTIVE', ?)", tenantId, k.keyId, issuer, k.publicKeySpki, KEY_REF, nowIso(db, tenantId));
  }
  return { keyId: k.keyId, issuer, privateKey: k.privateKey };
}

export function trustedKeys(db: DatabaseSync, tenantId: string): Map<string, TrustedKey> {
  return new Map(
    all<any>(db, "SELECT * FROM ext_certificate_key WHERE tenant_id=?", tenantId).map((r) => [r.key_id, { keyId: r.key_id, issuer: r.issuer, publicKey: publicKeyOf(r.public_key_spki), status: r.status }]),
  );
}

const issuedOf = (db: DatabaseSync, tenantId: string, contextId: string, scope: IssuedCertificate["scope"]): IssuedCertificate[] =>
  all<any>(db, "SELECT * FROM ext_certificate WHERE tenant_id=? AND context_id=? AND revoked_at IS NULL", tenantId, contextId).map((r) => ({ certId: r.cert_id, scope, subscriptionId: r.subscription_id, receiptId: r.receipt_id, expiresAt: r.expires_at }));

/**
 * Revoke certificates that no longer describe the truth (renewal back on, or a newer ending) and keep a fresh signed
 * revocation list. Returns the current list, or null when this tenant never issued a certificate.
 */
export function sweep(db: DatabaseSync, tenantId: string): string | null {
  if (!one(db, "SELECT 1 FROM ext_certificate WHERE tenant_id=? LIMIT 1", tenantId)) return null;
  return tx(db, () => {
    const now = iso(nowIso(db, tenantId));
    for (const { context_id } of all<any>(db, "SELECT DISTINCT context_id FROM ext_certificate WHERE tenant_id=? AND revoked_at IS NULL", tenantId)) {
      const view = stopReceipts(db, tenantId, context_id);
      for (const certId of certificatesToRevoke(issuedOf(db, tenantId, context_id, view.scope), view.receipts, now)) {
        run(db, "UPDATE ext_certificate SET revoked_at=?, revoked_reason=? WHERE cert_id=? AND tenant_id=? AND revoked_at IS NULL", now, "The provider's state no longer matches the confirmed stop", certId, tenantId);
      }
    }
    const revoked = all<any>(db, "SELECT cert_id FROM ext_certificate WHERE tenant_id=? AND revoked_at IS NOT NULL ORDER BY cert_id", tenantId).map((r) => r.cert_id as string);
    const latest = one<any>(db, "SELECT * FROM ext_certificate_revocation WHERE tenant_id=? ORDER BY seq DESC LIMIT 1", tenantId);
    const key = tenantKey(db, tenantId);
    const fresh = latest && latest.revoked_json === JSON.stringify(revoked) && latest.key_id === key.keyId && latest.issuer === key.issuer && nowMs(db, tenantId) < Date.parse(latest.next_update) - 3_600_000;
    if (fresh) return latest.signed_text as string;
    const seq = (latest?.seq ?? -1) + 1;
    const nextUpdate = toLocalIso(nowMs(db, tenantId) + LIST_HOURS * 3_600_000);
    const signed = signRevocationList({ seq, issuedAt: now, nextUpdate, revoked }, key);
    run(db, "INSERT INTO ext_certificate_revocation(tenant_id, seq, issuer, key_id, issued_at, next_update, revoked_json, signed_text) VALUES (?,?,?,?,?,?,?,?)", tenantId, seq, key.issuer, key.keyId, now, nextUpdate, JSON.stringify(revoked), signed);
    return signed;
  });
}

/* -------------------------------------------------------------------------------------- operation */

export function issueOp(c: ExtActionContext) {
  tx(c.db, () => issueTx(c));
}

function issueTx({ db, action, spec, attemptId }: ExtActionContext) {
  const t = action.tenant_id;
  const ctxId = action.context_id;
  const settle = (status: "REFUSED" | "NO_CHANGE", reason: string) => recordSettled(db, action.id, attemptId, status, { reason });
  const confirm = (row: any) =>
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference: `CRT-${sha256Hex(action.logical_key).slice(0, 10).toUpperCase()}`,
      effectiveAt: row.issued_at,
      accessUntil: null,
      termsRevision: null,
      details: { certId: row.cert_id, merchantName: row.merchant_name, stopReference: row.receipt_id, expiresAt: row.expires_at, keyId: row.key_id, statement: STATEMENT },
      channel: "BANK",
      verification: { method: "module issuance from a stop read back from the provider", checks: [`stop ${row.receipt_id} still in force`, "independent read-back of the provider's state", "Ed25519 signature with a key held outside the database"] },
      evidence: "BANK_RECORD",
    });

  const mine = one<any>(db, "SELECT * FROM ext_certificate WHERE action_id=? AND tenant_id=?", action.id, t);
  if (mine) return confirm(mine);
  const subId = String(spec.params.subscriptionId ?? "");
  const view = stopReceipts(db, t, ctxId);
  const sub = view.subs.get(subId);
  const now = iso(nowIso(db, t));
  const ending = sub ? endingInForce(view.receipts, view.scope, subId, now) : undefined;
  if (!sub || sub.id !== action.subject_ref) return settle("REFUSED", "No confirmed stop for this subscription in this context");
  if (!ending || ending.receiptId !== spec.params.receiptId) return settle("REFUSED", "The stop you approved is no longer in force; nothing was issued");
  if (ending.verification !== "INDEPENDENT_READ_BACK") return settle("REFUSED", "Only a stop read back from the provider can be certified");
  if (Number(spec.params.validityDays) !== VALIDITY_DAYS) return settle("REFUSED", "Validity does not match what was approved");
  const live = one<any>(db, "SELECT cert_id FROM ext_certificate WHERE tenant_id=? AND context_id=? AND receipt_id=? AND revoked_at IS NULL", t, ctxId, ending.receiptId);
  if (live) return settle("NO_CHANGE", "A valid certificate for this stop already exists");
  const key = tenantKey(db, t);
  const { compact, record } = issueCertificate({ scope: view.scope, subscriptionId: subId, receipts: view.receipts, merchantName: sub.merchant_name, key, validityDays: VALIDITY_DAYS, now });
  run(
    db,
    "INSERT INTO ext_certificate(cert_id, tenant_id, context_id, action_id, subscription_id, receipt_id, bank_receipt_id, merchant_name, key_id, issued_at, expires_at, holder_copy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    record.certId, t, ctxId, action.id, subId, record.receiptId, view.stops.find((s) => s.receipt.receiptId === record.receiptId)!.bankReceiptId, sub.merchant_name, key.keyId, now, record.expiresAt, compact,
  );
  confirm(one<any>(db, "SELECT * FROM ext_certificate WHERE cert_id=?", record.certId));
  sweep(db, t);
}

/* ---------------------------------------------------------------------------------------- routes */

export function getCertificate(db: DatabaseSync, session: Session, certId: string, url: URL) {
  if (!/^cert_[0-9a-f]{24}$/.test(certId)) throw new HttpError(404, "NOT_FOUND", "Certificate not found");
  const list = sweep(db, session.tenantId);
  const row = one<any>(db, "SELECT * FROM ext_certificate WHERE cert_id=? AND tenant_id=? AND context_id=?", certId, session.tenantId, session.contextId);
  if (!row || !list) throw new HttpError(404, "NOT_FOUND", "Certificate not found");
  const reveal = (url.searchParams.get("reveal") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (reveal.some((r) => !(CLAIM_NAMES as readonly string[]).includes(r)) || reveal.length > CLAIM_NAMES.length) throw new HttpError(400, "BAD_INPUT", `reveal must be a list of ${CLAIM_NAMES.join(", ")}`);
  const key = one<any>(db, "SELECT key_id, issuer, public_key_spki, status FROM ext_certificate_key WHERE tenant_id=? AND key_id=?", session.tenantId, row.key_id);
  return {
    certId: row.cert_id,
    merchantName: row.merchant_name,
    stopReference: row.receipt_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    certificate: reveal.length ? present(row.holder_copy, [...new Set(reveal)] as ClaimName[]) : row.holder_copy,
    disclosed: reveal.length ? [...new Set(reveal)] : [...CLAIM_NAMES],
    revocationList: list,
    publicKey: key ? { keyId: key.key_id, issuer: key.issuer, algorithm: "Ed25519", spki: key.public_key_spki, status: key.status } : null,
    statement: STATEMENT,
  };
}

const REASON_TEXT: Record<string, string> = {
  MALFORMED: "This is not a NextMove certificate",
  UNSUPPORTED_VERSION: "Unsupported certificate version",
  UNKNOWN_KEY: "Signed with a key this bank does not know",
  KEY_COMPROMISED: "The signing key was withdrawn",
  ISSUER_MISMATCH: "Issued for another customer's bank record",
  BAD_SIGNATURE: "The signature does not match: the certificate was altered",
  NOT_YET_VALID: "Not valid yet",
  EXPIRED: "Expired",
  DISCLOSURE_MISMATCH: "A shown claim was altered",
  DUPLICATE_DISCLOSURE: "A claim is shown twice",
  REVOCATION_LIST_INVALID: "The revocation list could not be checked",
  REVOCATION_LIST_STALE: "The revocation list is out of date",
  REVOKED: "Revoked: the provider's state no longer matches the stop",
};

export function verifyPresented(db: DatabaseSync, session: Session, body: any) {
  const text = body?.certificate;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_PRESENTED_LENGTH || !/^[A-Za-z0-9_.~-]+$/.test(text)) throw new HttpError(400, "BAD_INPUT", `certificate must be the certificate text (at most ${MAX_PRESENTED_LENGTH} characters)`);
  const list = sweep(db, session.tenantId);
  const now = iso(nowIso(db, session.tenantId));
  const result = list ? verifyCertificate(text, { trustedKeys: trustedKeys(db, session.tenantId), revocationList: list, now }) : ({ ok: false, reason: "UNKNOWN_KEY" } as const);
  return { ...result, ...(result.ok ? {} : { message: REASON_TEXT[result.reason] ?? result.reason }), checkedAt: now, statement: STATEMENT };
}
