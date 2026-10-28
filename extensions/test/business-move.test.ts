import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveBusinessMove,
  normalizeCui,
  planBusinessMove,
  repaymentKey,
  ruleSetFor,
  type BusinessProfile,
  type LedgerAccount,
  type MovableSubscription,
  type PastCharge,
  type VatRuleSet,
} from '../src/business-move/index.ts';
import { DomainError, type Scope } from '../src/shared/index.ts';
import { ALEX, ALEX_BUSINESS, grant, MARIA, NOW } from './fixtures.ts';

// Synthetic CUIs with valid check digits.
const CUI = '18547290';
const COMPANY: Scope = { ownerId: 'demo-alex-srl', contextId: 'BUSINESS' };

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const RULES: VatRuleSet[] = [
  { ruleSetId: 'ro-vat-demo', version: 1, effectiveFrom: '2026-01-01', homeCountry: 'RO', euCountries: EU },
  { ruleSetId: 'ro-vat-demo', version: 2, effectiveFrom: '2026-08-01', homeCountry: 'RO', euCountries: EU },
];

const subscription = (o: Partial<MovableSubscription> = {}): MovableSubscription => ({ scope: ALEX, subscriptionId: 'sub-cloudbox', merchantId: 'cloudbox', merchantCountry: 'IE', channel: 'MERCHANT_DIRECT', merchantSupportsBillingProfile: true, ...o });
const business = (o: Partial<BusinessProfile> = {}): BusinessProfile => ({ scope: ALEX_BUSINESS, legalName: 'Demo Alex SRL', taxId: CUI, vatRegistered: true, cardId: 'card-biz', ...o });
const PERSONAL: LedgerAccount = { accountId: 'acc-personal', scope: ALEX, currency: 'RON', status: 'OPEN' };
const BUSINESS_ACC: LedgerAccount = { accountId: 'acc-business', scope: ALEX_BUSINESS, currency: 'RON', status: 'OPEN' };

const charge = (chargeId: string, postedOn: string, o: Partial<PastCharge> = {}): PastCharge => ({ chargeId, subscriptionId: 'sub-cloudbox', accountId: 'acc-personal', postedOn, amountMinor: 5999, currency: 'RON', refunded: false, invoice: { invoiceId: `INV-${chargeId}`, issuedTo: 'PERSONAL_NAME' }, ...o });
const CHARGES = [charge('ch-07', '2026-07-15'), charge('ch-08', '2026-08-15'), charge('ch-09', '2026-09-15'), charge('ch-10', '2026-10-15')];

type Input = Parameters<typeof planBusinessMove>[0];
function plan(o: Partial<Input> = {}) {
  return planBusinessMove({
    subscription: subscription(),
    business: business(),
    personalAccount: PERSONAL,
    businessAccount: BUSINESS_ACC,
    charges: CHARGES,
    selectedChargeIds: ['ch-08', 'ch-09', 'ch-10'],
    businessUseBp: 10_000,
    repaidKeys: new Set(),
    rules: RULES,
    now: NOW,
    ...o,
  });
}

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code);

describe('normalizeCui', () => {
  it('accepts valid CUIs with or without the RO prefix', () => {
    assert.equal(normalizeCui('18547290'), '18547290');
    assert.equal(normalizeCui('RO18547290'), '18547290');
    assert.equal(normalizeCui(' ro 31978656 '), '31978656');
    assert.equal(normalizeCui('426'), '426');
  });

  it('rejects a wrong check digit, leading zeros, letters and lengths', () => {
    for (const bad of ['18547291', '018547290', '1854729X', '1', '12345678901', '']) throwsCode(() => normalizeCui(bad), 'INVALID_TAX_ID');
  });
});

describe('ruleSetFor', () => {
  it('picks the rules in force on the day, not today’s', () => {
    assert.equal(ruleSetFor(RULES, '2026-07-31')?.version, 1);
    assert.equal(ruleSetFor(RULES, '2026-08-01')?.version, 2);
    assert.equal(ruleSetFor(RULES, '2025-12-31'), undefined);
  });
});

