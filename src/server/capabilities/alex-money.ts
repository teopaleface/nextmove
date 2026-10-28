import { all, json, one, run } from "../db/connection";
import { accountsFor } from "../bank/ledger";
import { classifyPossibleDuplicates, priceAdjustmentCheck, totalCostOfOwnership, expiringCreditMatch, travelComparison } from "../finance/capabilities";
import { homeReadiness, comparePurchases, afterHomeBudget } from "../finance/goals";
import { merchantAccountId } from "../../shared/ids";
import { unavailable } from "./alex-subscriptions";
import {
  type Analysis,
  type Block,
  type CapEnv,
  type CapabilityDef,
  type Candidate,
  PROVENANCE,
  display,
  fact,
  fixture,
  fmtDate,
  fmtWhen,
  inputOr,
  money,
  openActionFor,
  spec,
} from "./core";

function goalInputs(env: CapEnv, id: string) {
  const g = one<any>(env.db, "SELECT * FROM goals WHERE id=? AND tenant_id=?", `${env.tenantId}:goal:${id}`, env.tenantId);
  return g ? { goal: g, inputs: json<any>(g.inputs_json, {}) } : null;
}

function answer(env: CapEnv, key: string): string | null {
  const f = fact(env, key);
  return f ? String(json<any>(f.value_json)?.value ?? "") : null;
}

function primaryAccount(env: CapEnv) {
  return accountsFor(env.db, env.tenantId, env.contextId).find((a) => a.kind === "CURRENT" || a.kind === "BUSINESS_CURRENT")!;
}

function ensureRecovery(env: CapEnv, id: string, r: { kind: string; merchantId: string; merchantName: string; amountMinor: number; transactionId: string | null; data: object }) {
  run(
    env.db,
    `INSERT OR IGNORE INTO recoveries(id, tenant_id, context_id, kind, merchant_id, merchant_name, amount_minor, state, reference, expected_by, transaction_id, timeline_json, data_json, updated_at)
     VALUES (?,?,?,?,?,?,?, 'DRAFT', NULL, NULL, ?, ?, ?, ?)`,
    id, env.tenantId, env.contextId, r.kind, r.merchantId, r.merchantName, r.amountMinor, r.transactionId, JSON.stringify([{ at: env.now, state: "DRAFT", label: "Prepared by NextMove from your bank records" }]), JSON.stringify(r.data), env.now,
  );
  return one<any>(env.db, "SELECT * FROM recoveries WHERE id=?", id);
}

