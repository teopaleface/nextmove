import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { all, one, run, tx } from "../db/connection";
import { repoRoot } from "../config";
import { setClock, FIXTURE_INSTANT } from "../clock";
import { clearingAccountId, post } from "../bank/ledger";
import { addForecastItem } from "../bank/forecast";
import { encryptSecret } from "../crypto";
import { merchantAdmin } from "../merchant-client";
import { shortId } from "../canonical";
import { canonicalKey, merchantAccountId, merchantContractId } from "../../shared/ids";
import { toMs } from "../../shared/time";

// Bank-side seeding from the repository fixtures. The bank stores what a bank would know (accounts, posted
// history, linked subscriptions, goals); provider state lives only in the merchant process.

export type Customer = "alex" | "laziz";

function readJson(rel: string) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), rel), "utf8"));
}

const TENANT_TABLES = [
  "sessions", "contexts", "users", "accounts", "ledger_entries", "transactions", "subscriptions", "forecast_items", "forecast_events", "goals",
  "saved_comparisons", "preferences", "business_records", "recoveries", "uploads", "extractions", "facts", "tasks", "task_events", "task_questions",
  "action_candidates", "proposals", "proposal_actions", "mandates", "grants", "permissions", "merchant_links", "outbox", "jobs", "attempts", "receipts",
  "inbox_events", "batches", "batch_items", "watches", "findings", "notifications", "demo_clocks", "model_calls",
];

export function deleteTenantRows(db: DatabaseSync, tenantId: string) {
  tx(db, () => {
    run(db, "DELETE FROM ledger_lines WHERE entry_id IN (SELECT id FROM ledger_entries WHERE tenant_id=?)", tenantId);
    run(db, "DELETE FROM task_blocks WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id=?)", tenantId);
    run(db, "DELETE FROM dispatch_journal WHERE attempt_id IN (SELECT id FROM attempts WHERE tenant_id=?)", tenantId);
    for (const t of TENANT_TABLES) run(db, `DELETE FROM ${t} WHERE tenant_id=?`, tenantId);
    run(db, "DELETE FROM tenants WHERE id=?", tenantId);
  });
}

interface SeedResult {
  tenantId: string;
  customer: Customer;
  userId: string;
  contexts: string[];
  linkedAccounts: number;
}

export async function seedTenant(db: DatabaseSync, tenantId: string, customer: Customer, opts: { isolated?: boolean } = {}): Promise<SeedResult> {
  deleteTenantRows(db, tenantId);
  const fixtureMs = toMs(FIXTURE_INSTANT);
  const merchant = await merchantAdmin.seed(tenantId, customer, fixtureMs);
  const result = tx(db, () => {
    run(db, "INSERT INTO tenants(id, base_customer, isolated, created_at) VALUES (?,?,?,?)", tenantId, customer, opts.isolated ? 1 : 0, new Date().toISOString());
    setClock(db, tenantId, fixtureMs);
    const r = customer === "alex" ? seedAlex(db, tenantId) : seedLaziz(db, tenantId);
    for (const tk of merchant.tokens as { merchantId: string; accountId: string; token: string }[]) {
      const ctx = contextForMerchant(r, tk.merchantId);
      run(
        db,
        "INSERT INTO merchant_links(id, tenant_id, context_id, merchant_id, subscriber_account_id, token_cipher, status, updated_at) VALUES (?,?,?,?,?,?, 'LINKED', ?)",
        shortId("ml"),
        tenantId,
        ctx,
        tk.merchantId,
        tk.accountId,
        encryptSecret(tk.token),
        new Date().toISOString(),
      );
    }
    run(db, "INSERT OR REPLACE INTO system_status(key, value_json, updated_at) VALUES (?,?,?)", `directory:${tenantId}`, JSON.stringify(merchant.directory), new Date().toISOString());
    return { ...r, linkedAccounts: merchant.tokens.length };
  });
  return { tenantId, customer, userId: result.userId, contexts: result.contexts, linkedAccounts: result.linkedAccounts };
}

function contextForMerchant(r: { contexts: string[]; merchantContext?: Record<string, string> }, merchantId: string) {
  return r.merchantContext?.[merchantId] ?? r.contexts[0];
}

