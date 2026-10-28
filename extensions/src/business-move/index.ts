import { checkGrant, sameScope, type ApprovalGrant, type GrantCheck, type Scope } from '../shared/authority.ts';
import { digestOf } from '../shared/digest.ts';
import { invariant } from '../shared/errors.ts';
import { assertCurrency, assertNonNegativeMinor, basisPointsOf } from '../shared/money.ts';
import { assertDate, assertInstant, compareDates, localDate, type Instant, type IsoDate } from '../shared/time.ts';

/**
 * Moves a subscription the customer pays personally onto their business: future billing goes
 * to the business card with invoices in the company's name, past months the business used are
 * repaid as a balanced transfer between the two ledgers, and the accountant gets a note.
 *
 * The note sorts charges into cases from a configurable, dated rule set. It never computes tax
 * owed and never says what is deductible; that is the accountant's call.
 */
export interface BusinessProfile {
  readonly scope: Scope;
  readonly legalName: string;
  /** Romanian CUI, digits only or with an `RO` prefix. */
  readonly taxId: string;
  readonly vatRegistered: boolean;
  readonly cardId: string;
}

export interface MovableSubscription {
  readonly scope: Scope;
  readonly subscriptionId: string;
  readonly merchantId: string;
  /** ISO 3166 alpha-2 of the supplier, from the merchant's invoice details. */
  readonly merchantCountry: string;
  /** App-store purchases are billed by the store; the merchant issues no invoice. */
  readonly channel: 'MERCHANT_DIRECT' | 'APP_STORE';
  readonly merchantSupportsBillingProfile: boolean;
}

export interface LedgerAccount {
  readonly accountId: string;
  readonly scope: Scope;
  readonly currency: string;
  readonly status: 'OPEN' | 'BLOCKED' | 'CLOSED';
}

export interface PastCharge {
  readonly chargeId: string;
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly postedOn: IsoDate;
  /** What the personal account actually paid, in its currency (after any conversion). */
  readonly amountMinor: number;
  readonly currency: string;
  readonly refunded: boolean;
  /** An issued invoice is final: the bank can file it but cannot change whose name is on it. */
  readonly invoice?: { readonly invoiceId: string; readonly issuedTo: 'PERSONAL_NAME' | 'BUSINESS_NAME' };
}

/** Dated and versioned so a charge is classified by the rules in force when it was posted. */
export interface VatRuleSet {
  readonly ruleSetId: string;
  readonly version: number;
  readonly effectiveFrom: IsoDate;
  readonly homeCountry: string;
  readonly euCountries: readonly string[];
}

export type VatCase =
  | 'DOMESTIC_SUPPLY'
  | 'EU_B2B_REVERSE_CHARGE_CANDIDATE'
  | 'EU_SUPPLY_BUYER_NOT_VAT_REGISTERED'
  | 'NON_EU_SUPPLY'
  | 'NO_MERCHANT_INVOICE'
  | 'NO_RULES_FOR_DATE';

export type VatFlag = 'NO_INVOICE_ON_FILE' | 'INVOICE_ISSUED_TO_PERSONAL_NAME' | 'PARTIAL_BUSINESS_USE';

export interface VatNoteLine {
  readonly chargeId: string;
  readonly postedOn: IsoDate;
  readonly vatCase: VatCase;
  readonly ruleSet?: { readonly ruleSetId: string; readonly version: number };
  readonly invoiceId?: string;
  readonly repaidMinor: number;
  readonly flags: readonly VatFlag[];
}

export interface VatNote {
  readonly disclaimer: 'INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE';
  readonly businessUseBp: number;
  readonly futureCase: VatCase;
  readonly lines: readonly VatNoteLine[];
}

export type FutureBilling =
  | { readonly kind: 'UPDATE_BILLING_PROFILE'; readonly invoiceName: string; readonly invoiceTaxId: string; readonly cardId: string }
  | { readonly kind: 'MANUAL_STEPS'; readonly invoiceName: string; readonly invoiceTaxId: string; readonly cardId: string }
  | { readonly kind: 'NOT_MOVABLE_APP_STORE' };

export type ExclusionReason = 'UNKNOWN_CHARGE' | 'NOT_THIS_SUBSCRIPTION' | 'OTHER_ACCOUNT' | 'REFUNDED' | 'ALREADY_REPAID' | 'FUTURE_DATED' | 'CURRENCY_MISMATCH' | 'ZERO_SHARE';

