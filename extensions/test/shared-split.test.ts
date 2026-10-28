import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateMandate,
  assessCollections,
  createMandate,
  memberScope,
  planCycle,
  requestKey,
  revokeMandate,
  splitByWeight,
  type Mandate,
  type RequestState,
  type SplitGroup,
  type SplitMember,
} from '../src/shared-split/index.ts';
import { DomainError } from '../src/shared/index.ts';
import { grant, NOW } from './fixtures.ts';

const member = (memberId: string, o: Partial<SplitMember> = {}): SplitMember => ({ memberId, weight: 1, joinedOn: '2026-01-01', bankCustomer: true, ...o });
const GROUP: SplitGroup = {
  groupId: 'grp-family',
  organizerId: 'demo-alex',
  subscriptionId: 'sub-streamly-family',
  currency: 'RON',
  members: [member('demo-alex'), member('demo-maria'), member('demo-ion'), member('demo-ana', { bankCustomer: false })],
};
const NOVEMBER = { cycleId: '2026-11', startsOn: '2026-11-01', endsOn: '2026-11-30' };

function activeMandate(memberId: string, max = 2000, group = GROUP): Mandate {
  const draft = createMandate(group, memberId, max);
  const r = activateMandate(draft, grant(draft.manifestDigest, { ownerId: memberId }), NOW);
  assert.ok(r.ok);
  return r.mandate;
}

function cycle(o: Partial<Parameters<typeof planCycle>[0]> = {}) {
  return planCycle({ group: GROUP, cycle: NOVEMBER, chargedMinor: 7999, chargeCurrency: 'RON', mandates: [activeMandate('demo-maria'), activeMandate('demo-ion')], dueDays: 7, now: NOW, ...o });
}

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code);

describe('splitByWeight', () => {
  it('always sums exactly to the total', () => {
    for (const total of [0, 1, 2, 3, 7999, 10_000, 99_999_999]) {
      for (const weights of [[1, 1, 1], [1, 2], [3, 3, 3, 1], [7, 11, 13]]) {
        const split = splitByWeight(total, weights.map((weight, i) => ({ id: `m${i}`, weight })));
        assert.equal([...split.values()].reduce((a, b) => a + b, 0), total);
      }
    }
  });

  it('gives the leftover bani to the largest remainders, ties by member ID, regardless of input order', () => {
    const a = splitByWeight(100, [{ id: 'c', weight: 1 }, { id: 'a', weight: 1 }, { id: 'b', weight: 1 }]);
    assert.deepEqual([...a].sort(), [['a', 34], ['b', 33], ['c', 33]]);
    const b = splitByWeight(100, [{ id: 'b', weight: 1 }, { id: 'a', weight: 1 }, { id: 'c', weight: 1 }]);
    assert.deepEqual([...a].sort(), [...b].sort());
    // 10 split 1:2 → 3.33 / 6.67: the larger remainder (0.67) wins the extra unit.
    assert.deepEqual([...splitByWeight(10, [{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }])].sort(), [['a', 3], ['b', 7]]);
  });

  it('handles zero weights and rejects bad input', () => {
    assert.deepEqual([...splitByWeight(10, [{ id: 'a', weight: 0 }, { id: 'b', weight: 1 }])].sort(), [['a', 0], ['b', 10]]);
    throwsCode(() => splitByWeight(10, [{ id: 'a', weight: 0 }]), 'NO_WEIGHT');
    throwsCode(() => splitByWeight(10, [{ id: 'a', weight: 1.5 }]), 'INVALID_WEIGHT');
    throwsCode(() => splitByWeight(10, [{ id: 'a', weight: 1 }, { id: 'a', weight: 1 }]), 'DUPLICATE_MEMBER');
    throwsCode(() => splitByWeight(-1, [{ id: 'a', weight: 1 }]), 'NEGATIVE_AMOUNT');
  });

  it('does not overflow on large weights', () => {
    const split = splitByWeight(99_999_999, [{ id: 'a', weight: 2 ** 40 }, { id: 'b', weight: 2 ** 40 + 1 }]);
    assert.equal([...split.values()].reduce((x, y) => x + y, 0), 99_999_999);
  });
});

