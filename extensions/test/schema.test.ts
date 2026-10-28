import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { repaymentKey } from '../src/business-move/index.ts';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
});

function insert(table: string, row: Record<string, SQLInputValue>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function rejects(table: string, row: Record<string, SQLInputValue>, pattern: RegExp): void {
  assert.throws(() => insert(table, row), pattern);
}

const T = '2026-10-28T09:45:00+02:00';

describe('schema loads', () => {
  it('is idempotent and creates only ext_ tables', () => {
    db.exec(SCHEMA);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
    assert.ok(names.length >= 25);
    assert.ok(names.every((n) => n.startsWith('ext_')));
  });

  it('refuses fractional or textual money in strict integer columns', () => {
    const row = { merchant_id: 'm', plan_key: 'p', currency: 'RON', old_minor: 4900, new_minor: 5900, direction: 'INCREASE', change_bp: 2040, customers: 20, first_seen_on: '2026-10-15', computed_at: T };
    rejects('ext_price_change_cluster', { ...row, new_minor: 59.5 }, /cannot store REAL/);
    rejects('ext_price_change_cluster', { ...row, new_minor: '59 RON' }, /cannot store TEXT/);
  });
});

describe('dispute cases', () => {
  const dispute = (o: Record<string, SQLInputValue> = {}) => ({
    packet_id: 'dsp_1', tenant_id: 'fictional-bank-demo', owner_id: 'demo-alex', context_id: 'personal', tx_id: 'tx-1', receipt_id: 'NF-1047',
    manifest_digest: 'md-1', currency: 'RON', disputable_minor: 7900, state: 'PREPARED', deadline: T, created_at: T, updated_at: T, ...o,
  });

  it('allows one dispute per charge', () => {
    insert('ext_dispute_case', dispute());
    rejects('ext_dispute_case', dispute({ packet_id: 'dsp_2', manifest_digest: 'md-2' }), /UNIQUE.*tx_id/);
  });

  it('never credits more than disputed and requires approval past PREPARED', () => {
    rejects('ext_dispute_case', dispute({ credited_minor: 7901 }), /CHECK/);
    rejects('ext_dispute_case', dispute({ credited_minor: 100, provisional_minor: 200 }), /CHECK/);
    rejects('ext_dispute_case', dispute({ state: 'SUBMITTED' }), /CHECK/);
    rejects('ext_dispute_case', dispute({ state: 'MAYBE', grant_id: 'g' }), /CHECK/);
    rejects('ext_dispute_case', dispute({ currency: 'ron' }), /CHECK/);
    insert('ext_dispute_case', dispute({ state: 'SUBMITTED', grant_id: 'grant-1', credited_minor: 7900, provisional_minor: 7900 }));
  });

  it('rejects a replayed event and events for unknown cases', () => {
    insert('ext_dispute_case', dispute());
    const event = { event_id: 'bank-ev-1', packet_id: 'dsp_1', kind: 'BANK_CREDIT_PROVISIONAL', amount_minor: 7900, applied_at: T };
    insert('ext_dispute_event', event);
    rejects('ext_dispute_event', event, /UNIQUE/);
    rejects('ext_dispute_event', { ...event, event_id: 'bank-ev-2', packet_id: 'dsp_missing' }, /FOREIGN KEY/);
  });
});

describe('exit plans', () => {
  const plan = (o: Record<string, SQLInputValue> = {}) => ({
    rule_id: 'exit_1', owner_id: 'demo-alex', context_id: 'personal', subscription_id: 'sub-fitflow', terms_revision: 3, terms_json: '{}',
    manifest_digest: 'md', status: 'ACTIVE', grant_id: 'g1', created_on: '2026-10-28', ...o,
  });

  it('keeps one live plan per subscription but any number of closed ones', () => {
    insert('ext_exit_plan', plan());
    rejects('ext_exit_plan', plan({ rule_id: 'exit_2' }), /UNIQUE/);
    insert('ext_exit_plan', plan({ rule_id: 'exit_3', status: 'REVOKED', grant_id: null }));
    insert('ext_exit_plan', plan({ rule_id: 'exit_4', status: 'KEPT' }));
  });

  it('requires a grant to be active and an idempotency key to request a stop', () => {
    rejects('ext_exit_plan', plan({ grant_id: null }), /CHECK/);
    rejects('ext_exit_plan', plan({ status: 'STOP_REQUESTED' }), /CHECK/);
    insert('ext_exit_plan', plan({ status: 'STOP_REQUESTED', idempotency_key: 'exit:exit_1:3' }));
    rejects('ext_exit_plan', plan({ rule_id: 'exit_9', status: 'STOPPED', subscription_id: 'other', idempotency_key: 'exit:exit_1:3' }), /UNIQUE/);
  });
});

describe('retention offers', () => {
  const offer = (o: Record<string, SQLInputValue> = {}) => ({
    offer_id: 'off-1', revision: 1, owner_id: 'demo-alex', context_id: 'personal', merchant_id: 'streamly', subscription_id: 'sub-streamly',
    offer_digest: 'od-1', signed_json: '{"offer":{}}', unsolicited: 1, received_at: T, expires_at: '2026-10-30T09:45:00+02:00', ...o,
  });
  const acceptance = (o: Record<string, SQLInputValue> = {}) => ({ idempotency_key: 'offer:off-1:1', offer_id: 'off-1', revision: 1, offer_digest: 'od-1', grant_id: 'g', accepted_at: T, ...o });

  it('stores each revision once and only accepts one revision of an offer', () => {
    insert('ext_retention_offer', offer());
    insert('ext_retention_offer', offer({ revision: 2, offer_digest: 'od-2', unsolicited: 0 }));
    rejects('ext_retention_offer', offer({ offer_digest: 'od-x' }), /UNIQUE/);
    insert('ext_offer_acceptance', acceptance());
    rejects('ext_offer_acceptance', acceptance({ idempotency_key: 'offer:off-1:2', revision: 2, offer_digest: 'od-2' }), /UNIQUE/);
  });

  it('ties the acceptance key to the offer and revision', () => {
    insert('ext_retention_offer', offer());
    rejects('ext_offer_acceptance', acceptance({ idempotency_key: 'offer:off-1:9' }), /CHECK/);
    rejects('ext_offer_acceptance', acceptance({ idempotency_key: 'offer:off-2:1', offer_id: 'off-2' }), /FOREIGN KEY/);
  });

  it('rejects malformed JSON, verdicts and counters', () => {
    rejects('ext_retention_offer', offer({ signed_json: '{oops' }), /CHECK/);
    rejects('ext_retention_offer', offer({ verdict: 'GREAT_DEAL' }), /CHECK/);
    insert('ext_retention_offer', offer());
    rejects('ext_offer_counter', { counter_id: 'ctr_1', offer_id: 'off-1', offer_revision: 1, monthly_minor: 2900, months: 0, currency: 'RON', sent_at: T }, /CHECK/);
    rejects('ext_offer_counter', { counter_id: 'ctr_1', offer_id: 'off-1', offer_revision: 5, monthly_minor: 2900, months: 3, currency: 'RON', sent_at: T }, /FOREIGN KEY/);
  });
});

describe('merchant insights', () => {
  it('stores no numbers for suppressed groups', () => {
    insert('ext_merchant_track_record', { merchant_id: 'tiny', status: 'INSUFFICIENT_DATA', computed_at: T });
    rejects('ext_merchant_track_record', { merchant_id: 'leaky', status: 'INSUFFICIENT_DATA', customers: 3, computed_at: T }, /CHECK/);
    rejects('ext_merchant_track_record', { merchant_id: 'bad', status: 'OK', customers: 20, billed_after_customers: 21, rate_bp: 0, lower_bound_bp: 0, computed_at: T }, /CHECK/);
    insert('ext_merchant_track_record', { merchant_id: 'sticky', status: 'FLAGGED', customers: 20, billed_after_customers: 3, rate_bp: 1500, lower_bound_bp: 523, computed_at: T });
  });

  it('has no column that could hold a customer key', () => {
    for (const table of ['ext_merchant_track_record', 'ext_price_change_cluster', 'ext_cancellation_difficulty']) {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => String(r.name));
      assert.ok(cols.every((c) => !/customer_key|owner|account/.test(c)), `${table}: ${cols.join(',')}`);
    }
  });

  it('keeps direction consistent with the prices', () => {
    const cluster = { merchant_id: 'streamly', plan_key: 'standard', currency: 'RON', old_minor: 4900, new_minor: 5900, direction: 'INCREASE', change_bp: 2040, customers: 20, first_seen_on: '2026-10-15', computed_at: T };
    insert('ext_price_change_cluster', cluster);
    rejects('ext_price_change_cluster', { ...cluster, plan_key: 'p2', direction: 'DECREASE' }, /CHECK/);
    rejects('ext_price_change_cluster', { ...cluster, plan_key: 'p3', new_minor: 4900 }, /CHECK/);
  });
});

