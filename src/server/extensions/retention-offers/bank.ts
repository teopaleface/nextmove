import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { all, one, run } from "../../db/connection";
import { dataDir } from "../../config";
import { sha256Hex } from "../../canonical";
import { canonicalJson, signPayload } from "../../../../extensions/src/shared/digest.ts";
import { verifyOffer, type MerchantKey, type OfferVerification, type RetentionOffer, type SignedOffer, type SubscriptionOwnership } from "../../../../extensions/src/retention-offers/index.ts";
import type { CustomerContext } from "../../../../extensions/src/shared/authority.ts";

// Bank side of retention offers: the merchant registry, merchant public keys, offer intake and re-verification.
// Merchants sign with Ed25519; the bank holds only public keys. The private half of a simulated merchant's key
// lives in a 0600 keystore file under the data directory and is used only by the Labs merchant simulation.

export const OFFER_MERCHANTS = [
  { merchantId: "streamly", verified: true, offersEnabled: true },
  { merchantId: "cloudbox", verified: true, offersEnabled: false },
] as const;

const keystoreDir = () => path.join(dataDir(), "keystore");
const keystoreFile = (keyId: string) => path.join(keystoreDir(), `${keyId}.json`);

export function contextKind(db: DatabaseSync, contextId: string): CustomerContext {
  return one<any>(db, "SELECT kind FROM contexts WHERE id=?", contextId)?.kind === "BUSINESS" ? "BUSINESS" : "PERSONAL";
}

/** The simulated merchant's active signing key for this run; generated when none exists or its private half is gone. */
export function merchantSigningKey(db: DatabaseSync, tenantId: string, merchantId: string, at: string): { keyId: string; privateKeyPem: string } {
  const row = one<any>(db, "SELECT key_id FROM ext_offer_merchant_key WHERE tenant_id=? AND merchant_id=? AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1", tenantId, merchantId);
  if (row) {
    try {
      const stored = JSON.parse(fs.readFileSync(keystoreFile(row.key_id), "utf8"));
      if (stored.keyId === row.key_id && stored.merchantId === merchantId && stored.tenantId === tenantId) return { keyId: row.key_id, privateKeyPem: stored.privateKeyPem };
    } catch {
      /* private half missing (new run or data dir): rotate below */
    }
    run(db, "UPDATE ext_offer_merchant_key SET status='RETIRED' WHERE tenant_id=? AND key_id=?", tenantId, row.key_id);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = `mk_${randomBytes(9).toString("hex")}`;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  fs.mkdirSync(keystoreDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keystoreFile(keyId), JSON.stringify({ keyId, tenantId, merchantId, algorithm: "Ed25519", privateKeyPem }), { mode: 0o600 });
  fs.chmodSync(keystoreFile(keyId), 0o600);
  run(
    db,
    "INSERT INTO ext_offer_merchant_key(tenant_id, key_id, merchant_id, algorithm, public_key_pem, private_ref, status, created_at) VALUES (?,?,?,'Ed25519',?,?, 'ACTIVE', ?)",
    tenantId, keyId, merchantId, publicKey.export({ type: "spki", format: "pem" }).toString(), `keystore:${keyId}`, at,
  );
  return { keyId, privateKeyPem };
}

/** Merchant-side signing (Labs simulation only). */
export function signOffer(offer: RetentionOffer, key: { keyId: string; privateKeyPem: string }): SignedOffer {
  const signature = edSign(null, Buffer.from(canonicalJson(offer)), createPrivateKey(key.privateKeyPem)).toString("base64");
  return { offer, keyId: key.keyId, signature };
}

function ed25519Valid(signed: SignedOffer, publicKeyPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(canonicalJson(signed.offer)), createPublicKey(publicKeyPem), Buffer.from(String(signed.signature), "base64"));
  } catch {
    return false;
  }
}

/**
 * Verify with the pure module. Its signature slot is an HMAC check, so the bank checks Ed25519 first and then hands
 * the module a per-call secret that matches only if the public-key check passed. Every other rule is the module's.
 */
