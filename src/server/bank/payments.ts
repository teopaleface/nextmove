import type { DatabaseSync } from "node:sqlite";
import { all, json, one } from "../db/connection";
import { HttpError, type Session } from "../auth/session";
import { createProposal } from "../authority/authority";
import { DEFAULT_CONSEQUENCES, type ActionSpec } from "../authority/actions";
import { accountsFor, balanceOf } from "./ledger";
import { shortId } from "../canonical";
import { nowIso } from "../clock";
import { formatMoney } from "../../shared/money";
import { proposalView } from "../capabilities/registry";

// Everyday banking drafts: paying a known bill and freezing or unfreezing a card. A draft becomes an immutable
// proposal that needs the same exact approval as any agent action. Payees are limited to bills already known to
// the bank in this context (no free-form IBAN), and execution books only in the synthetic demo ledger.

const money = (m: number) => formatMoney(m, "RON");
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Bucharest" }).format(new Date(iso));

export function payees(db: DatabaseSync, s: Session) {
  const items = all<any>(
    db,
    `SELECT f.*, sub.merchant_name, sub.merchant_id FROM forecast_items f LEFT JOIN subscriptions sub ON sub.id=f.subscription_id
     WHERE f.tenant_id=? AND f.context_id=? AND f.status='SCHEDULED' AND f.kind IN ('BILL','SUPPLIER_PAYMENT','UTILITY') AND f.amount_minor < 0
     ORDER BY f.due_at LIMIT 12`,
    s.tenantId,
    s.contextId,
  );
  const pending = new Set(
    all<any>(db, "SELECT subject_ref FROM proposal_actions WHERE tenant_id=? AND operation='PAYMENT' AND status IN ('PROPOSED','APPROVED','EXECUTING','PENDING','UNKNOWN')", s.tenantId).map((r) => r.subject_ref),
  );
  return items.map((f) => ({
    forecastItemId: f.id,
    payee: f.merchant_name ?? f.label.replace(/ (bill|payment)$/i, ""),
    label: f.label,
    amountMinor: -f.amount_minor,
    dueAt: f.due_at,
    draftPending: pending.has(f.id),
  }));
}

export function paymentDraft(db: DatabaseSync, s: Session, input: { forecastItemId: string; fromAccountId: string; taskId?: string | null }) {
  const item = one<any>(db, "SELECT f.*, sub.merchant_name, sub.merchant_id FROM forecast_items f LEFT JOIN subscriptions sub ON sub.id=f.subscription_id WHERE f.id=? AND f.tenant_id=?", input.forecastItemId, s.tenantId);
  if (!item || item.context_id !== s.contextId) throw new HttpError(404, "NOT_FOUND", "Bill not found in this context");
  if (item.status !== "SCHEDULED") throw new HttpError(409, "ALREADY_PAID", "This bill is no longer scheduled");
  const from = accountsFor(db, s.tenantId, s.contextId).find((a) => a.id === input.fromAccountId);
  if (!from) throw new HttpError(404, "NOT_FOUND", "Account not found in this context");
  const open = one<any>(db, "SELECT id FROM proposal_actions WHERE tenant_id=? AND operation='PAYMENT' AND subject_ref=? AND status IN ('PROPOSED','APPROVED','EXECUTING','PENDING','UNKNOWN')", s.tenantId, item.id);
  if (open) throw new HttpError(409, "ALREADY_IN_PROGRESS", "A payment for this bill is already waiting for approval or running");
  const amount = -Number(item.amount_minor);
  const payee = item.merchant_name ?? String(item.label).replace(/ (bill|payment)$/i, "");
  const balance = balanceOf(db, from.id);
  const spec: ActionSpec = {
    operation: "PAYMENT",
    route: "BANK_INTERNAL",
    capability: "BANK",
    merchantId: item.merchant_id ?? null,
    merchantName: payee,
    subscriberAccountId: null,
    contractId: null,
    canonicalKey: `pay:${item.id}`,
    subjectRef: item.id,
    params: { fromAccountId: from.id, amountMinor: amount, forecastItemId: item.id, description: item.label, category: "Bill payment", draftId: shortId("draft") },
    termsRevision: null,
    money: { currency: "RON", immediateDebitMinor: amount, maxDebitMinor: amount, feesMinor: 0, forecastChangeMinor: 0 },
    consequences: { ...DEFAULT_CONSEQUENCES, effectiveAt: nowIso(db, s.tenantId), remainingObligations: `The ${when(item.due_at)} bill is marked paid in your forecast` },
    dependsOn: [],
    display: {
      title: `Pay ${payee}`,
      summary: `${money(amount)} from ${from.name}, booked now in the demo ledger.`,
      lines: [
        { label: "From", value: `${from.name} (${money(balance)} available)` },
        { label: "To", value: payee },
        { label: "Amount", value: money(amount) },
        { label: "Bill due", value: when(item.due_at) },
        { label: "Fee", value: money(0) },
        { label: "Route", value: "NextMove bank ledger (synthetic)" },
      ],
      confirmLabel: `Pay ${money(amount)}`,
      declineLabel: "Keep as draft",
      note: balance < amount ? "The account does not hold enough money right now; the bank will refuse the payment unless funds arrive first." : "This pays a fictional payee inside the demo bank. No real money moves.",
    },
  };
  const p = createProposal(db, { tenantId: s.tenantId, contextId: s.contextId, actorUserId: s.userId, taskId: input.taskId ?? null, scope: "SINGLE", actions: [{ key: "pay", spec }] });
  return proposalView(db, s, p.id);
}

