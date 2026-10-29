import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../../db/connection";
import { HttpError } from "../../auth/session";
import { sha256Hex } from "../../canonical";
import { nowIso, nowMs } from "../../clock";
import { balanceOf, postCardOrTransfer, postInternalTransfer } from "../../bank/ledger";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { toLocalIso } from "../../../shared/time";
import { display, fmtDate, money, openActionFor, spec, type Analysis, type Block, type CapEnv, type Candidate, type CapabilityDef } from "../../capabilities/core";
import type { ExtActionContext, ExtensionModule } from "../types";
import {
  approveBusinessMove,
  normalizeCui,
  planBusinessMove,
  type BusinessMovePlan,
  type PastCharge,
  type VatCase,
  type VatFlag,
  type VatRuleSet,
} from "../../../../extensions/src/business-move/index.ts";

// E7: a cost Laziz pays from the household that the business actually uses. Moving money between his two contexts
// needs both sides: the household approves one exact plan (no money moves), then the business approves repaying
// exactly that plan from its own account. The business step re-plans from bank state and refuses if anything changed.

const CONSENT_DAYS = 7;
const MAX_CHARGES = 24;
const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];

const VAT_CASE: Record<VatCase, string> = {
  DOMESTIC_SUPPLY: "Romanian supplier",
  EU_B2B_REVERSE_CHARGE_CANDIDATE: "EU supplier to a VAT-registered company: possible reverse charge",
  EU_SUPPLY_BUYER_NOT_VAT_REGISTERED: "EU supplier, company not VAT registered",
  NON_EU_SUPPLY: "Supplier outside the EU",
  NO_MERCHANT_INVOICE: "Billed by an app store, no supplier invoice",
  NO_RULES_FOR_DATE: "No rule set on file for that date",
};
const VAT_FLAG: Record<VatFlag, string> = {
  NO_INVOICE_ON_FILE: "no invoice on file",
  INVOICE_ISSUED_TO_PERSONAL_NAME: "invoice in your personal name",
  PARTIAL_BUSINESS_USE: "partial business use",
};
export const VAT_DISCLAIMER = "Information for your accountant, not tax advice. NextMove sorts each charge with a dated rule set; it does not calculate VAT or decide what is deductible.";

/* ------------------------------------------------------------------------------------------- state */

type Inputs = { chargeIds: string[]; businessUseBp: number };

const ctxRow = (db: DatabaseSync, t: string, id: string) => one<any>(db, "SELECT * FROM contexts WHERE id=? AND tenant_id=?", id, t);
const siblingCtx = (db: DatabaseSync, t: string, ctxId: string, kind: "PERSONAL" | "BUSINESS") =>
  one<any>(db, "SELECT c.* FROM contexts c JOIN contexts me ON me.user_id=c.user_id AND me.tenant_id=c.tenant_id WHERE me.id=? AND c.tenant_id=? AND c.kind=? ORDER BY c.ordinal LIMIT 1", ctxId, t, kind);
