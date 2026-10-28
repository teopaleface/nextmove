import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../../db/connection";
import { HttpError } from "../../auth/session";
import { sha256Hex } from "../../canonical";
import { nowIso } from "../../clock";
import { postCardOrTransfer } from "../../bank/ledger";
import { recordConfirmed, recordSettled } from "../../execution/effects";
import { display, fmtDate, money, openActionFor, spec, type Analysis, type Block, type CapEnv, type Candidate, type CapabilityDef } from "../../capabilities/core";
import type { ExtActionContext, ExtensionModule } from "../types";
import { assessCollections, planCycle, type SplitGroup } from "../../../../extensions/src/shared-split/index.ts";

// E9: a household bill shared with (fictional) household members. The split comes from the pure planner; the only
// action is sending payment requests, recorded by the bank. Nobody else is debited: members without their own debit
// mandate (everyone here) can only be asked, and a payment arrives as an ordinary incoming credit.

type Req = { idempotencyKey: string; memberId: string; amountMinor: number; dueOn: string; why: string };

const groupFor = (db: DatabaseSync, t: string, ctx: string) => one<any>(db, "SELECT * FROM ext_split_group WHERE tenant_id=? AND context_id=? ORDER BY id LIMIT 1", t, ctx);
const membersOf = (db: DatabaseSync, t: string, groupId: string) => all<any>(db, "SELECT * FROM ext_split_member WHERE tenant_id=? AND group_id=? ORDER BY member_id", t, groupId);
const requestsOf = (db: DatabaseSync, t: string, g: any) => all<any>(db, "SELECT * FROM ext_split_request WHERE tenant_id=? AND context_id=? AND group_id=? AND cycle_id=? ORDER BY member_id", t, g.context_id, g.id, g.cycle_id);
const billOf = (db: DatabaseSync, t: string, g: any) => one<any>(db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=? AND context_id=?", g.subscription_id, t, g.context_id);

/** The pure split for the group's current cycle, from bank state only. No member holds a mandate in this build. */
function planFor(db: DatabaseSync, t: string, g: any, now: string) {
  const bill = billOf(db, t, g);
  if (!bill) throw new Error("bill missing");
  const members = membersOf(db, t, g.id);
  const group: SplitGroup = {
    groupId: g.id, organizerId: g.organizer_id, subscriptionId: g.subscription_id, currency: g.currency,
    members: members.map((m) => ({ memberId: m.member_id, weight: m.weight, joinedOn: m.joined_on, ...(m.left_on ? { leftOn: m.left_on } : {}), bankCustomer: Boolean(m.bank_customer) })),
  };
  const plan = planCycle({ group, cycle: { cycleId: g.cycle_id, startsOn: g.cycle_starts_on, endsOn: g.cycle_ends_on }, chargedMinor: bill.amount_minor, chargeCurrency: bill.currency, mandates: [], dueDays: g.due_days, now });
  const requests: Req[] = plan.effects.flatMap((e) => (e.type === "SEND_PAYMENT_REQUEST" ? [{ idempotencyKey: e.idempotencyKey, memberId: e.memberId, amountMinor: e.amountMinor, dueOn: e.dueOn, why: e.why }] : []));
  const debits = plan.effects.filter((e) => e.type === "DEBIT_MEMBER").length;
  return { bill, members, plan, requests, debits };
}

const WHY: Record<string, string> = { NOT_A_BANK_CUSTOMER: "not a customer of this bank", NO_MANDATE: "no debit mandate from them", ABOVE_MANDATE: "share above their mandate" };

async function analyze(env: CapEnv): Promise<Analysis> {
  const base = { capability: "E9", title: "Split shared household bills", contextId: env.contextId, evidence: ["DETERMINISTIC_CALCULATION", "BANK_RECORD"] as Analysis["evidence"], inputs: [], candidates: [], numbers: {} };
  const g = groupFor(env.db, env.tenantId, env.contextId);
  if (!g) return { ...base, headline: "No shared bills set up", summary: "Nothing in this context is shared with other people.", blocks: [] };
  let r: ReturnType<typeof planFor>;
  try {
    r = planFor(env.db, env.tenantId, g, env.now);
  } catch {
    return { ...base, headline: "This split cannot be calculated", summary: "The bill or the member list is incomplete.", blocks: [] };
  }
  const { bill, members, plan, requests } = r;
  const sent = new Map(requestsOf(env.db, env.tenantId, g).map((x) => [x.member_id, x]));
  const unsent = requests.filter((q) => !sent.has(q.memberId));
  const name = new Map(members.map((m) => [m.member_id, m.display_name]));
  const collections = assessCollections([...sent.values()].map((x) => ({ idempotencyKey: x.idempotency_key, memberId: x.member_id, amountMinor: x.amount_minor, paidMinor: x.paid_minor, dueOn: x.due_on, reminded: Boolean(x.reminded) })), env.now);
  const askedMinor = [...sent.values()].reduce((s, x) => s + x.amount_minor, 0);
  const receivedMinor = [...sent.values()].reduce((s, x) => s + x.paid_minor, 0);
  const busy = openActionFor(env, g.id, "EXT_SEND_SPLIT_REQUESTS");
  const candidates: Candidate[] = unsent.length
    ? [{
        key: "split-requests",
        defaultSelected: true,
        available: !busy,
        unavailableReason: busy ? "These requests are already being sent" : undefined,
        spec: spec({
          operation: "EXT_SEND_SPLIT_REQUESTS",
          route: "BANK_INTERNAL",
          capability: "E9",
          merchantId: bill.merchant_id,
          merchantName: bill.merchant_name,
          subjectRef: g.id,
          params: { groupId: g.id, cycleId: g.cycle_id, chargedMinor: bill.amount_minor, requests: unsent },
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: 0 },
          consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: "Records one payment request per member", remainingObligations: `You still pay the full ${bill.merchant_name} bill; unpaid shares stay yours` },
          display: display(
            `Ask ${unsent.map((q) => name.get(q.memberId)).join(" and ")} for their share`,
            `${bill.merchant_name} ${money(bill.amount_minor)}, split by days in the home.`,
            [...unsent.map((q) => ({ label: name.get(q.memberId) ?? q.memberId, value: `${money(q.amountMinor)} by ${fmtDate(q.dueOn)}` })), { label: "Debited from anyone", value: "No one; these are requests" }],
            "Requests only. Nobody is debited: a member pays by transfer if they choose, and you can see it arrive here.",
            "Send requests",
          ),
        }),
      }]
    : [];
  const blocks: Block[] = [
    { kind: "metrics", items: [{ label: `${bill.merchant_name} bill`, value: money(bill.amount_minor) }, { label: "Your share", value: money(plan.organizerShareMinor) }, { label: "Asked from others", value: money(askedMinor) }, { label: "Received", value: money(receivedMinor), tone: receivedMinor && receivedMinor === askedMinor ? "good" : undefined }] },
    {
      kind: "table",
      title: `${g.label}: ${fmtDate(g.cycle_starts_on)} – ${fmtDate(g.cycle_ends_on)}`,
      columns: ["Member", "Days", "Share", "Request"],
      rows: plan.shares.map((s) => {
        const x = sent.get(s.memberId);
        const planned = requests.find((q) => q.memberId === s.memberId);
        const state = s.memberId === g.organizer_id ? "Pays the bill" : x ? (x.status === "PAID" ? `Paid ${money(x.paid_minor)}` : `Requested, due ${fmtDate(x.due_on)}`) : planned ? `Not sent (${WHY[planned.why] ?? planned.why})` : "—";
        return { cells: [name.get(s.memberId) ?? s.memberId, String(s.activeDays), money(s.shareMinor), state], highlight: s.memberId === g.organizer_id, tone: x?.status === "PAID" ? ("good" as const) : undefined };
      }),
      note: "Shares are by weight times days in the home this cycle; they add up exactly to the bill.",
    },
    { kind: "note", tone: "info", text: "No one here has given this bank a debit mandate, so each member gets a request they can pay or ignore. Nothing is taken from their accounts, and an unpaid share is never moved onto the others." },
    ...(collections.shortfallMinor ? [{ kind: "note" as const, tone: "warn" as const, text: `${money(collections.shortfallMinor)} is overdue. A reminder is suggested ${collections.effects.some((e) => e.type === "SEND_REMINDER") ? "now" : "3 days after the due date"}.` }] : []),
  ];
  const labs = [...sent.values()].filter((x) => x.status === "REQUESTED").map((x) => ({ action: "member_pays", label: `${name.get(x.member_id) ?? x.member_id} pays ${money(x.amount_minor - x.paid_minor)}`, endpoint: "/labs/ext", body: { module: "shared-split", action: "member_pays", body: { memberId: x.member_id } } }));
  return {
    ...base,
    headline: unsent.length ? `Ask for ${money(unsent.reduce((s, q) => s + q.amountMinor, 0))} of the ${money(bill.amount_minor)} ${bill.merchant_name} bill` : !sent.size ? `Nobody else owes a share of ${bill.merchant_name}` : receivedMinor === askedMinor ? `Everyone paid their share of ${bill.merchant_name}` : `${money(askedMinor - receivedMinor)} still to come from the household`,
    summary: `${g.label} is shared by ${members.length} people. You pay ${bill.merchant_name}; the others are asked for their share.`,
    candidates,
    blocks,
    labs,
    numbers: { billMinor: bill.amount_minor, organizerShareMinor: plan.organizerShareMinor, askedMinor, receivedMinor, unsentMinor: unsent.reduce((s, q) => s + q.amountMinor, 0) },
  };
}

