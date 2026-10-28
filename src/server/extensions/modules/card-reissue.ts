import { all, json } from "../../db/connection";
import { type Analysis, type Block, type CapabilityDef, type Candidate, type InputField, display, fmtWhen, spec } from "../../capabilities/core";
import type { ExtensionModule } from "../types";
import { questionsFor, type Choice, type MerchantDecision, type ReissuePlan } from "../../../../extensions/src/card-reissue/index.ts";
import {
  applyReissuePlan,
  approvedPlan,
  buildPlan,
  cardAccount,
  cardLast4,
  cardsOnFile,
  endingReceipts,
  labsStartReissue,
  labsUpdaterInquiry,
  latestReissue,
  onFileRows,
  scopeOf,
  seedCardReissue,
} from "../card-reissue/bank";

// E6 card reissue. When the card is replaced, the customer decides once, per merchant holding it on file, who gets the
// new card (KEEP) and who does not (DROP). Defaults come from the module: a live subscription keeps it, a verified
// cancellation drops it, an unknown merchant is asked. The approved list is the only thing the bank answers
// card-updater inquiries from; before approval no merchant gets the new card from the bank.

const REASON: Record<string, string> = { EXPIRY: "Card expiry", LOST: "Card reported lost", STOLEN: "Card reported stolen", COMPROMISED: "Card details compromised", CUSTOMER_REQUEST: "You asked for a new card" };
const BASIS: Record<MerchantDecision["basis"], string> = {
  CUSTOMER_CHOICE: "Your choice",
  ALL_SUBSCRIPTIONS_CANCELLED: "Cancellation verified by the bank",
  ACTIVE_SUBSCRIPTION: "Active subscription",
  UNANSWERED_KEEPS_SERVICE: "Not answered: kept so the service continues",
  UNANSWERED_AFTER_FRAUD: "Not answered: dropped after loss or fraud",
};
const inputKey = (groupKey: string) => `c_${groupKey.replace(/[^A-Za-z0-9]/g, "_").slice(0, 38)}`;
const card = (last4: string) => `•••• ${last4}`;
const names = (ids: string[], name: (id: string) => string) => (ids.length ? ids.map(name).join(", ") : "None");

function labsButtons(state: "NONE" | "STARTED" | "APPROVED", merchants: string[]): NonNullable<Analysis["labs"]> {
  const btn = (action: string, label: string, body: Record<string, unknown>) => ({ action: `card-reissue:${action}:${String(body.reason ?? body.merchantId)}`, label, endpoint: "/labs/ext", body: { module: "card-reissue", action, body } });
  if (state === "NONE") return [btn("start_reissue", "Simulate: card expires, new card issued", { reason: "EXPIRY" }), btn("start_reissue", "Simulate: card details compromised", { reason: "COMPROMISED" })];
  return merchants.map((m) => btn("updater_inquiry", `Simulate: ${m} asks the card updater for the new card`, { merchantId: m }));
}