export function cardDraft(db: DatabaseSync, s: Session, input: { accountId: string; freeze: boolean }) {
  const acct = one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=?", input.accountId, s.tenantId);
  if (!acct || acct.context_id !== s.contextId) throw new HttpError(404, "NOT_FOUND", "Account not found in this context");
  const card = json<any>(acct.card_json, null);
  if (!card) throw new HttpError(409, "NO_CARD", "This account has no card");
  const target = input.freeze ? "FROZEN" : "ACTIVE";
  if (card.status === target) throw new HttpError(409, "NO_CHANGE", `The card is already ${input.freeze ? "frozen" : "active"}`);
  const spec: ActionSpec = {
    operation: "CARD_FREEZE",
    route: "BANK_INTERNAL",
    capability: "BANK",
    merchantId: null,
    merchantName: "NextMove",
    subscriberAccountId: null,
    contractId: null,
    canonicalKey: `card:${acct.id}`,
    subjectRef: acct.id,
    params: { accountId: acct.id, targetStatus: target, draftId: shortId("draft") },
    termsRevision: null,
    money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: 0 },
    consequences: { ...DEFAULT_CONSEQUENCES, effectiveAt: nowIso(db, s.tenantId), lostBenefits: input.freeze ? ["New card payments and cash withdrawals are declined while frozen"] : [] },
    dependsOn: [],
    display: {
      title: input.freeze ? `Freeze card •••• ${card.last4}` : `Unfreeze card •••• ${card.last4}`,
      summary: input.freeze ? "New card payments are declined until you unfreeze it. Scheduled bills from the account still run." : "Card payments work again straight away.",
      lines: [
        { label: "Card", value: `${card.kind ?? "Debit"} card •••• ${card.last4}` },
        { label: "Account", value: acct.name },
        { label: "Change", value: input.freeze ? "Active → Frozen" : "Frozen → Active" },
        { label: "Fee", value: money(0) },
      ],
      confirmLabel: input.freeze ? "Freeze card" : "Unfreeze card",
      declineLabel: "Not now",
      note: "You can reverse this at any time from the account page.",
    },
  };
  const p = createProposal(db, { tenantId: s.tenantId, contextId: s.contextId, actorUserId: s.userId, scope: "SINGLE", actions: [{ key: "card", spec }] });
  return proposalView(db, s, p.id);
}
