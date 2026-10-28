import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerUpdaterInquiry,
  approveReissuePlan,
  planReissue,
  questionsFor,
  type CardOnFile,
  type Choice,
  type ReissueReason,
} from '../src/card-reissue/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { ALEX, ALEX_BUSINESS, grant, MARIA, NOW, receipt } from './fixtures.ts';

const pan = (merchantId: string, subscriptionIds: string[], extra: Partial<CardOnFile> = {}): CardOnFile => ({ merchantId, credential: { kind: 'PAN' }, participatesInUpdater: true, subscriptionIds, ...extra });

const MERCHANTS: CardOnFile[] = [
  pan('fitflow', ['sub-fitflow']),
  pan('streamly', ['sub-streamly']),
  pan('cloudbox', ['sub-cloudbox'], { credential: { kind: 'NETWORK_TOKEN', tokenId: 'tok-cloudbox' } }),
  pan('pizzaplace', []),
];

// FitFlow was cancelled (verified); the others are live.
const RECEIPTS = [receipt()];

function plan(overrides: { reason?: ReissueReason; choices?: Map<string, Choice>; merchants?: CardOnFile[]; receipts?: typeof RECEIPTS } = {}) {
  return planReissue({
    scope: ALEX,
    oldCardId: 'card-old',
    newCardId: 'card-new',
    reason: overrides.reason ?? 'EXPIRY',
    merchants: overrides.merchants ?? MERCHANTS,
    receipts: overrides.receipts ?? RECEIPTS,
    choices: overrides.choices ?? new Map(),
    now: NOW,
  });
}

const decisionOf = (p: ReturnType<typeof plan>, merchantId: string) => p.decisions.find((d) => d.merchantId === merchantId);

describe('planReissue defaults', () => {
  it('drops merchants whose subscriptions are all verifiably cancelled and keeps live ones', () => {
    const p = plan();
    assert.deepEqual([decisionOf(p, 'fitflow')?.decision, decisionOf(p, 'fitflow')?.basis], ['DROP', 'ALL_SUBSCRIPTIONS_CANCELLED']);
    assert.deepEqual([decisionOf(p, 'streamly')?.decision, decisionOf(p, 'streamly')?.basis], ['KEEP', 'ACTIVE_SUBSCRIPTION']);
  });

  it('never drops an unexplained merchant silently on a routine expiry', () => {
    const d = decisionOf(plan(), 'pizzaplace');
    assert.deepEqual([d?.decision, d?.basis, d?.question], ['KEEP', 'UNANSWERED_KEEPS_SERVICE', 'UNKNOWN_PURPOSE']);
  });

  it('after loss or fraud, unanswered merchants get nothing but live subscriptions continue', () => {
    for (const reason of ['LOST', 'STOLEN', 'COMPROMISED'] as const) {
      const p = plan({ reason });
      assert.deepEqual([decisionOf(p, 'pizzaplace')?.decision, decisionOf(p, 'pizzaplace')?.basis], ['DROP', 'UNANSWERED_AFTER_FRAUD']);
      assert.equal(decisionOf(p, 'streamly')?.decision, 'KEEP');
      assert.equal(decisionOf(p, 'fitflow')?.decision, 'DROP');
    }
    assert.equal(decisionOf(plan({ reason: 'CUSTOMER_REQUEST' }), 'pizzaplace')?.decision, 'KEEP');
  });

  it('asks when a merchant has both cancelled and live subscriptions', () => {
    const merchants = [pan('fitflow', ['sub-fitflow', 'sub-fitflow-kids'])];
    const d = decisionOf(plan({ merchants }), 'fitflow');
    assert.equal(d?.question, 'MIXED_SUBSCRIPTIONS');
    assert.equal(d?.decision, 'KEEP');
  });

  it('does not trust weak proof, a reactivation, another context or another merchant’s receipt', () => {
    assert.equal(decisionOf(plan({ receipts: [receipt({ verification: 'MERCHANT_MESSAGE_ONLY' })] }), 'fitflow')?.decision, 'KEEP');
    assert.equal(decisionOf(plan({ receipts: [receipt(), receipt({ receiptId: 'R2', operation: 'REACTIVATE', confirmedAt: '2026-10-28T09:44:00+02:00' })] }), 'fitflow')?.decision, 'KEEP');
    assert.equal(decisionOf(plan({ receipts: [receipt({ scope: ALEX_BUSINESS })] }), 'fitflow')?.decision, 'KEEP');
    assert.equal(decisionOf(plan({ receipts: [receipt({ scope: MARIA })] }), 'fitflow')?.decision, 'KEEP');
    assert.equal(decisionOf(plan({ receipts: [receipt({ merchantId: 'fitflow-other' })] }), 'fitflow')?.decision, 'KEEP');
  });
});