export const E6: CapabilityDef = {
  id: "E6",
  title: "New card: who gets it",
  short: "Choose which merchants get your replacement card",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["new card", "card replaced", "card reissue", "card expired", "card updater", "card on file", "replacement card", "which merchants get my new card", "lost card"],
  async analyze(env): Promise<Analysis> {
    const base = { capability: "E6", title: "New card: who gets it", contextId: env.contextId, evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION"] as Analysis["evidence"] };
    const acct = cardAccount(env.db, env.tenantId, env.contextId);
    const rows = acct ? onFileRows(env.db, env.tenantId, env.contextId, acct.id) : [];
    const nameOf = (id: string) => rows.find((r) => r.merchant_id === id)?.merchant_name ?? id;
    const reissue = latestReissue(env.db, env.tenantId, env.contextId);
    const limit: Block = { kind: "note", tone: "info", text: "What the bank controls: whether it answers a merchant's card-updater request with the new card, and whether a network token keeps working. It cannot stop a merchant you give the new card to yourself, and merchants outside the updater only learn the new card from you." };

    if (!acct || !reissue) {
      return {
        ...base,
        headline: rows.length ? `${rows.length} merchants hold your card ${card(cardLast4(acct))} on file.` : "No merchant holds your card on file.",
        summary: "When your card is replaced, you choose which of these merchants get the new card. Nothing is shared until you approve the list.",
        blocks: [
          { kind: "status", title: "Card replacement", state: "None in progress" },
          { kind: "table", title: "Merchants holding your card", columns: ["Merchant", "Stored as", "Card updater"], rows: rows.map((r) => ({ cells: [r.merchant_name, r.credential_kind === "NETWORK_TOKEN" ? "Network token" : "Card number (last 4 only shown)", r.participates_in_updater ? "Takes part" : "Does not take part"] })) },
          limit,
        ],
        inputs: [],
        candidates: [],
        numbers: { onFile: rows.length },
        labs: labsButtons("NONE", []),
      };
    }

    const head = `${card(reissue.old_last4)} → ${card(reissue.new_last4)}`;
    const recorded = approvedPlan(env.db, env.tenantId, reissue.reissue_id);
    if (recorded) {
      const plan = json<ReissuePlan>(recorded.plan_json);
      const effects = json<any[]>(recorded.effects_json, []);
      const inquiries = all<any>(env.db, "SELECT merchant_id, answer, signal, received_at FROM ext_updater_inquiry WHERE tenant_id=? AND reissue_id=? ORDER BY received_at DESC, inquiry_id DESC LIMIT 20", env.tenantId, reissue.reissue_id);
      const manual = effects.filter((e) => e.type === "TELL_CUSTOMER_TO_UPDATE").map((e) => e.merchantId as string);
      const blocks: Block[] = [
        { kind: "status", title: `Card ${head}`, state: "List approved", detail: `Recorded ${fmtWhen(recorded.approved_at)}, reference ${recorded.reference}` },
        { kind: "table", title: "Your approved list", columns: ["Merchant", "New card", "Why"], rows: plan.decisions.map((d) => ({ cells: [nameOf(d.merchantId), d.decision === "KEEP" ? "Gets it" : "No update", BASIS[d.basis]], tone: d.decision === "KEEP" ? ("good" as const) : undefined })) },
        ...(manual.length ? [{ kind: "note" as const, tone: "warn" as const, text: `${names(manual, nameOf)} cannot get the new card through the updater. Enter ${card(reissue.new_last4)} with them yourself if you want them to keep billing you.` }] : []),
        {
          kind: "table",
          title: "Card-updater requests from merchants",
          columns: ["When", "Merchant", "Answer"],
          rows: inquiries.map((q) => ({
            cells: [fmtWhen(q.received_at), nameOf(q.merchant_id), q.answer === "PROVIDE" ? `New card ${card(reissue.new_last4)}` : q.signal === "REQUEST_AFTER_CANCELLATION" ? "Nothing shared: you cancelled" : q.signal === "NO_APPROVED_PLAN" ? "Nothing shared: no list approved yet" : "Nothing shared"],
            tone: q.signal === "REQUEST_AFTER_CANCELLATION" ? ("warn" as const) : undefined,
          })),
          note: inquiries.length ? undefined : "No merchant has asked yet.",
        },
        limit,
      ];
      return {
        ...base,
        headline: `Your list for ${head} is recorded. Merchants asking for the new card are answered from it.`,
        summary: `${plan.decisions.filter((d) => d.decision === "KEEP").length} merchants get the new card, ${plan.decisions.filter((d) => d.decision === "DROP").length} get no update.`,
        blocks,
        inputs: [],
        candidates: [],
        numbers: { keep: plan.decisions.filter((d) => d.decision === "KEEP").length, drop: plan.decisions.filter((d) => d.decision === "DROP").length, inquiries: inquiries.length },
        done: { label: "List recorded", href: "/activity" },
        labs: labsButtons("APPROVED", plan.decisions.map((d) => d.merchantId).slice(0, 12)),
      };
    }

    // STARTED: the customer's answers come in as select inputs, one per brand group; anything else is ignored.
    const merchants = cardsOnFile(env.db, env.tenantId, env.contextId, reissue.account_id);
    const questions = questionsFor({ scope: scopeOf(env.db, env.tenantId, env.contextId), merchants, receipts: endingReceipts(env.db, env.tenantId, env.contextId), now: env.now });
    const groups = [...new Set(merchants.map((m) => m.brandId ?? m.merchantId))].sort();
    const choices: Record<string, Choice> = {};
    for (const g of groups) {
      const v = env.inputs[inputKey(g)];
      if (v === "KEEP" || v === "DROP") choices[g] = v;
    }
    const { plan } = buildPlan(env.db, reissue, choices, env.now);
    const keep = plan.decisions.filter((d) => d.decision === "KEEP").map((d) => d.merchantId);
    const drop = plan.decisions.filter((d) => d.decision === "DROP").map((d) => d.merchantId);
    const manual = plan.decisions.filter((d) => d.warnings.includes("MANUAL_UPDATE_NEEDED")).map((d) => d.merchantId);
    const tokens = plan.decisions.filter((d) => d.decision === "DROP" && merchants.find((m) => m.merchantId === d.merchantId)?.credential.kind === "NETWORK_TOKEN").map((d) => d.merchantId);
    const keptCancelled = plan.decisions.filter((d) => d.warnings.includes("KEEPING_CANCELLED_MERCHANT")).map((d) => d.merchantId);
    const unanswered = questions.filter((q) => !choices[q.groupKey]);

    const inputs: InputField[] = groups.map((g) => {
      const q = questions.find((x) => x.groupKey === g);
      const d = plan.decisions.find((x) => x.groupKey === g)!;
      const label = q ? `${nameOf(d.merchantId)}: ${q.question === "UNKNOWN_PURPOSE" ? "no subscription known here; should it get the new card?" : "some subscriptions are cancelled; should it get the new card?"}` : `${nameOf(d.merchantId)} (${BASIS[d.basis].toLowerCase()})`;
      return { key: inputKey(g), label, type: "select", value: choices[g] ?? "", options: [{ value: "", label: `Suggested: ${d.basis === "CUSTOMER_CHOICE" ? "your choice" : d.decision === "KEEP" ? "gets it" : "no update"}` }, { value: "KEEP", label: "Gets the new card" }, { value: "DROP", label: "No update" }] };
    });

    const blocks: Block[] = [
      { kind: "status", title: `Card ${head}`, state: "Waiting for your list", detail: `${REASON[reissue.reason]}. Started ${fmtWhen(reissue.started_at)}. Until you approve, no merchant gets the new card from the bank.` },
      { kind: "metrics", items: [
        { label: "Get the new card", value: String(keep.length) },
        { label: "No update", value: String(drop.length) },
        { label: "To answer", value: String(unanswered.length), tone: unanswered.length ? ("warn" as const) : ("good" as const) },
      ] },
      {
        kind: "table",
        title: "Merchants holding your card",
        columns: ["Merchant", "New card", "Why", "Note"],
        rows: plan.decisions.map((d) => ({
          cells: [nameOf(d.merchantId), d.decision === "KEEP" ? "Gets it" : "No update", BASIS[d.basis], d.warnings.includes("MANUAL_UPDATE_NEEDED") ? "Not in the updater: update it yourself" : d.warnings.includes("KEEPING_CANCELLED_MERCHANT") ? "You cancelled this one" : d.question && d.basis !== "CUSTOMER_CHOICE" ? "Please answer" : ""],
          highlight: Boolean(d.question) && d.basis !== "CUSTOMER_CHOICE",
          tone: d.warnings.length ? ("warn" as const) : undefined,
        })),
      },
      ...unanswered.map((q): Block => ({ kind: "note", tone: "warn", text: `${names([...q.merchantIds], nameOf)}: ${q.question === "UNKNOWN_PURPOSE" ? "the bank knows no subscription here" : "some subscriptions here are cancelled and some are not"}. Without an answer, ${reissue.reason === "EXPIRY" || reissue.reason === "CUSTOMER_REQUEST" ? "it keeps the card so a service does not stop" : "it gets no update, because the card was lost or compromised"}.` })),
      ...(keptCancelled.length ? [{ kind: "note" as const, tone: "warn" as const, text: `You chose to give the new card to ${names(keptCancelled, nameOf)} although the bank verified you cancelled.` }] : []),
      limit,
    ];

    const candidates: Candidate[] = [{
      key: "apply-reissue-plan",
      defaultSelected: true,
      available: true,
      spec: spec({
        operation: "EXT_APPLY_REISSUE_PLAN",
        route: "BANK_INTERNAL",
        capability: "E6",
        subjectRef: reissue.reissue_id,
        canonicalKey: `ext-reissue:${reissue.reissue_id}`,
        params: { reissueId: reissue.reissue_id, oldCardRef: reissue.old_card_ref, newCardRef: reissue.new_card_ref, reason: reissue.reason, planId: plan.planId, manifestDigest: plan.manifestDigest, keep, drop, choices },
        display: display(
          `Give the new card ${card(reissue.new_last4)} to ${keep.length} merchants`,
          `When a merchant asks the card updater for your new card, the bank answers from this list only. ${drop.length} merchants get no update.`,
          [
            { label: "Card", value: `${card(reissue.old_last4)} replaced by ${card(reissue.new_last4)} (${REASON[reissue.reason]!.toLowerCase()})` },
            { label: "Gets the new card", value: names(keep, nameOf) },
            { label: "No update", value: names(drop, nameOf) },
            ...(manual.length ? [{ label: "Update yourself", value: `${names(manual, nameOf)} (not in the card updater)` }] : []),
            ...(tokens.length ? [{ label: "Token suspended", value: names(tokens, nameOf) }] : []),
          ],
          "You approve exactly this list. If a merchant is added to or removed from your card, or a cancellation changes before it is recorded, nothing is recorded and you are asked again. A merchant you give the new card to yourself can still charge it.",
          "Approve list",
        ),
      }),
    }];

    return {
      ...base,
      headline: unanswered.length ? `Your card ${head} is being replaced. ${unanswered.length} merchant${unanswered.length === 1 ? " needs" : "s need"} your answer.` : `Your card ${head} is being replaced. Review who gets the new card.`,
      summary: `${merchants.length} merchants hold the card. Live subscriptions keep it, verified cancellations do not, and you decide the rest.`,
      blocks,
      inputs,
      candidates,
      numbers: { onFile: merchants.length, keep: keep.length, drop: drop.length, questions: unanswered.length },
      labs: labsButtons("STARTED", ["streamly", "reelbox"]),
    };
  },
};

export const cardReissue: ExtensionModule = {
  key: "card-reissue",
  capabilities: [E6],
  operations: { EXT_APPLY_REISSUE_PLAN: applyReissuePlan },
  seed(db, input) {
    if (input.customer === "alex") seedCardReissue(db, input.tenantId);
  },
  labs: {
    start_reissue: ({ db, session, body }) => labsStartReissue(db, session, body),
    updater_inquiry: ({ db, session, body }) => labsUpdaterInquiry(db, session, body),
  },
};
