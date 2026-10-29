import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx } from "../db/connection";
import { repoRoot } from "../config";
import { HttpError, type Session } from "../auth/session";
import { createProposal } from "../authority/authority";
import type { ActionSpec } from "../authority/actions";
import { accountsFor } from "./ledger";
import { shortId } from "../canonical";
import { nowIso, nowMs } from "../clock";
import { autopilotConfig } from "../capabilities/cash-autopilot";
import { internalTransferSpec, transferParams, type TransferAccount, type TransferPurpose } from "../execution/internal-transfer";
import { interestMinor } from "../finance/cash-autopilot";
import { proposalView } from "../capabilities/registry";
import { formatMoney } from "../../shared/money";
import { formatDay, toMs } from "../../shared/time";

// "Put it to work": after a confirmed stop that avoided a future charge, offer to move that same amount from Daily
// into Savings or into a simulated Titluri de stat holding. The amount comes from the bank's own receipt (the
// avoided charge), never from the client or the model. Choosing an option only drafts one INTERNAL_TRANSFER that
// goes through the usual exact approval, per-action grant, dispatch gate and ledger posting. One move per receipt.

export type PutToWorkChoice = "savings" | "bonds";

const PURPOSE: Record<PutToWorkChoice, TransferPurpose> = { savings: "PUT_TO_WORK_SAVINGS", bonds: "PUT_TO_WORK_BONDS" };
/** Statuses where the move for a receipt is approved, running or done: a second one is never prepared. */
const TAKEN = new Set(["APPROVED", "EXECUTING", "PENDING", "UNKNOWN", "CONFIRMED"]);
const ELIGIBLE_OPERATIONS = new Set(["STOP_RENEWAL"]);

let cfgCache: any = null;
export function putToWorkConfig(): any {
  if (!cfgCache) cfgCache = JSON.parse(fs.readFileSync(path.join(repoRoot(), "demo/put-to-work.json"), "utf8"));
  return cfgCache;
}

const money = (m: number) => formatMoney(m);
const pct = (p: number) => `${Number(p)}%`;
const subjectRefFor = (tenantId: string, receiptId: string) => `${tenantId}:put-to-work:${receiptId}`;
const dismissKey = (receiptId: string) => `put_to_work_dismissed:${receiptId}`;

export function bondsAccountId(tenantId: string) {
  return `${tenantId}:${putToWorkConfig().bonds.accountLocal}`;
}

/** Fictional rate shown next to an account on Home and the account page. */
export function accountRateNote(tenantId: string, a: { id: string; kind: string }): string | null {
  if (a.kind === "SAVINGS") return autopilotConfig().pockets.savings.rateLabel;
  if (a.id === bondsAccountId(tenantId)) return putToWorkConfig().bonds.rateLabel;
  return null;
}

function moves(db: DatabaseSync, tenantId: string, receiptId: string) {
  const now = nowMs(db, tenantId);
  return all<any>(
    db,
    `SELECT a.id, a.status, a.spec_json, a.proposal_id, p.status AS proposal_status, p.ready_expires_at FROM proposal_actions a JOIN proposals p ON p.id=a.proposal_id
     WHERE a.tenant_id=? AND a.operation='INTERNAL_TRANSFER' AND a.subject_ref=? ORDER BY a.updated_at DESC`,
    tenantId,
    subjectRefFor(tenantId, receiptId),
  ).map((r) => {
    const purpose = transferParams(json<ActionSpec>(r.spec_json)).purpose;
    return {
      actionId: r.id as string,
      status: r.status as string,
      proposalId: r.proposal_id as string,
      choice: (purpose === PURPOSE.bonds ? "bonds" : "savings") as PutToWorkChoice,
      ready: r.status === "PROPOSED" && r.proposal_status === "READY" && now <= toMs(r.ready_expires_at),
    };
  });
}

