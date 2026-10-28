import type { ApprovalGrant, Scope } from '../src/shared/authority.ts';
import type { MerchantReceipt } from '../src/shared/receipts.ts';

/** Synthetic identities matching design/ui-fixtures.json and demo/bulk-cancellations.json. */
export const ALEX: Scope = { ownerId: 'demo-alex', contextId: 'PERSONAL' };
export const ALEX_BUSINESS: Scope = { ownerId: 'demo-alex', contextId: 'BUSINESS' };
export const MARIA: Scope = { ownerId: 'demo-maria', contextId: 'PERSONAL' };

export const NOW = '2026-10-28T09:45:00+02:00';

export function receipt(overrides: Partial<MerchantReceipt> = {}): MerchantReceipt {
  return {
    receiptId: 'NF-1047',
    scope: ALEX,
    merchantId: 'fitflow',
    subscriptionId: 'sub-fitflow',
    subscriberAccountId: 'demo-alex-account-001',
    operation: 'STOP_RENEWAL_AT_PERIOD_END',
    state: 'CONFIRMED',
    confirmedAt: '2026-10-28T09:41:00+02:00',
    accessUntil: '2026-11-03T23:59:59+02:00',
    termsRevision: 2,
    verification: 'INDEPENDENT_READ_BACK',
    evidenceRefs: ['readback:fitflow:NF-1047', 'screenshot:fitflow:confirm'],
    ...overrides,
  };
}

export function grant(manifestDigest: string, overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    grantId: 'grant-1',
    ownerId: ALEX.ownerId,
    contextId: ALEX.contextId,
    manifestDigest,
    issuedAt: '2026-10-28T09:40:00+02:00',
    expiresAt: '2026-10-28T09:55:00+02:00',
    ...overrides,
  };
}