/* ------------------------------------------------------------------------------------------------ T1 */
const T1: CapabilityDef = {
  id: "T1",
  title: "Read a screenshot or document",
  short: "Screen Time, student ID, invoices: read, confirm, match",
  group: "Evidence",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["screen time", "screenshot", "image", "photo", "upload", "document", "invoice", "usage"],
  async analyze(env) {
    const exts = all<any>(env.db, "SELECT e.*, u.label FROM extractions e JOIN uploads u ON u.id=e.upload_id WHERE e.tenant_id=? AND e.context_id=? ORDER BY e.created_at DESC LIMIT 6", env.tenantId, env.contextId);
    const blocks: Block[] = [];
    const st = exts.find((e) => json<any>(e.fields_json, {}).kind === "SCREEN_TIME" && e.status === "CONFIRMED");
    let numbers: Record<string, number> = {};
    if (st) {
      const f = json<any>(st.fields_json, {});
      const apps = (f.items as any[]).filter((i) => i.key.startsWith("app:") && i.value != null);
      const subs = all<any>(env.db, "SELECT * FROM subscriptions WHERE tenant_id=? AND context_id=? AND dataset='ui'", env.tenantId, env.contextId);
      const rows = apps.map((a) => {
        const name = a.key.slice(4);
        const sub = subs.find((s) => s.merchant_name.toLowerCase() === name.toLowerCase());
        const weeklyHours = Number(a.value) / 60;
        const perHour = sub && weeklyHours > 0 ? Math.round(sub.amount_minor / (weeklyHours * 4.345)) : null;
        return { name, minutes: Number(a.value), sub, perHour, prov: a.provenance };
      });
      const streamly = rows.find((r) => r.name.toLowerCase() === "streamly");
      if (streamly) numbers = { streamlyMinutes: streamly.minutes, streamlyMonthlyMinor: streamly.sub?.amount_minor ?? 0 };
      blocks.push({
        kind: "table",
        title: `Phone use (${f.items.find((i: any) => i.key === "periodLabel")?.value ?? "period"})`,
        columns: ["App", "Minutes", "Subscription", "Per phone hour"],
        rows: rows.map((r) => ({ cells: [r.name, String(r.minutes), r.sub ? `${money(r.sub.amount_minor)}/mo` : "—", r.perHour != null ? money(r.perHour) : "—"], highlight: Boolean(r.sub) })),
        note: "Phone minutes alone do not show TV, family or background use.",
      });
      blocks.push({
        kind: "facts",
        title: "Where each fact came from",
        items: rows.flatMap((r) => [
          { label: `${r.name} minutes`, value: String(r.minutes), provenance: r.prov === "READ_FROM_IMAGE" ? (st.mode === "LIVE_MODEL" ? `${PROVENANCE.READ_FROM_IMAGE} (${st.model})` : PROVENANCE.YOU_ENTERED) : PROVENANCE.YOU_ENTERED },
          ...(r.sub ? [{ label: `${r.name} price`, value: `${money(r.sub.amount_minor)}/month`, provenance: PROVENANCE.MATCHED_BANK_RECORD }] : []),
        ]),
      });
      const qs = [
        { id: "t1:tv_use_streamly", text: "Do you also watch Streamly on a TV or laptop?" },
        { id: "t1:family_use_streamly", text: "Does anyone else in your household use your Streamly account?" },
        { id: "t1:background_use", text: "Do any of these apps play in the background (music, downloads)?" },
      ];
      for (const q of qs) blocks.push({ kind: "question", id: q.id, text: q.text, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], answer: answer(env, q.id) });
      const tv = answer(env, "t1:tv_use_streamly");
      const fam = answer(env, "t1:family_use_streamly");
      if (tv || fam) {
        blocks.push({ kind: "note", tone: "info", text: tv === "yes" || fam === "yes" ? "Streamly is used beyond the phone, so the low phone minutes do not mean it is unused. Keep it, or compare the bundle (T3) instead of cancelling." : `Streamly had ${streamly?.minutes ?? 0} phone minutes and no other use. A pause (A6) would skip the next 49 RON charge without losing the account.` });
      }
    }
    for (const e of exts) {
      const f = json<any>(e.fields_json, {});
      if (f.injectedInstructions?.length) blocks.push({ kind: "note", tone: "warn", text: `${e.label ?? "An image"} contained text addressed to an assistant (“${String(f.injectedInstructions[0]).slice(0, 140)}”). NextMove treated it as data and ignored it. No payment or approval was created.` });
      if (f.kind === "INVOICE" && e.status !== "FAILED") {
        const iban = f.items.find((i: any) => i.key === "payeeIban")?.value;
        blocks.push({ kind: "facts", title: `Invoice ${f.items.find((i: any) => i.key === "invoiceNumber")?.value ?? ""}`, items: f.items.filter((i: any) => i.value != null).map((i: any) => ({ label: i.label, value: i.key === "amountMinor" ? money(Number(i.value)) : String(i.value), provenance: i.provenance === "READ_FROM_IMAGE" ? PROVENANCE.READ_FROM_IMAGE : i.provenance === "YOU_ENTERED" ? PROVENANCE.YOU_ENTERED : PROVENANCE.NEEDS_CHECKING })) });
        if (iban) blocks.push({ kind: "note", tone: "warn", text: `The payee IBAN on this invoice is not a known payee in your bank records. NextMove will not prepare a payment to it.` });
      }
    }
    blocks.push({
      kind: "table",
      title: "Recent images",
      columns: ["Image", "Read by", "Status"],
      rows: exts.map((e) => ({ cells: [e.label ?? json<any>(e.fields_json, {}).kind, e.mode === "LIVE_MODEL" ? `Live model${e.model ? ` (${e.model})` : ""}` : "You entered (manual)", e.status === "CONFIRMED" ? "Confirmed" : e.status === "FAILED" ? "Not read" : "Check the fields"] })),
    });
    return {
      capability: "T1",
      title: "Images and documents",
      contextId: env.contextId,
      headline: st ? "Screen Time confirmed and matched to your subscriptions" : "Upload a Screen Time screenshot or a document",
      summary: "NextMove reads the actual image with the live model, then you confirm each field. Text inside images is never treated as an instruction.",
      evidence: ["LIVE_MODEL_VISION", "BANK_RECORD", "MANUAL_INPUT"],
      blocks,
      inputs: [],
      candidates: [],
      numbers,
      links: [{ label: "Upload or use a sample image", href: "/agent/evidence" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A7 */
const A7: CapabilityDef = {
  id: "A7",
  title: "Refund on its way",
  short: "StudioMart accepted 249 RON; not credited yet",
  group: "Money back",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["refund", "money back", "studiomart", "return"],
  async analyze(env) {
    const recs = all<any>(env.db, "SELECT * FROM recoveries WHERE tenant_id=? AND context_id=? ORDER BY updated_at DESC", env.tenantId, env.contextId);
    const r = recs.find((x) => x.kind === "REFUND");
    if (!r) return unavailable(env, "A7", "No refunds are being tracked");
    const credit = r.credit_transaction_id ? one<any>(env.db, "SELECT * FROM transactions WHERE id=?", r.credit_transaction_id) : null;
    const overdue = !credit && r.expected_by && env.nowMs > Date.parse(r.expected_by);
    const balance = primaryAccount(env);
    const followed = openActionFor(env, r.id, "FOLLOW_UP");
    const candidates: Candidate[] = credit
      ? []
      : [
          {
            key: "follow-up",
            defaultSelected: true,
            available: !followed,
            unavailableReason: followed ? "A follow-up is already in progress" : undefined,
            spec: spec({
              operation: "FOLLOW_UP",
              route: "PARTNER_API",
              capability: "A7",
              merchantId: r.merchant_id,
              merchantName: r.merchant_name,
              subscriberAccountId: json<any>(r.data_json, {}).merchantAccount ?? merchantAccountId(env.tenantId, r.merchant_id, "sm-alex"),
              subjectRef: r.id,
              params: { subject: `Refund ${r.reference}`, body: `Hello, you accepted refund ${r.reference} for ${money(r.amount_minor)} on ${fmtDate(json<any[]>(r.timeline_json, []).find((t) => t.state === "MERCHANT_ACCEPTED")?.at)}. It has not reached my account yet. Please confirm the payout date.` },
              display: display(`Ask ${r.merchant_name} about refund ${r.reference}`, overdue ? "The expected date has passed." : `Expected by ${fmtDate(r.expected_by)}.`, [
                { label: "To", value: `${r.merchant_name} support (simulated)` },
                { label: "Message", value: `Refund ${r.reference}: please confirm the payout date` },
                { label: "Cost", value: money(0) },
              ], "Sends one message. It does not change any money."),
            }),
          },
        ];
    const tl = json<any[]>(r.timeline_json, []);
    return {
      capability: "A7",
      title: "Refund tracker",
      contextId: env.contextId,
      headline: credit ? `${money(r.amount_minor)} from ${r.merchant_name} has been credited` : `${r.merchant_name} accepted ${money(r.amount_minor)}; it is not in your account yet`,
      summary: credit ? `Credited on ${fmtWhen(credit.booked_at)} as a unique bank credit.` : `Accepted refunds are tracked separately. Your balance only changes when the bank receives the credit${r.expected_by ? ` (expected by ${fmtDate(r.expected_by)})` : ""}.`,
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_EVENT"],
      blocks: [
        { kind: "metrics", items: [{ label: "Accepted", value: money(r.amount_minor), sub: "Not money yet" }, { label: "Credited", value: money(credit ? credit.amount_minor : 0), tone: credit ? "good" : "neutral" }, { label: balance.name, value: money(balance.balanceMinor) }] },
        { kind: "timeline", title: "Refund states", items: [...tl.map((t) => ({ at: t.at, label: t.label, state: t.state })), ...(credit ? [] : [{ at: r.expected_by, label: overdue ? "Expected date passed" : "Expected by", state: overdue ? "OVERDUE" : "PENDING" }])] },
        { kind: "conditions", title: "States", items: ["SUBMITTED", "MERCHANT_ACCEPTED", "AWAITING_CREDIT", "CREDITED"].map((s) => ({ label: s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), state: s === "CREDITED" ? (credit ? "met" : "unmet") : "met" })) },
      ],
      inputs: [],
      candidates,
      numbers: { amountMinor: r.amount_minor, creditedMinor: credit ? credit.amount_minor : 0, balanceMinor: balance.balanceMinor },
      done: credit ? { label: `Credited ${money(credit.amount_minor)}` } : null,
      labs: credit ? [] : [{ action: "refund_payout", label: "Provider: pay the refund now", body: { reference: r.reference } }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A8 */
const A8: CapabilityDef = {
  id: "A8",
  title: "Charged twice?",
  short: "Check repeated payments before claiming",
  group: "Money back",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["twice", "double", "duplicate payment", "charged twice", "techbits", "dispute"],
  async analyze(env) {
    const txns = all<any>(env.db, "SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND status IN ('POSTED','PENDING') ORDER BY booked_at", env.tenantId, env.contextId).map((t) => ({ id: t.id, merchantName: t.merchant_name, amountMinor: t.amount_minor, status: t.status, bookedAt: t.booked_at, orderRef: t.order_ref, authId: json<any>(t.data_json, {}).authId ?? null, merchantId: t.merchant_id }));
    const r = classifyPossibleDuplicates(txns as any);
    const label = { AUTHORIZATION_HOLD: "Pending hold", LIKELY_TWO_PURCHASES: "Two purchases", POSSIBLE_SETTLED_DUPLICATE: "Possible duplicate" } as const;
    const candidates: Candidate[] = [];
    const blocks: Block[] = [{ kind: "table", title: "Repeated payments", columns: ["Merchant", "Amount", "What it is"], rows: r.groups.map((g) => ({ cells: [g.transactions[0].merchantName, money(g.transactions[0].amountMinor), label[g.classification]], tone: g.claimable ? "warn" : undefined })) }];
    for (const g of r.groups) {
      blocks.push({ kind: "facts", title: `${g.transactions[0].merchantName}: ${label[g.classification]}`, items: g.transactions.map((t: any) => ({ label: `${fmtWhen(t.bookedAt)} · ${t.status.toLowerCase()}`, value: `${money(t.amountMinor)}${t.orderRef ? ` · order ${t.orderRef}` : ""}${t.authId ? ` · auth ${t.authId}` : ""}`, provenance: PROVENANCE.BANK })) });
      blocks.push({ kind: "note", tone: g.claimable ? "warn" : "info", text: g.reason });
      if (g.question) blocks.push({ kind: "question", id: `a8:${g.key}`, text: g.question, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], answer: answer(env, `a8:${g.key}`) });
      if (g.claimable) {
        const t0: any = g.transactions[0];
        const t1: any = g.transactions[1];
        const merchantId = t0.merchantId ?? "techbits";
        const rec = ensureRecovery(env, `${env.tenantId}:rec:${merchantId}-dup`, { kind: "DUPLICATE_CLAIM", merchantId, merchantName: t0.merchantName, amountMinor: -t0.amountMinor, transactionId: t1.id, data: { orderRef: t0.orderRef, evidence: [t0.id, t1.id] } });
        const confirmed = answer(env, `a8:${g.key}`) === "yes";
        if (rec.state === "DRAFT") {
          candidates.push({
            key: "claim-duplicate",
            defaultSelected: true,
            available: confirmed,
            unavailableReason: confirmed ? undefined : "Answer the question first: did you place only one order?",
            spec: spec({
              operation: "SUBMIT_CLAIM",
              route: "PARTNER_API",
              capability: "A8",
              merchantId,
              merchantName: t0.merchantName,
              subscriberAccountId: merchantAccountId(env.tenantId, merchantId, "tb-alex"),
              subjectRef: rec.id,
              params: { kind: "DUPLICATE_CHARGE", amountMinor: -t1.amountMinor, orderRef: t0.orderRef, evidence: [`${fmtWhen(t0.bookedAt)} ${money(t0.amountMinor)}`, `${fmtWhen(t1.bookedAt)} ${money(t1.amountMinor)}`, `same order ${t0.orderRef}`] },
              display: display(`Claim the second ${t0.merchantName} payment`, `Ask ${t0.merchantName} to return ${money(-t1.amountMinor)} for order ${t0.orderRef}.`, [
                { label: "Claim", value: money(-t1.amountMinor) },
                { label: "Order", value: String(t0.orderRef) },
                { label: "Evidence", value: "Two posted payments, same order reference, 9 minutes apart" },
                { label: "You confirmed", value: "Only one order was placed" },
              ], "A claim is not money back. Your balance changes only when a credit arrives."),
            }),
          });
        } else {
          blocks.push({ kind: "status", title: `Claim ${rec.reference ?? ""}`, state: rec.state, detail: json<any[]>(rec.timeline_json, []).slice(-1)[0]?.label });
        }
      }
    }
    return {
      capability: "A8",
      title: "Repeated payments",
      contextId: env.contextId,
      headline: `${r.groups.length} repeated payments: ${r.groups.filter((g) => g.claimable).length} may be a real duplicate`,
      summary: "A pending hold, two genuine purchases and a settled duplicate look alike. Only the settled duplicate is worth a claim.",
      evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION"],
      blocks,
      inputs: [],
      candidates,
      numbers: { groups: r.groups.length, claimableMinor: r.groups.filter((g) => g.claimable).reduce((s, g) => s - g.transactions[1].amountMinor, 0) },
      labs: [{ action: "claims_fast_forward", label: "Provider: review claims now" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A9 */
const A9: CapabilityDef = {
  id: "A9",
  title: "Price dropped after you bought",
  short: "SoundHub price protection: 100 RON",
  group: "Money back",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["price drop", "price adjustment", "price protection", "soundhub", "cheaper now"],
  async analyze(env) {
    const acctId = merchantAccountId(env.tenantId, "soundhub", "sh-alex");
    const acct = (await env.merchant.getAccount("soundhub", acctId)).account;
    if (!acct) return unavailable(env, "A9", "SoundHub could not be read");
    const pol = acct.details.policy;
    const txn = one<any>(env.db, "SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND order_ref=?", env.tenantId, env.contextId, pol.purchase.orderRef);
    const r = priceAdjustmentCheck({ policy: pol, purchase: pol.purchase, currentPrice: pol.currentPrice, nowIso: env.now, merchantSeller: "SoundHub" });
    const rec = r.eligible ? ensureRecovery(env, `${env.tenantId}:rec:soundhub-pa`, { kind: "PRICE_ADJUSTMENT", merchantId: "soundhub", merchantName: "SoundHub", amountMinor: r.differenceMinor!, transactionId: txn?.id ?? null, data: { orderRef: pol.purchase.orderRef, policyRevision: pol.policyRevision } }) : null;
    const candidates: Candidate[] =
      r.eligible && rec?.state === "DRAFT"
        ? [
            {
              key: "claim-price",
              defaultSelected: true,
              available: true,
              spec: spec({
                operation: "SUBMIT_CLAIM",
                route: "PARTNER_API",
                capability: "A9",
                merchantId: "soundhub",
                merchantName: "SoundHub",
                subscriberAccountId: acctId,
                subjectRef: rec.id,
                params: { kind: "PRICE_ADJUSTMENT", amountMinor: r.differenceMinor, orderRef: pol.purchase.orderRef, policyRevision: pol.policyRevision, evidence: [`Paid ${money(pol.purchase.paidMinor)} on ${fmtDate(pol.purchase.purchasedAt)}`, `Now ${money(pol.currentPrice.priceMinor)} (catalog revision ${pol.currentPrice.catalogRevision})`] },
                display: display("Request the SoundHub price difference", `${money(r.differenceMinor!)} under price-protection policy revision ${pol.policyRevision}.`, [
                  { label: "Item", value: `${pol.purchase.item} (${pol.purchase.sku})` },
                  { label: "Paid", value: `${money(pol.purchase.paidMinor)} on ${fmtDate(pol.purchase.purchasedAt)}` },
                  { label: "Price now", value: money(pol.currentPrice.priceMinor) },
                  { label: "Request", value: money(r.differenceMinor!) },
                  { label: "Window ends", value: fmtWhen(r.windowEndsAt) },
                ], "A request is not money back; your balance changes only when the credit arrives."),
              }),
            },
          ]
        : [];
    return {
      capability: "A9",
      title: "Price adjustment",
      contextId: env.contextId,
      headline: r.eligible ? `Eligible: ${money(r.differenceMinor!)} until ${fmtDate(r.windowEndsAt)}` : r.status === "UNKNOWN_POLICY" ? "No price-protection policy found" : "Not eligible",
      summary: pol.text,
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "conditions", title: `Policy revision ${pol.policyRevision}`, items: ((r as any).checks ?? []).map((c: any) => ({ label: c.text, state: c.ok ? "met" : "unmet" })) },
        { kind: "facts", title: "Evidence", items: [
          { label: "Bank payment", value: txn ? `${money(txn.amount_minor)} on ${fmtWhen(txn.booked_at)} (order ${txn.order_ref})` : "Not found", provenance: PROVENANCE.MATCHED_BANK_RECORD },
          { label: "Current price", value: `${money(pol.currentPrice.priceMinor)} seen ${fmtWhen(pol.currentPrice.observedAt)}`, provenance: PROVENANCE.MERCHANT },
        ] },
        ...(rec && rec.state !== "DRAFT" ? [{ kind: "status" as const, title: `Request ${rec.reference ?? ""}`, state: rec.state, detail: json<any[]>(rec.timeline_json, []).slice(-1)[0]?.label }] : []),
      ],
      inputs: [],
      candidates,
      numbers: { differenceMinor: r.differenceMinor ?? 0, paidMinor: pol.purchase.paidMinor, currentMinor: pol.currentPrice.priceMinor },
      labs: [{ action: "claims_fast_forward", label: "Provider: review requests now" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A10 */
const A10: CapabilityDef = {
  id: "A10",
  title: "True cost of a purchase",
  short: "Phone: price plus accessories, protection, service",
  group: "Purchases",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["total cost", "tco", "phone", "buy", "worth", "accessories", "protection"],
  async analyze(env) {
    const g = goalInputs(env, "phone");
    const tco = g?.inputs.tco ?? fixture("demo/capability-scenarios.json").alex.phoneTco;
    const horizon = Math.min(60, Math.max(6, Number(inputOr(env, "horizonMonths", tco.horizonMonths))));
    const includeProtection = String(inputOr(env, "includeProtection", String(tco.includeProtection))) !== "false";
    const r = totalCostOfOwnership({ options: tco.options, horizonMonths: horizon, includeProtection });
    return {
      capability: "A10",
      title: "Total cost of ownership",
      contextId: env.contextId,
      headline: `Over ${horizon} months the ${r.rows.find((x) => x.id === r.lowestId)?.name} costs ${money(r.differenceMinor)} less`,
      summary: r.note,
      evidence: ["DETERMINISTIC_CALCULATION", "MANUAL_INPUT"],
      blocks: [
        { kind: "metrics", items: r.rows.map((x) => ({ label: x.name, value: money(x.totalMinor), sub: `${money(x.monthlyEquivalentMinor)}/month`, tone: x.id === r.lowestId ? ("good" as const) : undefined })) },
        ...r.rows.map((x) => ({ kind: "table" as const, title: x.name, columns: ["Cost", "Amount"], rows: [...x.parts.map((p) => ({ cells: [p.label, money(p.minor)] })), { cells: ["Total", money(x.totalMinor)], highlight: true }], note: x.unknowns.join(" ") || undefined })),
      ],
      inputs: [
        { key: "horizonMonths", label: "Keep it for", type: "number", value: horizon, min: 6, max: 60, suffix: "months" },
        { key: "includeProtection", label: "Include protection plan", type: "toggle", value: includeProtection },
      ],
      candidates: [],
      numbers: Object.fromEntries(r.rows.map((x) => [`${x.id}TotalMinor`, x.totalMinor])),
      links: [{ label: "See the effect on your home goal (O1)", href: "/capabilities/O1" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A12 */
const A12: CapabilityDef = {
  id: "A12",
  title: "Credit about to expire",
  short: "BookNook 120 RON credit expires 15 Nov",
  group: "Purchases",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["credit", "voucher", "expire", "expiring", "booknook", "gift card", "points"],
  async analyze(env) {
    const acctId = merchantAccountId(env.tenantId, "booknook", "bn-alex");
    const acct = (await env.merchant.getAccount("booknook", acctId)).account;
    if (!acct) return unavailable(env, "A12", "BookNook could not be read");
    const credit = acct.details.credit;
    const wish = goalInputs(env, "wishlist")?.inputs.items?.[0] ?? null;
    const r = expiringCreditMatch({ credit, intended: wish, eligibleCategories: ["books", "stationery"], nowIso: env.now });
    const ordered = (acct.details.orders ?? []).find((o: any) => o.creditId === credit.id);
    const daily = primaryAccount(env);
    const candidates: Candidate[] =
      r.status === "MATCH" && !ordered && credit.balanceMinor > 0
        ? [
            {
              key: "redeem",
              defaultSelected: true,
              available: daily.balanceMinor >= (r.uncoveredMinor ?? 0),
              unavailableReason: daily.balanceMinor < (r.uncoveredMinor ?? 0) ? "Not enough money for the uncovered part" : undefined,
              spec: spec({
                operation: "PLACE_ORDER",
                route: "PARTNER_API",
                capability: "A12",
                merchantId: "booknook",
                merchantName: "BookNook",
                subscriberAccountId: acctId,
                subjectRef: `${env.tenantId}:credit:booknook`,
                params: { itemId: wish.itemId, title: wish.title, creditId: credit.id, creditAppliedMinor: r.coveredMinor, cardChargeMinor: r.uncoveredMinor, debitAccountId: daily.id, category: "Books" },
                money: { currency: "RON", immediateDebitMinor: r.uncoveredMinor ?? 0, maxDebitMinor: r.uncoveredMinor ?? 0, feesMinor: 0, forecastChangeMinor: 0 },
                consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: null },
                display: display(`Use the BookNook credit for “${wish.title}”`, `${money(r.coveredMinor)} from the credit, ${money(r.uncoveredMinor ?? 0)} from ${daily.name}.`, [
                  { label: "Item", value: `${wish.title} · ${money(wish.priceMinor)}` },
                  { label: "Credit used", value: `${money(r.coveredMinor)} (${credit.id}, expires ${fmtDate(credit.expiresAt)})` },
                  { label: "Card charge", value: `${money(r.uncoveredMinor ?? 0)} from ${daily.name} (maximum)` },
                  { label: "Source", value: wish.source },
                ], "Only a purchase you already planned is matched. The bank refuses any charge above the approved maximum."),
              }),
            },
          ]
        : [];
    return {
      capability: "A12",
      title: "Expiring credit",
      contextId: env.contextId,
      headline: ordered ? "Credit used for your planned purchase" : r.status === "MATCH" ? `Your planned book uses ${money(r.coveredMinor)} of credit; ${money(r.uncoveredMinor ?? 0)} is not covered` : r.status === "EXPIRED" ? "The credit has expired" : "No planned purchase matches this credit",
      summary: `${money(credit.balanceMinor)} BookNook credit expires ${fmtWhen(credit.expiresAt)}. ${credit.restrictions}`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION", "BANK_RECORD"],
      blocks: [
        { kind: "metrics", items: [{ label: "Credit", value: money(credit.balanceMinor), sub: `expires ${fmtDate(credit.expiresAt)}` }, { label: "Covered", value: money(r.coveredMinor), tone: "good" }, { label: "You pay", value: money(r.uncoveredMinor ?? 0) }, { label: "Lost if unused", value: money(r.forfeitMinor) }] },
        { kind: "note", tone: "info", text: r.note },
      ],
      inputs: [],
      candidates,
      numbers: { creditMinor: credit.balanceMinor, coveredMinor: r.coveredMinor, uncoveredMinor: r.uncoveredMinor ?? 0 },
      done: ordered ? { label: "Order placed with the credit" } : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A14 */
const A14: CapabilityDef = {
  id: "A14",
  title: "Trip costs: data, cards, currency",
  short: "Barcelona 12–16 Nov",
  group: "Travel",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["travel", "trip", "barcelona", "roaming", "esim", "currency", "fx", "abroad"],
  async analyze(env) {
    const t = goalInputs(env, "trip")!.inputs;
    const mn = fixture("demo/capability-scenarios.json").alex.mobileNet;
    const verifiedFact = fact(env, "a14:card_benefit_verified");
    const verified = verifiedFact ? json<any>(verifiedFact.value_json)?.value === true : null;
    const dpAcct = merchantAccountId(env.tenantId, "datapass", "dp-alex");
    const days = Math.round((Date.parse(`${t.end}T00:00:00Z`) - Date.parse(`${t.start}T00:00:00Z`)) / 86_400_000) + 1;
    const r = travelComparison({
      dataNeedGb: Number(inputOr(env, "dataNeedGb", t.dataNeedGb)),
      tripDays: days,
      homePlan: { name: "MobileNet Unlimited Plus 100 GB", euRoamingGb: 4, extraEuGbMinor: mn.extraEuGbMinor },
      connectivity: t.connectivity,
      benefit: { amountMinor: t.cardBenefit.amountMinor, eligibleMerchants: t.cardBenefit.eligibleMerchants, verified },
      expectedCardSpendMinor: t.expectedCardSpendMinor,
      paymentMethods: t.paymentMethods,
      fxRate: t.fxRate,
    });
    const dp = r.connectivity.find((c) => c.id === "datapass")!;
    const daily = primaryAccount(env);
    const dpAccount = (await env.merchant.getAccount("datapass", dpAcct)).account;
    const ordered = (dpAccount?.details?.orders ?? []).length > 0;
    const candidates: Candidate[] = ordered
      ? []
      : [
          {
            key: "buy-datapass",
            defaultSelected: true,
            available: verified === true && r.recommendedConnectivityId === "datapass",
            unavailableReason: verified === null ? "Check the card credit eligibility first" : r.recommendedConnectivityId !== "datapass" ? "Another option is cheaper" : undefined,
            spec: spec({
              operation: "PLACE_ORDER",
              route: "PARTNER_API",
              capability: "A14",
              merchantId: "datapass",
              merchantName: "DataPass Europe",
              subscriberAccountId: dpAcct,
              subjectRef: `${env.tenantId}:trip:barcelona`,
              params: { productId: "datapass", dataGb: 5, validDays: 7, startDate: t.start, cardChargeMinor: dp.costMinor, benefitCreditMinor: dp.benefitAppliedMinor ?? 0, benefitId: t.cardBenefit.id, debitAccountId: daily.id, category: "Travel" },
              money: { currency: "RON", immediateDebitMinor: dp.costMinor, maxDebitMinor: dp.costMinor, feesMinor: 0, forecastChangeMinor: 0 },
              display: display("Buy the DataPass Europe eSIM", `${money(dp.costMinor)} charged, ${money(dp.benefitAppliedMinor ?? 0)} travel credit back: ${money(dp.netMinor ?? dp.costMinor)} net.`, [
                { label: "Product", value: `5 GB for 7 days from ${fmtDate(t.start)}` },
                { label: "Card charge", value: `${money(dp.costMinor)} from ${daily.name} (maximum)` },
                { label: "Travel credit", value: `${money(dp.benefitAppliedMinor ?? 0)} back (${t.cardBenefit.name})` },
                { label: "Net", value: money(dp.netMinor ?? dp.costMinor) },
              ], "Fictional provider and benefit. The bank refuses any charge above the approved maximum."),
            }),
          },
        ];
    return {
      capability: "A14",
      title: `${t.destination}, ${fmtDate(t.start)} – ${fmtDate(t.end)}`,
      contextId: env.contextId,
      headline: verified === null ? "DataPass may be cheapest once the card credit is confirmed" : `Cheapest data: ${r.connectivity.find((c) => c.id === r.recommendedConnectivityId)?.name} at ${money(r.connectivity.find((c) => c.id === r.recommendedConnectivityId)?.netMinor ?? 0)}; pay with ${r.payments.find((p) => p.id === r.recommendedPaymentId)?.name}`,
      summary: `${t.dataNeedGb} GB of data and about ${money(t.expectedCardSpendMinor)} of card spending (≈ €${(r.spendEurCents / 100).toFixed(2)}). ${r.note}`,
      evidence: ["FICTIONAL_CATALOG", "DETERMINISTIC_CALCULATION", "BANK_RECORD"],
      blocks: [
        { kind: "table", title: "Mobile data", columns: ["Option", "Cost", "Credit", "Net"], rows: r.connectivity.map((c) => ({ cells: [c.name, money(c.costMinor), c.benefitAppliedMinor == null ? "Unknown" : money(c.benefitAppliedMinor), c.netMinor == null ? "Unknown" : money(c.netMinor)], highlight: c.id === r.recommendedConnectivityId })) },
        { kind: "table", title: `Paying ${money(t.expectedCardSpendMinor)} abroad`, columns: ["Method", "FX cost", "Source"], rows: r.payments.map((p) => ({ cells: [p.name, p.fxCostMinor == null ? "Unknown" : money(p.fxCostMinor), p.source], highlight: p.id === r.recommendedPaymentId })) },
        { kind: "conditions", title: "Card travel credit", items: [{ label: `${t.cardBenefit.name}: ${money(t.cardBenefit.amountMinor)} at ${t.cardBenefit.eligibleMerchants.join(", ")}`, state: verified === null ? "unknown" : verified ? "met" : "unmet", detail: verified === null ? "Not yet checked" : verified ? "Confirmed from your card benefits" : "Not eligible" }] },
        ...r.unknowns.map((u) => ({ kind: "note" as const, tone: "warn" as const, text: `Unknown: ${u}` })),
      ],
      inputs: [{ key: "dataNeedGb", label: "Data you need", type: "number", value: Number(inputOr(env, "dataNeedGb", t.dataNeedGb)), min: 1, max: 50, suffix: "GB" }],
      candidates,
      numbers: { homePlanMinor: r.connectivity.find((c) => c.id === "home-plan")?.netMinor ?? 0, datapassNetMinor: dp.netMinor ?? -1, kioskFxMinor: r.payments.find((p) => p.id === "airport-kiosk")?.fxCostMinor ?? 0 },
      done: ordered ? { label: "DataPass eSIM ordered" } : null,
      links: [],
    };
  },
};

/** Bank-side check of the card benefit record (A14). Writes a fact with BANK provenance. */
export function verifyTravelBenefit(env: CapEnv) {
  const t = goalInputs(env, "trip")!.inputs;
  const card = accountsFor(env.db, env.tenantId, env.contextId).find((a) => a.card)?.card;
  const ok = Boolean(card && card.status === "ACTIVE" && env.nowMs < Date.parse(t.cardBenefit.expiresAt) && t.connectivity.find((c: any) => c.id === "datapass")?.partnerOfNextMoveCard);
  run(env.db, "INSERT INTO facts(id, tenant_id, context_id, key, value_json, provenance, source_ref, revision, created_at) VALUES (?,?,?,?,?, 'MATCHED_BANK_RECORD', ?, 1, ?)", `fact_${Date.now().toString(36)}`, env.tenantId, env.contextId, "a14:card_benefit_verified", JSON.stringify({ value: ok, checks: ["card active", "benefit not expired", "merchant on eligible list"] }), t.cardBenefit.source, new Date().toISOString());
  return ok;
}

/* ------------------------------------------------------------------------------------------------ O1 (personal) */
export const O1_PERSONAL = async (env: CapEnv): Promise<Analysis> => {
  const g = goalInputs(env, "home")!;
  const phone = goalInputs(env, "phone")!.inputs;
  const accts = accountsFor(env.db, env.tenantId, env.contextId);
  const liquid = accts.reduce((s, a) => s + a.balanceMinor, 0);
  const tc = inputOr<any>(env, "transactionCostsMinor", g.inputs.transactionCostsMinor);
  const home = {
    liquidMinor: liquid,
    downPaymentMinor: Number(inputOr(env, "downPaymentMinor", g.inputs.downPaymentMinor)),
    transactionCostsMinor: tc === "unknown" || tc === null ? null : Number(tc),
    protectedReserveMinor: Number(inputOr(env, "protectedReserveMinor", g.inputs.protectedReserveMinor)),
    monthlyContributionMinor: Number(inputOr(env, "monthlyContributionMinor", g.inputs.monthlyContributionMinor)),
  };
  const cmp = comparePurchases(home, phone.options);
  const ah = g.inputs.afterHome;
  const after = afterHomeBudget(ah);
  const monthLabel = (n: number | null) => {
    if (n == null) return "Unknown";
    const d = new Date(env.nowMs);
    d.setUTCMonth(d.getUTCMonth() + n);
    return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Europe/Bucharest" }).format(d);
  };
  const saved = all<any>(env.db, "SELECT * FROM saved_comparisons WHERE tenant_id=? AND context_id=? AND kind='O1' ORDER BY created_at DESC LIMIT 1", env.tenantId, env.contextId)[0];
  return {
    capability: "O1",
    title: "Phone now, home later",
    contextId: env.contextId,
    headline: cmp.baseline.complete ? `Home ready after ${cmp.baseline.contributions} contributions; the 6,000 RON phone adds ${(cmp.rows.find((r) => r.id === "phone-6000")?.contributions ?? 0) - (cmp.baseline.contributions ?? 0)}` : "Add transaction costs to see when the home is ready",
    summary: `Liquid funds ${money(liquid)} across ${accts.length} accounts. Target = down payment + transaction costs + protected reserve. No loan or mortgage approval is implied.`,
    evidence: ["DETERMINISTIC_CALCULATION", "BANK_RECORD", "MANUAL_INPUT"],
    blocks: [
      { kind: "metrics", items: [{ label: "Home target", value: money(cmp.baseline.targetMinor) }, { label: "Gap today", value: money(cmp.baseline.gapMinor) }, { label: "Monthly saving", value: money(home.monthlyContributionMinor) }] },
      { kind: "table", title: "Dated alternatives", columns: ["Choice", "Left after", "Contributions", "Home ready"], rows: [
        { cells: ["No phone", money(liquid), String(cmp.baseline.contributions ?? "Unknown"), monthLabel(cmp.baseline.contributions)] },
        ...cmp.rows.map((r) => ({ cells: [r.label, money(r.liquidAfterMinor), String(r.contributions ?? "Unknown"), monthLabel(r.contributions)], tone: r.delaysHome ? ("warn" as const) : ("good" as const) })),
      ] },
      { kind: "table", title: "Target", columns: ["Part", "Amount"], rows: cmp.baseline.breakdown.map((b) => ({ cells: [b.label, b.minor == null ? "Unknown" : money(b.minor)] })), note: cmp.baseline.formula },
      { kind: "table", title: "After buying the home (separate period)", columns: ["", "Per month"], rows: [{ cells: ["Expected", money(after.monthlyMinor)] }, { cells: ["If income drops", money(after.downsideMonthlyMinor)], tone: after.downsideNegative ? "bad" : undefined }], note: after.note },
      { kind: "note", tone: "info", text: (g.inputs.assumptions ?? []).join(" ") },
      ...(saved ? [{ kind: "status" as const, title: "Saved plan", state: saved.choice ?? "Saved", detail: `Saved ${fmtWhen(saved.created_at)} (input revision ${saved.input_revision})` }] : []),
    ],
    inputs: [
      { key: "monthlyContributionMinor", label: "Monthly saving", type: "money", value: home.monthlyContributionMinor },
      { key: "transactionCostsMinor", label: "Transaction and moving costs", type: "money", value: home.transactionCostsMinor, help: "Leave empty if you don't know: NextMove will not assume zero." },
      { key: "protectedReserveMinor", label: "Protected reserve", type: "money", value: home.protectedReserveMinor },
      { key: "downPaymentMinor", label: "Down payment", type: "money", value: home.downPaymentMinor },
    ],
    candidates: [],
    numbers: { targetMinor: cmp.baseline.targetMinor ?? 0, gapMinor: cmp.baseline.gapMinor ?? 0, contributions: cmp.baseline.contributions ?? 0, contributionsPhone6000: cmp.rows[1]?.contributions ?? 0, contributionsPhone3500: cmp.rows[0]?.contributions ?? 0, afterHomeMonthlyMinor: after.monthlyMinor, downsideMinor: after.downsideMonthlyMinor, liquidMinor: liquid },
    links: [{ label: "True cost of each phone over two years", href: "/capabilities/A10" }],
  };
};

export const ALEX_MONEY_CAPS = [T1, A7, A8, A9, A10, A12, A14];
