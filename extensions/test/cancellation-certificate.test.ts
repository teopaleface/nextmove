import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  certificatesToRevoke,
  effectiveDateOf,
  issueCertificate,
  present,
  signRevocationList,
  verifyCertificate,
  type SigningKey,
  type TrustedKey,
} from '../src/cancellation-certificate/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { ALEX, MARIA, NOW, receipt } from './fixtures.ts';

// Test-only keys, generated per run; nothing is persisted.
const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const KEY: SigningKey = { keyId: 'cert-2026-1', issuer: 'nextmove-demo', privateKey: pair.privateKey };
const trusted = (status: TrustedKey['status'] = 'ACTIVE', extra: TrustedKey[] = []) =>
  new Map<string, TrustedKey>([[KEY.keyId, { keyId: KEY.keyId, issuer: KEY.issuer, publicKey: pair.publicKey, status }], ...extra.map((k) => [k.keyId, k] as const)]);

const LATER = '2026-11-15T12:00:00+02:00';
const RECEIPTS = [receipt()];

function issue(overrides: Partial<Parameters<typeof issueCertificate>[0]> = {}) {
  return issueCertificate({ scope: ALEX, subscriptionId: 'sub-fitflow', receipts: RECEIPTS, merchantName: 'FitFlow', key: KEY, validityDays: 365, now: NOW, ...overrides });
}

const list = (revoked: string[] = [], o: { issuedAt?: string; nextUpdate?: string; key?: SigningKey } = {}) =>
  signRevocationList({ seq: 1, issuedAt: o.issuedAt ?? '2026-11-15T00:00:00+02:00', nextUpdate: o.nextUpdate ?? '2026-11-16T00:00:00+02:00', revoked }, o.key ?? KEY);

const check = (compact: string, o: { keys?: Map<string, TrustedKey>; revocationList?: string; now?: string } = {}) =>
  verifyCertificate(compact, { trustedKeys: o.keys ?? trusted(), revocationList: o.revocationList ?? list(), now: o.now ?? LATER });

const reason = (r: ReturnType<typeof check>) => (r.ok ? 'OK' : r.reason);