function insertAccount(db: DatabaseSync, a: { id: string; tenantId: string; contextId: string; name: string; kind: string; iban?: string; ordinal: number; card?: object }) {
  run(db, "INSERT INTO accounts(id, tenant_id, context_id, name, kind, iban_masked, currency, opening_minor, ordinal, card_json) VALUES (?,?,?,?,?,?, 'RON', 0, ?, ?)", a.id, a.tenantId, a.contextId, a.name, a.kind, a.iban ?? null, a.ordinal, a.card ? JSON.stringify(a.card) : null);
}

/** Post fixture history, then set the opening balance so the current balance equals the fixture value. */
function postHistory(db: DatabaseSync, tenantId: string, contextId: string, accountId: string, targetMinor: number, txns: any[]) {
  let posted = 0;
  for (const t of txns) {
    if (t.status === "POSTED") {
      const { entryId } = post(db, {
        tenantId,
        sourceEventId: `fixture:${tenantId}:${t.id}`,
        kind: t.amountMinor < 0 ? "DEBIT" : "CREDIT",
        description: t.merchant,
        postedAt: t.bookedAt,
        lines: [
          { accountId, amountMinor: t.amountMinor },
          { accountId: clearingAccountId(tenantId), amountMinor: -t.amountMinor },
        ],
      });
      posted += t.amountMinor;
      run(
        db,
        `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, order_ref, card_last4, booked_at, note, data_json)
         VALUES (?,?,?,?,?,'POSTED',?,?,'RON',?,?,?,?,?,?,?,?,?)`,
        `${tenantId}:${t.id}`, tenantId, contextId, accountId, entryId, t.amountMinor < 0 ? "DEBIT" : "CREDIT", t.amountMinor, t.merchantId ?? null, t.merchant, t.category ?? null,
        t.reference ?? null, t.orderRef ?? null, t.amountMinor < 0 && t.category !== "Income" ? "4821" : null, t.bookedAt, t.note ?? null, JSON.stringify({ authId: t.authId ?? null }),
      );
    } else {
      run(
        db,
        `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, order_ref, card_last4, booked_at, note, data_json)
         VALUES (?,?,?,?,NULL,'PENDING',?,?,'RON',?,?,?,?,?,'4821',?,?,?)`,
        `${tenantId}:${t.id}`, tenantId, contextId, accountId, t.amountMinor < 0 ? "DEBIT" : "CREDIT", t.amountMinor, t.merchantId ?? null, t.merchant, t.category ?? null,
        t.reference ?? null, t.orderRef ?? null, t.bookedAt, t.note ?? null, JSON.stringify({ authId: t.authId ?? null }),
      );
    }
  }
  run(db, "UPDATE accounts SET opening_minor=? WHERE id=?", targetMinor - posted, accountId);
}

function insertSubscription(db: DatabaseSync, s: { tenantId: string; contextId: string; id: string; dataset: string; category: string; merchantId: string; merchantName: string; accountId: string; contractId: string; planName: string; amountMinor: number; billingPeriod?: string; state: string; nextChargeAt: string | null; accessUntil: string | null; termsRevision: number; benefits?: object; data?: object }) {
  run(
    db,
    `INSERT INTO subscriptions(id, tenant_id, context_id, dataset, category, merchant_id, merchant_name, subscriber_account_id, contract_id, canonical_key, plan_name, amount_minor, currency, billing_period, state, next_charge_at, access_until, terms_revision, observed_revision, last_observed_at, benefits_json, data_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'RON', ?,?,?,?,?,?,?,?,?)`,
    s.id, s.tenantId, s.contextId, s.dataset, s.category, s.merchantId, s.merchantName, s.accountId, s.contractId, canonicalKey(s.merchantId, s.accountId, s.contractId || "?"),
    s.planName, s.amountMinor, s.billingPeriod ?? "MONTHLY", s.state, s.nextChargeAt, s.accessUntil, s.termsRevision, s.termsRevision, FIXTURE_INSTANT,
    JSON.stringify(s.benefits ?? {}), JSON.stringify(s.data ?? {}),
  );
}

