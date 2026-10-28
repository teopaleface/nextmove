import { createHash, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import type { Scope } from '../shared/authority.ts';
import { canonicalJson, digestOf } from '../shared/digest.ts';
import { invariant } from '../shared/errors.ts';
import { endingInForce, type MerchantReceipt } from '../shared/receipts.ts';
import { addMinutes, assertInstant, isAfter, isBefore, localDate, type Instant, type IsoDate } from '../shared/time.ts';

/**
 * A cancellation certificate anyone can check without asking the bank: a merchant, a
 * collections agency, a court. Signed with Ed25519 (an HMAC could only be checked by a holder
 * of the secret). Fits in a QR code.
 *
 * Selective disclosure follows the salted-hash pattern used by SD-JWT: the signed payload holds
 * only digests of each claim, and the holder reveals the claims they choose. The certificate
 * never contains amounts, the customer's name or bank identifiers.
 *
 * Wire format: `NMC1.<payload>.<signature>~<disclosure>~…`, every part base64url.
 */
export const CLAIM_NAMES = ['merchant', 'subscriptionRef', 'effectiveDate'] as const;
export type ClaimName = (typeof CLAIM_NAMES)[number];

export interface DisclosedClaims {
  readonly merchant?: { readonly merchantId: string; readonly name: string };
  /** The merchant's own confirmation number, so the merchant can look it up. */
  readonly subscriptionRef?: string;
  readonly effectiveDate?: IsoDate;
}

export interface SigningKey {
  readonly keyId: string;
  readonly issuer: string;
  readonly privateKey: KeyObject;
}

/** Retired keys still verify certificates they signed; a compromised key verifies nothing. */
export interface TrustedKey {
  readonly keyId: string;
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly status: 'ACTIVE' | 'RETIRED' | 'COMPROMISED';
}

/** What the issuer keeps so it can revoke later; holds no claim values. */
export interface IssuedCertificate {
  readonly certId: string;
  readonly scope: Scope;
  readonly subscriptionId: string;
  readonly receiptId: string;
  readonly expiresAt: Instant;
}

interface CertificatePayload {
  readonly v: 1;
  readonly typ: 'CANCELLATION_CERTIFICATE';
  readonly iss: string;
  readonly kid: string;
  readonly cid: string;
  readonly iat: Instant;
  readonly exp: Instant;
  readonly sd: readonly string[];
}

export const MAX_VALIDITY_DAYS = 400;

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url');
const sha = (text: string): string => createHash('sha256').update(text, 'ascii').digest('base64url');

/** Strict base64url: re-encoding must give the same text, so no two strings decode alike. */
function unb64(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : undefined;
}

function parseJson(bytes: Buffer | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function effectiveDateOf(receipt: MerchantReceipt): IsoDate {
  return receipt.operation === 'CANCEL_IMMEDIATELY' ? localDate(receipt.confirmedAt) : localDate(receipt.accessUntil);
}

export function issueCertificate(input: {
  readonly scope: Scope;
  readonly subscriptionId: string;
  readonly receipts: readonly MerchantReceipt[];
  readonly merchantName: string;
  readonly key: SigningKey;
  readonly validityDays: number;
  readonly now: Instant;
  /** Injected for deterministic tests; defaults to 128 random bits per claim. */
  readonly salt?: (claim: ClaimName) => string;
}): { readonly compact: string; readonly record: IssuedCertificate } {
  assertInstant(input.now, 'now');
  invariant(Number.isInteger(input.validityDays) && input.validityDays >= 1 && input.validityDays <= MAX_VALIDITY_DAYS, 'INVALID_VALIDITY', `validity must be 1..${MAX_VALIDITY_DAYS} days`);
  invariant(input.merchantName.trim().length > 0, 'INVALID_NAME', 'merchant name required');
  const receipt = endingInForce(input.receipts, input.scope, input.subscriptionId, input.now);
  invariant(receipt !== undefined, 'NO_CONFIRMED_ENDING', 'no confirmed cancellation is in force for this subscription');
  invariant(receipt.verification === 'INDEPENDENT_READ_BACK', 'WEAK_PROOF', 'only an independently read-back cancellation can be certified');

  const claims: Record<ClaimName, unknown> = {
    merchant: { merchantId: receipt.merchantId, name: input.merchantName.trim() },
    subscriptionRef: receipt.receiptId,
    effectiveDate: effectiveDateOf(receipt),
  };
  const saltOf = input.salt ?? (() => randomBytes(16).toString('base64url'));
  const disclosures = CLAIM_NAMES.map((name) => b64(JSON.stringify([saltOf(name), name, claims[name]])));
  const expiresAt = addMinutes(input.now, input.validityDays * 24 * 60);
  const certId = `cert_${digestOf({ receiptId: receipt.receiptId, scope: input.scope, iat: input.now, kid: input.key.keyId }).slice(0, 24)}`;
  const payload: CertificatePayload = { v: 1, typ: 'CANCELLATION_CERTIFICATE', iss: input.key.issuer, kid: input.key.keyId, cid: certId, iat: input.now, exp: expiresAt, sd: disclosures.map(sha).sort() };
  const signingInput = `NMC1.${b64(canonicalJson(payload))}`;
  const signature = b64(sign(null, Buffer.from(signingInput, 'ascii'), input.key.privateKey));
  return {
    compact: [`${signingInput}.${signature}`, ...disclosures].join('~'),
    record: { certId, scope: input.scope, subscriptionId: input.subscriptionId, receiptId: receipt.receiptId, expiresAt },
  };
}

/** The holder keeps only the claims they want to show; the signature still verifies. */
export function present(compact: string, reveal: readonly ClaimName[]): string {
  invariant(reveal.length > 0, 'NOTHING_DISCLOSED', 'reveal at least one claim');
  const [head, ...disclosures] = compact.split('~');
  const wanted = new Set(reveal);
  const kept = disclosures.filter((d) => {
    const parsed = parseJson(unb64(d));
    return Array.isArray(parsed) && wanted.has(parsed[1] as ClaimName);
  });
  invariant(kept.length === wanted.size, 'CLAIM_NOT_AVAILABLE', 'a requested claim is not in this certificate');
  return [head, ...kept].join('~');
}

export interface RevocationList {
  readonly v: 1;
  readonly iss: string;
  readonly kid: string;
  readonly seq: number;
  readonly issuedAt: Instant;
  readonly nextUpdate: Instant;
  readonly revoked: readonly string[];
}

export function signRevocationList(list: Omit<RevocationList, 'v' | 'iss' | 'kid'>, key: SigningKey): string {
  assertInstant(list.issuedAt, 'issuedAt');
  assertInstant(list.nextUpdate, 'nextUpdate');
  invariant(isBefore(list.issuedAt, list.nextUpdate), 'INVALID_WINDOW', 'nextUpdate must follow issuedAt');
  invariant(Number.isSafeInteger(list.seq) && list.seq >= 0, 'INVALID_SEQ', 'seq must be a non-negative integer');
  const body: RevocationList = { v: 1, iss: key.issuer, kid: key.keyId, seq: list.seq, issuedAt: list.issuedAt, nextUpdate: list.nextUpdate, revoked: [...new Set(list.revoked)].sort() };
  const signingInput = `NMR1.${b64(canonicalJson(body))}`;
  return `${signingInput}.${b64(sign(null, Buffer.from(signingInput, 'ascii'), key.privateKey))}`;
}

/** A reactivation (or a newer ending) means the certificate no longer describes the truth. */
export function certificatesToRevoke(issued: readonly IssuedCertificate[], receipts: readonly MerchantReceipt[], now: Instant): string[] {
  return issued
    .filter((c) => isAfter(c.expiresAt, now))
    .filter((c) => endingInForce(receipts, c.scope, c.subscriptionId, now)?.receiptId !== c.receiptId)
    .map((c) => c.certId)
    .sort();
}

export type VerifyRejection =
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_KEY'
  | 'KEY_COMPROMISED'
  | 'ISSUER_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'DISCLOSURE_MISMATCH'
  | 'DUPLICATE_DISCLOSURE'
  | 'REVOCATION_LIST_INVALID'
  | 'REVOCATION_LIST_STALE'
  | 'REVOKED';

export type VerifyResult =
  | { readonly ok: true; readonly certId: string; readonly issuer: string; readonly issuedAt: Instant; readonly expiresAt: Instant; readonly disclosed: DisclosedClaims }
  | { readonly ok: false; readonly reason: VerifyRejection };

function checkSigned(text: string, prefix: string, keys: ReadonlyMap<string, TrustedKey>): { ok: true; body: Record<string, unknown>; key: TrustedKey } | { ok: false; reason: VerifyRejection } {
  const parts = text.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [version, payloadPart, sigPart] = parts as [string, string, string];
  if (version !== prefix) return { ok: false, reason: version.startsWith(prefix.slice(0, 3)) ? 'UNSUPPORTED_VERSION' : 'MALFORMED' };
  const body = parseJson(unb64(payloadPart));
  const sig = unb64(sigPart);
  if (typeof body !== 'object' || body === null || Array.isArray(body) || sig === undefined || sig.length !== 64) return { ok: false, reason: 'MALFORMED' };
  const record = body as Record<string, unknown>;
  const key = typeof record.kid === 'string' ? keys.get(record.kid) : undefined;
  if (key === undefined) return { ok: false, reason: 'UNKNOWN_KEY' };
  if (key.status === 'COMPROMISED') return { ok: false, reason: 'KEY_COMPROMISED' };
  if (record.iss !== key.issuer) return { ok: false, reason: 'ISSUER_MISMATCH' };
  if (!verify(null, Buffer.from(`${version}.${payloadPart}`, 'ascii'), key.publicKey, sig)) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true, body: record, key };
}

const isInstant = (v: unknown): v is Instant => {
  if (typeof v !== 'string') return false;
  try {
    assertInstant(v);
    return true;
  } catch {
    return false;
  }
};

export function verifyCertificate(compact: string, ctx: { readonly trustedKeys: ReadonlyMap<string, TrustedKey>; readonly revocationList: string; readonly now: Instant }): VerifyResult {
  assertInstant(ctx.now, 'now');
  const [head, ...disclosures] = compact.split('~');
  if (head === undefined) return { ok: false, reason: 'MALFORMED' };
  const signed = checkSigned(head, 'NMC1', ctx.trustedKeys);
  if (!signed.ok) return signed;
  const p = signed.body;
  if (p.v !== 1 || p.typ !== 'CANCELLATION_CERTIFICATE') return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  if (typeof p.cid !== 'string' || !isInstant(p.iat) || !isInstant(p.exp) || !Array.isArray(p.sd) || !p.sd.every((d) => typeof d === 'string')) return { ok: false, reason: 'MALFORMED' };
  if (isBefore(ctx.now, p.iat)) return { ok: false, reason: 'NOT_YET_VALID' };
  if (!isBefore(ctx.now, p.exp)) return { ok: false, reason: 'EXPIRED' };

  const committed = new Set(p.sd as string[]);
  const disclosed: Record<string, unknown> = {};
  for (const d of disclosures) {
    if (!committed.has(sha(d))) return { ok: false, reason: 'DISCLOSURE_MISMATCH' };
    const parsed = parseJson(unb64(d));
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || !(CLAIM_NAMES as readonly unknown[]).includes(parsed[1])) return { ok: false, reason: 'MALFORMED' };
    const name = parsed[1] as ClaimName;
    if (name in disclosed) return { ok: false, reason: 'DUPLICATE_DISCLOSURE' };
    disclosed[name] = parsed[2];
  }

  const list = checkSigned(ctx.revocationList, 'NMR1', ctx.trustedKeys);
  if (!list.ok || list.body.iss !== p.iss || !isInstant(list.body.issuedAt) || !isInstant(list.body.nextUpdate) || !Array.isArray(list.body.revoked)) return { ok: false, reason: 'REVOCATION_LIST_INVALID' };
  if (isBefore(ctx.now, list.body.issuedAt)) return { ok: false, reason: 'REVOCATION_LIST_INVALID' };
  if (!isBefore(ctx.now, list.body.nextUpdate)) return { ok: false, reason: 'REVOCATION_LIST_STALE' };
  if ((list.body.revoked as unknown[]).includes(p.cid)) return { ok: false, reason: 'REVOKED' };

  return { ok: true, certId: p.cid, issuer: p.iss as string, issuedAt: p.iat, expiresAt: p.exp, disclosed: disclosed as DisclosedClaims };
}