describe('price-rise consent gate', () => {
  const ceiling = (o: Record<string, SQLInputValue> = {}) => ({
    ceiling_id: 'ceil_1', owner_id: 'demo-alex', context_id: 'PERSONAL', subscription_id: 'sub-streamly', merchant_ids_json: '["streamly"]', currency: 'RON',
    approved_minor: 4900, manifest_digest: 'md-1', status: 'ACTIVE', grant_id: 'grant-1', updated_at: T, ...o,
  });

  it('keeps one live ceiling per subscription and requires a grant to be live', () => {
    insert('ext_price_ceiling', ceiling());
    rejects('ext_price_ceiling', ceiling({ ceiling_id: 'ceil_2', status: 'PAUSED' }), /UNIQUE/);
    insert('ext_price_ceiling', ceiling({ ceiling_id: 'ceil_3', status: 'REVOKED' }));
    rejects('ext_price_ceiling', ceiling({ ceiling_id: 'ceil_4', subscription_id: 'sub-x', grant_id: null }), /CHECK/);
    rejects('ext_price_ceiling', ceiling({ ceiling_id: 'ceil_5', subscription_id: 'sub-y', merchant_ids_json: '[]' }), /CHECK/);
  });

  it('only records a rejection that is actually a rise', () => {
    rejects('ext_price_ceiling', ceiling({ rejected_minor: 4900, rejected_currency: 'RON' }), /CHECK/);
    rejects('ext_price_ceiling', ceiling({ rejected_minor: 5900 }), /CHECK/);
    insert('ext_price_ceiling', ceiling({ rejected_minor: 4900, rejected_currency: 'EUR' }));
  });

  it('notifies once per rise key and refuses unknown decline reasons', () => {
    insert('ext_price_rise_notice', { rise_key: 'pricerise:ceil_1:RON:5900', notified_at: T });
    rejects('ext_price_rise_notice', { rise_key: 'pricerise:ceil_1:RON:5900', notified_at: T }, /UNIQUE/);
    rejects('ext_price_gate_decline', { auth_id: 'a1', rise_key: 'k', reason: 'INSUFFICIENT_FUNDS', advice: 'RETRY_LATER', decided_at: T }, /CHECK/);
  });
});

