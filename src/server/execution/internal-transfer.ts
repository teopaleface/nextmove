import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { sha256Hex } from "../canonical";
import { nowIso, nowMs } from "../clock";
import { balanceOf, postInternalTransfer } from "../bank/ledger";
import { recordConfirmed, recordSettled } from "./effects";
import { taskEvent, taskIdForAction } from "../agent/events";
import { DEFAULT_CONSEQUENCES, type ActionSpec, type DisplayLine } from "../authority/actions";
import { formatMoney } from "../../shared/money";
import { formatDayTime, toMs } from "../../shared/time";

// INTERNAL_TRANSFER: money between two of the customer's own accounts in the same context (current account ↔
// pocket). It follows the same path as every other action: server-built spec → digested manifest → mandate and
// per-action grant → dispatch gate under the worker's fence → one balanced ledger posting keyed by the action's
// logical key → receipt. A scheduled leg waits for its approved demo-time date; a crash after the gate leaves the
// attempt UNKNOWN and reconciliation reads the ledger (the bank's own system of record) before anything else.

export type TransferPurpose = "VAULT_PARK" | "VAULT_RETURN" | "VAULT_RETURN_ALL" | "SHIELD_TOP_UP" | "PUT_TO_WORK_SAVINGS" | "PUT_TO_WORK_BONDS" | "MANUAL";

export interface TransferParams {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  /** EXACT moves the approved amount or nothing; UP_TO moves what is there, never more than approved. */
  mode: "EXACT" | "UP_TO";
  /** Demo-time instant for a scheduled leg; null moves as soon as the worker passes the gate. */
  executeAt: string | null;
  /** Approved rule: run a scheduled leg early when the destination balance drops below this amount. */
  returnEarlyBelowMinor: number | null;
  purpose: TransferPurpose;
  description: string;
  planId: string | null;
  legId: string;
  /** Opens the destination pocket on first use (same context, same customer). */
  openPocket: { name: string; kind: string } | null;
  /** Park legs: the scheduled returns this park relies on, shown in the forecast once the park posts. */
  returnSchedule?: { legId: string; returnAt: string; amountMinor: number; label: string }[];
  /** Return legs: the bills this money is for, as known at approval (used to detect changed bill amounts). */
  covers?: { label: string; amountMinor: number; dueAt: string }[];
}

export interface TransferAccount {
  id: string;
  name: string;
  balanceMinor: number;
}

/** Build the server-side spec for one transfer leg. Other capabilities reuse this; the model never authors it. */
export function internalTransferSpec(i: {
  capability: string;
  subjectRef: string;
  from: TransferAccount;
  to: TransferAccount;
  params: Omit<TransferParams, "fromAccountId" | "toAccountId">;
  title: string;
  summary: string;
  extraLines?: DisplayLine[];
  note?: string;
  dependsOn?: string[];
}): ActionSpec {
  const p: TransferParams = { ...i.params, fromAccountId: i.from.id, toAccountId: i.to.id };
  const when = p.executeAt ? `${formatDayTime(p.executeAt)} (demo clock)` : "As soon as you approve";
  const amount = p.mode === "UP_TO" ? `Up to ${formatMoney(p.amountMinor)}` : formatMoney(p.amountMinor);
  return {
    operation: "INTERNAL_TRANSFER",
    route: "BANK_INTERNAL",
    capability: i.capability,
    merchantId: null,
    merchantName: "NextMove bank",
    subscriberAccountId: null,
    contractId: null,
    canonicalKey: null,
    subjectRef: i.subjectRef,
    params: p as unknown as Record<string, unknown>,
    termsRevision: null,
    money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: p.amountMinor, feesMinor: 0, forecastChangeMinor: 0 },
    consequences: { ...DEFAULT_CONSEQUENCES, effectiveAt: p.executeAt, remainingObligations: p.returnEarlyBelowMinor != null ? `Runs early if ${i.to.name} drops below ${formatMoney(p.returnEarlyBelowMinor)}` : null },
    dependsOn: i.dependsOn ?? [],
    display: {
      title: i.title,
      summary: i.summary,
      lines: [
        { label: "From", value: p.executeAt ? i.from.name : `${i.from.name} · ${formatMoney(i.from.balanceMinor)} → ${formatMoney(i.from.balanceMinor - p.amountMinor)}` },
        { label: "To", value: p.openPocket ? `${i.to.name} (opens with this transfer)` : p.executeAt ? i.to.name : `${i.to.name} · ${formatMoney(i.to.balanceMinor)} → ${formatMoney(i.to.balanceMinor + p.amountMinor)}` },
        { label: "Amount", value: amount },
        { label: "When", value: when },
        ...(i.extraLines ?? []),
        { label: "Fees", value: "None" },
      ],
      note: i.note ?? "Both accounts are yours. One balanced posting; your total funds do not change.",
      confirmLabel: "Approve",
      declineLabel: "Not now",
    },
  };
}

export function transferParams(spec: ActionSpec): TransferParams {
  return spec.params as unknown as TransferParams;
}

export function transferReference(logicalKey: string) {
  return `NMT-${sha256Hex(logicalKey).slice(0, 10).toUpperCase()}`;
}