/** The stop receipt this offer hangs off, if it qualifies: confirmed, in this context, and it avoided a charge. */
function eligibleReceipt(db: DatabaseSync, s: Session, receipt: any) {
  if (!receipt || receipt.tenant_id !== s.tenantId || receipt.context_id !== s.contextId) return null;
  if (receipt.status !== "CONFIRMED" || !ELIGIBLE_OPERATIONS.has(receipt.operation) || !receipt.action_id) return null;
  if (s.contextKind !== "PERSONAL") return null;
  const avoided = -Number(json<any>(receipt.money_effect_json, {})?.forecastChangeMinor ?? 0);
  if (!Number.isSafeInteger(avoided) || avoided <= 0) return null;
  const action = one<any>(db, "SELECT a.spec_json, p.batch_id FROM proposal_actions a JOIN proposals p ON p.id=a.proposal_id WHERE a.id=? AND a.tenant_id=?", receipt.action_id, s.tenantId);
  // The 200-item bulk review keeps its own follow-ups; this offer is for single stops.
  if (!action || action.batch_id) return null;
  const list = accountsFor(db, s.tenantId, s.contextId);
  const daily = list.find((a) => a.kind === "CURRENT");
  const savings = list.find((a) => a.kind === "SAVINGS");
  if (!daily || !savings) return null;
  const merchant = String(json<any>(action.spec_json, {})?.merchantName ?? "this service");
  return { avoided, merchant, daily, savings, bonds: list.find((a) => a.id === bondsAccountId(s.tenantId)) ?? null };
}

/** The offer as shown on the receipt (and summarized on the action page), or null when there is nothing to offer. */
export function putToWorkOffer(db: DatabaseSync, s: Session, receipt: any) {
  const e = eligibleReceipt(db, s, receipt);
  if (!e) return null;
  const days = Number(putToWorkConfig().projectionDays);
  const sav = autopilotConfig().pockets.savings;
  const bonds = putToWorkConfig().bonds;
  const savInterest = interestMinor(e.avoided, sav.annualRatePct, days);
  const bondInterest = interestMinor(e.avoided, bonds.annualRatePct, days);
  const existing = moves(db, s.tenantId, receipt.id);
  const taken = existing.find((m) => TAKEN.has(m.status));
  const ready = existing.find((m) => m.ready);
  const dismissed = Boolean(one<any>(db, "SELECT id FROM preferences WHERE tenant_id=? AND context_id=? AND key=?", s.tenantId, s.contextId, dismissKey(receipt.id)));
  const transferReceipt = taken?.status === "CONFIRMED" ? one<any>(db, "SELECT id, issuer_reference FROM receipts WHERE action_id=?", taken.actionId) : null;
  return {
    state: taken ? (taken.status === "CONFIRMED" ? "DONE" : "IN_PROGRESS") : ready ? "PREPARED" : dismissed ? "DISMISSED" : "OFFER",
    amountMinor: e.avoided,
    merchant: e.merchant,
    from: { id: e.daily.id, name: e.daily.name, balanceMinor: e.daily.balanceMinor },
    enoughInDaily: e.daily.balanceMinor >= e.avoided,
    choice: taken?.choice ?? ready?.choice ?? null,
    actionId: taken?.actionId ?? null,
    proposalId: ready?.proposalId ?? null,
    transferReceipt: transferReceipt ? { id: transferReceipt.id, reference: transferReceipt.issuer_reference } : null,
    projectionMonths: 12,
    options: [
      {
        choice: "savings" as const,
        title: `Savings account, ${pct(sav.annualRatePct)} a year`,
        badge: "Demo rate",
        to: e.savings.name,
        rateLabel: sav.rateLabel,
        interestMinor: savInterest,
        totalMinor: e.avoided + savInterest,
        body: `Moves into your ${e.savings.name} account. You can move it back at any time, no fee. The demo rate can change.`,
      },
      {
        choice: "bonds" as const,
        title: "Titluri de stat (Romanian government bonds)",
        badge: "Simulated, not an offer",
        to: bonds.name,
        rateLabel: bonds.rateLabel,
        interestMinor: bondInterest,
        totalMinor: e.avoided + bondInterest,
        body: `Titluri de stat are bonds the Romanian state sells to savers: you lend for a fixed term at a fixed rate. Here it is simulated: the money moves to a "${bonds.name}" holding inside this demo bank, at an invented rate. No bond is bought.`,
      },
    ],
  };
}

/** "Not now": remembers the answer for this receipt. Prepares nothing. */
export function putToWorkDismiss(db: DatabaseSync, s: Session, receiptId: string) {
  const receipt = one<any>(db, "SELECT * FROM receipts WHERE id=?", receiptId);
  if (!putToWorkOffer(db, s, receipt)) throw new HttpError(409, "NOT_ELIGIBLE", "There is nothing to put to work from this receipt");
  run(
    db,
    `INSERT INTO preferences(id, tenant_id, context_id, key, value_json, source, revision, updated_at) VALUES (?,?,?,?,?, 'USER_CONFIRMED', 1, ?)
     ON CONFLICT(tenant_id, context_id, key) DO UPDATE SET value_json=excluded.value_json, revision=preferences.revision+1, updated_at=excluded.updated_at`,
    shortId("pref"),
    s.tenantId,
    s.contextId,
    dismissKey(receiptId),
    JSON.stringify("not_now"),
    new Date().toISOString(),
  );
  return { dismissed: true };
}

