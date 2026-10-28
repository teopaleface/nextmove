import { one } from "../db/connection";
import { formatDay } from "../../shared/time";
import { HOLD_HOURS, ensureShieldWatches, shieldPermitted, shieldWatches, sweepExpiredHolds, type ShieldWatch } from "../bank/trial-shield";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, display, fmtDate, fmtWhen, lastReceipt, money, spec } from "./core";

// T4 Trial Shield. T2 cancels a known trial at the merchant ahead of time; T4 is the bank-side net for trials the
// customer forgot or never told us about. It needs no trial end date: it holds the first full charge a watched
// merchant starts after its card check, and the customer decides. Both choices are exact proposals with receipts.

const PROVENANCE = { BANK: "NextMove bank record", CATALOG: "Fictional catalog", LINKED: "Linked subscription (T2)", CALC: "Calculated by NextMove" };

const OUTCOME_LABEL: Record<string, string> = {
  HELD: "Charge attempt held",
  DECLINED_BLOCKED: "Tried again: declined (blocked)",
  DECLINED_ALREADY_HELD: "Tried again while on hold: declined",
  DECLINED_CARD_FROZEN: "Declined: card frozen",
  DECLINED_INSUFFICIENT_FUNDS: "Declined: not enough money",
  APPROVED: "Charge approved (you allowed this merchant)",
  EXPIRED_DECLINED: `No decision in ${HOLD_HOURS} h: declined`,
  RELEASED_BY_BLOCK: "You blocked it: hold released",
  POSTED_BY_ALLOW: "You allowed it: posted",
};

function linkedSub(env: CapEnv, w: ShieldWatch) {
  return w.c.linkedSubscriptionId ? one<any>(env.db, "SELECT * FROM subscriptions WHERE id=? AND tenant_id=?", w.c.linkedSubscriptionId, env.tenantId) : null;
}

function statusText(env: CapEnv, w: ShieldWatch): string {
  const sub = linkedSub(env, w);
  switch (w.c.state) {
    case "HELD":
      return "On hold";
    case "BLOCKED":
      return "Blocked by you";
    case "ALLOWED":
      return "Allowed by you";
    default:
      if (sub?.state === "RENEWAL_OFF") return "No hold needed (T2)";
      if (sub) return "Known trial (T2)";
      return "Watching";
  }
}

function priceLine(w: ShieldWatch) {
  if (w.c.advertisedMinor == null) return "Not known";
  return `${money(w.c.advertisedMinor)} / month`;
}