/* ----------------------------------------------------------------------------------- operation */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function runRequests(c: ExtActionContext) {
  const { db, action } = c;
  const t = action.tenant_id;
  const settle = (status: "REFUSED" | "NO_CHANGE" | "BLOCKED", reason: string) => recordSettled(db, action.id, c.attemptId, status, { reason });
  tx(db, () => {
    const p = c.spec.params as any;
    const approved: Req[] = Array.isArray(p?.requests) ? p.requests : [];
    const g = typeof p?.groupId === "string" ? one<any>(db, "SELECT * FROM ext_split_group WHERE id=? AND tenant_id=? AND context_id=?", p.groupId, t, action.context_id) : null;
    if (!g || g.cycle_id !== p.cycleId || !approved.length || approved.length > 20) return settle("REFUSED", "This split is not set up here; no requests were sent");
    const now = nowIso(db, t);
    let r: ReturnType<typeof planFor>;
    try {
      r = planFor(db, t, g, now);
    } catch {
      return settle("REFUSED", "The split could not be rebuilt from bank records; no requests were sent");
    }
    if (r.debits) return settle("BLOCKED", "Debiting members is not offered; no requests were sent");
    if (r.bill.amount_minor !== p.chargedMinor) return settle("REFUSED", "The bill changed after you approved; no requests were sent. Review the new split.");
    const fresh = new Map(r.requests.map((q) => [q.idempotencyKey, q]));
    const today = now.slice(0, 10);
    for (const q of approved) {
      const f = fresh.get(q?.idempotencyKey);
      if (!f || f.memberId !== q.memberId || f.amountMinor !== q.amountMinor || typeof q.dueOn !== "string" || !DATE.test(q.dueOn)) return settle("REFUSED", "The split changed after you approved; no requests were sent. Review the new split.");
      if (q.dueOn < today) return settle("REFUSED", "The approved due date has passed; no requests were sent");
    }
    const exists = (k: string) => one(db, "SELECT 1 FROM ext_split_request WHERE tenant_id=? AND idempotency_key=?", t, k);
    const todo = approved.filter((q) => !exists(q.idempotencyKey));
    if (!todo.length) return settle("NO_CHANGE", "These requests were already sent");
    for (const q of todo) {
      run(db, "INSERT INTO ext_split_request(idempotency_key, tenant_id, context_id, group_id, cycle_id, member_id, amount_minor, paid_minor, due_on, why, status, action_id, reminded, created_at) VALUES (?,?,?,?,?,?,?,0,?,?, 'REQUESTED', ?, 0, ?)", q.idempotencyKey, t, g.context_id, g.id, g.cycle_id, q.memberId, q.amountMinor, q.dueOn, fresh.get(q.idempotencyKey)!.why, action.id, now);
    }
    recordConfirmed(db, action.id, c.attemptId, {
      issuer: "nextmove-bank", reference: `NMQ-${sha256Hex(String(action.logical_key)).slice(0, 8).toUpperCase()}`, effectiveAt: now, accessUntil: null, termsRevision: null,
      details: { groupId: g.id, cycleId: g.cycle_id, requests: todo.map((q) => ({ memberId: q.memberId, amountMinor: q.amountMinor, dueOn: q.dueOn })), requestedMinor: todo.reduce((s, q) => s + q.amountMinor, 0), debitedMinor: 0 },
      channel: "BANK", verification: { method: "bank_record", checks: ["split rebuilt from bank records matches the approval", "requests only, nobody debited"] }, evidence: "BANK_RECORD",
    });
  });
}