describe('customer choices', () => {
  it('override defaults and warn when keeping a cancelled merchant', () => {
    const p = plan({ choices: new Map<string, Choice>([['fitflow', 'KEEP'], ['streamly', 'DROP']]) });
    assert.deepEqual(decisionOf(p, 'fitflow'), { merchantId: 'fitflow', groupKey: 'fitflow', decision: 'KEEP', basis: 'CUSTOMER_CHOICE', warnings: ['KEEPING_CANCELLED_MERCHANT'] });
    assert.equal(decisionOf(p, 'streamly')?.decision, 'DROP');
  });

  it('apply to every merchant ID of a brand', () => {
    const merchants = [pan('streamly-ro', [], { brandId: 'streamly' }), pan('streamly-ie', [], { brandId: 'streamly' })];
    const p = plan({ merchants, reason: 'COMPROMISED', choices: new Map([['streamly', 'KEEP' as Choice]]) });
    assert.deepEqual(p.decisions.map((d) => d.decision), ['KEEP', 'KEEP']);
    assert.deepEqual(questionsFor({ scope: ALEX, merchants, receipts: [], now: NOW }), [{ groupKey: 'streamly', merchantIds: ['streamly-ie', 'streamly-ro'], question: 'UNKNOWN_PURPOSE' }]);
  });

  it('reject answers for merchants that are not on file', () => {
    assert.throws(() => plan({ choices: new Map([['ghost', 'DROP' as Choice]]) }), (e: unknown) => e instanceof DomainError && e.code === 'UNKNOWN_CHOICE');
  });
});

describe('questionsFor', () => {
  it('lists only the merchants that need an answer, mixed taking precedence within a brand', () => {
    const merchants = [...MERCHANTS.slice(1), pan('fitflow', ['sub-fitflow', 'sub-x'], { brandId: 'fitflow-brand' }), pan('fitflow-ie', [], { brandId: 'fitflow-brand' })];
    assert.deepEqual(questionsFor({ scope: ALEX, merchants, receipts: RECEIPTS, now: NOW }), [
      { groupKey: 'fitflow-brand', merchantIds: ['fitflow', 'fitflow-ie'], question: 'MIXED_SUBSCRIPTIONS' },
      { groupKey: 'pizzaplace', merchantIds: ['pizzaplace'], question: 'UNKNOWN_PURPOSE' },
    ]);
  });
});

describe('brands billing under several merchant IDs', () => {
  it('a cancellation confirmed under one merchant ID counts for the brand’s other IDs', () => {
    const merchants = [pan('fitflow', [], { brandId: 'fitflow-brand' }), pan('fitflow-ie', ['sub-fitflow'], { brandId: 'fitflow-brand' })];
    assert.equal(decisionOf(plan({ merchants }), 'fitflow-ie')?.basis, 'ALL_SUBSCRIPTIONS_CANCELLED');
  });

  it('but not for an unrelated merchant that happens to carry the same subscription ID', () => {
    const merchants = [pan('fitflow', []), pan('other-gym', ['sub-fitflow'])];
    assert.equal(decisionOf(plan({ merchants }), 'other-gym')?.basis, 'ACTIVE_SUBSCRIPTION');
  });
});

