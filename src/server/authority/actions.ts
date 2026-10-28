// Server-built action specifications. The model may reference a candidate by id; it can never author a spec,
// a destination, an amount or an approval.

export type Route = "PARTNER_API" | "ISOLATED_BROWSER" | "BANK_INTERNAL" | "LOCAL_PREPARATION";

export type Operation =
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
  | "FOLLOW_UP"
  | "OWNER_TRANSFER"
  | "PAYMENT"
  | "CARD_FREEZE"
  | "PREPARE_PACKET";

export interface DisplayLine {
  label: string;
  value: string;
}

export interface ActionSpec {
  operation: Operation;
  route: Route;
  capability: string; // O1..A14 / T1..T3 / BANK
  merchantId: string | null;
  merchantName: string | null;
  subscriberAccountId: string | null;
  contractId: string | null;
  canonicalKey: string | null;
  subjectRef: string; // bank-side subject (subscription, recovery, record)
  params: Record<string, unknown>;
  termsRevision: number | null;
  money: {
    currency: "RON";
    immediateDebitMinor: number; // money that may leave an account because of this action
    maxDebitMinor: number; // hard ceiling the bank will accept for any resulting charge
    feesMinor: number;
    forecastChangeMinor: number; // change to the dated forecast in the comparison window (negative = less due)
  };
  consequences: {
    effectiveAt: string | null;
    accessUntil: string | null;
    lostBenefits: string[];
    dataEffect: string | null;
    remainingObligations: string | null;
  };
  dependsOn: string[]; // candidate keys of prerequisite actions in the same proposal
  display: {
    title: string;
    summary: string;
    lines: DisplayLine[];
    confirmLabel: string;
    declineLabel: string;
    note: string;
  };
}

export const DEFAULT_MONEY = { currency: "RON" as const, immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: 0 };
export const DEFAULT_CONSEQUENCES = { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: null };