describe('planBusinessMove repayments', () => {
  it('repays each selected month as a balanced transfer from business to personal', () => {
    const p = plan();
    assert.equal(p.repayments.length, 3);
    assert.equal(p.repaymentTotalMinor, 3 * 5999);
    for (const r of p.repayments) {
      assert.equal(r.postings[0].amountMinor + r.postings[1].amountMinor, 0);
      assert.deepEqual(r.postings.map((x) => x.accountId), ['acc-business', 'acc-personal']);
      assert.equal(r.idempotencyKey, repaymentKey('sub-cloudbox', r.chargeId));
    }
  });

  it('repays only the business share, rounded down', () => {
    const p = plan({ businessUseBp: 3_333 });
    assert.deepEqual(p.repayments.map((r) => r.shareMinor), [1999, 1999, 1999]);
    assert.ok(p.vatNote.lines.every((l) => l.flags.includes('PARTIAL_BUSINESS_USE')));
    assert.deepEqual(p.warnings, ['PERSONAL_SHARE_ON_BUSINESS_CARD']);
  });

  it('skips a share that rounds to zero', () => {
    const p = plan({ charges: [charge('tiny', '2026-10-01', { amountMinor: 1 })], selectedChargeIds: ['tiny'], businessUseBp: 5_000 });
    assert.deepEqual(p.excluded, [{ chargeId: 'tiny', reason: 'ZERO_SHARE' }]);
    assert.equal(p.repaymentTotalMinor, 0);
  });

  it('excludes charges that are not repayable, each with a reason', () => {
    const charges = [
      ...CHARGES,
      charge('other-sub', '2026-09-01', { subscriptionId: 'sub-x' }),
      charge('other-acc', '2026-09-01', { accountId: 'acc-savings' }),
      charge('refunded', '2026-09-01', { refunded: true }),
      charge('future', '2026-10-29'),
      charge('eur', '2026-09-01', { currency: 'EUR' }),
    ];
    const p = plan({ charges, selectedChargeIds: ['other-sub', 'other-acc', 'refunded', 'future', 'eur', 'missing', 'ch-10'], repaidKeys: new Set([repaymentKey('sub-cloudbox', 'ch-10')]) });
    assert.deepEqual(p.excluded, [
      { chargeId: 'ch-10', reason: 'ALREADY_REPAID' },
      { chargeId: 'eur', reason: 'CURRENCY_MISMATCH' },
      { chargeId: 'future', reason: 'FUTURE_DATED' },
      { chargeId: 'missing', reason: 'UNKNOWN_CHARGE' },
      { chargeId: 'other-acc', reason: 'OTHER_ACCOUNT' },
      { chargeId: 'other-sub', reason: 'NOT_THIS_SUBSCRIPTION' },
      { chargeId: 'refunded', reason: 'REFUNDED' },
    ]);
    assert.equal(p.repayments.length, 0);
  });

  it('refuses to repay across currencies when the business account is in another currency', () => {
    const p = plan({ businessAccount: { ...BUSINESS_ACC, currency: 'EUR' } });
    assert.ok(p.excluded.every((e) => e.reason === 'CURRENCY_MISMATCH'));
    assert.equal(p.repayments.length, 0);
  });

  it('a later plan cannot repay the same month twice, even with a new selection', () => {
    const first = plan({ selectedChargeIds: ['ch-09'] });
    const repaid = new Set(first.repayments.map((r) => r.idempotencyKey));
    const second = plan({ selectedChargeIds: ['ch-08', 'ch-09'], repaidKeys: repaid });
    assert.deepEqual(second.repayments.map((r) => r.chargeId), ['ch-08']);
  });

  it('deduplicates the selection', () => {
    assert.equal(plan({ selectedChargeIds: ['ch-09', 'ch-09'] }).repayments.length, 1);
  });
});

