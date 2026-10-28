import { isAfter, isBefore, type Instant } from './time.ts';

export type CustomerContext = 'PERSONAL' | 'BUSINESS';

/** Who owns a record. The app derives this on the server; it is never taken from model output. */
export interface Scope {
  readonly ownerId: string;
  readonly contextId: CustomerContext;
}

/**
 * The app's server-issued approval, mapped to the fields these modules check.
 * Created only by a first-party customer confirmation (ADR 0003).
 */
export interface ApprovalGrant extends Scope {
  readonly grantId: string;
  readonly manifestDigest: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly revokedAt?: Instant;
}

export type GrantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'WRONG_OWNER' | 'WRONG_CONTEXT' | 'DIGEST_MISMATCH' | 'NOT_YET_VALID' | 'EXPIRED' | 'REVOKED' };

export function checkGrant(grant: ApprovalGrant, expected: { readonly scope: Scope; readonly manifestDigest: string }, now: Instant): GrantCheck {
  if (grant.ownerId !== expected.scope.ownerId) return { ok: false, reason: 'WRONG_OWNER' };
  if (grant.contextId !== expected.scope.contextId) return { ok: false, reason: 'WRONG_CONTEXT' };
  if (grant.manifestDigest !== expected.manifestDigest) return { ok: false, reason: 'DIGEST_MISMATCH' };
  if (grant.revokedAt !== undefined && !isAfter(grant.revokedAt, now)) return { ok: false, reason: 'REVOKED' };
  if (isBefore(now, grant.issuedAt)) return { ok: false, reason: 'NOT_YET_VALID' };
  if (!isBefore(now, grant.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  return { ok: true };
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.ownerId === b.ownerId && a.contextId === b.contextId;
}