export interface Repayment {
  /** Keyed by charge, not by plan, so planning twice can never repay one month twice. */
  readonly idempotencyKey: string;
  readonly chargeId: string;
  readonly currency: string;
  readonly shareMinor: number;
  readonly postings: readonly [{ readonly accountId: string; readonly amountMinor: number }, { readonly accountId: string; readonly amountMinor: number }];
}

export type MoveWarning = 'PERSONAL_SHARE_ON_BUSINESS_CARD' | 'DIFFERENT_OWNERS';

export interface BusinessMovePlan {
  readonly planId: string;
  readonly manifestDigest: string;
  readonly personalScope: Scope;
  readonly businessScope: Scope;
  readonly subscriptionId: string;
  readonly merchantId: string;
  readonly businessUseBp: number;
  readonly future: FutureBilling;
  readonly repayments: readonly Repayment[];
  readonly repaymentTotalMinor: number;
  readonly excluded: readonly { readonly chargeId: string; readonly reason: ExclusionReason }[];
  readonly vatNote: VatNote;
  readonly warnings: readonly MoveWarning[];
}

const CUI_KEY = '753217532';

/** Validates a Romanian CUI check digit and returns the bare digits. */
export function normalizeCui(taxId: string): string {
  const digits = taxId.trim().toUpperCase().replace(/^RO/, '').trim();
  invariant(/^[1-9][0-9]{1,9}$/.test(digits), 'INVALID_TAX_ID', 'a CUI is 2 to 10 digits');
  const body = digits.slice(0, -1).padStart(9, '0');
  let total = 0;
  for (let i = 0; i < 9; i++) total += Number(body[i]) * Number(CUI_KEY[i]);
  const control = (total * 10) % 11;
  invariant((control === 10 ? 0 : control) === Number(digits.at(-1)), 'INVALID_TAX_ID', 'CUI check digit does not match');
  return digits;
}

export function ruleSetFor(rules: readonly VatRuleSet[], on: IsoDate): VatRuleSet | undefined {
  return rules
    .filter((r) => compareDates(r.effectiveFrom, on) <= 0)
    .sort((a, b) => compareDates(b.effectiveFrom, a.effectiveFrom) || b.version - a.version)[0];
}

function vatCaseFor(subscription: MovableSubscription, business: BusinessProfile, rules: VatRuleSet | undefined): VatCase {
  if (subscription.channel === 'APP_STORE') return 'NO_MERCHANT_INVOICE';
  if (rules === undefined) return 'NO_RULES_FOR_DATE';
  if (subscription.merchantCountry === rules.homeCountry) return 'DOMESTIC_SUPPLY';
  if (rules.euCountries.includes(subscription.merchantCountry)) return business.vatRegistered ? 'EU_B2B_REVERSE_CHARGE_CANDIDATE' : 'EU_SUPPLY_BUYER_NOT_VAT_REGISTERED';
  return 'NON_EU_SUPPLY';
}

export function repaymentKey(subscriptionId: string, chargeId: string): string {
  return `bizmove:${subscriptionId}:${chargeId}`;
}