/* -------------------------------------------------------------------------------- seed and labs */

const MEMBERS = [
  { id: "ana", name: "Ana (sister)", weight: 1, joinedOn: "2026-01-01", bankCustomer: 0 },
  { id: "radu", name: "Radu (lodger since 15 Oct)", weight: 1, joinedOn: "2026-10-15", bankCustomer: 1 },
];

function seed(db: DatabaseSync, input: { tenantId: string; customer: "alex" | "laziz"; contexts: string[] }) {
  if (input.customer !== "laziz") return;
  const t = input.tenantId;
  const hh = one<any>(db, "SELECT * FROM contexts WHERE tenant_id=? AND kind='PERSONAL' ORDER BY ordinal LIMIT 1", t);
  const bill = hh && one<any>(db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND merchant_id='electracasa'", t, hh.id);
  const acct = hh && one<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING' ORDER BY ordinal LIMIT 1", t, hh.id);
  if (!bill || !acct) return;
  const gid = `${t}:split:home-power`;
  run(db, "INSERT INTO ext_split_group(id, tenant_id, context_id, organizer_id, subscription_id, account_id, label, currency, cycle_id, cycle_starts_on, cycle_ends_on, due_days) VALUES (?,?,?,?,?,?,?, 'RON', '2026-10', '2026-10-01', '2026-10-31', 7)", gid, t, hh.id, "laziz", bill.id, acct.id, "Home electricity");
  run(db, "INSERT INTO ext_split_member(tenant_id, group_id, member_id, display_name, weight, joined_on, left_on, bank_customer) VALUES (?,?,?,?,?,?,NULL,?)", t, gid, "laziz", "You", 1, "2025-06-01", 1);
  for (const m of MEMBERS) run(db, "INSERT INTO ext_split_member(tenant_id, group_id, member_id, display_name, weight, joined_on, left_on, bank_customer) VALUES (?,?,?,?,?,?,NULL,?)", t, gid, m.id, m.name, m.weight, m.joinedOn, m.bankCustomer);
}

const MEMBER_ID = /^[a-z][a-z0-9_-]{0,31}$/;

/** Labs: a member pays their requested share by transfer. Exactly the outstanding amount, credited once. */
function labsMemberPays({ db, session, body }: { db: DatabaseSync; session: any; body: Record<string, unknown> }) {
  const memberId = typeof body.memberId === "string" && MEMBER_ID.test(body.memberId) ? body.memberId : null;
  if (!memberId) throw new HttpError(400, "BAD_INPUT", "memberId is required");
  if (body.amountMinor !== undefined && !(Number.isSafeInteger(body.amountMinor) && (body.amountMinor as number) > 0)) throw new HttpError(400, "BAD_INPUT", "amountMinor must be a positive whole number of bani");
  const t = session.tenantId;
  return tx(db, () => {
    const g = groupFor(db, t, session.contextId);
    if (!g) throw new HttpError(404, "NOT_FOUND", "No shared bill in this context");
    const req = one<any>(db, "SELECT r.*, m.display_name FROM ext_split_request r JOIN ext_split_member m ON m.tenant_id=r.tenant_id AND m.group_id=r.group_id AND m.member_id=r.member_id WHERE r.tenant_id=? AND r.context_id=? AND r.group_id=? AND r.member_id=? ORDER BY r.created_at DESC LIMIT 1", t, g.context_id, g.id, memberId);
    if (!req) throw new HttpError(404, "NOT_FOUND", "No payment request was sent to this member");
    const outstanding = req.amount_minor - req.paid_minor;
    if (outstanding <= 0) return { paid: true, duplicate: true, amountMinor: 0 };
    if (body.amountMinor !== undefined && body.amountMinor !== outstanding) throw new HttpError(400, "BAD_INPUT", `This simulation pays exactly the requested share (${outstanding} bani)`);
    const now = nowIso(db, t);
    const { transactionId, duplicate } = postCardOrTransfer(db, { tenantId: t, contextId: g.context_id, accountId: g.account_id, sourceEventId: `${t}:${req.idempotency_key}:paid`, amountMinor: outstanding, merchantName: req.display_name, category: "Split payment", reference: `SPLIT-${g.cycle_id}-${memberId.toUpperCase()}`, bookedAt: now, note: "Share of a household bill (Labs simulation)" });
    if (!duplicate) run(db, "UPDATE ext_split_request SET paid_minor=amount_minor, status='PAID', paid_at=? WHERE tenant_id=? AND idempotency_key=?", now, t, req.idempotency_key);
    return { paid: true, duplicate, amountMinor: duplicate ? 0 : outstanding, transactionId };
  });
}

const E9: CapabilityDef = { id: "E9", title: "Split shared household bills", short: "Ask household members for their share; nobody is debited", group: "Bills", customer: "laziz", contextKind: "PERSONAL", keywords: ["split", "share", "household", "electricity", "bill", "request", "roommate", "family"], analyze };

export const sharedSplit: ExtensionModule = {
  key: "shared-split",
  capabilities: [E9],
  operations: { EXT_SEND_SPLIT_REQUESTS: runRequests },
  seed,
  labs: { member_pays: labsMemberPays },
};
