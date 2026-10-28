// Contract between the bank (worker/app) and the simulated merchant origin. The merchant is a separate process
// with its own database; the bank only learns merchant state through these HTTP interfaces.

export type MerchantOperation =
  | "STOP_RENEWAL"
  | "CHANGE_PLAN"
  | "PAUSE"
  | "CHANGE_BILLING_DATE"
  | "CHANGE_BILLING_PERIOD"
  | "ACTIVATE_OFFER"
  | "VERIFY_ELIGIBILITY"
  | "START_MIGRATION"
  | "REDUCE_SEATS"
  | "SUBMIT_CLAIM"
  | "PLACE_ORDER"
  | "SCHEDULE_START"
  | "SEND_MESSAGE"
  | "FOLLOW_UP";

export type ContractState = "TRIAL" | "ACTIVE" | "RENEWAL_OFF" | "PAUSED" | "CANCELLED" | "SCHEDULED";

export interface MerchantContractView {
  merchantId: string;
  merchantName: string;
  accountId: string;
  contractId: string;
  planId: string;
  planName: string;
  priceMinor: number;
  currency: "RON";
  billingPeriod: "MONTHLY" | "ANNUAL" | "PER_SEAT_MONTHLY" | "ONE_OFF";
  state: ContractState;
  autoRenew: boolean;
  nextChargeAt: string | null;
  accessUntil: string | null;
  termsRevision: number;
  resourceVersion: number;
  minimumTermUntil: string | null;
  exitFeeMinor: number | null;
  ownerKind: "SELF" | "HOUSEHOLD_MEMBER";
  shared: boolean;
  protectedReason: string | null;
  benefits: Record<string, unknown>;
  details: Record<string, unknown>;
  pending: Record<string, unknown> | null;
  observedAt: string;
}

export interface MerchantReceiptView {
  reference: string;
  merchantId: string;
  accountId: string;
  contractId: string | null;
  operation: MerchantOperation;
  status: "CONFIRMED" | "REFUSED";
  effectiveAt: string | null;
  accessUntil: string | null;
  termsRevision: number | null;
  correlationId: string | null;
  channel: "API" | "WEB";
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MerchantRequestView {
  requestId: string;
  correlationId: string | null;
  operation: MerchantOperation;
  status: "CONFIRMED" | "PENDING_REVIEW" | "REFUSED";
  receipt: MerchantReceiptView | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OperationRequestBody {
  operation: MerchantOperation;
  expectedTermsRevision: number | null;
  params: Record<string, unknown>;
}

export type OperationResponse =
  | { status: "CONFIRMED"; request: MerchantRequestView; receipt: MerchantReceiptView }
  | { status: "PENDING_REVIEW"; request: MerchantRequestView }
  | { status: "REFUSED"; request: MerchantRequestView; reason: string }
  | { error: "TERMS_CHANGED"; currentRevision: number; message: string }
  | { error: "AUTH_EXPIRED"; message: string }
  | { error: "IDEMPOTENCY_CONFLICT"; message: string }
  | { error: "NOT_SUPPORTED"; message: string }
  | { error: "VALIDATION"; message: string };

export interface MerchantDirectoryEntry {
  id: string;
  name: string;
  connector: "PARTNER_API" | "ISOLATED_BROWSER" | "NONE";
  readApi: boolean;
  operations: MerchantOperation[];
  manualRoute: string | null;
  category: string;
}

/** Signed event delivered from the merchant (or the simulated payment network) to the bank inbox. */
export interface MerchantEvent {
  eventId: string;
  issuer: string; // merchant id or "payment-network"
  tenantId: string;
  kind:
    | "request.resolved"
    | "offer.terms_changed"
    | "refund.accepted"
    | "claim.updated"
    | "counterparty.reply"
    | "credit_transfer"
    | "migration.completed"
    | "contract.updated";
  resourceVersion: number | null;
  occurredAt: string;
  data: Record<string, unknown>;
}

export const SIGNATURE_HEADER = "x-nextmove-signature";

/**
 * What a partner operation's HMAC covers: method and path (so a signature for one contract cannot be replayed
 * against another), then correlation id, idempotency key and the raw body. `path` is the URL pathname as sent,
 * percent-encoding included.
 */
export function partnerSigningString(method: string, path: string, correlationId: string, idempotencyKey: string, rawBody: string): string {
  return [method.toUpperCase(), path, correlationId, idempotencyKey, rawBody].join("\n");
}
export const CORRELATION_HEADER = "x-nextmove-correlation";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const ADMIN_HEADER = "x-merchant-admin";