export function planBusinessMove(input: {
  readonly subscription: MovableSubscription;
  readonly business: BusinessProfile;
  readonly personalAccount: LedgerAccount;
  readonly businessAccount: LedgerAccount;
  readonly charges: readonly PastCharge[];
  /** Months the customer says the business used; only these are repaid. */
  readonly selectedChargeIds: readonly string[];
  /** Business share of use, 1..10000 basis points; repayments round down. */
  readonly businessUseBp: number;
  readonly repaidKeys: ReadonlySet<string>;
  readonly rules: readonly VatRuleSet[];
  readonly now: Instant;
}): BusinessMovePlan {
  assertInstant(input.now, 'now');
  const { subscription, business, personalAccount, businessAccount } = input;
  invariant(subscription.scope.contextId === 'PERSONAL', 'WRONG_CONTEXT', 'the subscription must be personal');
  invariant(business.scope.contextId === 'BUSINESS', 'WRONG_CONTEXT', 'the target must be a business');
  invariant(sameScope(personalAccount.scope, subscription.scope), 'SCOPE_MISMATCH', 'personal account belongs to someone else');
  invariant(sameScope(businessAccount.scope, business.scope), 'SCOPE_MISMATCH', 'business account belongs to another business');
  invariant(personalAccount.status === 'OPEN' && businessAccount.status === 'OPEN', 'ACCOUNT_NOT_OPEN', 'both accounts must be open');
  invariant(Number.isInteger(input.businessUseBp) && input.businessUseBp >= 1 && input.businessUseBp <= 10_000, 'INVALID_BASIS_POINTS', 'business use must be 1..10000 bp');
  invariant(business.legalName.trim().length > 0, 'INVALID_NAME', 'the company needs a legal name');
  assertCurrency(personalAccount.currency);
  assertCurrency(businessAccount.currency);
  const cui = normalizeCui(business.taxId);
  const today = localDate(input.now);

  const byId = new Map(input.charges.map((c) => [c.chargeId, c]));
  const excluded: { chargeId: string; reason: ExclusionReason }[] = [];
  const repayments: Repayment[] = [];
  const lines: VatNoteLine[] = [];
  for (const chargeId of [...new Set(input.selectedChargeIds)].sort()) {
    const c = byId.get(chargeId);
    const reason: ExclusionReason | undefined =
      c === undefined ? 'UNKNOWN_CHARGE'
      : c.subscriptionId !== subscription.subscriptionId ? 'NOT_THIS_SUBSCRIPTION'
      : c.accountId !== personalAccount.accountId ? 'OTHER_ACCOUNT'
      : c.refunded ? 'REFUNDED'
      : input.repaidKeys.has(repaymentKey(subscription.subscriptionId, chargeId)) ? 'ALREADY_REPAID'
      : compareDates(c.postedOn, today) > 0 ? 'FUTURE_DATED'
      : c.currency !== personalAccount.currency || c.currency !== businessAccount.currency ? 'CURRENCY_MISMATCH'
      : undefined;
    if (reason !== undefined || c === undefined) {
      excluded.push({ chargeId, reason: reason ?? 'UNKNOWN_CHARGE' });
      continue;
    }
    assertDate(c.postedOn, 'postedOn');
    assertNonNegativeMinor(c.amountMinor);
    const share = basisPointsOf(c.amountMinor, input.businessUseBp);
    if (share === 0) {
      excluded.push({ chargeId, reason: 'ZERO_SHARE' });
      continue;
    }
    repayments.push({
      idempotencyKey: repaymentKey(subscription.subscriptionId, chargeId),
      chargeId,
      currency: c.currency,
      shareMinor: share,
      postings: [
        { accountId: businessAccount.accountId, amountMinor: -share },
        { accountId: personalAccount.accountId, amountMinor: share },
      ],
    });
    const rules = ruleSetFor(input.rules, c.postedOn);
    const flags: VatFlag[] = [];
    if (c.invoice === undefined && subscription.channel !== 'APP_STORE') flags.push('NO_INVOICE_ON_FILE');
    if (c.invoice?.issuedTo === 'PERSONAL_NAME') flags.push('INVOICE_ISSUED_TO_PERSONAL_NAME');
    if (input.businessUseBp < 10_000) flags.push('PARTIAL_BUSINESS_USE');
    lines.push({
      chargeId,
      postedOn: c.postedOn,
      vatCase: vatCaseFor(subscription, business, rules),
      ...(rules === undefined ? {} : { ruleSet: { ruleSetId: rules.ruleSetId, version: rules.version } }),
      ...(c.invoice === undefined ? {} : { invoiceId: c.invoice.invoiceId }),
      repaidMinor: share,
      flags,
    });
  }

  const invoiceTaxId = business.vatRegistered ? `RO${cui}` : cui;
  const future: FutureBilling =
    subscription.channel === 'APP_STORE' ? { kind: 'NOT_MOVABLE_APP_STORE' }
    : { kind: subscription.merchantSupportsBillingProfile ? 'UPDATE_BILLING_PROFILE' : 'MANUAL_STEPS', invoiceName: business.legalName.trim(), invoiceTaxId, cardId: business.cardId };
  const warnings: MoveWarning[] = [];
  if (input.businessUseBp < 10_000 && future.kind !== 'NOT_MOVABLE_APP_STORE') warnings.push('PERSONAL_SHARE_ON_BUSINESS_CARD');
  if (subscription.scope.ownerId !== business.scope.ownerId) warnings.push('DIFFERENT_OWNERS');

  const body = {
    kind: 'BUSINESS_MOVE',
    personalScope: subscription.scope,
    businessScope: business.scope,
    subscriptionId: subscription.subscriptionId,
    merchantId: subscription.merchantId,
    businessUseBp: input.businessUseBp,
    future,
    repayments,
    repaymentTotalMinor: repayments.reduce((t, r) => t + r.shareMinor, 0),
    excluded,
    vatNote: { disclaimer: 'INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE' as const, businessUseBp: input.businessUseBp, futureCase: vatCaseFor(subscription, business, ruleSetFor(input.rules, today)), lines },
    warnings,
  };
  const manifestDigest = digestOf(body);
  return { planId: `bizmove_${manifestDigest.slice(0, 24)}`, manifestDigest, ...body };
}