describe('approveReissuePlan', () => {
  it('turns decisions into updater and token effects', () => {
    const p = plan({ choices: new Map([['cloudbox', 'DROP' as Choice]]) });
    const result = approveReissuePlan(p, MERCHANTS, grant(p.manifestDigest), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.effects, [
      { type: 'SUSPEND_TOKEN', merchantId: 'cloudbox', tokenId: 'tok-cloudbox', idempotencyKey: `${p.planId}:token:tok-cloudbox` },
      { type: 'BLOCK_UPDATER', merchantId: 'fitflow', oldCardId: 'card-old' },
      { type: 'ALLOW_UPDATER', merchantId: 'pizzaplace', newCardId: 'card-new' },
      { type: 'ALLOW_UPDATER', merchantId: 'streamly', newCardId: 'card-new' },
    ]);
  });

  it('a kept token needs no action because it follows the account', () => {
    const p = plan();
    const result = approveReissuePlan(p, MERCHANTS, grant(p.manifestDigest), NOW);
    assert.ok(result.ok && !result.effects.some((e) => e.merchantId === 'cloudbox'));
  });

  it('tells the customer to update merchants outside the updater, and does nothing for dropped ones', () => {
    const merchants = [pan('gym', ['sub-gym'], { participatesInUpdater: false }), pan('fitflow', ['sub-fitflow'], { participatesInUpdater: false })];
    const p = plan({ merchants });
    assert.deepEqual(decisionOf(p, 'gym')?.warnings, ['MANUAL_UPDATE_NEEDED']);
    const result = approveReissuePlan(p, merchants, grant(p.manifestDigest), NOW);
    assert.deepEqual(result.ok && result.effects, [{ type: 'TELL_CUSTOMER_TO_UPDATE', merchantId: 'gym' }]);
  });

  it('requires a grant on this plan and the same merchant list', () => {
    const p = plan();
    assert.deepEqual(approveReissuePlan(p, MERCHANTS, grant('x'), NOW), { ok: false, reason: 'DIGEST_MISMATCH' });
    assert.deepEqual(approveReissuePlan(p, MERCHANTS.slice(1), grant(p.manifestDigest), NOW), { ok: false, reason: 'MERCHANTS_CHANGED' });
    assert.deepEqual(approveReissuePlan(p, [...MERCHANTS.slice(1), pan('new', [])], grant(p.manifestDigest), NOW), { ok: false, reason: 'MERCHANTS_CHANGED' });
  });

  it('a different choice yields a different plan digest', () => {
    assert.notEqual(plan().manifestDigest, plan({ choices: new Map([['streamly', 'DROP' as Choice]]) }).manifestDigest);
  });
});

describe('answerUpdaterInquiry', () => {
  const p = plan();
  it('provides the new card only to kept merchants', () => {
    assert.deepEqual(answerUpdaterInquiry(p, { merchantId: 'streamly', oldCardId: 'card-old', receivedAt: NOW }), { answer: 'PROVIDE', newCardId: 'card-new' });
  });

  it('records a cancelled merchant asking for the new number', () => {
    assert.deepEqual(answerUpdaterInquiry(p, { merchantId: 'fitflow', oldCardId: 'card-old', receivedAt: NOW }), { answer: 'WITHHOLD', signal: 'REQUEST_AFTER_CANCELLATION' });
  });

  it('withholds from merchants not on file or asking about another card', () => {
    assert.deepEqual(answerUpdaterInquiry(p, { merchantId: 'stranger', oldCardId: 'card-old', receivedAt: NOW }), { answer: 'WITHHOLD', signal: 'MERCHANT_NOT_ON_FILE' });
    assert.deepEqual(answerUpdaterInquiry(p, { merchantId: 'streamly', oldCardId: 'card-other', receivedAt: NOW }), { answer: 'WITHHOLD', signal: 'MERCHANT_NOT_ON_FILE' });
  });

  it('a customer-dropped merchant is withheld without a cancellation signal', () => {
    const dropped = plan({ choices: new Map([['streamly', 'DROP' as Choice]]) });
    assert.deepEqual(answerUpdaterInquiry(dropped, { merchantId: 'streamly', oldCardId: 'card-old', receivedAt: NOW }), { answer: 'WITHHOLD' });
  });
});

describe('input validation', () => {
  it('rejects the same card, duplicated merchants and bad instants', () => {
    assert.throws(() => planReissue({ scope: ALEX, oldCardId: 'c', newCardId: 'c', reason: 'EXPIRY', merchants: [], receipts: [], choices: new Map(), now: NOW }), DomainError);
    assert.throws(() => plan({ merchants: [pan('a', []), pan('a', [])] }), (e: unknown) => e instanceof DomainError && e.code === 'DUPLICATE_MERCHANT');
    assert.throws(() => planReissue({ scope: ALEX, oldCardId: 'a', newCardId: 'b', reason: 'EXPIRY', merchants: [], receipts: [], choices: new Map(), now: 'today' }), DomainError);
  });
});
