import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mrun, mtx } from "./db";
import type { MerchantOperation } from "../shared/merchant-contract";
import { seedHiddenLossWorld } from "./hidden-losses-world";

// Builds the simulated merchant world for one tenant from the repository fixtures.
// For the independent 200-item scenario, each record's scenario expectation is translated once into a
// provider-side *world condition* (renewal already off, session expiring, manual review, publishing new terms,
// losing a response after commit). The bank never reads these conditions or the fixture's expected fields;
// it discovers outcomes only through the merchant's API and rendered pages.

export interface SeededToken {
  merchantId: string;
  accountId: string;
  token: string;
}

interface MerchantDef {
  id: string;
  name: string;
  category: string;
  connector: "PARTNER_API" | "ISOLATED_BROWSER" | "NONE";
  readApi: boolean;
  operations: MerchantOperation[];
  manualRoute?: string | null;
  refPrefix: string;
  nextRef?: number;
  policy?: Record<string, unknown>;
}

function readJson(root: string, rel: string) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function accountKey(tenantId: string, merchantId: string, local: string) {
  return `${tenantId}:${merchantId}:${local}`;
}

function insertMerchant(db: DatabaseSync, tenantId: string, m: MerchantDef) {
  mrun(
    db,
    `INSERT INTO m_merchants(tenant_id,id,name,category,connector,read_api,operations_json,manual_route,ref_prefix,next_ref,policy_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    tenantId,
    m.id,
    m.name,
    m.category,
    m.connector,
    m.readApi ? 1 : 0,
    JSON.stringify(m.operations),
    m.manualRoute ?? null,
    m.refPrefix,
    m.nextRef ?? 1001,
    JSON.stringify(m.policy ?? {}),
  );
}

function insertAccount(db: DatabaseSync, tenantId: string, merchantId: string, local: string, holder: string, opts: { tokenState?: string; expireAfterReads?: number | null; details?: object } = {}): SeededToken {
  const id = accountKey(tenantId, merchantId, local);
  const token = randomBytes(24).toString("base64url");
  mrun(
    db,
    `INSERT INTO m_accounts(tenant_id,merchant_id,id,holder,token_hash,token_state,expire_after_reads,details_json) VALUES (?,?,?,?,?,?,?,?)`,
    tenantId,
    merchantId,
    id,
    holder,
    sha(token),
    opts.tokenState ?? "VALID",
    opts.expireAfterReads ?? null,
    JSON.stringify(opts.details ?? {}),
  );
  return { merchantId, accountId: id, token };
}

interface ContractDef {
  id: string;
  merchantId: string;
  accountId: string;
  planId: string;
  planName: string;
  priceMinor: number;
  billingPeriod: string;
  state: string;
  autoRenew: boolean;
  nextChargeAt: string | null;
  accessUntil: string | null;
  termsRevision: number;
  minimumTermUntil?: string | null;
  exitFeeMinor?: number | null;
  ownerKind?: string;
  shared?: boolean;
  protectedReason?: string | null;
  benefits?: object;
  details?: object;
}

function insertContract(db: DatabaseSync, tenantId: string, c: ContractDef) {
  mrun(
    db,
    `INSERT INTO m_contracts(tenant_id,id,merchant_id,account_id,plan_id,plan_name,price_minor,billing_period,state,auto_renew,next_charge_at,access_until,terms_revision,minimum_term_until,exit_fee_minor,owner_kind,shared,protected_reason,benefits_json,details_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tenantId,
    c.id,
    c.merchantId,
    c.accountId,
    c.planId,
    c.planName,
    c.priceMinor,
    c.billingPeriod,
    c.state,
    c.autoRenew ? 1 : 0,
    c.nextChargeAt,
    c.accessUntil,
    c.termsRevision,
    c.minimumTermUntil ?? null,
    c.exitFeeMinor === undefined ? 0 : c.exitFeeMinor,
    c.ownerKind ?? "SELF",
    c.shared ? 1 : 0,
    c.protectedReason ?? null,
    JSON.stringify(c.benefits ?? {}),
    JSON.stringify(c.details ?? {}),
  );
}

function fault(db: DatabaseSync, tenantId: string, contractId: string, kind: string, params: object = {}) {
  mrun(db, `INSERT OR REPLACE INTO m_faults(tenant_id,contract_id,kind,params_json) VALUES (?,?,?,?)`, tenantId, contractId, kind, JSON.stringify(params));
}

const BULK_PREFIX = ["Lumen", "Cobalt", "Nimbus", "Vertex", "Juniper", "Orbit", "Quill", "Saffron", "Tidal", "Willow"];
const BULK_SUFFIX = ["Music", "News", "Fitness", "Cloud", "Games", "Learning", "Recipes", "Photo", "Radio", "Books", "Maps", "Notes", "Kids", "Wellness", "Video", "Podcasts", "Comics", "Language", "Design", "Weather"];
export function bulkMerchantName(index: number): string {
  return `${BULK_PREFIX[index % 10]} ${BULK_SUFFIX[Math.floor(index / 10) % 20]}`;
}

export function seedWorld(db: DatabaseSync, root: string, tenantId: string, customer: "alex" | "laziz", fixtureInstantMs: number): SeededToken[] {
  const ui = readJson(root, "design/ui-fixtures.json");
  const caps = readJson(root, "demo/capability-scenarios.json");
  const tokens: SeededToken[] = [];
  return mtx(db, () => {
    mrun(db, `INSERT INTO m_tenants(id, customer, created_at) VALUES (?,?,?)`, tenantId, customer, new Date().toISOString());
    mrun(db, `INSERT INTO m_clocks(tenant_id, base_ms, anchor_real_ms) VALUES (?,?,?)`, tenantId, fixtureInstantMs, Date.now());
    if (customer === "alex") seedAlex(db, root, tenantId, ui, caps, tokens);
    else seedLaziz(db, tenantId, caps, tokens);
    return tokens;
  });
}

function seedAlex(db: DatabaseSync, root: string, t: string, ui: any, caps: any, tokens: SeededToken[]) {
  const subs: Record<string, any> = Object.fromEntries(ui.subscriptions.map((s: any) => [s.id, s]));
  const defs: MerchantDef[] = [
    { id: "fitflow", name: "FitFlow", category: "Fitness", connector: "ISOLATED_BROWSER", readApi: true, operations: ["STOP_RENEWAL"], refPrefix: "NF", nextRef: 1047, policy: { cancellationMode: "instant" } },
    { id: "studyplus", name: "StudyPlus", category: "Education", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL", "CHANGE_BILLING_PERIOD", "ACTIVATE_OFFER", "VERIFY_ELIGIBILITY"], refPrefix: "SP" },
    { id: "streamly", name: "Streamly", category: "Streaming", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL", "PAUSE", "CHANGE_PLAN"], refPrefix: "STR" },
    { id: "cloudbox", name: "CloudBox", category: "Cloud storage", connector: "PARTNER_API", readApi: true, operations: ["STOP_RENEWAL", "START_MIGRATION"], refPrefix: "CB" },
    { id: "mobilenet", name: "MobileNet", category: "Telecom", connector: "PARTNER_API", readApi: true, operations: ["CHANGE_PLAN", "PLACE_ORDER"], refPrefix: "MN" },
    { id: "studiomart", name: "StudioMart", category: "Shopping", connector: "PARTNER_API", readApi: true, operations: ["FOLLOW_UP"], refPrefix: "SMF" },
    { id: "soundhub", name: "SoundHub", category: "Electronics", connector: "PARTNER_API", readApi: true, operations: ["SUBMIT_CLAIM"], refPrefix: "SHC", policy: { claimReview: "review" } },
    { id: "techbits", name: "TechBits", category: "Electronics", connector: "PARTNER_API", readApi: true, operations: ["SUBMIT_CLAIM"], refPrefix: "TBC", policy: { claimReview: "review" } },
    { id: "booknook", name: "BookNook", category: "Books", connector: "PARTNER_API", readApi: true, operations: ["PLACE_ORDER"], refPrefix: "BN" },
    { id: "datapass", name: "DataPass Europe", category: "Travel eSIM", connector: "PARTNER_API", readApi: true, operations: ["PLACE_ORDER"], refPrefix: "DP" },
    { id: "cinemax", name: "CinemaMax", category: "Streaming", connector: "PARTNER_API", readApi: true, operations: ["SCHEDULE_START"], refPrefix: "CMX" },
    { id: "freshmarket", name: "Fresh Market", category: "Groceries", connector: "NONE", readApi: false, operations: [], manualRoute: "In-store receipts only", refPrefix: "FM" },
    { id: "urbanride", name: "UrbanRide", category: "Transport", connector: "NONE", readApi: false, operations: [], manualRoute: "Ride history in the UrbanRide app", refPrefix: "UR" },
  ];
  for (const d of defs) insertMerchant(db, t, d);

  const acct = (m: string, local: string, details: object = {}) => {
    const tk = insertAccount(db, t, m, local, "Alex", { details });
    tokens.push(tk);
    return tk.accountId;
  };

  const fit = acct("fitflow", "fit-alex");
  insertContract(db, t, {
    id: `${t}:fitflow-premium`, merchantId: "fitflow", accountId: fit, planId: "premium", planName: "FitFlow Premium",
    priceMinor: subs.fitflow.monthlyMinor, billingPeriod: "MONTHLY", state: "TRIAL", autoRenew: true,
    nextChargeAt: subs.fitflow.nextChargeAt, accessUntil: subs.fitflow.trialEnds, termsRevision: 1,
    benefits: { classes: "Unlimited live classes" }, details: { trialEnds: subs.fitflow.trialEnds, cancellationFeeMinor: 0 },
  });

  const sp = acct("studyplus", "sp-alex", { studentVerification: "NOT_VERIFIED" });
  insertContract(db, t, {
    id: `${t}:studyplus-standard`, merchantId: "studyplus", accountId: sp, planId: "standard", planName: "StudyPlus Standard",
    priceMinor: subs.studyplus.monthlyMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true,
    nextChargeAt: subs.studyplus.nextChargeAt, accessUntil: subs.studyplus.nextChargeAt, termsRevision: 1,
    benefits: { studyTools: true, cloudStorageGb: subs.studyplus.cloudStorageGb },
    details: { annualPlan: caps.alex.studyPlusAnnual, storageUsedGb: 0 },
  });
  const bundle = ui.mockBundle;
  mrun(
    db,
    `INSERT INTO m_offers(tenant_id,id,merchant_id,revision,terms_json,published_at,current) VALUES (?,?,?,?,?,?,1)`,
    t,
    bundle.id,
    "studyplus",
    bundle.termRevision,
    JSON.stringify({ ...bundle, status: "fictional_catalog_offer" }),
    "2026-10-28T09:00:00+02:00",
  );

  const st = acct("streamly", "st-alex");
  insertContract(db, t, {
    id: `${t}:streamly-standard`, merchantId: "streamly", accountId: st, planId: "standard", planName: "Streamly Standard",
    priceMinor: subs.streamly.monthlyMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true,
    nextChargeAt: subs.streamly.nextChargeAt, accessUntil: subs.streamly.nextChargeAt, termsRevision: 2,
    benefits: { offlinePlayback: true, tvAccess: true },
    details: { priceHistory: caps.alex.streamlyPriceHistory, alternatives: caps.alex.streamlyAlternatives, pause: caps.alex.streamlyPause },
  });

  const cb = acct("cloudbox", "cb-alex");
  insertContract(db, t, {
    id: `${t}:cloudbox-100`, merchantId: "cloudbox", accountId: cb, planId: "cloud-100", planName: "CloudBox 100 GB",
    priceMinor: subs.cloudbox.monthlyMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true,
    nextChargeAt: subs.cloudbox.nextChargeAt, accessUntil: subs.cloudbox.nextChargeAt, termsRevision: 1,
    benefits: { cloudStorageGb: subs.cloudbox.cloudStorageGb, primary: "cloud_storage" },
    details: { usedGb: ui.usageEvidence.cloudUsageGb, migration: null },
  });

  const mn = caps.alex.mobileNet;
  const mobile = caps.alex.bills[0];
  const mna = acct("mobilenet", mobile.subscriberAccountId);
  insertContract(db, t, {
    id: `${t}:mn-line`, merchantId: "mobilenet", accountId: mna, planId: mobile.planId, planName: mobile.planName,
    priceMinor: mobile.amountMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true,
    nextChargeAt: mobile.nextChargeAt, accessUntil: null, termsRevision: mn.catalogRevision,
    benefits: { dataGb: 100, hotspot: true, euRoamingGb: 4 },
    details: { usageGb: mn.usageGb, hotspotUsedGbLastCycle: mn.hotspotUsedGbLastCycle, plans: mn.plans, changeRule: mn.changeRule, extraEuGbMinor: mn.extraEuGbMinor, billingDay: mobile.billingDay },
  });

  const r = caps.alex.refund;
  const sma = acct("studiomart", "sm-alex");
  mrun(db, `INSERT INTO m_cases(tenant_id,id,merchant_id,account_id,kind,state,amount_minor,reference,details_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    t, `${t}:case-${r.reference}`, "studiomart", sma, "REFUND", "ACCEPTED", r.amountMinor, r.reference,
    JSON.stringify({ requestedAt: r.requestedAt, acceptedAt: r.acceptedAt, expectedBy: r.expectedBy, payout: "NOT_SENT" }), r.acceptedAt);

  acct("soundhub", "sh-alex", { orders: [caps.alex.soundHubPolicy.purchase], policy: caps.alex.soundHubPolicy });
  acct("techbits", "tb-alex", { orders: [{ orderRef: "TB-30017", items: 1, item: "USB-C dock", paidMinor: 34900, chargesReceived: 2 }] });
  const bn = caps.alex.bookNookCredit;
  acct("booknook", "bn-alex", { credit: { id: bn.creditId, balanceMinor: bn.balanceMinor, expiresAt: bn.expiresAt, restrictions: bn.restrictions }, catalog: [bn.intendedPurchase] });
  acct("datapass", "dp-alex", { products: caps.alex.travel.connectivity.filter((c: any) => c.id === "datapass") });
  acct("cinemax", "cm-alex", { catalog: caps.alex.contentCatalog });
  seedHiddenLossWorld(root, t, { merchant: (m) => insertMerchant(db, t, m), account: (m, local) => acct(m, local), contract: (c) => insertContract(db, t, c) });

  seedBulk(db, root, t, tokens);
}

function seedBulk(db: DatabaseSync, root: string, t: string, tokens: SeededToken[]) {
  const bulk = readJson(root, "demo/bulk-cancellations.json");
  bulk.records.forEach((rec: any, i: number) => {
    const status = rec.inspectionStatus as string;
    const route = rec.expectedRoute as string | undefined;
    const connector = status === "UNSUPPORTED" ? "NONE" : route === "ISOLATED_BROWSER" ? "ISOLATED_BROWSER" : "PARTNER_API";
    insertMerchant(db, t, {
      id: rec.merchantId,
      name: bulkMerchantName(i),
      category: "Subscription",
      connector,
      readApi: status !== "UNSUPPORTED",
      operations: status === "UNSUPPORTED" ? [] : ["STOP_RENEWAL"],
      manualRoute: status === "UNSUPPORTED" ? "Call the provider's support line or use the in-app settings; no partner connector or supported web procedure." : null,
      refPrefix: `R${String(i + 1).padStart(3, "0")}`,
    });
    const outcome = rec.expectedOutcomeAfterFirstPass as string;
    // World conditions (provider side), derived once from the scenario definition:
    const tokenState = status === "NEEDS_AUTH" ? "EXPIRED" : "VALID";
    const expireAfterReads = status === "READY" && outcome === "NEEDS_AUTH" ? 1 : null; // session lapses after the inventory read
    const tk = insertAccount(db, t, rec.merchantId, rec.subscriberAccountId, "Alex", { tokenState, expireAfterReads });
    tokens.push(tk);
    const isReady = status === "READY";
    const contractId = `${t}:${rec.id}`;
    insertContract(db, t, {
      id: contractId,
      merchantId: rec.merchantId,
      accountId: tk.accountId,
      planId: "standard",
      planName: `${bulkMerchantName(i)} Standard`,
      priceMinor: rec.nextChargeMinor,
      billingPeriod: "MONTHLY",
      state: status === "ALREADY_OFF" ? "RENEWAL_OFF" : "ACTIVE",
      autoRenew: status !== "ALREADY_OFF",
      nextChargeAt: rec.nextChargeAt ?? (status === "ALREADY_OFF" ? null : "2026-11-15T12:00:00+02:00"),
      accessUntil: rec.accessUntil ?? "2026-11-15T12:00:00+02:00",
      termsRevision: rec.termsRevision,
      minimumTermUntil: status === "FIXED_COMMITMENT" ? "2027-03-31T23:59:59+03:00" : null,
      exitFeeMinor: isReady ? rec.exitFeeMinor : status === "FIXED_COMMITMENT" ? null : 0,
      ownerKind: status === "PROTECTED_OR_SHARED" ? "HOUSEHOLD_MEMBER" : "SELF",
      shared: status === "PROTECTED_OR_SHARED",
      protectedReason: status === "PROTECTED_OR_SHARED" ? "Family plan managed by another household member; cancelling ends access for 3 members" : null,
      benefits: {},
      details: { externalId: rec.id },
    });
    if (isReady && outcome === "WAITING_EXTERNAL") fault(db, t, contractId, "MANUAL_REVIEW", { resolveAfterHours: 48, resolveTo: "CONFIRMED" });
    if (isReady && outcome === "TERMS_CHANGED") fault(db, t, contractId, "PUBLISH_TERMS_AFTER_READS", { afterReads: 1, newRevision: rec.expectedNewTermsRevision ?? 2, newPriceMinor: rec.nextChargeMinor + 300 });
    if (isReady && outcome === "OUTCOME_UNKNOWN") {
      fault(db, t, contractId, "DROP_RESPONSE_AFTER_COMMIT", {});
      fault(db, t, contractId, "READ_LAG", { hours: 6 });
    }
  });
}

function seedLaziz(db: DatabaseSync, t: string, caps: any, tokens: SeededToken[]) {
  const biz = caps.lazizBusiness;
  const hh = caps.lazizHousehold;
  const defs: MerchantDef[] = [
    { id: "teamdesk", name: "TeamDesk", category: "Software", connector: "PARTNER_API", readApi: true, operations: ["REDUCE_SEATS"], refPrefix: "TD" },
    { id: "millco", name: "MillCo Ingredients", category: "Supplier", connector: "PARTNER_API", readApi: true, operations: ["PLACE_ORDER"], refPrefix: "MC" },
    { id: "dobrogea", name: "Dobrogea Farms", category: "Supplier", connector: "PARTNER_API", readApi: true, operations: ["PLACE_ORDER"], refPrefix: "DF" },
    { id: "electracasa", name: "ElectraCasa", category: "Utility", connector: "PARTNER_API", readApi: true, operations: ["CHANGE_BILLING_DATE"], refPrefix: "EC" },
    { id: "fiberlink", name: "FiberLink", category: "Telecom", connector: "PARTNER_API", readApi: true, operations: [], refPrefix: "FL" },
    { id: "cafe-aurora", name: "Cafe Aurora SRL", category: "Customer", connector: "PARTNER_API", readApi: true, operations: ["SEND_MESSAGE"], refPrefix: "CA" },
    { id: "hotel-lumen", name: "Hotel Lumen", category: "Customer", connector: "PARTNER_API", readApi: true, operations: ["SEND_MESSAGE"], refPrefix: "HL" },
  ];
  for (const d of defs) insertMerchant(db, t, d);
  const acct = (m: string, local: string, holder: string, details: object = {}) => {
    const tk = insertAccount(db, t, m, local, holder, { details });
    tokens.push(tk);
    return tk.accountId;
  };
  const td = biz.teamDesk;
  const tda = acct("teamdesk", "td-laziz-products", "Laziz Products SRL");
  insertContract(db, t, {
    id: `${t}:teamdesk-business`, merchantId: "teamdesk", accountId: tda, planId: "business", planName: td.plan,
    priceMinor: td.seatPriceMinor * td.seats.length, billingPeriod: "PER_SEAT_MONTHLY", state: "ACTIVE", autoRenew: true,
    nextChargeAt: td.nextInvoiceAt, accessUntil: null, termsRevision: 1,
    benefits: {}, details: { seats: td.seats, seatPriceMinor: td.seatPriceMinor, minimumSeats: td.minimumSeats, rule: td.rule, invoices: [{ period: "2026-10", amountMinor: td.seatPriceMinor * td.seats.length, seats: td.seats.length }] },
  });
  for (const q of biz.supplierQuotes) acct(q.merchantId, `${q.merchantId}-laziz`, "Laziz Products SRL", { quote: q });
  const ec = hh.bills.find((b: any) => b.id === "bill-electracasa");
  const eca = acct("electracasa", ec.subscriberAccountId, "Mr Laziz");
  insertContract(db, t, {
    id: `${t}:electracasa-home`, merchantId: "electracasa", accountId: eca, planId: "fixed-home", planName: ec.planName,
    priceMinor: ec.amountMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true, nextChargeAt: ec.nextChargeAt, accessUntil: null, termsRevision: 1,
    details: { billingDay: ec.billingDay, supportedBillingDays: ec.supportedBillingDays, changeRule: ec.changeRule, failedPaymentFeeMinor: ec.failedPaymentFeeMinor },
  });
  const fl = hh.bills.find((b: any) => b.id === "bill-fiberlink");
  const fla = acct("fiberlink", fl.subscriberAccountId, "Mr Laziz");
  insertContract(db, t, {
    id: `${t}:fiberlink-home`, merchantId: "fiberlink", accountId: fla, planId: "fibre-500", planName: fl.planName,
    priceMinor: fl.amountMinor, billingPeriod: "MONTHLY", state: "ACTIVE", autoRenew: true, nextChargeAt: fl.nextChargeAt, accessUntil: null, termsRevision: 1,
    details: { billingDay: fl.billingDay },
  });
  acct("cafe-aurora", "ca-laziz", "Laziz Products SRL", { invoices: [biz.receivables[0]] });
  acct("hotel-lumen", "hl-laziz", "Laziz Products SRL", { invoices: [biz.receivables[1]] });
}
