import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mall, mget, mrun, mtx } from "./db";
import type {
  MerchantContractView,
  MerchantReceiptView,
  MerchantRequestView,
  OperationRequestBody,
  OperationResponse,
  MerchantOperation,
  MerchantEvent,
} from "../shared/merchant-contract";
import { addLocalMonths, localDaysBetween, toLocalIso, toMs, withLocalDay } from "../shared/time";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const j = (s: string | null | undefined, f: any = {}) => {
  if (!s) return f;
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};

export function merchantNow(db: DatabaseSync, tenantId: string): number {
  const c = mget<{ base_ms: number; anchor_real_ms: number }>(db, "SELECT base_ms, anchor_real_ms FROM m_clocks WHERE tenant_id=?", tenantId);
  return c ? c.base_ms + (Date.now() - c.anchor_real_ms) : Date.now();
}
export const merchantNowIso = (db: DatabaseSync, t: string) => toLocalIso(merchantNow(db, t));

export interface AuthedAccount {
  tenantId: string;
  merchantId: string;
  accountId: string;
  holder: string;
  details: any;
}

/** Validate a delegated token. Expired sessions never authenticate; some sessions lapse after N reads (world condition). */
export function authenticate(db: DatabaseSync, token: string | null, merchantId: string, countRead: boolean): AuthedAccount | { expired: true } | null {
  if (!token) return null;
  const row = mget<any>(db, "SELECT * FROM m_accounts WHERE token_hash=? AND merchant_id=?", sha(token), merchantId);
  if (!row) return null;
  if (row.token_state !== "VALID") return { expired: true };
  if (row.expire_after_reads != null && row.expire_after_reads <= 0) {
    mrun(db, "UPDATE m_accounts SET token_state='EXPIRED' WHERE tenant_id=? AND merchant_id=? AND id=?", row.tenant_id, merchantId, row.id);
    return { expired: true };
  }
  if (countRead && row.expire_after_reads != null) {
    mrun(db, "UPDATE m_accounts SET expire_after_reads=expire_after_reads-1 WHERE tenant_id=? AND merchant_id=? AND id=?", row.tenant_id, merchantId, row.id);
  }
  return { tenantId: row.tenant_id, merchantId, accountId: row.id, holder: row.holder, details: j(row.details_json) };
}

function faultsFor(db: DatabaseSync, tenantId: string, contractId: string): Record<string, any> {
  const rows = mall<any>(db, "SELECT kind, params_json FROM m_faults WHERE tenant_id=? AND contract_id=?", tenantId, contractId);
  return Object.fromEntries(rows.map((r) => [r.kind, j(r.params_json)]));
}

function merchantRow(db: DatabaseSync, tenantId: string, merchantId: string) {
  return mget<any>(db, "SELECT * FROM m_merchants WHERE tenant_id=? AND id=?", tenantId, merchantId);
}

export function contractView(db: DatabaseSync, row: any, nowIso: string): MerchantContractView {
  const m = merchantRow(db, row.tenant_id, row.merchant_id);
  const details = j(row.details_json);
  // A lagging read model returns the pre-change snapshot until it catches up.
  if (details.staleSnapshot && details.staleUntil && toMs(nowIso) < toMs(details.staleUntil)) {
    return { ...details.staleSnapshot, observedAt: nowIso };
  }
  const { staleSnapshot, staleUntil, ...publicDetails } = details;
  return {
    merchantId: row.merchant_id,
    merchantName: m?.name ?? row.merchant_id,
    accountId: row.account_id,
    contractId: row.id,
    planId: row.plan_id,
    planName: row.plan_name,
    priceMinor: row.price_minor,
    currency: "RON",
    billingPeriod: row.billing_period,
    state: row.state,
    autoRenew: Boolean(row.auto_renew),
    nextChargeAt: row.next_charge_at,
    accessUntil: row.access_until,
    termsRevision: row.terms_revision,
    resourceVersion: row.resource_version,
    minimumTermUntil: row.minimum_term_until,
    exitFeeMinor: row.exit_fee_minor,
    ownerKind: row.owner_kind,
    shared: Boolean(row.shared),
    protectedReason: row.protected_reason,
    benefits: j(row.benefits_json),
    details: publicDetails,
    pending: j(row.pending_json, null),
    observedAt: nowIso,
  };
}