export function verifySigned(db: DatabaseSync, tenantId: string, signed: SignedOffer, opts: { now: string; excludeReceivedAt?: string }): OfferVerification {
  // This bank never sends counter-offers, so a "reply to a counter" cannot be one; counting it keeps the
  // unrequested-offer limit from being skipped with a made-up counter id.
  if (signed?.offer?.inReplyToCounterId !== undefined) return { ok: false, reason: "RATE_LIMITED" };
  const keyRows = all<any>(db, "SELECT * FROM ext_offer_merchant_key WHERE tenant_id=?", tenantId);
  const callSecret = randomBytes(32).toString("hex");
  const target = keyRows.find((k) => k.key_id === signed.keyId);
  const edOk = target ? ed25519Valid(signed, target.public_key_pem) : false;
  const keys: MerchantKey[] = keyRows.map((k) => ({ keyId: k.key_id, merchantId: k.merchant_id, status: k.status, secret: k.key_id === signed.keyId ? callSecret : randomBytes(32).toString("hex") }));
  const bridged: SignedOffer = { offer: signed.offer, keyId: signed.keyId, signature: edOk ? signPayload(signed.offer, callSecret) : "0".repeat(64) };
  const merchants = all<any>(db, "SELECT * FROM ext_offer_merchant WHERE tenant_id=?", tenantId).map((m) => ({ merchantId: m.merchant_id, verified: m.verified === 1, retentionOffersEnabled: m.offers_enabled === 1 }));
  const ownership: SubscriptionOwnership[] = all<any>(db, "SELECT s.contract_id, s.merchant_id, s.subscriber_account_id, c.kind FROM subscriptions s JOIN contexts c ON c.id=s.context_id WHERE s.tenant_id=? AND s.state IN ('ACTIVE','TRIAL','RENEWAL_OFF','PAUSED')", tenantId).map((s) => ({
    subscriptionId: s.contract_id,
    merchantId: s.merchant_id,
    subscriberAccountId: s.subscriber_account_id,
    scope: { ownerId: tenantId, contextId: s.kind === "BUSINESS" ? "BUSINESS" : "PERSONAL" },
  }));
  const received = all<any>(
    db,
    "SELECT offer_id, subscription_id, received_at FROM ext_retention_offer WHERE tenant_id=? AND status != 'REJECTED' AND (? IS NULL OR received_at < ?)",
    tenantId, opts.excludeReceivedAt ?? null, opts.excludeReceivedAt ?? null,
  ).map((r) => ({ offerId: r.offer_id, subscriptionId: r.subscription_id, receivedAt: r.received_at, isCounterReply: false }));
  try {
    return verifyOffer(bridged, { keys, merchants, ownership, received, now: opts.now });
  } catch {
    return { ok: false, reason: "INVALID_TERMS" };
  }
}

/** Bank intake: every offer is verified and kept (rejected ones with the reason), never acted on by itself. */
export function receiveOffer(db: DatabaseSync, tenantId: string, signed: SignedOffer, now: string) {
  const o = signed.offer;
  const existing = one<any>(db, "SELECT * FROM ext_retention_offer WHERE tenant_id=? AND offer_id=? AND revision=?", tenantId, o.offerId, o.revision);
  if (existing) return { row: existing, duplicate: true };
  const v = verifySigned(db, tenantId, signed, { now });
  const sub = one<any>(db, "SELECT id, context_id FROM subscriptions WHERE tenant_id=? AND contract_id=? AND merchant_id=?", tenantId, o.subscriptionId, o.merchantId);
  if (!sub) throw new Error("offer for an unknown subscription");
  run(
    db,
    `INSERT INTO ext_retention_offer(tenant_id, context_id, offer_id, revision, merchant_id, subscription_id, offer_digest, signed_json, status, rejection, unsolicited, received_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    tenantId, sub.context_id, o.offerId, o.revision, o.merchantId, o.subscriptionId, v.ok ? v.offerDigest : sha256Hex(canonicalJson(o)), JSON.stringify(signed), v.ok ? "VERIFIED" : "REJECTED", v.ok ? null : v.reason, now, o.expiresAt,
  );
  return { row: one<any>(db, "SELECT * FROM ext_retention_offer WHERE tenant_id=? AND offer_id=? AND revision=?", tenantId, o.offerId, o.revision)!, duplicate: false };
}

/** Re-verify a stored offer now (keys, merchant status, ownership, expiry); only offers received before it count against the rate limit. */
export function reverify(db: DatabaseSync, row: any, now: string): OfferVerification {
  const signed = JSON.parse(row.signed_json) as SignedOffer;
  return verifySigned(db, row.tenant_id, signed, { now, excludeReceivedAt: row.received_at });
}

export const REJECTION_TEXT: Record<string, string> = {
  UNKNOWN_KEY: "Signed with a key the bank does not know",
  RETIRED_KEY: "Signed with a retired key",
  KEY_MERCHANT_MISMATCH: "Signed with another merchant's key",
  BAD_SIGNATURE: "Signature does not match the offer (it was changed after signing)",
  MERCHANT_NOT_VERIFIED: "The merchant is not a verified business client",
  OFFERS_NOT_ENABLED: "The merchant is not enrolled to send offers",
  NOT_CUSTOMER_SUBSCRIPTION: "It names a subscription that is not yours",
  INVALID_TERMS: "The terms are malformed",
  ISSUED_IN_FUTURE: "Dated in the future",
  EXPIRED: "The offer has expired",
  VALIDITY_TOO_LONG: "Valid for longer than 72 hours",
  RATE_LIMITED: "More than one unrequested offer in 30 days",
};
