import { all, json, one } from "../db/connection";
import { sha256Hex } from "../canonical";
import { accountsFor } from "../bank/ledger";
import { scheduledItems } from "../bank/forecast";
import { featureAllowed, featureForRoute } from "../authority/features";
import { pauseEffect } from "../finance/capabilities";
import { airbagProjection, airbagProtection, type AirbagChange } from "../finance/financial-airbag";
import type { MerchantContractView } from "../../shared/merchant-contract";
import { toLocalIso } from "../../shared/time";
import { directory, display, fmtWhen, lastReceipt, liveContract, maskAccount, money, spec, subjectFields, type Analysis, type Block, type CapabilityDef, type Candidate } from "./core";

// A choice is an assumption for a review, never authority. The existing proposal/manifest/worker path owns execution.
export const O9: CapabilityDef = {
  id: "O9",
  title: "Financial Airbag",
  short: "Review optional outgoings in one place",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["financial airbag", "airbag", "pause optional spending", "stop optional spending", "pause nonessential", "spending emergency", "emergency spending"],
  async analyze(env): Promise<Analysis> {
    const window = { startInclusive: env.now, endExclusive: toLocalIso(env.nowMs + 30 * 86_400_000) };
    // The 200-payment bulk demonstration is a separate Labs scenario, not the customer's connected finances.
    const subscriptions = all<any>(env.db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset!='bulk' ORDER BY merchant_name, id", env.tenantId, env.contextId);
    const items = scheduledItems(env.db, env.tenantId, env.contextId).filter((i) => i.dataset !== "bulk");
    const providers = directory(env.db, env.tenantId);
    const keepPlayback = env.inputs.keepPlayback !== false;
    const inputs: Analysis["inputs"] = [{ key: "keepPlayback", label: "Keep TV and offline playback", type: "toggle", value: keepPlayback, help: "On: plans with these benefits are protected. Off: you may explicitly choose to lose access while paused or after paid access ends." }];
    const candidates: Candidate[] = [];
    const changes: AirbagChange[] = [];
    const rows: { cells: string[] }[] = [];
    const statusBlocks: Block[] = [];

    for (const sub of subscriptions) {
      const provider = providers.find((p) => p.id === sub.merchant_id);
      const localBenefits = json<Record<string, unknown>>(sub.benefits_json, {});
      const localProtection = airbagProtection({ category: sub.category, merchantCategory: provider?.category, localBenefits, contract: null, keepPlayback });
      if (localProtection) {
        rows.push({ cells: [sub.merchant_name, "Keep", localProtection] });
        continue;
      }
      const { contract: c } = await liveContract(env, sub);
      if (!c) {
        rows.push({ cells: [sub.merchant_name, "Unavailable", "Provider contract could not be checked; no action offered."] });
        continue;
      }
      if (c.merchantId !== sub.merchant_id || c.accountId !== sub.subscriber_account_id || c.contractId !== sub.contract_id) {
        rows.push({ cells: [sub.merchant_name, "Unavailable", "Provider account or contract did not match; no action offered."] });
        continue;
      }
      const protection = airbagProtection({ category: sub.category, merchantCategory: provider?.category, localBenefits, contract: c, keepPlayback });
      if (protection) {
        rows.push({ cells: [sub.merchant_name, "Keep", protection] });
        continue;
      }
      const busy = one<any>(env.db, `SELECT id, status FROM proposal_actions WHERE tenant_id=? AND context_id=? AND (subject_ref=? OR canonical_key=?) AND status IN ('APPROVED','EXECUTING','PENDING','UNKNOWN') ORDER BY updated_at DESC LIMIT 1`, env.tenantId, env.contextId, sub.id, sub.canonical_key);
      const receipt = lastReceipt(env, sub.id, "PAUSE") ?? lastReceipt(env, sub.id, "STOP_RENEWAL");
      if (busy) statusBlocks.push({ kind: "status", title: `${sub.merchant_name}: ${busy.status.toLowerCase()}`, state: busy.status, detail: "No repeat is sent. Scheduled costs stay unchanged until a provider receipt is verified.", href: `/actions/${busy.id}` });
      else if (receipt) statusBlocks.push({ kind: "status", title: `${sub.merchant_name}: provider receipt`, state: "CONFIRMED", detail: `Reference ${receipt.issuer_reference}. Current costs below use the recorded outcome.`, href: `/receipts/${receipt.id}` });

      let reason = !provider || provider.connector === "NONE" ? "No supported provider connector; use the provider directly." :
        !c.autoRenew || ["CANCELLED", "RENEWAL_OFF"].includes(c.state) ? "Renewal is already off; nothing more is submitted." :
        c.minimumTermUntil && Date.parse(c.minimumTermUntil) > env.nowMs ? `Minimum commitment until ${fmtWhen(c.minimumTermUntil)}; separate terms review required.` :
        c.exitFeeMinor !== 0 || (c.details.cancellationFeeMinor != null && c.details.cancellationFeeMinor !== 0) ? "Exit fees are not confirmed as zero; separate terms review required." :
        !c.accessUntil && !c.nextChargeAt ? "Access end is not confirmed; separate provider review required." : null;
      const pending = c.pending && Object.keys(c.pending).length > 0;
      const pause = c.details.pause as { startsAt?: string; allowedMonths?: number[]; feeMinor?: number } | undefined;
      const subItems = items.filter((i) => i.subscription_id === sub.id);
      const first = subItems[0];
      // The existing PAUSE effect reschedules one item. Offer one month only, with a matching dated charge and no fee.
      const canPause = provider?.connector === "PARTNER_API" && provider.operations.includes("PAUSE") && c.billingPeriod === "MONTHLY" &&
        pause?.allowedMonths?.includes(1) && pause.feeMinor === 0 && typeof pause.startsAt === "string" && Number.isFinite(Date.parse(pause.startsAt)) &&
        Date.parse(pause.startsAt) >= env.nowMs && first && Date.parse(first.due_at) === Date.parse(pause.startsAt) && first.amount_minor === -c.priceMinor;
      const canStop = provider?.connector !== "NONE" && provider?.operations.includes("STOP_RENEWAL");
      if (!reason && !canStop && !canPause) reason = "Neither a supported provider pause nor renewal-off is available; no card block is substituted.";
      if (reason) {
        rows.push({ cells: [sub.merchant_name, "Unavailable", reason] });
        continue;
      }
      const key = `airbag_${sha256Hex(sub.id).slice(0, 12)}`;
      const choice = env.inputs[key] === "pause" && canPause ? "pause" : env.inputs[key] === "stop" && canStop ? "stop" : "keep";
      const options = [{ value: "keep", label: "Keep unchanged" }, ...(canPause ? [{ value: "pause", label: "Provider pause · 1 month, then resumes" }] : []), ...(canStop ? [{ value: "stop", label: "Turn off renewal · paid access ends" }] : [])];
      // Keep the existing primitive-input boundary: no list of client-authored action specs or amounts.
      if (inputs.length < 20) inputs.push({ key, label: sub.merchant_name, type: "select", value: choice, options, help: "Choose an exact action, then Recalculate. You still review and approve its terms before anything is sent." });
      else {
        rows.push({ cells: [sub.merchant_name, "Keep", "This review supports 19 service choices; review this service separately."] });
        continue;
      }
      const executionAllowed = featureAllowed(featureForRoute(provider!.connector as "PARTNER_API" | "ISOLATED_BROWSER"));
      const unavailableReason = !executionAllowed ? "Execution is disabled in this environment; current scheduled costs stay due." : busy ? `Another change is ${busy.status.toLowerCase()}; follow the existing action.` : pending ? "The provider already has a pending change or scheduled pause; review its outcome first." : undefined;
      rows.push({ cells: [sub.merchant_name, choice === "pause" ? "Pause 1 month" : choice === "stop" ? "Renewal off" : "Keep", unavailableReason ?? (canPause ? "Provider pause available; access stops temporarily and resumes automatically." : "Provider pause unavailable. Renewal-off preserves paid access, then ends it.")] });
      if (choice === "keep") continue;
      const p = choice === "pause" ? pauseEffect({ monthlyMinor: c.priceMinor, pauseStartsAt: pause!.startsAt!, months: 1, allowedMonths: pause!.allowedMonths!, feeMinor: 0, window }) : null;
      const change: AirbagChange = p ? { operation: "PAUSE", subscriptionId: sub.id, itemId: first!.id, resumesAt: p.resumesAt } : { operation: "STOP_RENEWAL", subscriptionId: sub.id };
      const projection = airbagProjection(subItems, [change], window);
      const accessUntil = p?.accessEndsAt ?? c.accessUntil ?? c.nextChargeAt;
      const lostBenefits = benefitLosses(c, Boolean(p));
      const title = p ? `Pause ${sub.merchant_name} for 1 month` : `Turn off ${sub.merchant_name} renewal`;
      const candidate: Candidate = {
        key: `${key}_${choice}`,
        defaultSelected: true, // Only a customer's explicit service choice creates a candidate.
        available: !unavailableReason,
        unavailableReason,
        spec: spec({
          capability: "O9", operation: change.operation, route: provider!.connector as "PARTNER_API" | "ISOLATED_BROWSER", ...subjectFields(sub),
          params: p ? { months: 1 } : {}, termsRevision: c.termsRevision,
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: 0, forecastChangeMinor: projection.afterMinor - projection.beforeMinor },
          consequences: { effectiveAt: p ? pause!.startsAt! : null, accessUntil, lostBenefits, dataEffect: "No storage or student-tool service is included in this review.", remainingObligations: p ? `Automatically resumes ${fmtWhen(p.resumesAt)} at ${money(c.priceMinor)}/month. Existing obligations stay due.` : "Existing bills and obligations stay due; only future renewal is turned off." },
          display: display(title, p ? `Access stops ${fmtWhen(accessUntil)}; automatically resumes ${fmtWhen(p.resumesAt)} at ${money(c.priceMinor)}/month.` : `Paid access ends ${fmtWhen(accessUntil)}. This changes the provider contract, not the card.`, [
            { label: "Provider / plan", value: `${c.merchantName} · ${c.planName}` },
            { label: "Subscriber account", value: maskAccount(c.accountId) },
            { label: "Exact action", value: p ? "Provider pause for 1 month; automatic restart" : "Turn off renewal; no automatic restart" },
            { label: "Access ends", value: fmtWhen(accessUntil) },
            { label: "Fee / debit now", value: `${money(0)} / ${money(0)}` },
            { label: "Lost benefits", value: lostBenefits.join("; ") },
            { label: "30-day dates", value: `${fmtWhen(window.startInclusive)} to ${fmtWhen(window.endExclusive)} (end excluded)` },
            { label: "Dated costs before → if confirmed", value: `${money(projection.beforeMinor)} → ${money(projection.afterMinor)}` },
            { label: "Restart / remaining obligations", value: p ? `${fmtWhen(p.resumesAt)} at ${money(c.priceMinor)}/month; existing obligations remain due` : "No renewal; existing obligations remain due" },
            { label: "Terms", value: `Revision ${c.termsRevision}` },
          ], "Approval covers only this service and action. Current cash does not change. A provider pause, renewal-off and blocking a card are different actions; no card is blocked here.", "Approve this exact action"),
        }),
      };
      candidates.push(candidate);
      if (candidate.available) changes.push(change);
    }
    const projection = airbagProjection(items, changes, window);
    const cashMinor = accountsFor(env.db, env.tenantId, env.contextId).reduce((s, a) => s + a.balanceMinor, 0);
    return {
      capability: "O9", title: "Financial Airbag", contextId: env.contextId,
      headline: changes.length ? `${changes.length} optional change${changes.length === 1 ? "" : "s"} ready for exact review` : "Choose optional spending to pause or stop renewing",
      summary: "An emergency spending review. Opening it changes nothing; you choose each service and approve an exact manifest.",
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Scheduled costs · next 30 days", value: money(projection.beforeMinor), sub: `${fmtWhen(window.startInclusive)} to ${fmtWhen(window.endExclusive)} (end excluded)` }, { label: "Conditional after all choices confirm", value: money(projection.afterMinor), sub: "Only available choices below; pending and unknown outcomes still count as due." }, { label: "Current cash · unchanged", value: money(cashMinor), sub: "Avoiding a future charge is not a refund or a cash credit." }] },
        { kind: "note", tone: "info", text: "Choose services below and Recalculate, then review the selected actions. A provider pause suspends access and restarts automatically. Renewal-off keeps paid access until it ends. Card blocking only stops card use and does not end a contract; no card block is offered here." },
        { kind: "table", title: "Services and protections", columns: ["Service", "Choice", "What applies"], rows, note: "Rent, utilities, loans, insurance and healthcare remain due. Data, storage, student tools and required benefits need a separate dependency review. Unsupported providers stay unchanged." },
        { kind: "table", title: "Dated scheduled costs", columns: ["Payment / date", "Before", "If choices confirm"], rows: projection.rows.filter((r) => r.beforeMinor || r.afterMinor).map((r) => ({ cells: [`${r.item.label} · ${fmtWhen(r.item.due_at)}`, money(r.beforeMinor), `${money(r.afterMinor)}${r.dueAfter && r.dueAfter !== r.item.due_at ? ` · moves to ${fmtWhen(r.dueAfter)}` : !r.dueAfter ? " · renewal off" : ""}`] })), note: "Uses this context's recorded scheduled outflows, excluding the separate bulk Labs scenario. Conditional bank entries remain conditional; no unrecorded recurring costs or lifetime savings are estimated." },
        ...statusBlocks,
      ],
      inputs, candidates,
      numbers: { beforeMinor: projection.beforeMinor, conditionalAfterMinor: projection.afterMinor, currentCashMinor: cashMinor, conditionalAvoidedMinor: projection.beforeMinor - projection.afterMinor, selectedActions: changes.length },
    };
  },
};

function benefitLosses(c: MerchantContractView, paused: boolean): string[] {
  const when = paused ? "while paused" : "after paid access ends";
  const labels: Record<string, string> = { tvAccess: "TV access", offlinePlayback: "Offline playback", freeDelivery: "Free delivery", classes: "Classes", access: "Membership access" };
  const benefits = Object.entries(c.benefits).filter(([, v]) => v !== false && v !== 0 && v !== null && v !== undefined && v !== "").map(([key, value]) => `${labels[key] ?? key}${typeof value === "string" ? ` (${value})` : ""} ${when}`);
  return benefits.length ? benefits : [`${c.planName} access ${when}`];
}