/** Read a contract, counting access; a provider may publish new terms after an earlier snapshot (world condition). */
export function readContract(db: DatabaseSync, tenantId: string, contractId: string, accountId: string): any | null {
  const row = mget<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND id=? AND account_id=?", tenantId, contractId, accountId);
  if (!row) return null;
  const faults = faultsFor(db, tenantId, contractId);
  const nextCount = row.access_count + 1;
  mrun(db, "UPDATE m_contracts SET access_count=? WHERE tenant_id=? AND id=?", nextCount, tenantId, contractId);
  const publish = faults.PUBLISH_TERMS_AFTER_READS;
  if (publish && row.access_count >= publish.afterReads && row.terms_revision < publish.newRevision) {
    mrun(
      db,
      "UPDATE m_contracts SET terms_revision=?, price_minor=?, resource_version=resource_version+1 WHERE tenant_id=? AND id=?",
      publish.newRevision,
      publish.newPriceMinor,
      tenantId,
      contractId,
    );
    mrun(db, "DELETE FROM m_faults WHERE tenant_id=? AND contract_id=? AND kind='PUBLISH_TERMS_AFTER_READS'", tenantId, contractId);
  }
  return mget<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND id=?", tenantId, contractId);
}

function nextReference(db: DatabaseSync, tenantId: string, merchantId: string): string {
  const m = merchantRow(db, tenantId, merchantId);
  mrun(db, "UPDATE m_merchants SET next_ref=next_ref+1 WHERE tenant_id=? AND id=?", tenantId, merchantId);
  return `${m.ref_prefix}-${m.next_ref}`;
}

export function receiptView(r: any): MerchantReceiptView {
  return {
    reference: r.ref,
    merchantId: r.merchant_id,
    accountId: r.account_id,
    contractId: r.contract_id,
    operation: r.operation,
    status: r.status,
    effectiveAt: r.effective_at,
    accessUntil: r.access_until,
    termsRevision: r.terms_revision,
    correlationId: r.correlation_id,
    channel: r.channel,
    details: j(r.details_json),
    createdAt: r.created_at,
  };
}