describe('issueCertificate', () => {
  it('certifies a verified cancellation, verifiable by anyone with the public key', () => {
    const { compact, record } = issue();
    const result = check(compact);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.certId, record.certId);
    assert.deepEqual(result.disclosed, { merchant: { merchantId: 'fitflow', name: 'FitFlow' }, subscriptionRef: 'NF-1047', effectiveDate: '2026-11-03' });
    assert.equal(record.receiptId, 'NF-1047');
  });

  it('shows the merchant’s own reference but keys the record on the unique receipt id', () => {
    const { compact, record } = issue({ receipts: [receipt({ receiptId: 'rcp-bank-1', merchantReference: 'NF-1047' })] });
    const result = check(compact);
    assert.equal(result.ok && result.disclosed.subscriptionRef, 'NF-1047');
    assert.equal(record.receiptId, 'rcp-bank-1');
  });

  it('never contains amounts, the customer or bank identifiers', () => {
    const { compact } = issue();
    const decoded = compact.split(/[.~]/).map((p) => Buffer.from(p, 'base64url').toString('utf8')).join(' ');
    for (const secret of ['demo-alex', 'demo-alex-account-001', 'sub-fitflow', 'amount', 'Minor', 'readback:']) assert.ok(!decoded.includes(secret), secret);
  });

  it('fits comfortably in a QR code', () => {
    assert.ok(issue().compact.length < 1000);
  });

  it('refuses weak proof, a reactivated subscription or someone else’s receipt', () => {
    const code = (fn: () => unknown, c: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === c);
    code(() => issue({ receipts: [receipt({ verification: 'MERCHANT_MESSAGE_ONLY' })] }), 'WEAK_PROOF');
    code(() => issue({ receipts: [...RECEIPTS, receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-10-28T09:44:00+02:00' })] }), 'NO_CONFIRMED_ENDING');
    code(() => issue({ scope: MARIA }), 'NO_CONFIRMED_ENDING');
    code(() => issue({ validityDays: 0 }), 'INVALID_VALIDITY');
    code(() => issue({ validityDays: 401 }), 'INVALID_VALIDITY');
    code(() => issue({ merchantName: ' ' }), 'INVALID_NAME');
  });

  it('uses the confirmation day for an immediate cancellation', () => {
    assert.equal(effectiveDateOf(receipt({ operation: 'CANCEL_IMMEDIATELY' })), '2026-10-28');
  });

  it('salts claims so equal values do not produce equal digests across certificates', () => {
    const a = issue().compact.split('~')[0];
    const b = issue().compact.split('~')[0];
    assert.notEqual(a, b);
  });
});

describe('selective disclosure', () => {
  it('reveals only the chosen claims and still verifies', () => {
    const shown = present(issue().compact, ['effectiveDate']);
    const result = check(shown);
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.disclosed, { effectiveDate: '2026-11-03' });
    const decoded = shown.split(/[.~]/).map((p) => Buffer.from(p, 'base64url').toString('utf8')).join(' ');
    assert.ok(!decoded.includes('FitFlow') && !decoded.includes('NF-1047'));
    const two = check(present(issue().compact, ['merchant', 'subscriptionRef']));
    assert.deepEqual(two.ok && Object.keys(two.disclosed).sort(), ['merchant', 'subscriptionRef']);
  });

  it('a presentation with nothing revealed is refused at creation', () => {
    assert.throws(() => present(issue().compact, []), DomainError);
  });

  it('cannot reveal a claim that was already withheld', () => {
    const dateOnly = present(issue().compact, ['effectiveDate']);
    assert.throws(() => present(dateOnly, ['merchant']), (e: unknown) => e instanceof DomainError && e.code === 'CLAIM_NOT_AVAILABLE');
  });
});

describe('tampering', () => {
  const { compact } = issue();
  const [head = '', ...disclosures] = compact.split('~');
  const [prefix, payload = '', sig = ''] = head.split('.');

  it('a changed payload breaks the signature', () => {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    body.exp = '2099-01-01T00:00:00+02:00';
    const forged = `${prefix}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${sig}`;
    assert.equal(reason(check([forged, ...disclosures].join('~'))), 'BAD_SIGNATURE');
  });

  it('a changed disclosure no longer matches its commitment', () => {
    const fake = Buffer.from(JSON.stringify(['salt', 'effectiveDate', '2026-10-01'])).toString('base64url');
    assert.equal(reason(check([head, fake].join('~'))), 'DISCLOSURE_MISMATCH');
  });

  it('a disclosure from another certificate does not transfer', () => {
    const otherDisclosure = issue().compact.split('~')[1] as string;
    assert.equal(reason(check([head, otherDisclosure].join('~'))), 'DISCLOSURE_MISMATCH');
  });

  it('a repeated disclosure is refused', () => {
    assert.equal(reason(check([head, disclosures[0], disclosures[0]].join('~'))), 'DUPLICATE_DISCLOSURE');
  });

  it('a signature from another key, or a non-canonical encoding, is refused', () => {
    const otherSig = issue({ key: { ...KEY, privateKey: other.privateKey } }).compact;
    assert.equal(reason(check(otherSig)), 'BAD_SIGNATURE');
    assert.equal(reason(check(`${prefix}.${payload}.${sig}=`)), 'MALFORMED');
    assert.equal(reason(check(`${prefix}.${payload}`)), 'MALFORMED');
    assert.equal(reason(check('garbage')), 'MALFORMED');
    assert.equal(reason(check(`NMC2.${payload}.${sig}`)), 'UNSUPPORTED_VERSION');
  });
});

describe('keys', () => {
  it('rejects unknown and compromised keys and a key claiming another issuer', () => {
    assert.equal(reason(check(issue({ key: { ...KEY, keyId: 'nope' } }).compact)), 'UNKNOWN_KEY');
    assert.equal(reason(check(issue().compact, { keys: trusted('COMPROMISED') })), 'KEY_COMPROMISED');
    assert.equal(reason(check(issue({ key: { ...KEY, issuer: 'evil-bank' } }).compact)), 'ISSUER_MISMATCH');
  });

  it('a retired key still verifies what it signed', () => {
    const keys = trusted('RETIRED');
    assert.equal(check(issue().compact, { keys }).ok, true);
  });
});

describe('time', () => {
  it('is valid from issue until the exclusive expiry', () => {
    const { compact, record } = issue({ validityDays: 30 });
    assert.equal(reason(check(compact, { now: '2026-10-28T09:44:59+02:00', revocationList: list([], { issuedAt: '2026-10-28T00:00:00+02:00' }) })), 'NOT_YET_VALID');
    assert.equal(record.expiresAt, '2026-11-27T07:45:00.000Z');
    const at = (now: string) => check(compact, { now, revocationList: list([], { issuedAt: '2026-11-26T00:00:00+02:00', nextUpdate: '2026-11-29T00:00:00+02:00' }) });
    assert.equal(reason(at('2026-11-27T09:44:59+02:00')), 'OK');
    assert.equal(reason(at('2026-11-27T09:45:00+02:00')), 'EXPIRED');
  });
});

describe('revocation', () => {
  it('a reactivation revokes the certificate', () => {
    const { compact, record } = issue();
    const reactivated = [...RECEIPTS, receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-11-01T10:00:00+02:00' })];
    const revoked = certificatesToRevoke([record], reactivated, LATER);
    assert.deepEqual(revoked, [record.certId]);
    assert.equal(reason(check(compact, { revocationList: list(revoked) })), 'REVOKED');
  });

  it('a newer ending supersedes the old certificate; an unchanged ending keeps it', () => {
    const { record } = issue();
    assert.deepEqual(certificatesToRevoke([record], RECEIPTS, LATER), []);
    const newer = [...RECEIPTS, receipt({ receiptId: 'NF-2000', confirmedAt: '2026-11-02T10:00:00+02:00' })];
    assert.deepEqual(certificatesToRevoke([record], newer, LATER), [record.certId]);
  });

  it('expired certificates are not listed again', () => {
    const { record } = issue({ validityDays: 1 });
    assert.deepEqual(certificatesToRevoke([record], [], LATER), []);
  });

  it('a stale, future, forged or foreign revocation list is not trusted', () => {
    const { compact } = issue();
    assert.equal(reason(check(compact, { revocationList: list([], { nextUpdate: '2026-11-15T12:00:00+02:00' }) })), 'REVOCATION_LIST_STALE');
    assert.equal(reason(check(compact, { revocationList: list([], { issuedAt: '2026-11-15T13:00:00+02:00' }) })), 'REVOCATION_LIST_INVALID');
    assert.equal(reason(check(compact, { revocationList: list([], { key: { ...KEY, privateKey: other.privateKey } }) })), 'REVOCATION_LIST_INVALID');
    const foreign: TrustedKey = { keyId: 'other-bank-1', issuer: 'other-bank', publicKey: other.publicKey, status: 'ACTIVE' };
    assert.equal(reason(check(compact, { keys: trusted('ACTIVE', [foreign]), revocationList: list([], { key: { keyId: 'other-bank-1', issuer: 'other-bank', privateKey: other.privateKey } }) })), 'REVOCATION_LIST_INVALID');
    assert.equal(reason(check(compact, { revocationList: 'NMR1.x.y' })), 'REVOCATION_LIST_INVALID');
  });

  it('refuses to sign an inverted list window', () => {
    assert.throws(() => list([], { issuedAt: '2026-11-16T00:00:00+02:00', nextUpdate: '2026-11-15T00:00:00+02:00' }), DomainError);
  });
});
