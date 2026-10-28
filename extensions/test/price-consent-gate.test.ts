import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activatePriceCeiling,
  answerPriceRise,
  createPriceCeiling,
  decideAuthorization,
  pausePriceCeiling,
  priceRiseManifest,
  revokePriceCeiling,
  riseKey,
  type AuthorizationRequest,
  type PriceCeiling,
  type PriceCeilingTerms,
} from '../src/price-consent-gate/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { ALEX, ALEX_BUSINESS, grant, MARIA, NOW } from './fixtures.ts';

function terms(overrides: Partial<PriceCeilingTerms> = {}): PriceCeilingTerms {
  return { scope: ALEX, subscriptionId: 'sub-streamly', merchantIds: ['streamly-ro'], currency: 'RON', approvedMinor: 4900, ...overrides };
}

function active(overrides: Partial<PriceCeilingTerms> = {}): PriceCeiling {
  const draft = createPriceCeiling(terms(overrides));
  const result = activatePriceCeiling(draft, grant(draft.manifestDigest), NOW);
  assert.equal(result.ok, true);
  return (result as { ceiling: PriceCeiling }).ceiling;
}

function auth(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    authId: 'auth-1',
    scope: ALEX,
    merchantId: 'streamly-ro',
    amountMinor: 4900,
    currency: 'RON',
    billingAmountMinor: 4900,
    billingCurrency: 'RON',
    initiator: 'MERCHANT',
    receivedAt: NOW,
    ...overrides,
  };
}

const empty = { notifiedKeys: new Set<string>(), declinesByKey: new Map<string, number>() };
const decide = (request: AuthorizationRequest, ceilings: PriceCeiling[], extra: Partial<typeof empty> = {}) => decideAuthorization(request, { ceilings, ...empty, ...extra });

describe('creating and activating a ceiling', () => {
  it('needs a grant on the exact manifest', () => {
    const draft = createPriceCeiling(terms());
    assert.equal(draft.status, 'DRAFT');
    assert.deepEqual(activatePriceCeiling(draft, grant('other'), NOW), { ok: false, reason: 'DIGEST_MISMATCH' });
    assert.deepEqual(activatePriceCeiling(draft, grant(draft.manifestDigest, { contextId: 'BUSINESS' }), NOW), { ok: false, reason: 'WRONG_CONTEXT' });
    assert.deepEqual(activatePriceCeiling(active(), grant(draft.manifestDigest), NOW), { ok: false, reason: 'INVALID_STATE' });
  });

  it('is independent of merchant ID order and rejects bad input', () => {
    assert.equal(createPriceCeiling(terms({ merchantIds: ['a', 'b'] })).ceilingId, createPriceCeiling(terms({ merchantIds: ['b', 'a'] })).ceilingId);
    assert.throws(() => createPriceCeiling(terms({ merchantIds: [] })), (e: unknown) => e instanceof DomainError && e.code === 'NO_MERCHANT');
    assert.throws(() => createPriceCeiling(terms({ merchantIds: ['a', 'a'] })), (e: unknown) => e instanceof DomainError && e.code === 'DUPLICATE_MERCHANT');
    assert.throws(() => createPriceCeiling(terms({ approvedMinor: 49.5 })), DomainError);
    assert.throws(() => createPriceCeiling(terms({ currency: 'lei' })), DomainError);
  });
});

