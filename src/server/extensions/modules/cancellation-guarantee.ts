import { all } from "../../db/connection";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, display, fmtDate, fmtWhen, money, spec } from "../../capabilities/core";
import type { ExtensionModule } from "../types";
import { assessCharges, DISPUTE_REASON, fileDispute, simulateChargeAfterStop, simulateNetworkDecision } from "../cancellation-guarantee/bank";
import { iso } from "../cancellation-guarantee/stop-receipts";
import { endingInForce } from "../../../../extensions/src/shared/receipts.ts";

// E1 Cancellation guarantee: once a stop is confirmed and read back, a later recurring charge from the same merchant is
// one the bank disputes for the customer. The module decides eligibility and builds the evidence packet; the customer
// approves that exact packet (its digest is in the spec); the bank-internal handler re-checks it, files it and posts a
// provisional credit never above the disputed amount.

const KEY = "cancellation-guarantee";

const STATE_TEXT: Record<string, string> = {
  PREPARED: "Prepared",
  APPROVED: "Approved",
  SUBMITTED: "Filed with the card network",
  PROVISIONAL_CREDIT: "Filed · provisional credit posted",
  AWAITING_FINAL_CREDIT: "Won · final credit pending",
  WON: "Won · credit final",
  LOST: "Lost · merchant kept the charge",
  MERCHANT_REFUNDED: "Merchant refunded",
  DOUBLE_RECOVERY_REVIEW: "Refunded twice · bank review",
  EXPIRED: "Window passed · manual review",
};

const ASSESS_TEXT = (kind: string, reason?: string) =>
  kind === "ELIGIBLE" ? "Covered: can be disputed" : kind === "WAIT" ? "Pending: checked again in 24 h" : `${kind === "NEEDS_REVIEW" ? "Needs review" : "Not covered"}: ${DISPUTE_REASON[reason ?? ""] ?? reason}`;