describe('card reissue', () => {
  const plan = (o: Record<string, SQLInputValue> = {}) => ({
    plan_id: 'reissue_1', owner_id: 'demo-alex', context_id: 'PERSONAL', old_card_id: 'card-old', new_card_id: 'card-new', reason: 'COMPROMISED', manifest_digest: 'md-1', ...o,
  });

  it('allows one approved filter per replaced card and requires approval time with the grant', () => {
    insert('ext_reissue_plan', plan({ grant_id: 'g1', approved_at: T }));
    rejects('ext_reissue_plan', plan({ plan_id: 'reissue_2', manifest_digest: 'md-2', grant_id: 'g2', approved_at: T }), /UNIQUE/);
    insert('ext_reissue_plan', plan({ plan_id: 'reissue_3', manifest_digest: 'md-3' }));
    rejects('ext_reissue_plan', plan({ plan_id: 'reissue_4', manifest_digest: 'md-4', grant_id: 'g4' }), /CHECK/);
    rejects('ext_reissue_plan', plan({ plan_id: 'reissue_5', manifest_digest: 'md-5', new_card_id: 'card-old' }), /CHECK/);
  });

  it('decides each merchant once and only attaches signals to withheld answers', () => {
    insert('ext_reissue_plan', plan());
    const decision = { plan_id: 'reissue_1', merchant_id: 'fitflow', group_key: 'brand:fitflow', decision: 'DROP', basis: 'ALL_SUBSCRIPTIONS_CANCELLED' };
    insert('ext_reissue_decision', decision);
    rejects('ext_reissue_decision', { ...decision, decision: 'KEEP' }, /UNIQUE/);
    rejects('ext_reissue_decision', { ...decision, merchant_id: 'other', basis: 'MODEL_GUESS' }, /CHECK/);
    rejects('ext_updater_inquiry', { inquiry_id: 'i1', plan_id: 'reissue_1', merchant_id: 'fitflow', answer: 'PROVIDE', signal: 'REQUEST_AFTER_CANCELLATION', received_at: T }, /CHECK/);
    insert('ext_updater_inquiry', { inquiry_id: 'i2', plan_id: 'reissue_1', merchant_id: 'fitflow', answer: 'WITHHOLD', signal: 'REQUEST_AFTER_CANCELLATION', received_at: T });
    rejects('ext_updater_inquiry', { inquiry_id: 'i3', plan_id: 'reissue_missing', merchant_id: 'fitflow', answer: 'WITHHOLD', received_at: T }, /FOREIGN KEY/);
  });
});