const subFor = (db: DatabaseSync, t: string, hhCtx: string) => one<any>(db, "SELECT * FROM ext_bizmove_subscription WHERE tenant_id=? AND context_id=? ORDER BY id LIMIT 1", t, hhCtx);
const profileFor = (db: DatabaseSync, t: string, bizCtx: string) => one<any>(db, "SELECT * FROM ext_business_profile WHERE tenant_id=? AND context_id=?", t, bizCtx);
const chargesFor = (db: DatabaseSync, t: string, sub: any) => all<any>(db, "SELECT * FROM ext_bizmove_charge WHERE tenant_id=? AND context_id=? AND subscription_id=? ORDER BY posted_on", t, sub.context_id, sub.id);
const repaidFor = (db: DatabaseSync, t: string, subId: string) => all<any>(db, "SELECT * FROM ext_business_repayment WHERE tenant_id=? AND subscription_id=?", t, subId);
const monthKey = (postedOn: string) => `m${postedOn.slice(0, 7).replace("-", "_")}`;
const monthLabel = (postedOn: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${postedOn}T12:00:00Z`));

/** The pure planner over current bank state. Throws a DomainError on invalid input; callers fail closed. */
function planFor(db: DatabaseSync, t: string, sub: any, profile: any, inputs: Inputs, now: string): BusinessMovePlan {
  const hh = ctxRow(db, t, sub.context_id);
  const biz = ctxRow(db, t, profile.context_id);
  if (!hh || !biz || hh.user_id !== biz.user_id || hh.kind !== "PERSONAL" || biz.kind !== "BUSINESS") throw new Error("contexts do not belong to one customer");
  const hhAcct = one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=? AND context_id=?", sub.account_id, t, hh.id);
  const bizAcct = one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=? AND context_id=?", profile.account_id, t, biz.id);
  if (!hhAcct || !bizAcct) throw new Error("account missing");
  const personal = { ownerId: hh.user_id, contextId: "PERSONAL" as const };
  const business = { ownerId: biz.user_id, contextId: "BUSINESS" as const };
  const rules: VatRuleSet[] = all<any>(db, "SELECT * FROM ext_vat_rule_set WHERE tenant_id=? ORDER BY effective_from", t).map((r) => ({ ruleSetId: r.rule_set_id, version: r.version, effectiveFrom: r.effective_from, homeCountry: r.home_country, euCountries: json<string[]>(r.eu_countries_json, []) }));
  const charges: PastCharge[] = chargesFor(db, t, sub).map((c) => ({
    chargeId: c.id, subscriptionId: c.subscription_id, accountId: c.account_id, postedOn: c.posted_on, amountMinor: c.amount_minor, currency: c.currency, refunded: Boolean(c.refunded),
    ...(c.invoice_id ? { invoice: { invoiceId: c.invoice_id, issuedTo: c.invoice_issued_to === "BUSINESS_NAME" ? ("BUSINESS_NAME" as const) : ("PERSONAL_NAME" as const) } } : {}),
  }));
  return planBusinessMove({
    subscription: { scope: personal, subscriptionId: sub.id, merchantId: sub.merchant_id, merchantCountry: sub.merchant_country, channel: sub.channel === "APP_STORE" ? "APP_STORE" : "MERCHANT_DIRECT", merchantSupportsBillingProfile: Boolean(sub.supports_billing_profile) },
    business: { scope: business, legalName: profile.legal_name, taxId: profile.tax_id, vatRegistered: Boolean(profile.vat_registered), cardId: profile.card_id },
    personalAccount: { accountId: hhAcct.id, scope: personal, currency: hhAcct.currency, status: "OPEN" },
    businessAccount: { accountId: bizAcct.id, scope: business, currency: bizAcct.currency, status: "OPEN" },
    charges,
    selectedChargeIds: inputs.chargeIds,
    businessUseBp: inputs.businessUseBp,
    repaidKeys: new Set(repaidFor(db, t, sub.id).map((r) => r.idempotency_key as string)),
    rules,
    now,
  });
}

function validInputs(p: any): Inputs | null {
  const ids = p?.chargeIds;
  const bp = p?.businessUseBp;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_CHARGES || !ids.every((x) => typeof x === "string" && x.length <= 120)) return null;
  if (!Number.isInteger(bp) || bp < 1 || bp > 10_000) return null;
  return { chargeIds: [...ids], businessUseBp: bp };
}

const reference = (action: any, prefix: string) => `${prefix}-${sha256Hex(String(action.logical_key)).slice(0, 8).toUpperCase()}`;
const caseText = (l: { vatCase: VatCase; flags: readonly VatFlag[] }) => [VAT_CASE[l.vatCase], ...l.flags.map((f) => VAT_FLAG[f])].join("; ");
const futureText = (plan: BusinessMovePlan, merchant: string) =>
  plan.future.kind === "NOT_MOVABLE_APP_STORE"
    ? `${merchant} is billed through an app store, so future months cannot be moved to the company.`
    : plan.future.kind === "UPDATE_BILLING_PROFILE"
      ? `Future months: ${merchant} can bill ${plan.future.invoiceName} (${plan.future.invoiceTaxId}) on the business card.`
      : `Future months are a manual step: in ${merchant}'s own billing settings, set the invoice name to ${plan.future.invoiceName}, tax ID ${plan.future.invoiceTaxId}, and pay with the business card ${plan.future.cardId}. The bank cannot change a provider's billing profile for you.`;

function vatBlocks(plan: BusinessMovePlan, byId: Map<string, any>): Block[] {
  return [
    {
      kind: "table",
      title: "Note for your accountant",
      columns: ["Charge", "Business share", "Case"],
      rows: plan.vatNote.lines.map((l) => ({ cells: [`${monthLabel(l.postedOn)}${l.invoiceId ? ` · ${l.invoiceId}` : ""}`, money(l.repaidMinor), caseText(l)] })),
      note: `${VAT_DISCLAIMER} Rule set: ${plan.vatNote.lines[0]?.ruleSet ? `${plan.vatNote.lines[0].ruleSet.ruleSetId} v${plan.vatNote.lines[0].ruleSet.version}` : "none"}. Future months: ${VAT_CASE[plan.vatNote.futureCase]}.`,
    },
    ...(plan.excluded.length ? [{ kind: "note" as const, tone: "info" as const, text: `Not included: ${plan.excluded.map((e) => `${byId.get(e.chargeId) ? monthLabel(byId.get(e.chargeId).posted_on) : "unknown charge"} (${e.reason.toLowerCase().replace(/_/g, " ")})`).join(", ")}.` }] : []),
  ];
}

/* ------------------------------------------------------------------------------- household side */

async function analyzeHousehold(env: CapEnv): Promise<Analysis> {
  const base = { capability: "E7H", title: "Move a business cost off the household", contextId: env.contextId, evidence: ["BANK_LEDGER_POSTING", "DETERMINISTIC_CALCULATION"] as Analysis["evidence"], inputs: [], candidates: [], numbers: {} };
  const sub = subFor(env.db, env.tenantId, env.contextId);
  const bizCtx = siblingCtx(env.db, env.tenantId, env.contextId, "BUSINESS");
  const profile = bizCtx ? profileFor(env.db, env.tenantId, bizCtx.id) : null;
  if (!sub || !profile) return { ...base, headline: "No personally paid business costs found", summary: "Nothing in this household looks like a cost your business uses.", blocks: [] };

  const charges = chargesFor(env.db, env.tenantId, sub);
  const repaid = new Set(repaidFor(env.db, env.tenantId, sub.id).map((r) => r.charge_id));
  const open = charges.filter((c) => !c.refunded && !repaid.has(c.id));
  const pct = Math.round(Math.min(100, Math.max(1, Number(env.inputs.businessUse ?? 100) || 100)));
  const chosen = open.filter((c) => env.inputs[monthKey(c.posted_on)] !== false).map((c) => c.id);
  const byId = new Map(charges.map((c) => [c.id, c]));
  const inputs: Analysis["inputs"] = [
    { key: "businessUse", label: "Business share of use", type: "number", value: pct, min: 1, max: 100, suffix: "%", help: "Repayments round down to the ban." },
    ...open.map((c) => ({ key: monthKey(c.posted_on), label: `${monthLabel(c.posted_on)} (${money(c.amount_minor)})`, type: "toggle" as const, value: chosen.includes(c.id), help: "The business used it this month" })),
  ];
  const table: Block = {
    kind: "table",
    title: `${sub.merchant_name} charges on the household account`,
    columns: ["Month", "Paid", "Status"],
    rows: charges.map((c) => ({ cells: [monthLabel(c.posted_on), money(c.amount_minor), c.refunded ? "Refunded by the provider" : repaid.has(c.id) ? "Repaid by the business" : chosen.includes(c.id) ? "In this plan" : "Not selected"], tone: c.refunded || repaid.has(c.id) ? ("neutral" as const) : undefined })),
  };
  const labs = open.length
    ? [{ action: "merchant_refund", label: `${sub.merchant_name} refunds the ${monthLabel(open[open.length - 1].posted_on)} charge`, endpoint: "/labs/ext", body: { module: "business-move", action: "merchant_refund", body: { month: open[open.length - 1].posted_on.slice(0, 7) } } }]
    : [];
  if (!chosen.length) return { ...base, inputs, labs, headline: "Nothing left to move", summary: `Every ${sub.merchant_name} charge is refunded, repaid or not selected.`, blocks: [table] };

  let plan: BusinessMovePlan;
  try {
    plan = planFor(env.db, env.tenantId, sub, profile, { chargeIds: chosen, businessUseBp: pct * 100 }, env.now);
  } catch {
    return { ...base, inputs, labs, headline: "This plan cannot be prepared", summary: "The bank records needed for it are incomplete.", blocks: [table] };
  }
  const consent = one<any>(env.db, "SELECT * FROM ext_business_move WHERE tenant_id=? AND household_context_id=? AND plan_id=?", env.tenantId, env.contextId, plan.planId);
  const busy = openActionFor(env, sub.id, "EXT_BIZMOVE_CONSENT");
  const candidates: Candidate[] = plan.repayments.length
    ? [{
        key: "bizmove-consent",
        defaultSelected: true,
        available: !consent && !busy,
        unavailableReason: consent ? "The household already approved this exact plan" : busy ? "This approval is already in progress" : undefined,
        spec: spec({
          operation: "EXT_BIZMOVE_CONSENT",
          route: "BANK_INTERNAL",
          capability: "E7H",
          merchantId: sub.merchant_id,
          merchantName: sub.merchant_name,
          subjectRef: sub.id,
          params: { planId: plan.planId, manifestDigest: plan.manifestDigest, subscriptionId: sub.id, chargeIds: [...chosen].sort(), businessUseBp: plan.businessUseBp, repaymentTotalMinor: plan.repaymentTotalMinor, toAccountId: sub.account_id },
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: 0 },
          consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: "Records the household's approval of this exact plan for 7 days", remainingObligations: `${bizCtx!.name} must approve separately before anything is paid` },
          display: display(
            `Household side: let ${profile.legal_name} repay ${money(plan.repaymentTotalMinor)}`,
            `Approves this exact ${sub.merchant_name} plan from the household. No money moves from this account.`,
            [
              { label: "Months", value: plan.repayments.map((r) => monthLabel(byId.get(r.chargeId).posted_on)).join(", ") },
              { label: "Business share", value: `${plan.businessUseBp / 100}%` },
              { label: "Household receives", value: money(plan.repaymentTotalMinor) },
              { label: "Then", value: `Switch to ${bizCtx!.name} and approve the business side` },
            ],
            "If the charges change before the business approves (a refund, a different selection), the business side is refused and this plan has to be approved again.",
            "Approve household side",
          ),
        }),
      }]
    : [];
  const blocks: Block[] = [
    { kind: "metrics", items: [{ label: "Months selected", value: String(plan.repayments.length) }, { label: "Business share", value: `${pct}%` }, { label: "Business repays", value: money(plan.repaymentTotalMinor), tone: "good" }] },
    table,
    ...(consent ? [{ kind: "status" as const, title: "Household side", state: consent.status === "COMPLETED" ? "Repaid" : "Approved", detail: consent.status === "COMPLETED" ? `Repaid ${money(consent.repaid_minor)}.` : `Approved until ${fmtDate(consent.consent_expires_at)}. Switch to ${bizCtx!.name} to approve the repayment.` }] : []),
    ...vatBlocks(plan, byId),
    { kind: "note", tone: "info", text: futureText(plan, sub.merchant_name) },
  ];
  return {
    ...base,
    headline: `${profile.legal_name} could repay the household ${money(plan.repaymentTotalMinor)} for ${sub.merchant_name}`,
    summary: `${sub.merchant_name} is paid from the household, but the business uses it. Each side approves separately; the money moves only from the business account.`,
    inputs,
    candidates,
    blocks,
    labs,
    numbers: { repaymentTotalMinor: plan.repaymentTotalMinor, months: plan.repayments.length, businessUseBp: plan.businessUseBp },
  };
}

/* -------------------------------------------------------------------------------- business side */

async function analyzeBusiness(env: CapEnv): Promise<Analysis> {
  const base = { capability: "E7", title: "Repay the household for business costs", contextId: env.contextId, evidence: ["BANK_LEDGER_POSTING", "DETERMINISTIC_CALCULATION"] as Analysis["evidence"], inputs: [], candidates: [], numbers: {} };
  const profile = profileFor(env.db, env.tenantId, env.contextId);
  const hhCtx = siblingCtx(env.db, env.tenantId, env.contextId, "PERSONAL");
  const sub = hhCtx ? subFor(env.db, env.tenantId, hhCtx.id) : null;
  if (!profile || !hhCtx || !sub) return { ...base, headline: "No household costs to repay", summary: "Nothing paid from the household looks like a business cost.", blocks: [] };
  const consent = one<any>(env.db, "SELECT * FROM ext_business_move WHERE tenant_id=? AND business_context_id=? AND subscription_id=? ORDER BY household_approved_at DESC, rowid DESC LIMIT 1", env.tenantId, env.contextId, sub.id);
  const charges = chargesFor(env.db, env.tenantId, sub);
  const byId = new Map(charges.map((c) => [c.id, c]));
  const facts: Block = { kind: "facts", title: "Invoice details for future months", items: [{ label: "Company", value: profile.legal_name, provenance: "BANK" }, { label: "Tax ID (synthetic demo CUI)", value: `RO${normalizeCui(profile.tax_id)}`, provenance: "BANK" }, { label: "Business card", value: profile.card_id, provenance: "BANK" }] };

  if (!consent || consent.status === "COMPLETED") {
    const done = consent?.status === "COMPLETED";
    return {
      ...base,
      headline: done ? `Repaid the household ${money(consent.repaid_minor)} for ${sub.merchant_name}` : `Waiting for the household to approve its side`,
      summary: `Open ${hhCtx.name} → "Move a business cost off the household" to choose the months and approve. The business side appears here afterwards.`,
      blocks: [
        ...(done ? [{ kind: "status" as const, title: "Last repayment", state: "Repaid", detail: `${money(consent.repaid_minor)} on ${fmtDate(consent.completed_at)}.` }] : []),
        { kind: "note", tone: "info", text: "Money between the household and the business moves only after both contexts approve the same exact plan." },
        facts,
      ],
    };
  }

  const inputs = json<Inputs>(consent.inputs_json, { chargeIds: [], businessUseBp: 0 });
  let plan: BusinessMovePlan | null = null;
  try {
    plan = planFor(env.db, env.tenantId, sub, profile, inputs, env.now);
  } catch {
    plan = null;
  }
  const expired = Date.parse(consent.consent_expires_at) <= env.nowMs;
  const changed = !plan || plan.planId !== consent.plan_id;
  const bizBal = balanceOf(env.db, profile.account_id);
  const reserve = ctxRow(env.db, env.tenantId, env.contextId)?.reserve_floor_minor ?? 0;
  const available = Math.max(0, bizBal - reserve);
  const busy = openActionFor(env, sub.id, "EXT_BIZMOVE_REPAY");
  const total = plan?.repaymentTotalMinor ?? 0;
  const reason = changed ? "The charges changed after the household approved. Ask the household to approve the new plan." : expired ? "The household's approval expired. Ask the household to approve again." : total > available ? "The business would go below its reserve" : busy ? "This repayment is already in progress" : undefined;
  const candidates: Candidate[] = plan && plan.repayments.length
    ? [{
        key: "bizmove-repay",
        defaultSelected: true,
        available: !reason,
        unavailableReason: reason,
        spec: spec({
          operation: "EXT_BIZMOVE_REPAY",
          route: "BANK_INTERNAL",
          capability: "E7",
          merchantId: sub.merchant_id,
          merchantName: sub.merchant_name,
          subjectRef: sub.id,
          params: {
            planId: plan.planId, manifestDigest: plan.manifestDigest, subscriptionId: sub.id, householdActionId: consent.household_action_id,
            fromAccountId: profile.account_id, toAccountId: sub.account_id, totalMinor: plan.repaymentTotalMinor,
            repayments: plan.repayments.map((r) => ({ chargeId: r.chargeId, idempotencyKey: r.idempotencyKey, amountMinor: r.shareMinor })),
          },
          money: { currency: "RON", immediateDebitMinor: plan.repaymentTotalMinor, maxDebitMinor: plan.repaymentTotalMinor, feesMinor: 0, forecastChangeMinor: 0 },
          consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: "Files the accountant note with the repayment", remainingObligations: plan.future.kind === "MANUAL_STEPS" ? "Moving future months to the business card is a manual step in the provider's settings" : null },
          display: display(
            `Business side: repay the household ${money(plan.repaymentTotalMinor)}`,
            `${profile.legal_name} pays back the business share of ${sub.merchant_name}, as approved by the household.`,
            [
              { label: "From", value: `Business account · ${money(bizBal)} → ${money(bizBal - plan.repaymentTotalMinor)}` },
              { label: "To", value: `${hhCtx.name} · household account` },
              ...plan.repayments.map((r) => ({ label: monthLabel(byId.get(r.chargeId)?.posted_on ?? ""), value: money(r.shareMinor) })),
              { label: "Accountant note", value: "Filed with the repayment; not tax advice" },
            ],
            "One transfer per month, between your own accounts. Refused without moving money if the charges changed after the household approved.",
            "Approve repayment",
          ),
        }),
      }]
    : [];
  return {
    ...base,
    headline: changed ? "The plan changed after the household approved" : `Repay the household ${money(total)} for ${sub.merchant_name}`,
    summary: `Household side approved on ${fmtDate(consent.household_approved_at)}. The business approves the repayment here; the money leaves only the business account.`,
    candidates,
    blocks: [
      { kind: "metrics", items: [{ label: "Repayment", value: money(total), tone: changed ? "warn" : "good" }, { label: "Business account", value: money(bizBal) }, { label: "Above reserve", value: money(available) }] },
      { kind: "conditions", title: "Before the business pays", items: [
        { label: "Household approved this exact plan", state: changed ? "unmet" : "met", detail: changed ? "Charges changed since (for example a refund)" : `Plan ${consent.plan_id.slice(0, 16)}…` },
        { label: "Household approval still valid", state: expired ? "unmet" : "met", detail: `Until ${fmtDate(consent.consent_expires_at)}` },
        { label: "Business stays above its reserve", state: total <= available ? "met" : "unmet", detail: `${money(reserve)} reserve` },
      ] },
      ...(plan ? vatBlocks(plan, byId) : []),
      ...(plan ? [{ kind: "note" as const, tone: "info" as const, text: futureText(plan, sub.merchant_name) }] : []),
      facts,
    ],
    numbers: { repaymentTotalMinor: total, availableMinor: available },
  };
}

/* ----------------------------------------------------------------------------------- operations */

function settle(db: DatabaseSync, c: ExtActionContext, status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) {
  recordSettled(db, c.action.id, c.attemptId, status, { reason });
}

/** Household approval of one exact plan. Moves no money; the business side needs it before it can pay. */
function runConsent(c: ExtActionContext) {
  const { db, action } = c;
  const t = action.tenant_id;
  tx(db, () => {
    const p = c.spec.params as any;
    const inputs = validInputs(p);
    const sub = typeof p?.subscriptionId === "string" ? one<any>(db, "SELECT * FROM ext_bizmove_subscription WHERE id=? AND tenant_id=? AND context_id=?", p.subscriptionId, t, action.context_id) : null;
    if (!inputs || !sub) return settle(db, c, "REFUSED", "This plan does not match a household cost here; nothing was recorded");
    const bizCtx = siblingCtx(db, t, action.context_id, "BUSINESS");
    const profile = bizCtx ? profileFor(db, t, bizCtx.id) : null;
    if (!profile) return settle(db, c, "BLOCKED", "No business profile to repay from; nothing was recorded");
    const now = nowIso(db, t);
    let plan: BusinessMovePlan;
    try {
      plan = planFor(db, t, sub, profile, inputs, now);
    } catch {
      return settle(db, c, "REFUSED", "The plan could not be rebuilt from bank records; nothing was recorded");
    }
    if (plan.planId !== p.planId || plan.manifestDigest !== p.manifestDigest || plan.repaymentTotalMinor !== p.repaymentTotalMinor) return settle(db, c, "REFUSED", "The charges changed after you approved (for example a refund); nothing was recorded. Review the new plan.");
    if (!plan.repayments.length) return settle(db, c, "NO_CHANGE", "Nothing left to repay");
    const grant = one<any>(db, "SELECT * FROM grants WHERE action_id=? AND tenant_id=? AND context_id=?", action.id, t, action.context_id);
    if (!grant) return settle(db, c, "BLOCKED", "No approval on record for this step");
    const expires = toLocalIso(nowMs(db, t) + CONSENT_DAYS * 86_400_000);
    run(
      db,
      `INSERT INTO ext_business_move(plan_id, tenant_id, household_context_id, business_context_id, subscription_id, manifest_digest, inputs_json, status, household_action_id, household_grant_id, household_approved_at, consent_expires_at)
       VALUES (?,?,?,?,?,?,?, 'HOUSEHOLD_APPROVED', ?,?,?,?)
       ON CONFLICT(tenant_id, plan_id) DO UPDATE SET household_action_id=excluded.household_action_id, household_grant_id=excluded.household_grant_id,
         household_approved_at=excluded.household_approved_at, consent_expires_at=excluded.consent_expires_at
       WHERE ext_business_move.status='HOUSEHOLD_APPROVED'`,
      plan.planId, t, action.context_id, profile.context_id, sub.id, plan.manifestDigest, JSON.stringify(inputs), action.id, grant.id, now, expires,
    );
    recordConfirmed(db, action.id, c.attemptId, {
      issuer: "nextmove-bank", reference: reference(action, "NMH"), effectiveAt: now, accessUntil: null, termsRevision: null,
      details: { planId: plan.planId, householdApproved: true, repaymentTotalMinor: plan.repaymentTotalMinor, consentExpiresAt: expires, moneyMoved: 0 },
      channel: "BANK", verification: { method: "bank_record", checks: ["plan rebuilt from bank records", "plan id and digest match the approval", "no money moved"] }, evidence: "BANK_RECORD",
    });
  });
}

/** Business approval: repays exactly the plan the household approved, only from the business account. */
function runRepay(c: ExtActionContext) {
  const { db, action } = c;
  const t = action.tenant_id;
  tx(db, () => {
    const p = c.spec.params as any;
    if (typeof p?.planId !== "string" || !Array.isArray(p.repayments) || !Number.isInteger(p.totalMinor)) return settle(db, c, "REFUSED", "Malformed repayment; nothing was paid");
    const consent = one<any>(db, "SELECT * FROM ext_business_move WHERE tenant_id=? AND plan_id=? AND business_context_id=?", t, p.planId, action.context_id);
    if (!consent) return settle(db, c, "REFUSED", "The household has not approved this plan; nothing was paid");
    if (consent.status === "COMPLETED") return settle(db, c, "NO_CHANGE", "This plan was already repaid; nothing was paid again");
    const now = nowIso(db, t);
    if (Date.parse(consent.consent_expires_at) <= nowMs(db, t)) return settle(db, c, "REFUSED", "The household's approval expired; nothing was paid");
    const sub = one<any>(db, "SELECT * FROM ext_bizmove_subscription WHERE id=? AND tenant_id=? AND context_id=?", consent.subscription_id, t, consent.household_context_id);
    const profile = profileFor(db, t, action.context_id);
    if (!sub || !profile || p.fromAccountId !== profile.account_id || p.toAccountId !== sub.account_id || p.subscriptionId !== sub.id) return settle(db, c, "REFUSED", "Accounts do not match the approved plan; nothing was paid");
    const hhAction = one<any>(db, "SELECT * FROM proposal_actions WHERE id=? AND tenant_id=? AND context_id=? AND status='CONFIRMED'", consent.household_action_id, t, consent.household_context_id);
    const hhGrant = one<any>(db, "SELECT * FROM grants WHERE id=? AND action_id=? AND tenant_id=? AND context_id=?", consent.household_grant_id, consent.household_action_id, t, consent.household_context_id);
    const grant = one<any>(db, "SELECT * FROM grants WHERE action_id=? AND tenant_id=? AND context_id=?", action.id, t, action.context_id);
    if (!hhAction || !hhGrant || !grant || p.householdActionId !== consent.household_action_id) return settle(db, c, "REFUSED", "The household approval on record does not match; nothing was paid");

    let plan: BusinessMovePlan;
    try {
      plan = planFor(db, t, sub, profile, json<Inputs>(consent.inputs_json, { chargeIds: [], businessUseBp: 0 }), now);
    } catch {
      return settle(db, c, "REFUSED", "The plan could not be rebuilt from bank records; nothing was paid");
    }
    if (plan.planId !== p.planId || plan.planId !== consent.plan_id || plan.manifestDigest !== p.manifestDigest) return settle(db, c, "REFUSED", "The charges changed after approval (for example a refund); nothing was paid. Both sides need to approve the new plan.");
    const approved = new Map((p.repayments as any[]).map((r) => [r?.idempotencyKey, r?.amountMinor]));
    if (plan.repayments.length !== approved.size || plan.repayments.some((r) => approved.get(r.idempotencyKey) !== r.shareMinor) || plan.repaymentTotalMinor !== p.totalMinor) return settle(db, c, "REFUSED", "Amounts differ from the approved plan; nothing was paid");
    if (plan.repaymentTotalMinor > c.spec.money.maxDebitMinor || plan.repaymentTotalMinor > (grant.max_debit_minor ?? 0)) return settle(db, c, "REFUSED", "The repayment is above the approved amount; nothing was paid");

    const owner = ctxRow(db, t, consent.household_context_id)?.user_id;
    if (!owner) return settle(db, c, "REFUSED", "The household context is missing; nothing was paid");
    const reserve = ctxRow(db, t, action.context_id)?.reserve_floor_minor ?? 0;
    const available = Math.max(0, balanceOf(db, profile.account_id) - reserve);
    const decision = approveBusinessMove(
      plan,
      {
        personal: { ownerId: owner, contextId: "PERSONAL", grantId: hhGrant.id, manifestDigest: consent.manifest_digest, issuedAt: hhGrant.issued_at, expiresAt: consent.consent_expires_at },
        business: { ownerId: grant.actor_user_id, contextId: "BUSINESS", grantId: grant.id, manifestDigest: p.manifestDigest, issuedAt: grant.issued_at, expiresAt: grant.expires_at },
      },
      available,
      now,
    );
    if (!decision.ok) return settle(db, c, "REFUSED", decision.reason === "INSUFFICIENT_FUNDS" ? "The business would go below its reserve; nothing was paid" : `Approvals do not cover this plan (${decision.reason}); nothing was paid`);

    const ref = reference(action, "NMB");
    const transfers: { chargeId: string; amountMinor: number; entryId: string }[] = [];
    let vat: unknown = null;
    let future: unknown = null;
    for (const e of decision.effects) {
      if (e.type === "POST_TRANSFER") {
        const r = e.repayment;
        const charge = one<any>(db, "SELECT posted_on FROM ext_bizmove_charge WHERE id=? AND tenant_id=?", r.chargeId, t);
        const { entryId } = postInternalTransfer(db, { tenantId: t, sourceEventId: `${t}:${r.idempotencyKey}`, fromAccountId: profile.account_id, toAccountId: sub.account_id, amountMinor: r.shareMinor, description: `${sub.merchant_name} ${monthLabel(charge?.posted_on ?? "")}: business share repaid`, bookedAt: now, reference: ref });
        run(db, "INSERT INTO ext_business_repayment(idempotency_key, tenant_id, subscription_id, charge_id, plan_id, amount_minor, ledger_entry_id, created_at) VALUES (?,?,?,?,?,?,?,?)", r.idempotencyKey, t, sub.id, r.chargeId, plan.planId, r.shareMinor, entryId, now);
        transfers.push({ chargeId: r.chargeId, amountMinor: r.shareMinor, entryId });
      } else if (e.type === "FILE_VAT_NOTE") vat = e.note;
      else if (e.type === "SHOW_MANUAL_STEPS" || e.type === "UPDATE_BILLING_PROFILE") future = e;
    }
    const paid = transfers.reduce((s, x) => s + x.amountMinor, 0);
    run(db, "UPDATE ext_business_move SET status='COMPLETED', business_action_id=?, repaid_minor=?, future_json=?, vat_note_json=?, completed_at=? WHERE tenant_id=? AND plan_id=?", action.id, paid, JSON.stringify(future), JSON.stringify(vat), now, t, plan.planId);
    recordConfirmed(db, action.id, c.attemptId, {
      issuer: "nextmove-bank", reference: ref, effectiveAt: now, accessUntil: null, termsRevision: null,
      details: { planId: plan.planId, repaidMinor: paid, transfers: transfers.length, fromAccountId: profile.account_id, toAccountId: sub.account_id, vatNote: "INFORMATION_FOR_ACCOUNTANT_NOT_TAX_ADVICE", futureBilling: plan.future.kind },
      channel: "BANK", verification: { method: "ledger_posting", checks: ["household approved this exact plan", "plan rebuilt from bank records matches", "within the approved amount", "business stays above its reserve", "balanced transfers between your own accounts"] }, evidence: "BANK_LEDGER_POSTING",
    });
  });
}

/* -------------------------------------------------------------------------------- seed and labs */

const PIXELFORGE = { merchantId: "pixelforge", name: "PixelForge Studio", country: "DE", plan: "Design suite, 1 seat", amountMinor: 11900 };
const PF_CHARGES = [
  { month: "2026-08", postedOn: "2026-08-05", bookedAt: "2026-08-05T10:00:00+03:00", invoice: "PF-INV-2026-0805" },
  { month: "2026-09", postedOn: "2026-09-05", bookedAt: "2026-09-05T10:00:00+03:00", invoice: "PF-INV-2026-0905" },
  { month: "2026-10", postedOn: "2026-10-05", bookedAt: "2026-10-05T10:00:00+03:00", invoice: null },
];

function seed(db: DatabaseSync, input: { tenantId: string; customer: "alex" | "laziz"; contexts: string[] }) {
  if (input.customer !== "laziz") return;
  const t = input.tenantId;
  const hh = one<any>(db, "SELECT * FROM contexts WHERE tenant_id=? AND kind='PERSONAL' ORDER BY ordinal LIMIT 1", t);
  const biz = one<any>(db, "SELECT * FROM contexts WHERE tenant_id=? AND kind='BUSINESS' ORDER BY ordinal LIMIT 1", t);
  const hhAcct = hh && one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING' ORDER BY ordinal LIMIT 1", t, hh.id);
  const bizAcct = biz && one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND kind='BUSINESS_CURRENT' ORDER BY ordinal LIMIT 1", t, biz.id);
  if (!hhAcct || !bizAcct) return;
  const card = json<any>(bizAcct.card_json, null);
  const subId = `${t}:bizmove:${PIXELFORGE.merchantId}`;
  run(db, "INSERT INTO ext_bizmove_subscription(id, tenant_id, context_id, account_id, merchant_id, merchant_name, merchant_country, channel, supports_billing_profile, plan_name, amount_minor) VALUES (?,?,?,?,?,?,?, 'MERCHANT_DIRECT', 0, ?, ?)", subId, t, hh.id, hhAcct.id, PIXELFORGE.merchantId, PIXELFORGE.name, PIXELFORGE.country, PIXELFORGE.plan, PIXELFORGE.amountMinor);
  // Past direct debits are history: the opening balance absorbs them (as the fixture history does), so today's balance is unchanged.
  let posted = 0;
  for (const ch of PF_CHARGES) {
    const { transactionId } = postCardOrTransfer(db, { tenantId: t, contextId: hh.id, accountId: hhAcct.id, sourceEventId: `fixture:${t}:pixelforge-${ch.month}`, amountMinor: -PIXELFORGE.amountMinor, merchantName: PIXELFORGE.name, merchantId: PIXELFORGE.merchantId, category: "Software", reference: `PF-${ch.month}`, bookedAt: ch.bookedAt, note: "Monthly direct debit" });
    posted -= PIXELFORGE.amountMinor;
    run(db, "INSERT INTO ext_bizmove_charge(id, tenant_id, context_id, subscription_id, account_id, transaction_id, posted_on, amount_minor, currency, refunded, invoice_id, invoice_issued_to) VALUES (?,?,?,?,?,?,?,?, 'RON', 0, ?, ?)", `${subId}:${ch.month}`, t, hh.id, subId, hhAcct.id, transactionId, ch.postedOn, PIXELFORGE.amountMinor, ch.invoice, ch.invoice ? "PERSONAL_NAME" : null);
  }
  run(db, "UPDATE accounts SET opening_minor = opening_minor - ? WHERE id=? AND tenant_id=?", posted, hhAcct.id, t);
  run(db, "INSERT INTO ext_business_profile(context_id, tenant_id, account_id, legal_name, tax_id, vat_registered, card_id) VALUES (?,?,?,?,?,1,?)", biz.id, t, bizAcct.id, biz.subtitle || "Laziz Products SRL", "RO47205916", card?.last4 ? `Business debit •••• ${card.last4}` : "Business debit card");
  run(db, "INSERT INTO ext_vat_rule_set(id, tenant_id, rule_set_id, version, effective_from, home_country, eu_countries_json) VALUES (?,?,?,?,?,?,?)", `${t}:vat:ro-demo:1`, t, "ro-demo-rules", 1, "2026-01-01", "RO", JSON.stringify(EU));
}

const MONTH = /^20\d\d-(0[1-9]|1[0-2])$/;

/** Labs: the provider refunds one month. A bounded, idempotent credit; it changes the plan, so stale approvals are refused. */
function labsRefund({ db, session, body }: { db: DatabaseSync; session: any; body: Record<string, unknown> }) {
  const month = typeof body.month === "string" && MONTH.test(body.month) ? body.month : null;
  if (!month) throw new HttpError(400, "BAD_INPUT", "month must be YYYY-MM");
  const t = session.tenantId;
  return tx(db, () => {
    const charge = one<any>(db, "SELECT c.*, s.merchant_name, s.merchant_id FROM ext_bizmove_charge c JOIN ext_bizmove_subscription s ON s.id=c.subscription_id AND s.tenant_id=c.tenant_id WHERE c.tenant_id=? AND c.context_id=? AND substr(c.posted_on,1,7)=?", t, session.contextId, month);
    if (!charge) throw new HttpError(404, "NOT_FOUND", "No such charge in this context");
    if (charge.refunded) return { refunded: true, duplicate: true, amountMinor: 0 };
    if (one(db, "SELECT 1 FROM ext_business_repayment WHERE tenant_id=? AND subscription_id=? AND charge_id=?", t, charge.subscription_id, charge.id)) throw new HttpError(409, "ALREADY_REPAID", "The business already repaid this month; the refund is not simulated");
    const { transactionId } = postCardOrTransfer(db, { tenantId: t, contextId: charge.context_id, accountId: charge.account_id, sourceEventId: `${t}:pixelforge-refund:${charge.id}`, amountMinor: charge.amount_minor, merchantName: charge.merchant_name, merchantId: charge.merchant_id, category: "Refund", reference: `RF-${month}`, bookedAt: nowIso(db, t), note: "Refund (Labs simulation)" });
    run(db, "UPDATE ext_bizmove_charge SET refunded=1 WHERE id=? AND tenant_id=?", charge.id, t);
    return { refunded: true, duplicate: false, amountMinor: charge.amount_minor, transactionId };
  });
}

const E7H: CapabilityDef = { id: "E7H", title: "Move a business cost off the household", short: "Household side of repaying a cost the business uses", group: "Business", customer: "laziz", contextKind: "PERSONAL", keywords: ["business", "expense", "move a cost", "move the cost", "move costs", "business cost", "repay", "vat", "pixelforge", "household", "company"], analyze: analyzeHousehold };
const E7: CapabilityDef = { id: "E7", title: "Repay the household for business costs", short: "Business side, with a note for your accountant", group: "Business", customer: "laziz", contextKind: "BUSINESS", keywords: ["business", "expense", "move a cost", "move the cost", "move costs", "business cost", "repay", "vat", "accountant", "household", "reimburse"], analyze: analyzeBusiness };

export const businessMove: ExtensionModule = {
  key: "business-move",
  capabilities: [E7, E7H],
  operations: { EXT_BIZMOVE_CONSENT: runConsent, EXT_BIZMOVE_REPAY: runRepay },
  seed,
  labs: { merchant_refund: labsRefund },
};