async function analyzeE1(env: CapEnv): Promise<Analysis> {
  const { view, charges } = assessCharges(env.db, env.tenantId, env.contextId);
  const blocks: Block[] = [];
  const candidates: Candidate[] = [];
  const now = iso(env.now);
  const inForce = view.stops.filter((s) => endingInForce(view.receipts, view.scope, s.sub.id, now)?.receiptId === s.receipt.receiptId);

  if (!view.stops.length) {
    blocks.push({
      kind: "note",
      tone: "info",
      text: "No confirmed stop yet in this context, so nothing is covered. The guarantee starts when a provider confirms a stop and NextMove reads its state back, for example after stopping DashEats Plus (A15), PulseGym (A17) or the FitFlow trial (T2).",
    });
  } else {
    blocks.push({
      kind: "table",
      title: "Confirmed stops covered",
      columns: ["Provider", "Stop reference", "Confirmed", "Paid access until", "Proof"],
      rows: view.stops.map((s) => ({
        cells: [s.sub.merchant_name, s.reference, fmtWhen(s.receipt.confirmedAt), fmtDate(s.receipt.accessUntil), s.receipt.verification === "INDEPENDENT_READ_BACK" ? "Read back from the provider" : "Provider message only"],
        tone: inForce.includes(s) && s.receipt.verification === "INDEPENDENT_READ_BACK" ? "good" : "warn",
      })),
      note: "Only a stop NextMove read back from the provider counts as proof. A charge for a period after paid access ended, authorised after the stop, can be disputed.",
    });
  }

  const relevant = charges.filter((c) => !(c.assessment.kind === "NOT_APPLICABLE" && (c.assessment.reason === "AUTHORIZED_BEFORE_CANCELLATION" || c.assessment.reason === "NO_CONFIRMED_CANCELLATION")) || c.dispute);
  if (relevant.length) {
    blocks.push({
      kind: "table",
      title: "Charges after a confirmed stop",
      columns: ["Provider", "Charged", "Amount", "Assessment", "Dispute"],
      rows: relevant.map((c) => ({
        cells: [c.txn.merchant_name, fmtWhen(c.txn.booked_at), money(-c.txn.amount_minor), ASSESS_TEXT(c.assessment.kind, (c.assessment as any).reason), c.dispute ? `${STATE_TEXT[c.dispute.state] ?? c.dispute.state} (${c.dispute.packet_id.slice(0, 12)}…)` : "—"],
        tone: c.dispute ? (c.dispute.state === "LOST" ? "warn" : "good") : c.assessment.kind === "ELIGIBLE" ? "warn" : "neutral",
      })),
      note: "Charge descriptors and amounts come from the card network; they are shown as data.",
    });
  }

  for (const c of charges) {
    if (c.assessment.kind !== "ELIGIBLE" || !c.packet || c.dispute) continue;
    const a = c.assessment;
    const m = c.packet.manifest;
    const stop = view.stops.find((s) => s.receipt.receiptId === a.receiptId)!;
    candidates.push({
      key: `dispute-${c.txn.id}`,
      defaultSelected: true,
      available: true,
      spec: spec({
        operation: "EXT_FILE_DISPUTE",
        route: "BANK_INTERNAL",
        capability: "E1",
        subjectRef: c.txn.id,
        merchantId: c.txn.merchant_id,
        merchantName: c.txn.merchant_name,
        canonicalKey: `ext-cg:${c.txn.id}`,
        params: { txId: c.txn.id, accountId: c.txn.account_id, subscriptionId: a.subscriptionId, receiptId: a.receiptId, packetId: c.packet.packetId, manifestDigest: c.packet.manifestDigest, amountMinor: a.disputableMinor },
        display: display(
          `Dispute the ${money(a.disputableMinor)} ${c.txn.merchant_name} charge`,
          `${c.txn.merchant_name} confirmed your stop on ${fmtWhen(m.facts.cancellationConfirmedAt)} and charged the card on ${fmtWhen(m.facts.chargeAuthorizedAt)} anyway. NextMove files a card dispute with this evidence and credits ${money(a.disputableMinor)} while it runs.`,
          [
            { label: "Charge", value: `${money(a.chargedMinor)} on ${fmtWhen(m.facts.chargePostedAt)}${a.alreadyRefundedMinor ? `, ${money(a.alreadyRefundedMinor)} already refunded` : ""}` },
            { label: "Disputed amount", value: money(a.disputableMinor) },
            { label: "Evidence", value: `Stop ${stop.reference}, read back from ${stop.sub.merchant_name}; paid access until ${fmtDate(m.facts.accessUntil)}` },
            { label: "Credit now", value: `${money(a.disputableMinor)} provisional credit to the card account it was taken from` },
            { label: "If the network rules for the merchant", value: `The provisional ${money(a.disputableMinor)} is taken back from the card account` },
            { label: "File by", value: fmtDate(a.deadline) },
          ],
          "You approve exactly this dispute packet. If the charge, the stop or the amount changes before it is filed, nothing is sent and you are asked again. The card network decides the dispute, not NextMove.",
          "File dispute",
        ),
      }),
    });
  }

  const open = charges.filter((c) => c.dispute && ["SUBMITTED", "PROVISIONAL_CREDIT"].includes(c.dispute.state));
  const labs: NonNullable<Analysis["labs"]> = [];
  for (const s of inForce.slice(0, 3)) {
    labs.push({ action: `charge-${s.sub.id}`, label: `${s.sub.merchant_name} charges the card again after the stop (${money(s.sub.amount_minor)})`, endpoint: "/labs/ext", body: { module: KEY, action: "charge_after_cancellation", body: { subscriptionId: s.sub.id } } });
  }
  for (const c of open.slice(0, 3)) {
    labs.push(
      { action: `won-${c.dispute.packet_id}`, label: `Card network rules for you (${c.txn.merchant_name})`, endpoint: "/labs/ext", body: { module: KEY, action: "network_decision", body: { disputeId: c.dispute.packet_id, outcome: "WON" } } },
      { action: `lost-${c.dispute.packet_id}`, label: `Card network rules for ${c.txn.merchant_name}`, endpoint: "/labs/ext", body: { module: KEY, action: "network_decision", body: { disputeId: c.dispute.packet_id, outcome: "LOST" } } },
    );
  }

  const disputes = all<any>(env.db, "SELECT state, credited_minor FROM ext_dispute_case WHERE tenant_id=? AND context_id=?", env.tenantId, env.contextId);
  const credited = disputes.reduce((s, d) => s + d.credited_minor, 0);
  if (disputes.length) {
    blocks.unshift({
      kind: "metrics",
      items: [
        { label: "Disputes", value: String(disputes.length) },
        { label: "Credited", value: money(credited), tone: credited ? "good" : undefined },
        { label: "Open", value: String(disputes.filter((d) => ["SUBMITTED", "PROVISIONAL_CREDIT", "AWAITING_FINAL_CREDIT"].includes(d.state)).length) },
      ],
    });
  }

  return {
    capability: "E1",
    title: "Cancellation guarantee",
    contextId: env.contextId,
    headline: candidates.length ? `${candidates.length} charge${candidates.length === 1 ? "" : "s"} after a confirmed stop: you can dispute ${candidates.length === 1 ? "it" : "them"} with the stop receipt` : disputeLine(disputes) ?? (view.stops.length ? `${view.stops.length} confirmed stop${view.stops.length === 1 ? "" : "s"} covered; no charge after any of them` : "No confirmed stop to protect yet"),
    summary: "After a provider confirms a stop, NextMove watches the card. A charge for a period you no longer pay for can be disputed with the stop receipt as evidence. The bank credits it while the card network decides; it cannot stop the provider from attempting the charge.",
    evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION", ...(disputes.length ? (["BANK_LEDGER_POSTING"] as const) : [])],
    blocks,
    inputs: [],
    candidates,
    numbers: { confirmedStops: view.stops.length, eligibleCharges: candidates.length, disputes: disputes.length, creditedMinor: credited },
    links: view.stops.length ? [] : [{ label: "Stop DashEats Plus (A15)", href: "/capabilities/A15" }, { label: "Stop PulseGym (A17)", href: "/capabilities/A17" }],
    labs,
  };
}