describe('mandates', () => {
  it('only the member can activate their own mandate', () => {
    const draft = createMandate(GROUP, 'demo-maria', 2000);
    assert.deepEqual(activateMandate(draft, grant(draft.manifestDigest), NOW), { ok: false, reason: 'WRONG_OWNER' });
    assert.deepEqual(activateMandate(draft, grant(draft.manifestDigest, { ownerId: 'demo-maria', contextId: 'BUSINESS' }), NOW), { ok: false, reason: 'WRONG_CONTEXT' });
    assert.equal(activateMandate(draft, grant(draft.manifestDigest, { ownerId: 'demo-maria' }), NOW).ok, true);
    assert.deepEqual(memberScope('demo-maria'), { ownerId: 'demo-maria', contextId: 'PERSONAL' });
  });

  it('cannot be created for the organizer, outsiders, non-customers or a zero cap', () => {
    throwsCode(() => createMandate(GROUP, 'demo-alex', 2000), 'ORGANIZER_PAYS_DIRECTLY');
    throwsCode(() => createMandate(GROUP, 'stranger', 2000), 'NOT_A_MEMBER');
    throwsCode(() => createMandate(GROUP, 'demo-ana', 2000), 'NOT_A_BANK_CUSTOMER');
    throwsCode(() => createMandate(GROUP, 'demo-maria', 0), 'INVALID_AMOUNT');
  });
});

describe('planCycle', () => {
  it('debits members with a mandate and requests from everyone else; the organizer pays the rest directly', () => {
    const plan = cycle();
    assert.deepEqual(plan.shares.map((s) => [s.memberId, s.shareMinor]), [['demo-alex', 2000], ['demo-ana', 2000], ['demo-ion', 2000], ['demo-maria', 1999]]);
    assert.equal(plan.organizerShareMinor, 2000);
    assert.deepEqual(plan.effects.map((e) => [e.type, 'memberId' in e ? e.memberId : '', 'why' in e ? e.why : '']), [
      ['SEND_PAYMENT_REQUEST', 'demo-ana', 'NOT_A_BANK_CUSTOMER'],
      ['DEBIT_MEMBER', 'demo-ion', ''],
      ['DEBIT_MEMBER', 'demo-maria', ''],
    ]);
  });

  it('never debits without the member’s own active mandate', () => {
    for (const mandates of [[], [revokeMandate(activeMandate('demo-maria'))], [createMandate(GROUP, 'demo-maria', 5000)], [activeMandate('demo-maria', 2000, { ...GROUP, groupId: 'other' })]]) {
      const plan = cycle({ mandates });
      assert.ok(!plan.effects.some((e) => e.type === 'DEBIT_MEMBER'));
      assert.ok(plan.effects.some((e) => e.type === 'SEND_PAYMENT_REQUEST' && e.memberId === 'demo-maria' && e.why === 'NO_MANDATE'));
    }
  });

  it('a price rise above a mandate needs fresh consent from that payer; the others are still debited', () => {
    const plan = cycle({ chargedMinor: 9999, mandates: [activeMandate('demo-maria', 2000), activeMandate('demo-ion', 3000)] });
    assert.deepEqual(plan.effects.filter((e) => e.type !== 'SEND_PAYMENT_REQUEST' || e.memberId !== 'demo-ana').map((e) => [e.type, 'memberId' in e ? e.memberId : '']), [
      ['DEBIT_MEMBER', 'demo-ion'],
      ['SEND_PAYMENT_REQUEST', 'demo-maria'],
      ['ASK_PRICE_CONSENT', 'demo-maria'],
    ]);
  });

  it('a price drop is still covered by the existing mandates', () => {
    assert.equal(cycle({ chargedMinor: 3999 }).effects.filter((e) => e.type === 'DEBIT_MEMBER').length, 2);
  });

  it('pro-rates a member who leaves mid-cycle and one who joins mid-cycle', () => {
    const group: SplitGroup = { ...GROUP, members: [member('demo-alex'), member('demo-maria', { leftOn: '2026-11-15' }), member('demo-ion', { joinedOn: '2026-11-16' })] };
    const plan = cycle({ group, chargedMinor: 6000 });
    assert.deepEqual(plan.shares.map((s) => [s.memberId, s.activeDays, s.shareMinor]), [['demo-alex', 30, 3000], ['demo-ion', 15, 1500], ['demo-maria', 15, 1500]]);
  });

  it('leaves out members gone before the cycle or joining after it', () => {
    const group: SplitGroup = { ...GROUP, members: [member('demo-alex'), member('demo-maria', { leftOn: '2026-10-31' }), member('demo-ion', { joinedOn: '2026-12-01' })] };
    const plan = cycle({ group });
    assert.deepEqual(plan.shares.map((s) => s.memberId), ['demo-alex']);
    assert.equal(plan.organizerShareMinor, 7999);
    assert.deepEqual(plan.effects, []);
  });

  it('honours weights', () => {
    const group: SplitGroup = { ...GROUP, members: [member('demo-alex', { weight: 2 }), member('demo-maria')] };
    assert.deepEqual(cycle({ group, chargedMinor: 3000 }).shares.map((s) => s.shareMinor), [2000, 1000]);
  });

  it('keys requests per group, cycle and member so a retry never doubles them', () => {
    const debit = cycle().effects.find((e) => e.type === 'DEBIT_MEMBER' && e.memberId === 'demo-maria');
    assert.equal(debit !== undefined && 'idempotencyKey' in debit && debit.idempotencyKey, requestKey('grp-family', '2026-11', 'demo-maria'));
    assert.deepEqual(cycle().effects, cycle().effects);
  });

  it('sets the due date from the Bucharest day', () => {
    const req = cycle().effects.find((e) => e.type === 'SEND_PAYMENT_REQUEST');
    assert.equal(req?.type === 'SEND_PAYMENT_REQUEST' && req.dueOn, '2026-11-04');
  });

  it('rejects a charge in another currency, a bad cycle and a missing organizer', () => {
    throwsCode(() => cycle({ chargeCurrency: 'EUR' }), 'CURRENCY_MISMATCH');
    throwsCode(() => cycle({ cycle: { ...NOVEMBER, endsOn: '2026-10-31' } }), 'INVALID_CYCLE');
    throwsCode(() => cycle({ group: { ...GROUP, organizerId: 'stranger' } }), 'ORGANIZER_NOT_MEMBER');
    throwsCode(() => cycle({ group: { ...GROUP, members: [member('demo-alex', { weight: 0 })] } }), 'INVALID_WEIGHT');
    throwsCode(() => cycle({ group: { ...GROUP, members: [member('demo-alex', { joinedOn: '2026-11-10', leftOn: '2026-11-01' })] } }), 'INVALID_MEMBERSHIP');
    throwsCode(() => cycle({ dueDays: 0 }), 'INVALID_DUE_DAYS');
  });
});