export function requestView(db: DatabaseSync, r: any, nowIso: string): MerchantRequestView {
  const receipt = r.receipt_ref ? mget<any>(db, "SELECT * FROM m_receipts WHERE tenant_id=? AND ref=?", r.tenant_id, r.receipt_ref) : null;
  const visible = receipt && toMs(nowIso) >= toMs(receipt.visible_at);
  return {
    requestId: r.id,
    correlationId: r.correlation_id,
    operation: r.operation,
    status: r.status,
    receipt: visible ? receiptView(receipt) : null,
    reason: r.reason,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function emitEvent(db: DatabaseSync, tenantId: string, issuer: string, kind: MerchantEvent["kind"], data: Record<string, unknown>, resourceVersion: number | null = null) {
  const id = `evt_${randomBytes(10).toString("hex")}`;
  const ev: MerchantEvent = { eventId: id, issuer, tenantId, kind, resourceVersion, occurredAt: merchantNowIso(db, tenantId), data };
  mrun(db, "INSERT INTO m_events(id, tenant_id, issuer, kind, payload_json, created_at) VALUES (?,?,?,?,?,?)", id, tenantId, issuer, kind, JSON.stringify(ev), new Date().toISOString());
  return ev;
}

interface ExecContext {
  channel: "API" | "WEB";
  correlationId: string | null;
  idempotencyKey: string | null;
}

export interface ExecResult {
  response: OperationResponse;
  httpStatus: number;
  dropResponse: boolean;
}

/** Apply one operation atomically: version check, state change, request record and receipt under one transaction. */
export function executeOperation(db: DatabaseSync, account: AuthedAccount, contractId: string | null, body: OperationRequestBody, ctx: ExecContext): ExecResult {
  const t = account.tenantId;
  const payloadHash = sha(JSON.stringify({ contractId, operation: body.operation, expectedTermsRevision: body.expectedTermsRevision, params: body.params }));
  return mtx(db, () => {
    const nowIso = merchantNowIso(db, t);
    if (ctx.idempotencyKey) {
      const prior = mget<any>(db, "SELECT * FROM m_requests WHERE tenant_id=? AND merchant_id=? AND idempotency_key=?", t, account.merchantId, ctx.idempotencyKey);
      if (prior) {
        if (prior.payload_hash !== payloadHash) {
          return { httpStatus: 409, dropResponse: false, response: { error: "IDEMPOTENCY_CONFLICT", message: "This idempotency key was used with a different request." } };
        }
        return { httpStatus: prior.status === "PENDING_REVIEW" ? 202 : 200, dropResponse: false, response: responseFor(db, prior, nowIso) };
      }
    }
    const merchant = merchantRow(db, t, account.merchantId);
    const ops: MerchantOperation[] = j(merchant.operations_json, []);
    if (!ops.includes(body.operation)) return { httpStatus: 422, dropResponse: false, response: { error: "NOT_SUPPORTED", message: `${merchant.name} does not support ${body.operation}` } };

    let contract: any = null;
    if (contractId) {
      contract = mget<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND id=? AND account_id=?", t, contractId, account.accountId);
      if (!contract) return { httpStatus: 404, dropResponse: false, response: { error: "VALIDATION", message: "Contract not found for this account" } };
      if (body.expectedTermsRevision != null && contract.terms_revision !== body.expectedTermsRevision) {
        return { httpStatus: 409, dropResponse: false, response: { error: "TERMS_CHANGED", currentRevision: contract.terms_revision, message: `Terms are now revision ${contract.terms_revision}` } };
      }
    }
    const faults = contract ? faultsFor(db, t, contract.id) : {};
    const policy = j(merchant.policy_json);
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    const insertRequest = (status: string, receiptRef: string | null, reason: string | null, resolveAt: string | null = null, resolveTo: string | null = null) =>
      mrun(
        db,
        `INSERT INTO m_requests(tenant_id,id,merchant_id,account_id,contract_id,operation,correlation_id,idempotency_key,payload_hash,status,receipt_ref,reason,channel,params_json,created_at,resolve_at,resolve_to,resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t, requestId, account.merchantId, account.accountId, contractId, body.operation, ctx.correlationId, ctx.idempotencyKey, payloadHash,
        status, receiptRef, reason, ctx.channel, JSON.stringify(body.params ?? {}), nowIso, resolveAt, resolveTo, status === "PENDING_REVIEW" ? null : nowIso,
      );

    // Merchant-side review / refusal policies.
    const cancellationMode = policy.cancellationMode as string | undefined;
    if (body.operation === "STOP_RENEWAL" && cancellationMode === "refuse") {
      insertRequest("REFUSED", null, "The account holder could not be verified for this change. Contact FitFlow support.");
      return { httpStatus: 422, dropResponse: false, response: responseFor(db, mget(db, "SELECT * FROM m_requests WHERE tenant_id=? AND id=?", t, requestId), nowIso) };
    }
    if ((body.operation === "STOP_RENEWAL" && cancellationMode === "review") || faults.MANUAL_REVIEW) {
      const hours = faults.MANUAL_REVIEW?.resolveAfterHours ?? 0.5;
      const resolveAt = toLocalIso(toMs(nowIso) + hours * 3_600_000);
      insertRequest("PENDING_REVIEW", null, null, resolveAt, faults.MANUAL_REVIEW?.resolveTo ?? "CONFIRMED");
      return { httpStatus: 202, dropResponse: false, response: responseFor(db, mget(db, "SELECT * FROM m_requests WHERE tenant_id=? AND id=?", t, requestId), nowIso) };
    }

    const applied = applyOperation(db, account, contract, body, nowIso);
    if ("error" in applied) {
      return { httpStatus: applied.httpStatus, dropResponse: false, response: { error: applied.error as any, message: applied.message } as OperationResponse };
    }
    const ref = applied.reuseReceipt ?? nextReference(db, t, account.merchantId);
    if (!applied.reuseReceipt) {
      const lagHours = faults.READ_LAG?.hours ?? 0;
      const visibleAt = toLocalIso(toMs(nowIso) + lagHours * 3_600_000);
      mrun(
        db,
        `INSERT INTO m_receipts(tenant_id,ref,merchant_id,account_id,contract_id,request_id,operation,status,effective_at,access_until,terms_revision,correlation_id,channel,details_json,created_at,visible_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t, ref, account.merchantId, account.accountId, contractId, requestId, body.operation, "CONFIRMED", applied.effectiveAt, applied.accessUntil,
        applied.termsRevision, ctx.correlationId, ctx.channel, JSON.stringify(applied.details ?? {}), nowIso, visibleAt,
      );
      if (lagHours > 0 && contract && applied.snapshotBefore) {
        const d = j(mget<any>(db, "SELECT details_json FROM m_contracts WHERE tenant_id=? AND id=?", t, contract.id)!.details_json);
        d.staleSnapshot = applied.snapshotBefore;
        d.staleUntil = visibleAt;
        mrun(db, "UPDATE m_contracts SET details_json=? WHERE tenant_id=? AND id=?", JSON.stringify(d), t, contract.id);
      }
    }
    insertRequest("CONFIRMED", ref, null);
    const req = mget<any>(db, "SELECT * FROM m_requests WHERE tenant_id=? AND id=?", t, requestId);
    const resp = responseFor(db, req, nowIso);
    // Fault: the change commits but the response never reaches the caller.
    const drop = Boolean(faults.DROP_RESPONSE_AFTER_COMMIT) && ctx.channel === "WEB";
    return { httpStatus: 200, dropResponse: drop, response: resp };
  });
}

function responseFor(db: DatabaseSync, req: any, nowIso: string): OperationResponse {
  const view = requestView(db, req, nowIso);
  if (req.status === "PENDING_REVIEW") return { status: "PENDING_REVIEW", request: view };
  if (req.status === "REFUSED") return { status: "REFUSED", request: view, reason: req.reason };
  const receipt = mget<any>(db, "SELECT * FROM m_receipts WHERE tenant_id=? AND ref=?", req.tenant_id, req.receipt_ref);
  return { status: "CONFIRMED", request: view, receipt: receiptView(receipt) };
}

type Applied =
  | { effectiveAt: string | null; accessUntil: string | null; termsRevision: number | null; details?: Record<string, unknown>; reuseReceipt?: string; snapshotBefore?: MerchantContractView }
  | { error: string; message: string; httpStatus: number };

function bump(db: DatabaseSync, t: string, id: string) {
  mrun(db, "UPDATE m_contracts SET resource_version=resource_version+1, terms_revision=terms_revision+1 WHERE tenant_id=? AND id=?", t, id);
}

function applyOperation(db: DatabaseSync, account: AuthedAccount, contract: any, body: OperationRequestBody, nowIso: string): Applied {
  const t = account.tenantId;
  const p = body.params ?? {};
  const before = contract ? contractView(db, contract, nowIso) : undefined;
  const details = contract ? j(contract.details_json) : {};
  switch (body.operation) {
    case "STOP_RENEWAL": {
      if (!contract) return { error: "VALIDATION", message: "Contract required", httpStatus: 400 };
      if (!contract.auto_renew) {
        const prior = mget<any>(db, "SELECT ref FROM m_receipts WHERE tenant_id=? AND contract_id=? AND operation='STOP_RENEWAL' ORDER BY created_at DESC LIMIT 1", t, contract.id);
        if (prior) return { effectiveAt: null, accessUntil: contract.access_until, termsRevision: contract.terms_revision, reuseReceipt: prior.ref };
        return { error: "VALIDATION", message: "Renewal is already off", httpStatus: 409 };
      }
      const accessUntil = contract.access_until ?? contract.next_charge_at;
      mrun(db, "UPDATE m_contracts SET auto_renew=0, state='RENEWAL_OFF', next_charge_at=NULL, access_until=? WHERE tenant_id=? AND id=?", accessUntil, t, contract.id);
      bump(db, t, contract.id);
      const after = mget<any>(db, "SELECT terms_revision FROM m_contracts WHERE tenant_id=? AND id=?", t, contract.id);
      return { effectiveAt: nowIso, accessUntil, termsRevision: after.terms_revision, details: { nextChargeMinor: 0, cancellationFeeMinor: 0, previousNextChargeAt: contract.next_charge_at }, snapshotBefore: before };
    }
    case "CHANGE_PLAN": {
      const plans = details.plans ?? details.alternatives ?? [];
      const plan = plans.find((x: any) => x.id === p.planId);
      if (!plan) return { error: "VALIDATION", message: "Unknown plan", httpStatus: 400 };
      const benefits = plan.dataGb != null ? { dataGb: plan.dataGb, hotspot: plan.hotspot, euRoamingGb: plan.euRoamingGb } : { offlinePlayback: plan.offlinePlayback, tvAccess: plan.tvAccess, ads: plan.ads };
      const price = plan.monthlyMinor;
      mrun(db, "UPDATE m_contracts SET plan_id=?, plan_name=?, price_minor=?, benefits_json=? WHERE tenant_id=? AND id=?", plan.id, plan.name, price, JSON.stringify(benefits), t, contract.id);
      bump(db, t, contract.id);
      return { effectiveAt: contract.next_charge_at, accessUntil: null, termsRevision: contract.terms_revision + 1, details: { fromPlan: contract.plan_name, toPlan: plan.name, newPriceMinor: price, firstBillAt: contract.next_charge_at } };
    }
    case "PAUSE": {
      const pause = details.pause;
      const months = Number(p.months);
      if (!pause || !pause.allowedMonths.includes(months)) return { error: "VALIDATION", message: "Pause length not offered", httpStatus: 400 };
      const resumesAt = toLocalIso(addLocalMonths(toMs(pause.startsAt), months));
      mrun(db, "UPDATE m_contracts SET next_charge_at=?, access_until=?, pending_json=? WHERE tenant_id=? AND id=?", resumesAt, pause.startsAt, JSON.stringify({ pause: { startsAt: pause.startsAt, resumesAt, months } }), t, contract.id);
      bump(db, t, contract.id);
      return { effectiveAt: pause.startsAt, accessUntil: pause.startsAt, termsRevision: contract.terms_revision + 1, details: { resumesAt, months, feeMinor: 0, resumePriceMinor: contract.price_minor } };
    }
    case "CHANGE_BILLING_DATE": {
      const day = Number(p.billingDay);
      if (!details.supportedBillingDays?.includes(day)) return { error: "VALIDATION", message: "Billing day not supported", httpStatus: 400 };
      if (!contract?.next_charge_at) return { error: "VALIDATION", message: "No upcoming bill to move", httpStatus: 409 };
      const now = toMs(nowIso);
      const current = toMs(contract.next_charge_at);
      if (current - now < 3 * 86_400_000) return { error: "VALIDATION", message: "Too late for the next bill; request at least 3 days before", httpStatus: 409 };
      // The next bill moves to the new day of the same local month; an earlier day must still give 3 days' notice.
      const next = withLocalDay(current, day);
      if (next - now < 3 * 86_400_000) return { error: "VALIDATION", message: "The new billing day is less than 3 days away; choose a later day", httpStatus: 409 };
      const shift = localDaysBetween(current, next);
      const proration = shift > 0 ? Math.floor((contract.price_minor * shift * 2 + 30) / 60) : 0;
      const firstBillAt = toLocalIso(next);
      details.billingDay = day;
      details.nextBillAmountMinor = contract.price_minor + proration;
      details.prorationMinor = proration;
      mrun(db, "UPDATE m_contracts SET next_charge_at=?, details_json=? WHERE tenant_id=? AND id=?", firstBillAt, JSON.stringify(details), t, contract.id);
      bump(db, t, contract.id);
      return { effectiveAt: firstBillAt, accessUntil: null, termsRevision: contract.terms_revision + 1, details: { billingDay: day, firstBillAt, firstBillAmountMinor: contract.price_minor + proration, prorationMinor: proration } };
    }
    case "CHANGE_BILLING_PERIOD": {
      const annual = details.annualPlan;
      if (p.period !== "ANNUAL" || !annual) return { error: "VALIDATION", message: "Unsupported billing period", httpStatus: 400 };
      details.pendingBillingPeriod = { period: "ANNUAL", priceMinor: annual.annualMinor, effectiveAt: contract.next_charge_at };
      mrun(db, "UPDATE m_contracts SET details_json=?, price_minor=?, billing_period='ANNUAL' WHERE tenant_id=? AND id=?", JSON.stringify(details), annual.annualMinor, t, contract.id);
      bump(db, t, contract.id);
      return { effectiveAt: contract.next_charge_at, accessUntil: null, termsRevision: contract.terms_revision + 1, details: { annualChargeMinor: annual.annualMinor, firstAnnualChargeAt: contract.next_charge_at } };
    }
    case "VERIFY_ELIGIBILITY": {
      const raw = String(p.studentIdNumber ?? "").replace(/\s+/g, "").toUpperCase();
      if (!/^S\d{12}$/.test(raw)) return { error: "VALIDATION", message: "Student ID number not recognised", httpStatus: 422 };
      const acc = mget<any>(db, "SELECT details_json FROM m_accounts WHERE tenant_id=? AND merchant_id=? AND id=?", t, account.merchantId, account.accountId);
      const d = j(acc.details_json);
      d.studentVerification = "VERIFIED";
      d.studentVerifiedUntil = "2027-06-30";
      mrun(db, "UPDATE m_accounts SET details_json=? WHERE tenant_id=? AND merchant_id=? AND id=?", JSON.stringify(d), t, account.merchantId, account.accountId);
      return { effectiveAt: nowIso, accessUntil: null, termsRevision: null, details: { studentVerification: "VERIFIED", validUntil: "2027-06-30", sharedFields: ["student ID number"] } };
    }
    case "ACTIVATE_OFFER": {
      const offer = mget<any>(db, "SELECT * FROM m_offers WHERE tenant_id=? AND id=? AND current=1", t, String(p.offerId));
      if (!offer) return { error: "VALIDATION", message: "Offer not found", httpStatus: 404 };
      if (offer.revision !== Number(p.offerRevision)) return { error: "TERMS_CHANGED", message: `Offer terms are now revision ${offer.revision}`, httpStatus: 409 };
      const acc = mget<any>(db, "SELECT details_json FROM m_accounts WHERE tenant_id=? AND merchant_id=? AND id=?", t, account.merchantId, account.accountId);
      if (j(acc.details_json).studentVerification !== "VERIFIED") return { error: "VALIDATION", message: "Student status must be verified first", httpStatus: 422 };
      const terms = j(offer.terms_json);
      const id = `${t}:student-bundle`;
      if (!mget(db, "SELECT id FROM m_contracts WHERE tenant_id=? AND id=?", t, id)) {
        mrun(
          db,
          `INSERT INTO m_contracts(tenant_id,id,merchant_id,account_id,plan_id,plan_name,price_minor,billing_period,state,auto_renew,next_charge_at,access_until,terms_revision,benefits_json,details_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          t, id, account.merchantId, account.accountId, terms.id, terms.name, terms.monthlyMinor, "MONTHLY", "SCHEDULED", 1, terms.firstChargeAt, null, offer.revision,
          JSON.stringify({ cloudStorageGb: terms.includesCloudStorageGb, offlinePlayback: terms.offlinePlayback, studyTools: true, streaming: true }),
          JSON.stringify({ activatesAt: terms.activationDateAssumed, priceValidUntil: terms.priceValidUntil, postPromotionMonthlyMinor: terms.postPromotionMonthlyMinor }),
        );
      }
      return { effectiveAt: terms.activationDateAssumed, accessUntil: null, termsRevision: offer.revision, details: { contractId: id, firstChargeAt: terms.firstChargeAt, monthlyMinor: terms.monthlyMinor } };
    }
    case "START_MIGRATION": {
      if (details.migration && details.migration.state !== "FAILED") {
        return { effectiveAt: details.migration.startedAt, accessUntil: null, termsRevision: contract.terms_revision, reuseReceipt: details.migration.receipt };
      }
      const completesAt = toLocalIso(toMs(nowIso) + 20 * 60_000);
      details.migration = { state: "IN_PROGRESS", destination: p.destination, gb: details.usedGb, startedAt: nowIso, completesAt };
      mrun(db, "UPDATE m_contracts SET details_json=? WHERE tenant_id=? AND id=?", JSON.stringify(details), t, contract.id);
      return { effectiveAt: nowIso, accessUntil: null, termsRevision: contract.terms_revision, details: { migration: "IN_PROGRESS", destination: p.destination, completesAt } };
    }
    case "REDUCE_SEATS": {
      const ids: string[] = Array.isArray(p.seatIds) ? (p.seatIds as string[]) : [];
      const seats: any[] = details.seats;
      const active = seats.filter((s) => !s.removedFrom);
      const targets = active.filter((s) => ids.includes(s.seatId));
      if (targets.length !== ids.length) return { error: "VALIDATION", message: "Unknown or already removed seat", httpStatus: 400 };
      if (targets.some((s) => /owner|service account/i.test(s.role))) return { error: "VALIDATION", message: "Owner and service-account seats cannot be removed here", httpStatus: 422 };
      if (active.length - ids.length < details.minimumSeats) return { error: "VALIDATION", message: "Plan minimum seats", httpStatus: 422 };
      for (const s of seats) if (ids.includes(s.seatId)) s.removedFrom = contract.next_charge_at;
      const remaining = active.length - ids.length;
      mrun(db, "UPDATE m_contracts SET details_json=?, price_minor=? WHERE tenant_id=? AND id=?", JSON.stringify(details), remaining * details.seatPriceMinor, t, contract.id);
      bump(db, t, contract.id);
      return { effectiveAt: contract.next_charge_at, accessUntil: null, termsRevision: contract.terms_revision + 1, details: { removedSeatIds: ids, seatsAfter: remaining, nextInvoiceMinor: remaining * details.seatPriceMinor } };
    }
    case "SUBMIT_CLAIM": {
      const caseId = `${t}:case-${randomBytes(4).toString("hex")}`;
      const amount = Number(p.amountMinor);
      if (!Number.isSafeInteger(amount) || amount <= 0) return { error: "VALIDATION", message: "Claim amount required", httpStatus: 400 };
      const reviewAt = toLocalIso(toMs(nowIso) + 60 * 60_000);
      mrun(db, `INSERT INTO m_cases(tenant_id,id,merchant_id,account_id,kind,state,amount_minor,reference,details_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        t, caseId, account.merchantId, account.accountId, String(p.kind ?? "CLAIM"), "SUBMITTED", amount, null, JSON.stringify({ orderRef: p.orderRef, evidence: p.evidence ?? [], reviewAt }), nowIso);
      return { effectiveAt: nowIso, accessUntil: null, termsRevision: null, details: { caseId, state: "SUBMITTED", amountMinor: amount, reviewExpectedBy: reviewAt } };
    }
    case "PLACE_ORDER": {
      const order = { ...p, placedAt: nowIso };
      const acc = mget<any>(db, "SELECT details_json FROM m_accounts WHERE tenant_id=? AND merchant_id=? AND id=?", t, account.merchantId, account.accountId);
      const d = j(acc.details_json);
      if (p.creditId) {
        if (!d.credit || d.credit.id !== p.creditId) return { error: "VALIDATION", message: "Credit not found", httpStatus: 400 };
        if (toMs(nowIso) > toMs(d.credit.expiresAt)) return { error: "VALIDATION", message: "Credit expired", httpStatus: 409 };
        if (Number(p.creditAppliedMinor) > d.credit.balanceMinor) return { error: "VALIDATION", message: "Credit balance too low", httpStatus: 409 };
        d.credit.balanceMinor -= Number(p.creditAppliedMinor);
      }
      d.orders = [...(d.orders ?? []), order];
      mrun(db, "UPDATE m_accounts SET details_json=? WHERE tenant_id=? AND merchant_id=? AND id=?", JSON.stringify(d), t, account.merchantId, account.accountId);
      const charge = Number(p.cardChargeMinor ?? 0);
      return { effectiveAt: nowIso, accessUntil: null, termsRevision: null, details: { order, cardChargeMinor: charge, creditRemainingMinor: d.credit?.balanceMinor ?? null } };
    }
    case "SCHEDULE_START": {
      const id = `${t}:cinemax-${String(p.startDate)}`;
      const start = `${p.startDate}T00:00:00+02:00`;
      if (!mget(db, "SELECT id FROM m_contracts WHERE tenant_id=? AND id=?", t, id)) {
        const end = toLocalIso(toMs(start) + 30 * 86_400_000 - 1000);
        mrun(
          db,
          `INSERT INTO m_contracts(tenant_id,id,merchant_id,account_id,plan_id,plan_name,price_minor,billing_period,state,auto_renew,next_charge_at,access_until,terms_revision,benefits_json,details_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          t, id, account.merchantId, account.accountId, "monthly", "CinemaMax Monthly", Number(p.priceMinor), "MONTHLY", "SCHEDULED", 0, start, end, 1, "{}", JSON.stringify({ titles: p.titles ?? [] }),
        );
      }
      return { effectiveAt: start, accessUntil: toLocalIso(toMs(start) + 30 * 86_400_000 - 1000), termsRevision: 1, details: { contractId: id, firstChargeAt: start, autoRenew: false, priceMinor: Number(p.priceMinor) } };
    }
    case "SEND_MESSAGE":
    case "FOLLOW_UP": {
      const msgId = `msg_${randomBytes(6).toString("hex")}`;
      mrun(db, "INSERT INTO m_messages(tenant_id,id,counterparty_id,subject,body,correlation_id,received_at) VALUES (?,?,?,?,?,?,?)", t, msgId, account.merchantId, String(p.subject ?? ""), String(p.body ?? ""), null, nowIso);
      if (account.merchantId === "cafe-aurora") {
        // Scripted fictional counterparty: replies 10 demo minutes later with a partial payment promise.
        mrun(db, `INSERT INTO m_cases(tenant_id,id,merchant_id,account_id,kind,state,amount_minor,reference,details_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          t, `${t}:reply-${msgId}`, account.merchantId, account.accountId, "COUNTERPARTY_REPLY", "SCHEDULED", null, String(p.invoiceNumber ?? ""),
          JSON.stringify({ replyAt: toLocalIso(toMs(nowIso) + 10 * 60_000), promise: [{ day: 5, amountMinor: 400000 }, { day: 12, amountMinor: 800000 }], text: "We can pay 4,000 RON on day 5 and the remaining 8,000 RON on day 12." }), nowIso);
      }
      return { effectiveAt: nowIso, accessUntil: null, termsRevision: null, details: { messageId: msgId, delivered: true } };
    }
    default:
      return { error: "NOT_SUPPORTED", message: "Unsupported operation", httpStatus: 422 };
  }
}

/** Advance merchant-side scheduled work (reviews, migrations, claims, scripted replies, payouts) for one tenant. */
export function tick(db: DatabaseSync, tenantId: string): number {
  let changes = 0;
  const nowIso = merchantNowIso(db, tenantId);
  const now = toMs(nowIso);
  mtx(db, () => {
    for (const r of mall<any>(db, "SELECT * FROM m_requests WHERE tenant_id=? AND status='PENDING_REVIEW' AND resolve_at IS NOT NULL", tenantId)) {
      if (toMs(r.resolve_at) > now) continue;
      const account = mget<any>(db, "SELECT * FROM m_accounts WHERE tenant_id=? AND merchant_id=? AND id=?", tenantId, r.merchant_id, r.account_id);
      const authed: AuthedAccount = { tenantId, merchantId: r.merchant_id, accountId: r.account_id, holder: account.holder, details: j(account.details_json) };
      if (r.resolve_to === "REFUSED") {
        mrun(db, "UPDATE m_requests SET status='REFUSED', reason=?, resolved_at=? WHERE tenant_id=? AND id=?", "The provider declined the request after review.", nowIso, tenantId, r.id);
      } else {
        const contract = r.contract_id ? mget<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND id=?", tenantId, r.contract_id) : null;
        const applied = applyOperation(db, authed, contract, { operation: r.operation, expectedTermsRevision: null, params: j(r.params_json) }, nowIso);
        if ("error" in applied) {
          mrun(db, "UPDATE m_requests SET status='REFUSED', reason=?, resolved_at=? WHERE tenant_id=? AND id=?", applied.message, nowIso, tenantId, r.id);
        } else {
          const ref = applied.reuseReceipt ?? nextReference(db, tenantId, r.merchant_id);
          if (!applied.reuseReceipt) {
            mrun(db, `INSERT INTO m_receipts(tenant_id,ref,merchant_id,account_id,contract_id,request_id,operation,status,effective_at,access_until,terms_revision,correlation_id,channel,details_json,created_at,visible_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              tenantId, ref, r.merchant_id, r.account_id, r.contract_id, r.id, r.operation, "CONFIRMED", applied.effectiveAt, applied.accessUntil, applied.termsRevision, r.correlation_id, r.channel, JSON.stringify(applied.details ?? {}), nowIso, nowIso);
          }
          mrun(db, "UPDATE m_requests SET status='CONFIRMED', receipt_ref=?, resolved_at=? WHERE tenant_id=? AND id=?", ref, nowIso, tenantId, r.id);
        }
      }
      emitEvent(db, tenantId, r.merchant_id, "request.resolved", { requestId: r.id, correlationId: r.correlation_id, contractId: r.contract_id });
      changes++;
    }
    for (const c of mall<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND details_json LIKE '%IN_PROGRESS%'", tenantId)) {
      const d = j(c.details_json);
      if (d.migration?.state === "IN_PROGRESS" && toMs(d.migration.completesAt) <= now) {
        d.migration.state = "VERIFIED";
        d.migration.verifiedAt = nowIso;
        d.migration.filesChecked = true;
        mrun(db, "UPDATE m_contracts SET details_json=?, resource_version=resource_version+1 WHERE tenant_id=? AND id=?", JSON.stringify(d), tenantId, c.id);
        emitEvent(db, tenantId, c.merchant_id, "migration.completed", { contractId: c.id, gb: d.migration.gb, destination: d.migration.destination }, c.resource_version + 1);
        changes++;
      }
    }
    for (const k of mall<any>(db, "SELECT * FROM m_cases WHERE tenant_id=? AND state IN ('SUBMITTED','SCHEDULED','ACCEPTED_PAYOUT_DUE')", tenantId)) {
      const d = j(k.details_json);
      if (k.kind === "COUNTERPARTY_REPLY" && k.state === "SCHEDULED" && toMs(d.replyAt) <= now) {
        mrun(db, "UPDATE m_cases SET state='SENT', updated_at=? WHERE tenant_id=? AND id=?", nowIso, tenantId, k.id);
        emitEvent(db, tenantId, k.merchant_id, "counterparty.reply", { counterparty: k.merchant_id, invoiceNumber: k.reference, text: d.text, promise: d.promise });
        changes++;
      } else if (k.state === "SUBMITTED" && d.reviewAt && toMs(d.reviewAt) <= now) {
        const ref = nextReference(db, tenantId, k.merchant_id);
        d.payoutAt = toLocalIso(now + 2 * 3_600_000);
        mrun(db, "UPDATE m_cases SET state='ACCEPTED_PAYOUT_DUE', reference=?, details_json=?, updated_at=? WHERE tenant_id=? AND id=?", ref, JSON.stringify(d), nowIso, tenantId, k.id);
        emitEvent(db, tenantId, k.merchant_id, "claim.updated", { caseId: k.id, state: "MERCHANT_ACCEPTED", reference: ref, amountMinor: k.amount_minor, payoutExpectedAt: d.payoutAt });
        changes++;
      } else if (k.state === "ACCEPTED_PAYOUT_DUE" && d.payoutAt && toMs(d.payoutAt) <= now) {
        payout(db, tenantId, k, nowIso);
        changes++;
      }
    }
  });
  return changes;
}

/** Simulated payment network: the merchant pays money back to the customer's bank account (unique transfer id). */
export function payout(db: DatabaseSync, tenantId: string, k: any, nowIso: string) {
  mrun(db, "UPDATE m_cases SET state='PAID', updated_at=? WHERE tenant_id=? AND id=?", nowIso, tenantId, k.id);
  emitEvent(db, tenantId, "payment-network", "credit_transfer", {
    transferId: `trf_${randomBytes(8).toString("hex")}`,
    payer: k.merchant_id,
    amountMinor: k.amount_minor,
    currency: "RON",
    reference: k.reference,
    caseId: k.id,
    accountRef: k.account_id,
  });
}