describe('decideAuthorization', () => {
  it('lets through charges at the approved price or lower', () => {
    assert.equal(decide(auth(), [active()]).action, 'APPROVE');
    assert.deepEqual(decide(auth({ amountMinor: 3900 }), [active()]), { action: 'APPROVE', reason: 'WITHIN_CEILING', ceilingId: active().ceilingId, effects: [] });
  });

  it('holds a merchant-initiated rise with a soft decline and one notice', () => {
    const ceiling = active();
    const decision = decide(auth({ amountMinor: 5900 }), [ceiling]);
    assert.equal(decision.action, 'DECLINE');
    if (decision.action !== 'DECLINE') return;
    assert.equal(decision.reason, 'ABOVE_CEILING');
    assert.equal(decision.advice, 'RETRY_LATER');
    assert.deepEqual(decision.effects, [{ type: 'NOTIFY_PRICE_RISE', key: decision.key, ceilingIds: [ceiling.ceilingId], currentMinor: 4900, requestedMinor: 5900, currency: 'RON' }]);
  });

  it('notifies once across a retry storm and turns hard after the soft-decline budget', () => {
    const ceiling = active();
    const key = riseKey([ceiling], 5900, 'RON');
    const second = decide(auth({ amountMinor: 5900 }), [ceiling], { notifiedKeys: new Set([key]), declinesByKey: new Map([[key, 1]]) });
    assert.equal(second.action === 'DECLINE' && second.effects.length, 0);
    assert.equal(second.action === 'DECLINE' && second.advice, 'RETRY_LATER');
    const third = decide(auth({ amountMinor: 5900 }), [ceiling], { notifiedKeys: new Set([key]), declinesByKey: new Map([[key, 2]]) });
    assert.equal(third.action === 'DECLINE' && third.advice, 'DO_NOT_RETRY');
  });

  it('a different requested price is a new rise with its own notice', () => {
    const ceiling = active();
    const key = riseKey([ceiling], 5900, 'RON');
    const other = decide(auth({ amountMinor: 6900 }), [ceiling], { notifiedKeys: new Set([key]) });
    assert.equal(other.action === 'DECLINE' && other.effects.length, 1);
  });

  it('ignores card-side FX movement and judges the merchant price', () => {
    const eur = active({ currency: 'EUR', approvedMinor: 999 });
    assert.equal(decide(auth({ amountMinor: 999, currency: 'EUR', billingAmountMinor: 5112, billingCurrency: 'RON' }), [eur]).action, 'APPROVE');
    assert.equal(decide(auth({ amountMinor: 999, currency: 'EUR', billingAmountMinor: 4970, billingCurrency: 'RON' }), [eur]).action, 'APPROVE');
  });

  it('treats a switch of billing currency as needing consent', () => {
    const decision = decide(auth({ amountMinor: 999, currency: 'EUR' }), [active()]);
    assert.equal(decision.action === 'DECLINE' && decision.reason, 'CURRENCY_CHANGED');
  });

  it('does not gate a purchase the customer authenticates themselves', () => {
    assert.deepEqual(decide(auth({ amountMinor: 12900, initiator: 'CUSTOMER' }), [active()]), { action: 'APPROVE', reason: 'CUSTOMER_PRESENT', effects: [] });
  });

  it('judges incremental authorizations on the running total', () => {
    assert.equal(decide(auth({ amountMinor: 900, incrementOf: { authId: 'auth-0', approvedSoFarMinor: 4000 } }), [active()]).action, 'APPROVE');
    const over = decide(auth({ amountMinor: 1000, incrementOf: { authId: 'auth-0', approvedSoFarMinor: 4000 } }), [active()]);
    assert.equal(over.action === 'DECLINE' && over.effects[0]?.type === 'NOTIFY_PRICE_RISE' && over.effects[0].requestedMinor, 5000);
  });

  it('gates every merchant ID of a brand and nothing else', () => {
    const ceiling = active({ merchantIds: ['streamly-ro', 'streamly-ie'] });
    assert.equal(decide(auth({ merchantId: 'streamly-ie', amountMinor: 5900 }), [ceiling]).action, 'DECLINE');
    assert.deepEqual(decide(auth({ merchantId: 'cloudbox', amountMinor: 5900 }), [ceiling]), { action: 'APPROVE', reason: 'NOT_GATED', effects: [] });
  });

  it('never applies another customer’s or context’s ceiling', () => {
    assert.equal(decide(auth({ scope: MARIA, amountMinor: 9900 }), [active()]).action, 'APPROVE');
    assert.equal(decide(auth({ scope: ALEX_BUSINESS, amountMinor: 9900 }), [active()]).action, 'APPROVE');
  });

  it('does nothing while paused, revoked or still a draft', () => {
    const ceiling = active();
    for (const c of [pausePriceCeiling(ceiling), revokePriceCeiling(ceiling), createPriceCeiling(terms())]) {
      assert.equal(decide(auth({ amountMinor: 9900 }), [c]).reason, 'NOT_GATED');
    }
    assert.throws(() => pausePriceCeiling(createPriceCeiling(terms())), DomainError);
  });

  it('with two subscriptions at one merchant, approves against the tightest covering ceiling', () => {
    const basic = active({ subscriptionId: 'sub-a', approvedMinor: 4900 });
    const family = active({ subscriptionId: 'sub-b', approvedMinor: 7900 });
    const decision = decide(auth({ amountMinor: 4900 }), [family, basic]);
    assert.equal(decision.action === 'APPROVE' && decision.ceilingId, basic.ceilingId);
    assert.equal(decide(auth({ amountMinor: 6900 }), [family, basic]).action === 'APPROVE' && decide(auth({ amountMinor: 6900 }), [family, basic]).reason, 'WITHIN_CEILING');
    const above = decide(auth({ amountMinor: 8900 }), [family, basic]);
    assert.equal(above.action === 'DECLINE' && above.effects[0]?.type === 'NOTIFY_PRICE_RISE' && above.effects[0].ceilingIds.length, 2);
  });

  it('a zero-amount verification charge passes', () => {
    assert.equal(decide(auth({ amountMinor: 0 }), [active()]).action, 'APPROVE');
  });

  it('rejects malformed requests', () => {
    assert.throws(() => decide(auth({ amountMinor: -1 }), [active()]), DomainError);
    assert.throws(() => decide(auth({ receivedAt: '2026-10-28' }), [active()]), DomainError);
  });
});