function decisionCandidates(env: CapEnv, w: ShieldWatch, card: string): Candidate[] {
  const h = w.c.hold!;
  const name = w.c.merchantName;
  const differs = w.c.advertisedMinor != null && w.c.advertisedMinor !== h.amountMinor;
  const payFrom = one<{ name: string }>(env.db, "SELECT a.name FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=? AND t.tenant_id=?", h.transactionId, env.tenantId)?.name ?? "your card account";
  const params = { watchId: w.id, merchantId: w.c.merchantId, holdTransactionId: h.transactionId, amountMinor: h.amountMinor, advertisedMinor: w.c.advertisedMinor, heldAt: h.heldAt, expiresAt: h.expiresAt };
  const base = { route: "BANK_INTERNAL" as const, capability: "T4", merchantId: w.c.merchantId, merchantName: name, subjectRef: h.transactionId, params };
  const shared = [
    { label: "Merchant", value: name },
    { label: "Tried to charge", value: `${money(h.amountMinor)} on ${fmtWhen(h.heldAt)}` },
    { label: "Advertised price", value: differs ? `${priceLine(w)} (different)` : priceLine(w) },
    { label: "Card", value: `Debit •••• ${card}` },
  ];
  return [
    {
      key: `block-${w.c.merchantId}`,
      defaultSelected: false,
      available: true,
      spec: spec({
        ...base,
        operation: "MERCHANT_BLOCK",
        money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: -h.amountMinor },
        consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [`${name} paid features, if ${name} stops the service`], dataEffect: null, remainingObligations: `Your ${name} account is not cancelled. Cancel with ${name} to end the contract.` },
        display: display(
          `Block ${name} and release the hold`,
          `Decline this charge and later card charges from ${name}. ${money(h.amountMinor)} stays in your account.`,
          [
            ...shared,
            { label: "Change", value: `Release the hold; decline future ${name} card charges` },
            { label: "Money", value: "Nothing leaves your account. An avoided charge, not a credit." },
            { label: "Your account with them", value: "Not cancelled by this. Cancel with the merchant too." },
          ],
          `In this demo bank, the card issuer can decline charges a merchant starts on its own. This does not end your ${name} contract; the merchant may still ask for payment under its terms.`,
          "Approve block",
          "Not now",
        ),
      }),
    },
    {
      key: `allow-${w.c.merchantId}`,
      defaultSelected: false,
      available: true,
      spec: spec({
        ...base,
        operation: "HOLD_ALLOW",
        money: { currency: "RON", immediateDebitMinor: h.amountMinor, maxDebitMinor: h.amountMinor, feesMinor: 0, forecastChangeMinor: 0 },
        consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: `Later ${name} charges go through as usual.` },
        display: display(
          `Allow the ${money(h.amountMinor)} ${name} payment`,
          `Post the held charge as a normal payment. Later ${name} charges go through as usual.`,
          [...shared, { label: "Pays now", value: `${money(h.amountMinor)} from ${payFrom}` }, { label: "After this", value: `${name} is no longer held` }],
          differs ? `${name} asked for ${money(h.amountMinor)}, not the advertised ${money(w.c.advertisedMinor!)}. You approve exactly ${money(h.amountMinor)}.` : `You approve exactly ${money(h.amountMinor)}. Nothing more can be posted from this hold.`,
          "Approve payment",
          "Not now",
        ),
      }),
    },
  ];
}