function insertWatch(db: DatabaseSync, w: { tenantId: string; contextId: string; kind: string; subjectRef: string; label: string; condition: object; nextCheckAt: string }) {
  run(
    db,
    "INSERT INTO watches(id, tenant_id, context_id, kind, subject_ref, label, condition_json, status, consent_revision, next_check_at, created_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?)",
    `${w.tenantId}:watch:${w.kind.toLowerCase()}:${w.subjectRef.split(":").pop()}`,
    w.tenantId,
    w.contextId,
    w.kind,
    w.subjectRef,
    w.label,
    JSON.stringify(w.condition),
    w.nextCheckAt,
    new Date().toISOString(),
  );
}

function insertPermission(db: DatabaseSync, p: { tenantId: string; contextId: string; kind: string; source: string; scope: string; expiresAt?: string | null }) {
  run(db, "INSERT INTO permissions(id, tenant_id, context_id, kind, source, scope, status, granted_at, expires_at, last_checked_at) VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?, ?)", shortId("perm"), p.tenantId, p.contextId, p.kind, p.source, p.scope, FIXTURE_INSTANT, p.expiresAt ?? null, FIXTURE_INSTANT);
}

function seedAlex(db: DatabaseSync, t: string) {
  const ui = readJson("design/ui-fixtures.json");
  const caps = readJson("demo/capability-scenarios.json");
  const cases = readJson("demo/cases.json");
  const bulk = readJson("demo/bulk-cancellations.json");
  const userId = `${t}:alex`;
  const ctx = `${t}:personal`;
  run(db, "INSERT INTO users(id, tenant_id, display_name, initials) VALUES (?,?,?,?)", userId, t, ui.profile.name, "AX");
  run(db, "INSERT INTO contexts(id, tenant_id, user_id, kind, name, subtitle, role, reserve_floor_minor, ordinal) VALUES (?,?,?,?,?,?,?,?,0)", ctx, t, userId, "PERSONAL", "Personal", "Alex", "OWNER", null);
  insertAccount(db, { id: clearingAccountId(t), tenantId: t, contextId: ctx, name: "External clearing", kind: "EXTERNAL_CLEARING", ordinal: 99 });
  const daily = ui.accounts.find((a: any) => a.id === "daily");
  const savings = ui.accounts.find((a: any) => a.id === "savings");
  insertAccount(db, { id: `${t}:daily`, tenantId: t, contextId: ctx, name: daily.name, kind: "CURRENT", iban: "RO49 NXMV •••• 4821", ordinal: 0, card: { last4: "4821", status: "ACTIVE", kind: "Debit", holder: "Alex" } });
  insertAccount(db, { id: `${t}:savings`, tenantId: t, contextId: ctx, name: savings.name, kind: "SAVINGS", iban: "RO12 NXMV •••• 7730", ordinal: 1 });
  postHistory(db, t, ctx, `${t}:daily`, daily.balanceMinor, caps.alex.transactions);
  postHistory(db, t, ctx, `${t}:savings`, savings.balanceMinor, []);

  // Linked subscriptions (canonical UI dataset).
  const benefits: Record<string, object> = {
    studyplus: { studyTools: true, cloudStorageGb: 100 },
    streamly: { offlinePlayback: true, tvAccess: true, streaming: true },
    cloudbox: { cloudStorageGb: 100, primary: "cloud_storage" },
    fitflow: { classes: "Unlimited live classes" },
  };
  const contractLocal: Record<string, string> = { fitflow: "fitflow-premium", studyplus: "studyplus-standard", streamly: "streamly-standard", cloudbox: "cloudbox-100" };
  const accountLocal: Record<string, string> = { fitflow: "fit-alex", studyplus: "sp-alex", streamly: "st-alex", cloudbox: "cb-alex" };
  const planName: Record<string, string> = { fitflow: "FitFlow Premium", studyplus: "StudyPlus Standard", streamly: "Streamly Standard", cloudbox: "CloudBox 100 GB" };
  for (const s of ui.subscriptions) {
    const id = `${t}:sub:${s.id}`;
    const acct = merchantAccountId(t, s.id, accountLocal[s.id]);
    insertSubscription(db, {
      tenantId: t, contextId: ctx, id, dataset: "ui", category: "SUBSCRIPTION", merchantId: s.id, merchantName: s.merchant, accountId: acct,
      contractId: merchantContractId(t, contractLocal[s.id]), planName: planName[s.id], amountMinor: s.monthlyMinor,
      state: s.state === "trial" ? "TRIAL" : "ACTIVE", nextChargeAt: s.nextChargeAt, accessUntil: s.state === "trial" ? s.trialEnds : s.nextChargeAt,
      termsRevision: s.id === "streamly" ? 2 : 1, benefits: benefits[s.id], data: { lastChargeAt: s.lastChargeAt ?? null, trialEnds: s.trialEnds ?? null },
    });
    addForecastItem(db, {
      tenantId: t, contextId: ctx, dataset: "ui", subscriptionId: id, kind: s.state === "trial" ? "TRIAL_CONVERSION" : "RENEWAL",
      label: s.state === "trial" ? `${s.merchant} trial becomes paid` : `${s.merchant} renewal`, amountMinor: -s.monthlyMinor, dueAt: s.nextChargeAt, source: "fixture:ui-fixtures",
    });
  }
  const mn = caps.alex.bills[0];
  const mnSub = `${t}:sub:mobilenet`;
  insertSubscription(db, {
    tenantId: t, contextId: ctx, id: mnSub, dataset: "bills", category: "TELECOM", merchantId: "mobilenet", merchantName: "MobileNet", accountId: merchantAccountId(t, "mobilenet", mn.subscriberAccountId),
    contractId: merchantContractId(t, "mn-line"), planName: mn.planName, amountMinor: mn.amountMinor, state: "ACTIVE", nextChargeAt: mn.nextChargeAt, accessUntil: null, termsRevision: caps.alex.mobileNet.catalogRevision,
    benefits: { dataGb: 100, hotspot: true, euRoamingGb: 4 }, data: { billingDay: mn.billingDay },
  });
  addForecastItem(db, { tenantId: t, contextId: ctx, dataset: "bills", subscriptionId: mnSub, kind: "BILL", label: "MobileNet bill", amountMinor: -mn.amountMinor, dueAt: mn.nextChargeAt, source: "fixture:capability-scenarios" });

  // Independent 200-item stress inventory: only what the bank sees from recurring card payments.
  for (const rec of bulk.records) {
    insertSubscription(db, {
      tenantId: t, contextId: ctx, id: `${t}:bulk:${rec.id}`, dataset: "bulk", category: "SUBSCRIPTION", merchantId: rec.merchantId, merchantName: rec.merchantId,
      accountId: merchantAccountId(t, rec.merchantId, rec.subscriberAccountId), contractId: "", planName: "Recurring card payment", amountMinor: rec.nextChargeMinor,
      state: "UNKNOWN", nextChargeAt: null, accessUntil: null, termsRevision: 0, data: { fixtureId: rec.id },
    });
  }

  // Goals and planning inputs (O1, A10, A12, A14).
  const p = cases.phoneAndHome;
  const now = new Date().toISOString();
  const goal = (id: string, kind: string, name: string, inputs: object) => run(db, "INSERT INTO goals(id, tenant_id, context_id, kind, name, inputs_json, revision, updated_at) VALUES (?,?,?,?,?,?,1,?)", `${t}:goal:${id}`, t, ctx, kind, name, JSON.stringify(inputs), now);
  goal("home", "HOME", "First home", {
    liquidSource: "all liquid accounts",
    downPaymentMinor: p.homeDepositMinor,
    transactionCostsMinor: p.closingAndMovingMinor,
    protectedReserveMinor: p.protectedReserveMinor,
    monthlyContributionMinor: p.monthlySavingsBeforeHomeMinor,
    afterHome: { incomeMinor: p.monthlyIncomeMinor, otherSpendingMinor: p.monthlyOtherSpendingMinor, mortgagePaymentMinor: p.mockQuotedMortgagePaymentMinor, downsideIncomeReductionMinor: p.downsideIncomeReductionMinor },
    assumptions: p.assumptions,
  });
  goal("phone", "PURCHASE", "A new phone", { options: [{ id: "phone-3500", label: "3,500 RON phone", priceMinor: p.alternativePhonePriceMinor }, { id: "phone-6000", label: "6,000 RON phone", priceMinor: p.phonePriceMinor }], priority: "keep_home_timing", tco: caps.alex.phoneTco });
  goal("trip", "TRIP", "Barcelona, 12–16 Nov", caps.alex.travel);
  goal("wishlist", "WISHLIST", "Saved for later", { items: [caps.alex.bookNookCredit.intendedPurchase] });

  // Recovery already in progress (A7).
  const r = caps.alex.refund;
  run(
    db,
    `INSERT INTO recoveries(id, tenant_id, context_id, kind, merchant_id, merchant_name, amount_minor, state, reference, expected_by, transaction_id, timeline_json, data_json, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `${t}:rec:studiomart`, t, ctx, "REFUND", r.merchantId, r.merchant, r.amountMinor, "AWAITING_CREDIT", r.reference, r.expectedBy, `${t}:${r.originalTransactionId}`,
    JSON.stringify([
      { at: r.requestedAt, state: "SUBMITTED", label: "Refund requested" },
      { at: r.acceptedAt, state: "MERCHANT_ACCEPTED", label: "Merchant accepted the refund" },
    ]),
    JSON.stringify({ merchantAccount: merchantAccountId(t, "studiomart", "sm-alex") }),
    FIXTURE_INSTANT,
  );

  // Permissions and monitoring (each watch has its own explicit monitoring permission).
  insertPermission(db, { tenantId: t, contextId: ctx, kind: "READ", source: "NextMove bank accounts", scope: "Daily account, Savings: balances and transactions" });
  insertPermission(db, { tenantId: t, contextId: ctx, kind: "READ", source: "Linked merchant accounts (simulated)", scope: "Plan, renewal and terms for linked subscriptions" });
  insertPermission(db, { tenantId: t, contextId: ctx, kind: "MONITOR", source: "FitFlow", scope: "Trial conversion date", expiresAt: "2026-11-30T00:00:00+02:00" });
  insertPermission(db, { tenantId: t, contextId: ctx, kind: "MONITOR", source: "StudyPlus catalog", scope: "Student bundle terms" });
  insertPermission(db, { tenantId: t, contextId: ctx, kind: "MONITOR", source: "StudioMart", scope: "Refund SM-2048 credit" });
  insertWatch(db, { tenantId: t, contextId: ctx, kind: "TRIAL_CONVERSION", subjectRef: `${t}:sub:fitflow`, label: "FitFlow trial conversion", condition: { thresholdsHours: [48, 24], conversionAt: "2026-10-30T09:00:00+02:00", amountMinor: 7900 }, nextCheckAt: FIXTURE_INSTANT });
  insertWatch(db, { tenantId: t, contextId: ctx, kind: "OFFER_TERMS", subjectRef: `${t}:offer:student-bundle`, label: "Student bundle terms", condition: { offerId: "student-bundle", merchantId: "studyplus", knownRevision: 1 }, nextCheckAt: FIXTURE_INSTANT });
  insertWatch(db, { tenantId: t, contextId: ctx, kind: "PRICE_CHANGE", subjectRef: `${t}:sub:streamly`, label: "Streamly price", condition: { merchantId: "streamly" }, nextCheckAt: FIXTURE_INSTANT });
  insertWatch(db, { tenantId: t, contextId: ctx, kind: "REFUND_DUE", subjectRef: `${t}:rec:studiomart`, label: "StudioMart refund", condition: { expectedBy: r.expectedBy, amountMinor: r.amountMinor }, nextCheckAt: FIXTURE_INSTANT });
  insertWatch(db, { tenantId: t, contextId: ctx, kind: "CREDIT_EXPIRY", subjectRef: `${t}:credit:booknook`, label: "BookNook credit", condition: { expiresAt: caps.alex.bookNookCredit.expiresAt, amountMinor: caps.alex.bookNookCredit.balanceMinor, warnDays: 21 }, nextCheckAt: FIXTURE_INSTANT });

  return { userId, contexts: [ctx] };
}

function seedLaziz(db: DatabaseSync, t: string) {
  const caps = readJson("demo/capability-scenarios.json");
  const cases = readJson("demo/cases.json");
  const userId = `${t}:laziz`;
  const biz = `${t}:business`;
  const hh = `${t}:personal`;
  const b = cases.businessOrder;
  run(db, "INSERT INTO users(id, tenant_id, display_name, initials) VALUES (?,?,?,?)", userId, t, "Mr Laziz", "ML");
  run(db, "INSERT INTO contexts(id, tenant_id, user_id, kind, name, subtitle, role, reserve_floor_minor, ordinal) VALUES (?,?,?,?,?,?,?,?,0)", biz, t, userId, "BUSINESS", "Laziz Products", "Laziz Products SRL", "OWNER", b.businessReserveMinor);
  run(db, "INSERT INTO contexts(id, tenant_id, user_id, kind, name, subtitle, role, reserve_floor_minor, ordinal) VALUES (?,?,?,?,?,?,?,?,1)", hh, t, userId, "PERSONAL", "Personal", "Laziz household", "OWNER", null);
  insertAccount(db, { id: clearingAccountId(t), tenantId: t, contextId: biz, name: "External clearing", kind: "EXTERNAL_CLEARING", ordinal: 99 });
  insertAccount(db, { id: `${t}:biz-current`, tenantId: t, contextId: biz, name: "Business account", kind: "BUSINESS_CURRENT", iban: "RO77 NXMV •••• 2600", ordinal: 0, card: { last4: "9012", status: "ACTIVE", kind: "Business debit", holder: "Laziz Products SRL" } });
  insertAccount(db, { id: `${t}:hh-current`, tenantId: t, contextId: hh, name: "Household account", kind: "CURRENT", iban: "RO05 NXMV •••• 1188", ordinal: 0 });
  postHistory(db, t, biz, `${t}:biz-current`, b.openingCashMinor, [
    { id: "txn-teamdesk-2026-10", merchant: "TeamDesk", merchantId: "teamdesk", category: "Software", amountMinor: -54000, bookedAt: "2026-10-01T00:05:00+03:00", status: "POSTED" },
    { id: "txn-sales-2026-10-27", merchant: "Card sales settlement", category: "Income", amountMinor: 186000, bookedAt: "2026-10-27T23:00:00+02:00", status: "POSTED" },
  ]);
  const h = caps.lazizHousehold;
  postHistory(db, t, hh, `${t}:hh-current`, h.openingBalanceMinor, [{ id: "txn-hh-groceries", merchant: "Fresh Market", category: "Groceries", amountMinor: -21400, bookedAt: "2026-10-26T18:00:00+02:00", status: "POSTED" }]);

  const now = new Date().toISOString();
  const record = (kind: string, id: string, ctx: string, data: object) => run(db, "INSERT INTO business_records(id, tenant_id, context_id, kind, data_json, revision, updated_at) VALUES (?,?,?,?,?,1,?)", `${t}:${id}`, t, ctx, kind, JSON.stringify(data), now);
  record("INVENTORY", "inventory", biz, b.inventory);
  record("SCENARIOS", "scenarios", biz, { openingCashMinor: b.openingCashMinor, reserveMinor: b.businessReserveMinor, orderReceiptMinor: b.orderReceiptMinor, scenarios: b.scenarios, assumptions: b.assumptions, householdLinkedEvents: b.householdLinkedEvents });
  record("FUNDING_OFFERS", "funding", biz, { offers: b.mockFundingOffers, lender: "FictionalLender (mock catalog)" });
  record("SUPPLIER_QUOTES", "quotes", biz, { quotes: caps.lazizBusiness.supplierQuotes });
  record("RECEIVABLES", "receivables", biz, { invoices: caps.lazizBusiness.receivables.map((r: any) => ({ ...r, status: "OPEN", paidMinor: 0, promises: [] })) });
  record("OWNER_ARRANGEMENT", "owner", biz, caps.lazizBusiness.ownerArrangement);
  record("NEW_SHOP", "newshop", biz, cases.newPretzelShop);

  const td = caps.lazizBusiness.teamDesk;
  const tdSub = `${t}:sub:teamdesk`;
  insertSubscription(db, {
    tenantId: t, contextId: biz, id: tdSub, dataset: "bills", category: "SOFTWARE", merchantId: "teamdesk", merchantName: "TeamDesk", accountId: merchantAccountId(t, "teamdesk", "td-laziz-products"),
    contractId: merchantContractId(t, "teamdesk-business"), planName: `${td.plan}, ${td.seats.length} seats`, amountMinor: td.seatPriceMinor * td.seats.length, billingPeriod: "PER_SEAT_MONTHLY",
    state: "ACTIVE", nextChargeAt: td.nextInvoiceAt, accessUntil: null, termsRevision: 1, data: { seats: td.seats.length, seatPriceMinor: td.seatPriceMinor },
  });
  addForecastItem(db, { tenantId: t, contextId: biz, dataset: "bills", subscriptionId: tdSub, kind: "BILL", label: "TeamDesk invoice", amountMinor: -(td.seatPriceMinor * td.seats.length), dueAt: td.nextInvoiceAt, source: "fixture:capability-scenarios" });
  for (const bill of h.bills) {
    const subId = `${t}:sub:${bill.merchantId}`;
    insertSubscription(db, {
      tenantId: t, contextId: hh, id: subId, dataset: "bills", category: bill.category, merchantId: bill.merchantId, merchantName: bill.merchant, accountId: merchantAccountId(t, bill.merchantId, bill.subscriberAccountId),
      contractId: merchantContractId(t, bill.merchantId === "fiberlink" ? "fiberlink-home" : "electracasa-home"), planName: bill.planName, amountMinor: bill.amountMinor, state: "ACTIVE", nextChargeAt: bill.nextChargeAt,
      accessUntil: null, termsRevision: 1, data: { billingDay: bill.billingDay, supportedBillingDays: bill.supportedBillingDays ?? null },
    });
    addForecastItem(db, { tenantId: t, contextId: hh, dataset: "bills", subscriptionId: subId, kind: "BILL", label: `${bill.merchant} bill`, amountMinor: -bill.amountMinor, dueAt: bill.nextChargeAt, source: "fixture:capability-scenarios" });
  }
  for (const inc of h.income) addForecastItem(db, { tenantId: t, contextId: hh, dataset: "bills", kind: "PLANNED_TRANSFER", label: inc.label, amountMinor: inc.amountMinor, dueAt: inc.expectedAt, condition: "Planned by the owner arrangement; not received", source: "fixture:capability-scenarios", data: { ownerTransfer: true } });
  for (const e of h.essentials) addForecastItem(db, { tenantId: t, contextId: hh, dataset: "bills", kind: "BILL", label: e.label, amountMinor: e.amountMinor, dueAt: e.dueAt, source: "fixture:capability-scenarios" });

  run(db, "INSERT INTO goals(id, tenant_id, context_id, kind, name, inputs_json, revision, updated_at) VALUES (?,?,?,?,?,?,1,?)", `${t}:goal:order`, t, biz, "BUSINESS_ORDER", "Can we take the 40,000 RON order?", JSON.stringify({ orderReceiptMinor: b.orderReceiptMinor }), now);
  run(db, "INSERT INTO goals(id, tenant_id, context_id, kind, name, inputs_json, revision, updated_at) VALUES (?,?,?,?,?,?,1,?)", `${t}:goal:newshop`, t, biz, "NEW_BUSINESS", "Open a second pretzel shop", JSON.stringify(cases.newPretzelShop), now);

  insertPermission(db, { tenantId: t, contextId: biz, kind: "READ", source: "NextMove business account", scope: "Balances, transactions, invoices" });
  insertPermission(db, { tenantId: t, contextId: biz, kind: "READ", source: "TeamDesk (simulated)", scope: "Seat roster, activity, invoices" });
  insertPermission(db, { tenantId: t, contextId: hh, kind: "READ", source: "NextMove household account", scope: "Balances and bills" });
  insertPermission(db, { tenantId: t, contextId: biz, kind: "MONITOR", source: "TeamDesk", scope: "Seat usage before each invoice" });
  insertWatch(db, { tenantId: t, contextId: biz, kind: "SEAT_USAGE", subjectRef: tdSub, label: "TeamDesk seat usage", condition: { merchantId: "teamdesk" }, nextCheckAt: FIXTURE_INSTANT });

  return { userId, contexts: [biz, hh], merchantContext: { electracasa: hh, fiberlink: hh } };
}

export function tenantExists(db: DatabaseSync, tenantId: string) {
  return Boolean(one(db, "SELECT id FROM tenants WHERE id=?", tenantId));
}

export function isolatedTenants(db: DatabaseSync) {
  return all<any>(db, "SELECT id FROM tenants WHERE isolated=1");
}