describe('future billing', () => {
  it('asks the merchant to bill the company card in the company name, with RO prefix when VAT registered', () => {
    assert.deepEqual(plan().future, { kind: 'UPDATE_BILLING_PROFILE', invoiceName: 'Demo Alex SRL', invoiceTaxId: `RO${CUI}`, cardId: 'card-biz' });
    const notRegistered = plan({ business: business({ vatRegistered: false, taxId: `RO${CUI}` }) }).future;
    assert.equal(notRegistered.kind === 'UPDATE_BILLING_PROFILE' && notRegistered.invoiceTaxId, CUI);
  });

  it('falls back to manual steps when the merchant has no billing-profile API', () => {
    assert.equal(plan({ subscription: subscription({ merchantSupportsBillingProfile: false }) }).future.kind, 'MANUAL_STEPS');
  });

  it('app-store purchases cannot be moved and carry no merchant invoice', () => {
    const p = plan({ subscription: subscription({ channel: 'APP_STORE' }), charges: CHARGES.map((c) => ({ ...c, invoice: undefined })) as PastCharge[] });
    assert.deepEqual(p.future, { kind: 'NOT_MOVABLE_APP_STORE' });
    assert.ok(p.vatNote.lines.every((l) => l.vatCase === 'NO_MERCHANT_INVOICE' && !l.flags.includes('NO_INVOICE_ON_FILE')));
    assert.deepEqual(plan({ subscription: subscription({ channel: 'APP_STORE' }), businessUseBp: 5_000 }).warnings, []);
  });
});

describe('VAT note for the accountant', () => {
  it('says it is not tax advice and computes no tax', () => {
    const note = plan().vatNote;
    assert.equal(note.disclaimer, 'INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE');
    assert.ok(!JSON.stringify(note).toLowerCase().includes('deductible'));
  });

  it('marks foreign EU software as a reverse-charge candidate only for a VAT-registered buyer', () => {
    assert.equal(plan().vatNote.futureCase, 'EU_B2B_REVERSE_CHARGE_CANDIDATE');
    assert.equal(plan({ business: business({ vatRegistered: false }) }).vatNote.futureCase, 'EU_SUPPLY_BUYER_NOT_VAT_REGISTERED');
    assert.equal(plan({ subscription: subscription({ merchantCountry: 'RO' }) }).vatNote.futureCase, 'DOMESTIC_SUPPLY');
    assert.equal(plan({ subscription: subscription({ merchantCountry: 'US' }) }).vatNote.futureCase, 'NON_EU_SUPPLY');
  });

  it('classifies each month by the rules in force when it was posted', () => {
    const p = plan({ selectedChargeIds: ['ch-07', 'ch-08'] });
    assert.deepEqual(p.vatNote.lines.map((l) => l.ruleSet?.version), [1, 2]);
    const early = plan({ charges: [charge('old', '2025-11-15')], selectedChargeIds: ['old'] });
    assert.equal(early.vatNote.lines[0]?.vatCase, 'NO_RULES_FOR_DATE');
  });

  it('flags invoices already issued in the personal name instead of pretending to change them', () => {
    const charges = [charge('a', '2026-09-01'), charge('b', '2026-09-02', { invoice: { invoiceId: 'INV-b', issuedTo: 'BUSINESS_NAME' } }), charge('c', '2026-09-03', { invoice: undefined })];
    const lines = plan({ charges, selectedChargeIds: ['a', 'b', 'c'] }).vatNote.lines;
    assert.deepEqual(lines.map((l) => [l.chargeId, l.invoiceId, l.flags]), [
      ['a', 'INV-a', ['INVOICE_ISSUED_TO_PERSONAL_NAME']],
      ['b', 'INV-b', []],
      ['c', undefined, ['NO_INVOICE_ON_FILE']],
    ]);
  });
});

describe('plan validation', () => {
  it('rejects wrong contexts, foreign accounts and closed accounts', () => {
    throwsCode(() => plan({ subscription: subscription({ scope: ALEX_BUSINESS }) }), 'WRONG_CONTEXT');
    throwsCode(() => plan({ business: business({ scope: ALEX }) }), 'WRONG_CONTEXT');
    throwsCode(() => plan({ personalAccount: { ...PERSONAL, scope: MARIA } }), 'SCOPE_MISMATCH');
    throwsCode(() => plan({ businessAccount: { ...BUSINESS_ACC, scope: COMPANY } }), 'SCOPE_MISMATCH');
    throwsCode(() => plan({ businessAccount: { ...BUSINESS_ACC, status: 'BLOCKED' } }), 'ACCOUNT_NOT_OPEN');
  });

  it('rejects 0% or over 100% business use, an invalid CUI and a blank name', () => {
    throwsCode(() => plan({ businessUseBp: 0 }), 'INVALID_BASIS_POINTS');
    throwsCode(() => plan({ businessUseBp: 10_001 }), 'INVALID_BASIS_POINTS');
    throwsCode(() => plan({ businessUseBp: 50.5 }), 'INVALID_BASIS_POINTS');
    throwsCode(() => plan({ business: business({ taxId: '18547291' }) }), 'INVALID_TAX_ID');
    throwsCode(() => plan({ business: business({ legalName: '  ' }) }), 'INVALID_NAME');
  });
});