export const T4: CapabilityDef = {
  id: "T4",
  title: "Trial Shield",
  short: "Hold the first charge after a free trial until you decide",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["trial shield", "try to charge", "tried to charge", "after a free trial", "after the trial", "card check", "on hold", "held", "hold", "block", "forgot", "snapwise", "lingualeap", "charge attempt"],
  async analyze(env): Promise<Analysis> {
    sweepExpiredHolds(env.db, env.tenantId, env.contextId);
    ensureShieldWatches(env.db, env.tenantId, env.contextId);
    const watches = shieldWatches(env.db, env.tenantId, env.contextId);
    const card = (JSON.parse(one<any>(env.db, "SELECT card_json FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", env.tenantId, env.contextId)?.card_json ?? "{}").last4 as string) ?? "—";
    const base = { capability: "T4", title: "Trial Shield", contextId: env.contextId, evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION", "FICTIONAL_CATALOG"] as Analysis["evidence"] };
    if (!shieldPermitted(env.db, env.tenantId, env.contextId)) {
      return { ...base, headline: "Trial Shield is off", summary: "Turn it on in Profile → Permissions to hold charges after free trials.", blocks: [{ kind: "note", tone: "info", text: "Without this permission the bank does not hold any charge." }], inputs: [], candidates: [], numbers: {} };
    }

    const held = watches.filter((w) => w.c.state === "HELD");
    const open = held.map((w) => ({ w, action: one<any>(env.db, "SELECT * FROM proposal_actions WHERE tenant_id=? AND subject_ref=? AND operation IN ('MERCHANT_BLOCK','HOLD_ALLOW') AND status IN ('APPROVED','EXECUTING','PENDING','UNKNOWN') ORDER BY updated_at DESC LIMIT 1", env.tenantId, w.c.hold!.transactionId) }));
    const heldMinor = held.reduce((s, w) => s + w.c.hold!.amountMinor, 0);
    const avoidedMinor = watches.reduce((s, w) => s + w.c.avoidedMinor, 0);
    const first = held[0];

    const blocks: Block[] = [
      {
        kind: "metrics",
        items: [
          held.length ? { label: "On hold", value: money(heldMinor), sub: "Not taken from your account", tone: "bad" as const } : { label: "Under watch", value: `${watches.filter((w) => w.c.state === "WATCHING").length} merchants`, sub: "After a card check" },
          { label: "Kept by blocking", value: money(avoidedMinor), sub: "Avoided charges, not a credit", tone: avoidedMinor ? ("good" as const) : undefined },
        ],
      },
    ];

    for (const { w, action } of open) {
      const h = w.c.hold!;
      const differs = w.c.advertisedMinor != null && w.c.advertisedMinor !== h.amountMinor;
      blocks.push({
        kind: "timeline",
        title: `${w.c.merchantName}: what happened`,
        items: [
          { at: w.c.check.at, label: `Card check: ${money(w.c.check.amountMinor)}. Free trial likely started`, state: "Watching" },
          { at: h.heldAt, label: `${w.c.merchantName} tried to charge the card`, amount: money(-h.amountMinor), state: "Held, not posted" },
          { at: h.expiresAt, label: "Declined automatically if you don't decide" },
        ],
      });
      blocks.push({
        kind: "facts",
        title: `${w.c.merchantName}: amounts`,
        items: [
          { label: "Tried to charge", value: money(h.amountMinor), provenance: PROVENANCE.BANK },
          { label: "Advertised price", value: priceLine(w), provenance: w.c.advertisedSource === "LINKED_SUBSCRIPTION" ? PROVENANCE.LINKED : PROVENANCE.CATALOG },
          ...(differs ? [{ label: "Difference", value: money(h.amountMinor - w.c.advertisedMinor!, { sign: true }), provenance: PROVENANCE.CALC }] : []),
          { label: "Trial length", value: "Not needed: we catch the first charge", provenance: PROVENANCE.BANK },
        ],
      });
      if (differs) blocks.push({ kind: "note", tone: "warn", text: `${w.c.merchantName} asked for ${money(h.amountMinor)}, but its advertised price is ${money(w.c.advertisedMinor!)}. Check before you allow it.` });
      if (action) blocks.push({ kind: "status", title: `Your decision is running`, state: action.status, detail: "Follow it in Activity → Tasks.", href: `/actions/${action.id}` });
    }

    blocks.push({
      kind: "table",
      title: "Trials under watch",
      columns: ["Merchant", "Card check", "Status"],
      rows: watches.map((w) => ({ cells: [w.c.merchantName, `${money(w.c.check.amountMinor)}, ${formatDay(w.c.check.at)}`, statusText(env, w)], highlight: w.c.state === "HELD", tone: w.c.state === "HELD" ? ("bad" as const) : undefined })),
      note: "A 0.00 or 1.00 RON card check usually means a free trial started. We hold the first full charge from that merchant.",
    });

    for (const w of watches) {
      const sub = linkedSub(env, w);
      if (!sub || w.c.state !== "WATCHING") continue;
      if (sub.state === "RENEWAL_OFF") {
        const r = lastReceipt(env, sub.id, "STOP_RENEWAL");
        blocks.push({ kind: "note", tone: "info", text: `${w.c.merchantName}: no hold needed. You turned renewal off with T2${r ? ` (ref ${r.issuer_reference})` : ""}, so no charge is coming.` });
      } else {
        blocks.push({ kind: "note", tone: "info", text: `${w.c.merchantName} is a trial you told us about. T2 can turn renewal off before ${fmtDate(sub.next_charge_at)}. If ${w.c.merchantName} still charges this card, Trial Shield holds it.` });
      }
    }

    const history = watches.flatMap((w) => w.c.attempts.map((a) => ({ ...a, merchantName: w.c.merchantName }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
    if (history.length && !(held.length && history.length === 1)) blocks.push({ kind: "timeline", title: "What the shield did", items: history.map((a) => (["APPROVED", "POSTED_BY_ALLOW"].includes(a.outcome) ? { at: a.at, label: `${a.merchantName}: ${OUTCOME_LABEL[a.outcome] ?? a.outcome}`, amount: money(-a.amountMinor) } : { at: a.at, label: `${a.merchantName}: ${OUTCOME_LABEL[a.outcome] ?? a.outcome} (${money(a.amountMinor)}, not taken)` })) });

    if (!held.length) blocks.push({ kind: "note", tone: "info", text: `If you don't decide within ${HOLD_HOURS} hours, we decline the charge. No money leaves; if the merchant tries again, we hold it and ask you again.` });
    blocks.push({ kind: "note", tone: "info", text: "In this demo bank, the card issuer can decline charges a merchant starts on its own. Blocking card payments does not cancel your account with the merchant; to end the contract, cancel with them too." });

    const candidates = open.filter((x) => !x.action).flatMap(({ w }) => decisionCandidates(env, w, card));
    const blocked = watches.filter((w) => w.c.state === "BLOCKED" && w.c.decidedAt);
    const lastBlock = blocked.map((w) => ({ w, r: one<any>(env.db, "SELECT r.id, r.issuer_reference, r.money_effect_json FROM receipts r WHERE r.tenant_id=? AND r.context_id=? AND r.operation='MERCHANT_BLOCK' AND json_extract(r.money_effect_json,'$.details.merchantName')=? ORDER BY r.verified_at DESC LIMIT 1", env.tenantId, env.contextId, w.c.merchantName) })).find((x) => x.r);
    const lastAllow = one<any>(env.db, "SELECT r.id, r.issuer_reference FROM receipts r WHERE r.tenant_id=? AND r.context_id=? AND r.operation='HOLD_ALLOW' ORDER BY r.verified_at DESC LIMIT 1", env.tenantId, env.contextId);
    const avoidedLast = lastBlock ? Number(JSON.parse(lastBlock.r.money_effect_json).details?.avoidedMinor ?? 0) : 0;

    if (lastBlock && !held.length && avoidedLast) blocks.splice(1, 0, { kind: "note", tone: "info", text: `Follow-up idea: move the ${money(avoidedLast)} you kept into Savings. This stays your call.` });

    const labs: NonNullable<Analysis["labs"]> = [];
    for (const w of watches) {
      if (w.c.linkedSubscriptionId) continue; // T2 owns the known trial; its charges are not simulated here.
      const amount = w.c.attemptMinor ?? w.c.advertisedMinor ?? 0;
      if (w.c.state === "WATCHING") labs.push({ action: "card_attempt", endpoint: "/labs/card-attempt", label: `${w.c.merchantName} tries to charge ${money(amount)}`, body: { merchantId: w.c.merchantId } });
      if (w.c.state === "BLOCKED") labs.push({ action: "card_attempt", endpoint: "/labs/card-attempt", label: `${w.c.merchantName} tries again`, body: { merchantId: w.c.merchantId } });
    }
    if (held.length) labs.push({ action: "clock", endpoint: "/labs/clock", label: `Let ${HOLD_HOURS} hours pass (moves the demo clock)`, body: { minutes: HOLD_HOURS * 60 } });

    return {
      ...base,
      headline: first
        ? `${first.c.merchantName} tried to take ${money(first.c.hold!.amountMinor)} after its free trial. We're holding it.`
        : blocked.length
          ? `${blocked.map((w) => w.c.merchantName).join(", ")} blocked. Nothing was taken.`
          : watches.length
            ? `Watching ${watches.length} free trial${watches.length === 1 ? "" : "s"} (${watches.map((w) => w.c.merchantName).join(", ")}). Nothing has tried to charge yet.`
            : "No card checks found. Nothing to watch.",
      summary: first ? "Nothing has left your account. Block it or allow it; both open an exact review." : "We spot card checks from new merchants and hold their first full charge until you decide.",
      blocks,
      inputs: [],
      candidates,
      numbers: { heldMinor, avoidedMinor, watching: watches.filter((w) => w.c.state === "WATCHING").length, held: held.length },
      done: !held.length && lastBlock ? { label: `${lastBlock.w.c.merchantName} blocked and hold released (ref ${lastBlock.r.issuer_reference})`, href: `/receipts/${lastBlock.r.id}` } : !held.length && lastAllow ? { label: `Payment allowed and posted (ref ${lastAllow.issuer_reference})`, href: `/receipts/${lastAllow.id}` } : null,
      links: lastBlock && !held.length && avoidedLast ? [{ label: "Open Savings account", href: "/home/accounts/" + encodeURIComponent(`${env.tenantId}:savings`) }] : [],
      labs,
    };
  },
};