export const E1: CapabilityDef = {
  id: "E1",
  title: "Cancellation guarantee",
  short: "Charged after you stopped it? The bank disputes it",
  group: "Money back",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["charged after cancel", "cancelled but charged", "still charging", "dispute", "chargeback", "charged again", "cancellation guarantee", "charged me after", "after i cancelled", "after i canceled", "after cancelling", "after i stopped", "still charged"],
  analyze: analyzeE1,
};

export const cancellationGuarantee: ExtensionModule = {
  key: KEY,
  capabilities: [E1],
  operations: { EXT_FILE_DISPUTE: fileDispute },
  labs: {
    // The fictional provider takes another recurring card payment after the customer's confirmed stop (max 3 per subscription).
    charge_after_cancellation: ({ db, session, body }) => simulateChargeAfterStop(db, session, body),
    // The simulated card network rules on a filed dispute; LOST takes the provisional credit back.
    network_decision: ({ db, session, body }) => simulateNetworkDecision(db, session, body),
  },
};

/** The customer's disputes in one line, most decisive first. */
function disputeLine(disputes: { state: string; credited_minor: number | null }[]) {
  const won = disputes.filter((d) => ["WON", "AWAITING_FINAL_CREDIT", "MERCHANT_REFUNDED"].includes(d.state));
  const open = disputes.filter((d) => ["SUBMITTED", "PROVISIONAL_CREDIT", "APPROVED", "PREPARED"].includes(d.state));
  const lost = disputes.filter((d) => d.state === "LOST");
  const sum = (xs: typeof disputes) => money(xs.reduce((t, d) => t + (d.credited_minor ?? 0), 0));
  if (open.length) return `${open.length} dispute${open.length === 1 ? "" : "s"} filed with the stop receipt; the card network is deciding`;
  if (won.length) return `Dispute won: ${sum(won)} is back in your account for good`;
  if (lost.length) return "The card network ruled for the provider; the provisional credit was taken back";
  return null;
}