describe('answerPriceRise', () => {
  it('accepting raises the ceiling to exactly the shown price, so the merchant retry passes', () => {
    const ceiling = active();
    const { manifestDigest } = priceRiseManifest(ceiling, 5900, 'RON');
    const answered = answerPriceRise(ceiling, { newMinor: 5900, currency: 'RON' }, { kind: 'ACCEPT', grant: grant(manifestDigest, { grantId: 'grant-rise' }) }, NOW);
    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    assert.equal(answered.ceiling.terms.approvedMinor, 5900);
    assert.equal(answered.ceiling.ceilingId, ceiling.ceilingId);
    assert.notEqual(answered.ceiling.manifestDigest, ceiling.manifestDigest);
    assert.equal(decide(auth({ amountMinor: 5900 }), [answered.ceiling]).action, 'APPROVE');
    assert.equal(decide(auth({ amountMinor: 5901 }), [answered.ceiling]).action, 'DECLINE');
  });

  it('accepting needs a grant for this exact rise', () => {
    const ceiling = active();
    const wrong = priceRiseManifest(ceiling, 6900, 'RON').manifestDigest;
    assert.deepEqual(answerPriceRise(ceiling, { newMinor: 5900, currency: 'RON' }, { kind: 'ACCEPT', grant: grant(wrong) }, NOW), { ok: false, reason: 'DIGEST_MISMATCH' });
    const right = priceRiseManifest(ceiling, 5900, 'RON').manifestDigest;
    assert.deepEqual(answerPriceRise(ceiling, { newMinor: 5900, currency: 'RON' }, { kind: 'ACCEPT', grant: grant(right) }, '2026-10-28T10:00:00+02:00'), { ok: false, reason: 'EXPIRED' });
  });

  it('accepting a currency switch moves the ceiling to the new currency', () => {
    const ceiling = active();
    const { manifestDigest } = priceRiseManifest(ceiling, 999, 'EUR');
    const answered = answerPriceRise(ceiling, { newMinor: 999, currency: 'EUR' }, { kind: 'ACCEPT', grant: grant(manifestDigest) }, NOW);
    assert.equal(answered.ok && answered.ceiling.terms.currency, 'EUR');
  });

  it('rejecting turns later attempts into hard declines and suggests ending the contract properly', () => {
    const ceiling = active();
    const answered = answerPriceRise(ceiling, { newMinor: 5900, currency: 'RON' }, { kind: 'REJECT' }, NOW);
    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    assert.deepEqual(answered.effects, [{ type: 'SUGGEST_STOP_RENEWAL', subscriptionId: 'sub-streamly' }]);
    const retry = decide(auth({ amountMinor: 5900 }), [answered.ceiling]);
    assert.deepEqual(retry.action === 'DECLINE' && [retry.reason, retry.advice, retry.effects.length], ['RISE_REJECTED', 'DO_NOT_RETRY', 0]);
    assert.equal(decide(auth({ amountMinor: 4900 }), [answered.ceiling]).action, 'APPROVE');
    const smallerRise = decide(auth({ amountMinor: 5400 }), [answered.ceiling]);
    assert.equal(smallerRise.action === 'DECLINE' && smallerRise.reason, 'ABOVE_CEILING');
  });

  it('accepting later clears an earlier rejection', () => {
    const rejected = answerPriceRise(active(), { newMinor: 5900, currency: 'RON' }, { kind: 'REJECT' }, NOW);
    assert.ok(rejected.ok);
    const { manifestDigest } = priceRiseManifest(rejected.ceiling, 5900, 'RON');
    const accepted = answerPriceRise(rejected.ceiling, { newMinor: 5900, currency: 'RON' }, { kind: 'ACCEPT', grant: grant(manifestDigest) }, NOW);
    assert.equal(accepted.ok && accepted.ceiling.rejected, undefined);
  });

  it('refuses non-rises and inactive ceilings', () => {
    assert.deepEqual(answerPriceRise(active(), { newMinor: 4900, currency: 'RON' }, { kind: 'REJECT' }, NOW), { ok: false, reason: 'NOT_A_RISE' });
    assert.deepEqual(answerPriceRise(pausePriceCeiling(active()), { newMinor: 5900, currency: 'RON' }, { kind: 'REJECT' }, NOW), { ok: false, reason: 'INVALID_STATE' });
  });
});