describe('approveBusinessMove', () => {
  const personalGrant = (d: string) => grant(d, { grantId: 'g-personal' });
  const businessGrant = (d: string, scope: Scope = ALEX_BUSINESS) => grant(d, { grantId: 'g-business', ownerId: scope.ownerId, contextId: scope.contextId });

  it('emits billing change, one transfer per month and the filed note', () => {
    const p = plan();
    const result = approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant(p.manifestDigest) }, 1_000_000, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.effects.map((e) => e.type), ['UPDATE_BILLING_PROFILE', 'POST_TRANSFER', 'POST_TRANSFER', 'POST_TRANSFER', 'FILE_VAT_NOTE']);
  });

  it('needs consent in both contexts, each from its own scope', () => {
    const p = plan();
    assert.deepEqual(approveBusinessMove(p, { personal: businessGrant(p.manifestDigest), business: personalGrant(p.manifestDigest) }, 1_000_000, NOW), { ok: false, reason: 'PERSONAL_GRANT_INVALID', detail: 'WRONG_CONTEXT' });
    assert.deepEqual(approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant('other') }, 1_000_000, NOW), { ok: false, reason: 'BUSINESS_GRANT_INVALID', detail: 'DIGEST_MISMATCH' });
    const same = grant(p.manifestDigest);
    assert.deepEqual(approveBusinessMove(p, { personal: same, business: same }, 1_000_000, NOW), { ok: false, reason: 'SAME_GRANT_TWICE' });
  });

  it('supports a company approved by a different person', () => {
    const p = plan({ business: business({ scope: COMPANY }), businessAccount: { ...BUSINESS_ACC, scope: COMPANY } });
    assert.ok(p.warnings.includes('DIFFERENT_OWNERS'));
    assert.deepEqual(approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant(p.manifestDigest) }, 1_000_000, NOW), { ok: false, reason: 'BUSINESS_GRANT_INVALID', detail: 'WRONG_OWNER' });
    assert.equal(approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant(p.manifestDigest, COMPANY) }, 1_000_000, NOW).ok, true);
  });

  it('refuses when the business cannot cover the repayment', () => {
    const p = plan();
    assert.deepEqual(approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant(p.manifestDigest) }, p.repaymentTotalMinor - 1, NOW), { ok: false, reason: 'INSUFFICIENT_FUNDS' });
    assert.equal(approveBusinessMove(p, { personal: personalGrant(p.manifestDigest), business: businessGrant(p.manifestDigest) }, p.repaymentTotalMinor, NOW).ok, true);
  });

  it('shows manual steps instead of a merchant call, and none at all for an app-store purchase', () => {
    const manual = plan({ subscription: subscription({ merchantSupportsBillingProfile: false }) });
    const r1 = approveBusinessMove(manual, { personal: personalGrant(manual.manifestDigest), business: businessGrant(manual.manifestDigest) }, 1_000_000, NOW);
    assert.equal(r1.ok && r1.effects[0]?.type, 'SHOW_MANUAL_STEPS');
    const store = plan({ subscription: subscription({ channel: 'APP_STORE' }) });
    const r2 = approveBusinessMove(store, { personal: personalGrant(store.manifestDigest), business: businessGrant(store.manifestDigest) }, 1_000_000, NOW);
    assert.ok(r2.ok && !r2.effects.some((e) => e.type === 'UPDATE_BILLING_PROFILE' || e.type === 'SHOW_MANUAL_STEPS'));
  });
});
