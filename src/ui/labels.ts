// Customer-facing wording for stored states. Pending, accepted and credited money stay distinct.

export function recoveryState(state: string): { tone: "ok" | "warn" | "bad" | "neutral"; text: string } {
  switch (state) {
    case "SUBMITTED":
      return { tone: "neutral", text: "Requested" };
    case "MERCHANT_ACCEPTED":
    case "AWAITING_CREDIT":
      return { tone: "neutral", text: "Accepted by merchant, waiting for bank credit" };
    case "CREDITED":
      return { tone: "ok", text: "Credited to your account" };
    case "DRAFT":
      return { tone: "neutral", text: "Draft prepared, nothing sent" };
    case "CLAIM_SUBMITTED":
      return { tone: "neutral", text: "Claim submitted, waiting for the merchant" };
    case "OVERDUE":
      return { tone: "warn", text: "The expected credit date has passed" };
    case "REJECTED":
    case "DECLINED":
      return { tone: "bad", text: "Declined by the merchant" };
    default:
      return { tone: "neutral", text: state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ") };
  }
}

export function subState(s: string) {
  return ({ ACTIVE: "active", TRIAL: "free trial", RENEWAL_OFF: "renewal off", CANCELLATION_PENDING: "cancellation pending", CANCELLED: "cancelled", PAUSED: "paused" } as Record<string, string>)[s] ?? s.toLowerCase().replace(/_/g, " ");
}

export function recoveryKind(kind: string) {
  return ({ REFUND: "refund", PRICE_ADJUSTMENT: "price adjustment", DUPLICATE_CLAIM: "duplicate charge claim", DUPLICATE: "possible duplicate charge", CLAIM: "claim" } as Record<string, string>)[kind] ?? kind.toLowerCase().replace(/_/g, " ");
}

export function forecastKind(kind: string) {
  return ({ RENEWAL: "Renewal", TRIAL_CONVERSION: "Trial becomes paid", BILL: "Bill", PLANNED_TRANSFER: "Planned transfer", RECEIVABLE: "Expected from a customer", SUPPLIER_PAYMENT: "Supplier payment", ORDER: "Order", HELD_CHARGE: "Held charge, needs your decision" } as Record<string, string>)[kind] ?? kind.toLowerCase().replace(/_/g, " ");
}

/** Where to go from a subscription or bill: the capabilities that concern this provider. */
export const PROVIDER_CAPABILITIES: Record<string, { id: string; label: string }[]> = {
  fitflow: [{ id: "T2", label: "Stop the trial before it charges" }],
  studyplus: [
    { id: "T3", label: "Compare the student bundle" },
    { id: "A3", label: "Monthly or annual" },
  ],
  streamly: [
    { id: "A4", label: "The price went up" },
    { id: "A6", label: "Pause for a month instead" },
    { id: "T3", label: "Compare the student bundle" },
  ],
  cloudbox: [{ id: "A1", label: "Check for duplicate storage" }],
  mobilenet: [{ id: "A2", label: "Right-size the phone plan" }],
  cinemamax: [{ id: "A5", label: "Time it around the shows you want" }],
  electracasa: [{ id: "A11", label: "Move the bill's date" }],
  teamdesk: [{ id: "A13", label: "Remove unused seats" }],
};