describe('business move', () => {
  const move = (o: Record<string, SQLInputValue> = {}) => ({
    plan_id: 'bizmove_1', personal_owner_id: 'demo-alex', personal_context_id: 'PERSONAL', business_owner_id: 'demo-alex', business_context_id: 'BUSINESS',
    subscription_id: 'sub-cloudbox', business_use_bp: 10000, manifest_digest: 'md-1', vat_note_json: '{"case":"DOMESTIC_SUPPLY"}', ...o,
  });

  it('needs two different grants to be approved and keeps contexts the right way round', () => {
    rejects('ext_business_move', move({ approved_at: T, personal_grant_id: 'g1' }), /CHECK/);
    rejects('ext_business_move', move({ approved_at: T, personal_grant_id: 'g1', business_grant_id: 'g1' }), /CHECK/);
    rejects('ext_business_move', move({ personal_context_id: 'BUSINESS' }), /CHECK/);
    rejects('ext_business_move', move({ business_use_bp: 0 }), /CHECK/);
    insert('ext_business_move', move({ approved_at: T, personal_grant_id: 'g1', business_grant_id: 'g2' }));
  });

  it('repays a charge once, even from a second plan', () => {
    insert('ext_business_move', move());
    insert('ext_business_move', move({ plan_id: 'bizmove_2', manifest_digest: 'md-2' }));
    const row = { idempotency_key: repaymentKey('sub-cloudbox', 'tx-oct'), plan_id: 'bizmove_1', subscription_id: 'sub-cloudbox', charge_id: 'tx-oct', amount_minor: 2900, currency: 'RON' };
    insert('ext_business_repayment', row);
    rejects('ext_business_repayment', row, /UNIQUE/);
    rejects('ext_business_repayment', { ...row, idempotency_key: 'respelled', plan_id: 'bizmove_2' }, /UNIQUE/);
    rejects('ext_business_repayment', { ...row, idempotency_key: 'k0', charge_id: 'tx-nov', amount_minor: 0 }, /CHECK/);
  });

  it('versions VAT rule sets by date', () => {
    const rules = { rule_set_id: 'ro-vat', version: 1, effective_from: '2025-08-01', home_country: 'RO', eu_countries_json: '["AT","DE","RO"]' };
    insert('ext_vat_rule_set', rules);
    rejects('ext_vat_rule_set', rules, /UNIQUE/);
    rejects('ext_vat_rule_set', { ...rules, version: 2, home_country: 'ro' }, /CHECK/);
  });
});

describe('cancellation certificates', () => {
  const key = (o: Record<string, SQLInputValue> = {}) => ({
    key_id: 'cert-2026-1', issuer: 'nextmove-demo', algorithm: 'Ed25519', public_key_spki: 'MCowBQYDK2VwAyEA-test', private_key_ref: 'keystore:cert-2026-1', status: 'ACTIVE', created_at: T, ...o,
  });

  it('stores private keys by reference only and signs with one active key per issuer', () => {
    insert('ext_certificate_key', key());
    rejects('ext_certificate_key', key({ key_id: 'cert-2026-2' }), /UNIQUE/);
    rejects('ext_certificate_key', key({ key_id: 'cert-2026-3', status: 'RETIRED', private_key_ref: '-----BEGIN PRIVATE KEY-----' }), /CHECK/);
    insert('ext_certificate_key', key({ key_id: 'cert-2026-4', status: 'COMPROMISED' }));
  });

  it('records issued certificates against a known key and keeps the revocation list sequence unique', () => {
    insert('ext_certificate_key', key());
    const cert = { cert_id: 'c1', owner_id: 'demo-alex', context_id: 'PERSONAL', subscription_id: 'sub-fitflow', receipt_id: 'NF-1047', key_id: 'cert-2026-1', issued_at: T, expires_at: '2027-10-28T07:45:00.000Z' };
    insert('ext_certificate', cert);
    rejects('ext_certificate', { ...cert, cert_id: 'c2', key_id: 'unknown' }, /FOREIGN KEY/);
    rejects('ext_certificate', { ...cert, cert_id: 'c3', expires_at: T }, /CHECK/);
    const crl = { issuer: 'nextmove-demo', seq: 1, issued_at: T, next_update: '2026-10-29T09:45:00+02:00', signed_text: 'NMR1.payload.sig' };
    insert('ext_revocation_list', crl);
    rejects('ext_revocation_list', crl, /UNIQUE/);
    rejects('ext_revocation_list', { ...crl, seq: 2, signed_text: 'unsigned' }, /CHECK/);
  });
});