describe('assessCollections', () => {
  const req = (memberId: string, cycleId: string, o: Partial<RequestState> = {}): RequestState => ({ idempotencyKey: requestKey('grp-family', cycleId, memberId), memberId, amountMinor: 2000, paidMinor: 0, dueOn: '2026-10-20', reminded: false, ...o });

  it('reminds once after the grace days and counts the shortfall', () => {
    const r = assessCollections([req('demo-ana', '2026-10')], NOW);
    assert.equal(r.shortfallMinor, 2000);
    assert.deepEqual(r.effects, [{ type: 'SEND_REMINDER', idempotencyKey: `${requestKey('grp-family', '2026-10', 'demo-ana')}:reminder`, memberId: 'demo-ana', outstandingMinor: 2000 }]);
    assert.deepEqual(assessCollections([req('demo-ana', '2026-10', { reminded: true })], NOW).effects, []);
  });

  it('ignores paid, not-yet-due and due-today requests, and counts partial payments', () => {
    const r = assessCollections([req('a', '1', { paidMinor: 2000 }), req('b', '1', { dueOn: '2026-10-28' }), req('c', '1', { dueOn: '2026-11-01' }), req('d', '1', { paidMinor: 1500 })], NOW);
    assert.equal(r.shortfallMinor, 500);
  });

  it('does not remind before the grace period ends', () => {
    assert.deepEqual(assessCollections([req('a', '1', { dueOn: '2026-10-26' })], NOW).effects, []);
  });

  it('suggests removing a member after repeated non-payment but never debits or reshares', () => {
    const r = assessCollections([req('demo-ana', '2026-09', { reminded: true }), req('demo-ana', '2026-10', { reminded: true })], NOW);
    assert.deepEqual(r.effects, [{ type: 'SUGGEST_REMOVE_MEMBER', memberId: 'demo-ana', overdueCount: 2 }]);
    assert.ok(!r.effects.some((e) => e.type === 'DEBIT_MEMBER' || e.type === 'SEND_PAYMENT_REQUEST'));
  });
});