function sourceEventId(action: any) {
  return `transfer:${action.logical_key}`;
}

/**
 * Called before an attempt is created. Returns a re-queue time while a scheduled leg is not due yet, or null when
 * the leg should run now (due, unscheduled, or the approved early-return rule applies).
 */
export function transferWait(db: DatabaseSync, action: any, spec: ActionSpec): { availableAt: string } | null {
  const p = transferParams(spec);
  if (!p.executeAt) return null;
  const now = nowMs(db, action.tenant_id);
  const due = toMs(p.executeAt);
  if (now >= due) return null;
  if (p.returnEarlyBelowMinor != null) {
    const dest = one<any>(db, "SELECT id FROM accounts WHERE id=? AND tenant_id=? AND context_id=?", p.toAccountId, action.tenant_id, action.context_id);
    if (dest && balanceOf(db, dest.id) < p.returnEarlyBelowMinor) return null;
  }
  // Poll at most every 3 s of real time; Labs may move the demo clock forward at any moment.
  return { availableAt: new Date(Date.now() + Math.min(3000, Math.max(250, due - now))).toISOString() };
}

type Authorize = () => Promise<{ ok: true } | { ok: false; reason: string }>;

function account(db: DatabaseSync, action: any, id: string) {
  return one<any>(db, "SELECT * FROM accounts WHERE id=? AND tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING'", id, action.tenant_id, action.context_id);
}

/** Checks that do not depend on the gate. Returns a refusal reason, a no-change reason, or the amount to move. */
function precheck(db: DatabaseSync, action: any, spec: ActionSpec): { refuse: string } | { noChange: string } | { amountMinor: number } {
  const p = transferParams(spec);
  const approved = Number(p.amountMinor);
  if (!Number.isSafeInteger(approved) || approved <= 0) return { refuse: "The approved amount is not a positive whole number of bani" };
  const grant = one<any>(db, "SELECT max_debit_minor FROM grants WHERE action_id=?", action.id);
  if (!grant || approved > grant.max_debit_minor || approved > spec.money.maxDebitMinor) return { refuse: "Amount exceeds the approved maximum" };
  if (p.fromAccountId === p.toAccountId) return { refuse: "Source and destination are the same account" };
  const from = account(db, action, p.fromAccountId);
  if (!from) return { refuse: "Source account not found in this context" };
  const to = account(db, action, p.toAccountId);
  // A pocket may be opened by its first transfer, but only under this tenant's own id namespace.
  if (!to && !(p.openPocket && p.toAccountId.startsWith(`${action.tenant_id}:`) && !one(db, "SELECT id FROM accounts WHERE id=?", p.toAccountId))) return { refuse: "Destination account not found in this context" };
  // A park is only safe together with its approved returns: if any return leg was left out, nothing moves.
  if (p.purpose === "VAULT_PARK" && p.returnSchedule?.length) {
    const siblings = all<any>(db, "SELECT spec_json, status FROM proposal_actions WHERE proposal_id=? AND id != ?", action.proposal_id, action.id).map((r) => ({ status: r.status, p: transferParams(json<ActionSpec>(r.spec_json)) }));
    const okLegs = new Set(siblings.filter((x) => ["APPROVED", "EXECUTING", "CONFIRMED", "NO_CHANGE"].includes(x.status)).map((x) => x.p.legId));
    if (p.returnSchedule.some((r) => !okLegs.has(r.legId))) return { refuse: "The scheduled returns were not approved with this park, so nothing moved. Approve the whole plan." };
  }
  const bal = balanceOf(db, from.id);
  if (p.mode === "UP_TO") {
    const amount = Math.min(approved, Math.max(0, bal));
    return amount > 0 ? { amountMinor: amount } : { noChange: `Nothing left in ${from.name} to move` };
  }
  if (bal < approved) return { refuse: `Not enough in ${from.name}: ${formatMoney(bal)} available, ${formatMoney(approved)} approved. Nothing moved.` };
  return { amountMinor: approved };
}