describe('shared split', () => {
  beforeEach(() => {
    insert('ext_split_group', { group_id: 'grp-1', organizer_id: 'demo-alex', subscription_id: 'sub-family', currency: 'RON' });
    for (const m of ['demo-alex', 'demo-maria']) insert('ext_split_member', { group_id: 'grp-1', member_id: m, weight: 1, joined_on: '2026-09-01', bank_customer: 1 });
  });
  const mandate = (o: Record<string, SQLInputValue> = {}) => ({ mandate_id: 'mandate_1', group_id: 'grp-1', member_id: 'demo-maria', currency: 'RON', max_share_minor: 2000, manifest_digest: 'md', status: 'ACTIVE', grant_id: 'g', ...o });
  const request = (o: Record<string, SQLInputValue> = {}) => ({
    idempotency_key: 'split:grp-1:2026-11:demo-maria', group_id: 'grp-1', cycle_id: '2026-11', member_id: 'demo-maria', method: 'REQUEST', amount_minor: 1500, due_on: '2026-11-08', ...o,
  });

  it('allows one active mandate per member, only with a grant, and only for members', () => {
    insert('ext_split_mandate', mandate());
    rejects('ext_split_mandate', mandate({ mandate_id: 'mandate_2' }), /UNIQUE/);
    rejects('ext_split_mandate', mandate({ mandate_id: 'mandate_3', member_id: 'demo-alex', grant_id: null }), /CHECK/);
    rejects('ext_split_mandate', mandate({ mandate_id: 'mandate_4', member_id: 'stranger' }), /FOREIGN KEY/);
  });

  it('charges each member once per cycle; a debit always names a mandate', () => {
    insert('ext_split_mandate', mandate());
    insert('ext_split_request', request());
    rejects('ext_split_request', request({ idempotency_key: 'respelled' }), /UNIQUE/);
    rejects('ext_split_request', request({ idempotency_key: 'k2', cycle_id: '2026-12', method: 'DEBIT' }), /CHECK/);
    rejects('ext_split_request', request({ idempotency_key: 'k3', cycle_id: '2027-01', mandate_id: 'mandate_1' }), /CHECK/);
    insert('ext_split_request', request({ idempotency_key: 'k4', cycle_id: '2027-02', method: 'DEBIT', mandate_id: 'mandate_1' }));
    rejects('ext_split_request', request({ idempotency_key: 'k5', cycle_id: '2027-03', paid_minor: 1501 }), /CHECK/);
  });

  it('refuses zero weights and leaving before joining', () => {
    rejects('ext_split_member', { group_id: 'grp-1', member_id: 'x', weight: 0, joined_on: '2026-09-01', bank_customer: 1 }, /CHECK/);
    rejects('ext_split_member', { group_id: 'grp-1', member_id: 'y', weight: 1, joined_on: '2026-09-01', left_on: '2026-08-01', bank_customer: 0 }, /CHECK/);
  });
});

describe('cancellation difficulty', () => {
  it('stores no numbers or grade for suppressed merchants', () => {
    insert('ext_cancellation_difficulty', { merchant_id: 'tiny', flow_revision: 1, status: 'INSUFFICIENT_DATA', computed_at: T });
    rejects('ext_cancellation_difficulty', { merchant_id: 'leaky', flow_revision: 1, status: 'INSUFFICIENT_DATA', customers: 5, computed_at: T }, /CHECK/);
    rejects('ext_cancellation_difficulty', { merchant_id: 'graded', flow_revision: 1, status: 'INSUFFICIENT_DATA', grade: 'HARD', computed_at: T }, /CHECK/);
    const measured = { merchant_id: 'fitflow', flow_revision: 2, status: 'MEASURED', customers: 20, grade: 'HARD', median_steps: 7, p90_steps: 11, median_retention_screens: 3, median_seconds: 640, human_contact_bp: 1000, completion_bp: 8000, computed_at: T };
    insert('ext_cancellation_difficulty', measured);
    rejects('ext_cancellation_difficulty', { ...measured, merchant_id: 'over', completion_bp: 10001 }, /CHECK/);
    rejects('ext_cancellation_difficulty', { ...measured, merchant_id: 'ungraded', grade: null }, /CHECK/);
  });
});