/**
 * Draft the exact transfer for one option. Returns the proposal for review; nothing moves until it is approved.
 * Re-asking for the same option returns the open draft. Picking the other option retires the open draft, so two
 * moves for one receipt can never both be approvable; once one is approved, no further draft is prepared.
 */
export function putToWorkDraft(db: DatabaseSync, s: Session, receiptId: string, choice: PutToWorkChoice) {
  return tx(db, () => {
    const receipt = one<any>(db, "SELECT * FROM receipts WHERE id=?", receiptId);
    const e = eligibleReceipt(db, s, receipt);
    if (!e) throw new HttpError(409, "NOT_ELIGIBLE", "There is nothing to put to work from this receipt");
    const existing = moves(db, s.tenantId, receiptId);
    if (existing.some((m) => TAKEN.has(m.status))) throw new HttpError(409, "ALREADY_DONE", "You already chose where this money goes. It is moved once per receipt.");
    if (e.daily.balanceMinor < e.avoided) throw new HttpError(409, "NOT_ENOUGH", `${e.daily.name} holds ${money(e.daily.balanceMinor)}, less than ${money(e.avoided)}. Nothing was prepared.`);
    const same = existing.find((m) => m.ready && m.choice === choice);
    if (same) return proposalView(db, s, same.proposalId);
    const at = nowIso(db, s.tenantId);
    for (const m of existing.filter((x) => x.ready)) {
      run(db, "UPDATE proposals SET status='OUTDATED', outdated_reason=? WHERE id=? AND status='READY'", "You picked another option for this money", m.proposalId);
      run(db, "UPDATE proposal_actions SET status='OUTDATED', updated_at=? WHERE proposal_id=? AND status='PROPOSED'", at, m.proposalId);
    }

    const amount = e.avoided;
    const bondsCfg = putToWorkConfig().bonds;
    const sav = autopilotConfig().pockets.savings;
    const days = Number(putToWorkConfig().projectionDays);
    const from: TransferAccount = { id: e.daily.id, name: e.daily.name, balanceMinor: e.daily.balanceMinor };
    const to: TransferAccount =
      choice === "savings" ? { id: e.savings.id, name: e.savings.name, balanceMinor: e.savings.balanceMinor } : { id: bondsAccountId(s.tenantId), name: bondsCfg.name, balanceMinor: e.bonds?.balanceMinor ?? 0 };
    const rate = choice === "savings" ? sav : bondsCfg;
    const interest = interestMinor(amount, rate.annualRatePct, days);
    const maturity = formatDay(nowMs(db, s.tenantId) + days * 86_400_000);
    const spec = internalTransferSpec({
      capability: "BANK",
      subjectRef: subjectRefFor(s.tenantId, receiptId),
      from,
      to,
      params: {
        amountMinor: amount,
        mode: "EXACT",
        executeAt: null,
        returnEarlyBelowMinor: null,
        purpose: PURPOSE[choice],
        description: `Put to work: ${e.merchant} stop, to ${to.name}`,
        planId: receiptId,
        legId: `put-to-work:${receiptId}`,
        openPocket: choice === "bonds" && !e.bonds ? { name: bondsCfg.name, kind: bondsCfg.kind } : null,
      },
      title: `Move ${money(amount)} from ${from.name} to ${to.name}`,
      summary: `The same amount the ${e.merchant} stop keeps from being charged. It comes out of ${from.name} now; nothing was refunded.`,
      extraLines: [
        { label: "Rate", value: rate.rateLabel },
        { label: choice === "bonds" ? `At maturity, ${maturity}` : "In 12 months", value: `${money(amount + interest)}, of which ${money(interest)} interest (projection, not a promise)` },
        ...(choice === "bonds" ? [{ label: "Simulation", value: "No bond is bought. A holding account inside the demo bank; not an offer" }] : []),
      ],
      note:
        choice === "bonds"
          ? "Both accounts are yours in the demo bank. One balanced posting; your total funds do not change. Titluri de stat here are simulated with an invented rate."
          : "Both accounts are yours. One balanced posting; your total funds do not change. The savings rate is a demo rate.",
    });
    spec.display.confirmLabel = `Move ${money(amount)}`;
    const p = createProposal(db, { tenantId: s.tenantId, contextId: s.contextId, actorUserId: s.userId, scope: "SINGLE", actions: [{ key: `put-to-work-${choice}`, spec }] });
    return proposalView(db, s, p.id);
  });
}