/** Post the transfer and its receipt in one transaction. Re-checks funds inside the transaction. */
function commit(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, via: string) {
  const p = transferParams(spec);
  const t = action.tenant_id;
  tx(db, () => {
    const existing = one<any>(db, "SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, sourceEventId(action));
    let amount: number;
    if (existing) {
      amount = Number(one<any>(db, "SELECT amount_minor FROM ledger_lines WHERE entry_id=? AND account_id=?", existing.id, p.toAccountId)?.amount_minor ?? 0);
    } else {
      const pre = precheck(db, action, spec);
      if ("refuse" in pre) return void recordSettled(db, action.id, attemptId, "REFUSED", { reason: pre.refuse });
      if ("noChange" in pre) return void recordSettled(db, action.id, attemptId, "NO_CHANGE", { reason: pre.noChange });
      amount = pre.amountMinor;
      if (p.openPocket && !account(db, action, p.toAccountId)) {
        const ord = one<any>(db, "SELECT MAX(ordinal) o FROM accounts WHERE tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING'", t, action.context_id)?.o ?? 0;
        run(db, "INSERT INTO accounts(id, tenant_id, context_id, name, kind, iban_masked, currency, opening_minor, ordinal, card_json) VALUES (?,?,?,?,?, NULL, 'RON', 0, ?, NULL)", p.toAccountId, t, action.context_id, p.openPocket.name, p.openPocket.kind, ord + 1);
      }
    }
    const reference = transferReference(action.logical_key);
    const posted = postInternalTransfer(db, { tenantId: t, sourceEventId: sourceEventId(action), fromAccountId: p.fromAccountId, toAccountId: p.toAccountId, amountMinor: amount, description: p.description, bookedAt: nowIso(db, t), reference });
    const lines = all<any>(db, "SELECT account_id, amount_minor FROM ledger_lines WHERE entry_id=?", posted.entryId);
    const balanced = lines.reduce((s, l) => s + l.amount_minor, 0) === 0;
    const early = Boolean(p.executeAt && nowMs(db, t) < toMs(p.executeAt));
    recordConfirmed(db, action.id, attemptId, {
      issuer: "nextmove-bank",
      reference,
      effectiveAt: nowIso(db, t),
      accessUntil: null,
      termsRevision: null,
      details: { amountMinor: amount, approvedMinor: p.amountMinor, from: p.fromAccountId, to: p.toAccountId, entryId: posted.entryId, purpose: p.purpose, legId: p.legId, planId: p.planId, early, fromBalanceAfterMinor: balanceOf(db, p.fromAccountId), toBalanceAfterMinor: balanceOf(db, p.toAccountId) },
      channel: "BANK",
      verification: {
        method: `ledger posting read back (${via})`,
        checks: [
          `entry ${posted.entryId} ${balanced ? "balanced" : "NOT balanced"} across ${lines.length} lines`,
          "unique source event per approved action",
          "both accounts belong to this customer and context",
          ...(early ? ["ran early under the approved early-return rule"] : []),
          ...(p.mode === "UP_TO" && amount < p.amountMinor ? [`moved ${formatMoney(amount)} of up to ${formatMoney(p.amountMinor)}`] : []),
        ],
      },
      evidence: "BANK_LEDGER_POSTING",
    });
  });
}

/** Execute one approved leg. `deny` closes the attempt when the gate refuses (revoked, expired, digest…). */
export async function runInternalTransfer(db: DatabaseSync, action: any, spec: ActionSpec, attemptId: string, authorize: Authorize, deny: (reason: string) => void) {
  const pre = precheck(db, action, spec);
  if ("refuse" in pre) return void tx(db, () => recordSettled(db, action.id, attemptId, "REFUSED", { reason: pre.refuse }));
  if ("noChange" in pre) return void tx(db, () => recordSettled(db, action.id, attemptId, "NO_CHANGE", { reason: pre.noChange }));
  const gate = await authorize();
  if (!gate.ok) return deny(gate.reason);
  run(db, "UPDATE attempts SET status='SENT' WHERE id=? AND status='DISPATCH_AUTHORIZED'", attemptId);
  commit(db, action, spec, attemptId, "after the dispatch gate");
}

/**
 * Reconcile an UNKNOWN transfer attempt (the worker stopped between the gate and the commit). The ledger is the
 * bank's own record: an entry for this action's source event means it posted; no entry means the posting never
 * committed, so it may be completed under the same consumed grant only while the approval is still active.
 */
export function reconcileInternalTransfer(db: DatabaseSync, attempt: any, action: any, spec: ActionSpec, checkNo: number) {
  const taskId = taskIdForAction(db, action.id);
  const entry = one<any>(db, "SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", action.tenant_id, sourceEventId(action));
  const mandate = one<any>(db, "SELECT m.status FROM grants g JOIN mandates m ON m.id=g.mandate_id WHERE g.id=?", attempt.grant_id);
  if (entry) {
    taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: the bank ledger shows the transfer (${entry.id}); recording the receipt`, evidence: "BANK_LEDGER_POSTING" });
    return commit(db, action, spec, attempt.id, `reconciliation check ${checkNo}`);
  }
  if (mandate?.status === "ACTIVE") {
    taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: no posting in the ledger; completing the approved transfer once`, evidence: "BANK_LEDGER_POSTING" });
    return commit(db, action, spec, attempt.id, `reconciliation check ${checkNo}`);
  }
  taskEvent(db, { taskId, tenantId: action.tenant_id, kind: "reconcile", label: `Check ${checkNo}: no posting in the ledger and the approval was stopped; nothing moved`, evidence: "BANK_LEDGER_POSTING" });
  tx(db, () => recordSettled(db, action.id, attempt.id, "REVOKED", { reason: "You stopped this approval before the transfer posted. Nothing moved." }));
}

/** Pending scheduled legs of a plan, for status views. */
export function planLegs(db: DatabaseSync, tenantId: string, planId: string) {
  return all<any>(db, "SELECT * FROM proposal_actions WHERE tenant_id=? AND operation='INTERNAL_TRANSFER' ORDER BY updated_at DESC", tenantId)
    .map((a) => ({ ...a, spec: json<ActionSpec>(a.spec_json) }))
    .filter((a) => transferParams(a.spec).planId === planId);
}