export type MoveEffect =
  | { readonly type: 'UPDATE_BILLING_PROFILE'; readonly idempotencyKey: string; readonly subscriptionId: string; readonly merchantId: string; readonly invoiceName: string; readonly invoiceTaxId: string; readonly cardId: string }
  | { readonly type: 'SHOW_MANUAL_STEPS'; readonly subscriptionId: string; readonly invoiceName: string; readonly invoiceTaxId: string; readonly cardId: string }
  | { readonly type: 'POST_TRANSFER'; readonly repayment: Repayment }
  | { readonly type: 'FILE_VAT_NOTE'; readonly idempotencyKey: string; readonly businessScope: Scope; readonly note: VatNote };

type GrantRejection = Extract<GrantCheck, { ok: false }>['reason'];

export type MoveApproval =
  | { readonly ok: true; readonly effects: readonly MoveEffect[] }
  | { readonly ok: false; readonly reason: 'PERSONAL_GRANT_INVALID' | 'BUSINESS_GRANT_INVALID'; readonly detail: GrantRejection }
  | { readonly ok: false; readonly reason: 'SAME_GRANT_TWICE' | 'INSUFFICIENT_FUNDS' };

/**
 * Both sides consent separately: the personal owner for their subscription and the business
 * (possibly a different person) for paying. One grant can never stand in for both.
 */
export function approveBusinessMove(plan: BusinessMovePlan, grants: { readonly personal: ApprovalGrant; readonly business: ApprovalGrant }, businessAvailableMinor: number, now: Instant): MoveApproval {
  if (grants.personal.grantId === grants.business.grantId) return { ok: false, reason: 'SAME_GRANT_TWICE' };
  const p = checkGrant(grants.personal, { scope: plan.personalScope, manifestDigest: plan.manifestDigest }, now);
  if (!p.ok) return { ok: false, reason: 'PERSONAL_GRANT_INVALID', detail: p.reason };
  const b = checkGrant(grants.business, { scope: plan.businessScope, manifestDigest: plan.manifestDigest }, now);
  if (!b.ok) return { ok: false, reason: 'BUSINESS_GRANT_INVALID', detail: b.reason };
  assertNonNegativeMinor(businessAvailableMinor, 'businessAvailableMinor');
  if (businessAvailableMinor < plan.repaymentTotalMinor) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };

  const effects: MoveEffect[] = [];
  const f = plan.future;
  if (f.kind === 'UPDATE_BILLING_PROFILE') {
    effects.push({ type: 'UPDATE_BILLING_PROFILE', idempotencyKey: `${plan.planId}:billing`, subscriptionId: plan.subscriptionId, merchantId: plan.merchantId, invoiceName: f.invoiceName, invoiceTaxId: f.invoiceTaxId, cardId: f.cardId });
  } else if (f.kind === 'MANUAL_STEPS') {
    effects.push({ type: 'SHOW_MANUAL_STEPS', subscriptionId: plan.subscriptionId, invoiceName: f.invoiceName, invoiceTaxId: f.invoiceTaxId, cardId: f.cardId });
  }
  for (const repayment of plan.repayments) effects.push({ type: 'POST_TRANSFER', repayment });
  effects.push({ type: 'FILE_VAT_NOTE', idempotencyKey: `${plan.planId}:vatnote`, businessScope: plan.businessScope, note: plan.vatNote });
  return { ok: true, effects };
}
