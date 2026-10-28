import { all, json, one } from "../db/connection";
import { accountsFor, balanceOf } from "../bank/ledger";
import { traceCash, type CashEvent } from "../finance/cashflow";
import { inventoryNeed, compareSupplierQuotes, compareFunding, newShopPlan, ownerTransferEffect } from "../finance/business";
import { billingDateOptions, reviewLicenses } from "../finance/capabilities";
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
  fixture,
  fmtDate,
  fmtWhen,
  forecastFor,
  lastReceipt,
  liveContract,
  money,
  openActionFor,
  spec,
  subjectFields,
  subscription,
} from "./core";

// Day N of the closed business fixture is 2026-11-N (day 0 = 31 Oct 2026, Europe/Bucharest).
export function dayToIso(day: number) {
  return new Date(Date.UTC(2026, 9, 31, 10, 0, 0) + day * 86_400_000).toISOString().replace("Z", "+00:00");
}

function record(env: CapEnv, kind: string) {
  const r = one<any>(env.db, "SELECT * FROM business_records WHERE tenant_id=? AND kind=?", env.tenantId, kind);
  return r ? { row: r, data: json<any>(r.data_json, {}) } : null;
}

function contexts(env: CapEnv) {
  const all_ = all<any>(env.db, "SELECT * FROM contexts WHERE tenant_id=? ORDER BY ordinal", env.tenantId);
  return { business: all_.find((c) => c.kind === "BUSINESS"), household: all_.find((c) => c.kind === "PERSONAL") };
}

function traceBlock(title: string, opening: number, events: CashEvent[], floor: number | null): Block {
  const t = traceCash(opening, events, floor);
  return {
    kind: "timeline",
    title: `${title}: lowest ${money(t.minimumMinor)} on day ${t.minimumDay}`,
    items: t.points.map((p: any) => ({ at: dayToIso(p.day), label: `Day ${p.day}: ${p.label ?? p.id}`, amount: money(p.amountMinor, { sign: true }), state: floor != null && p.balanceMinor < floor ? "BELOW_RESERVE" : undefined })),
  };
}

/* ------------------------------------------------------------------------------------------------ O1 (business) */
export const O1_BUSINESS = async (env: CapEnv): Promise<Analysis> => {
  const b = fixture("demo/cases.json").businessOrder;
  const scen = record(env, "SCENARIOS")!.data;
  const shop = newShopPlan(record(env, "NEW_SHOP")!.data);
  const opening = balanceOf(env.db, `${env.tenantId}:biz-current`);
  const rows = scen.scenarios.map((s: any) => ({ s, t: traceCash(opening, s.events, scen.reserveMinor) }));
  const label: Record<string, string> = { baseline: "Without the order", accept_unchanged: "Accept, normal terms", deposit_and_early_collection: "Accept with 12,000 RON deposit + early invoice", partial_reply: "Accept, invoice paid in two parts" };
  return {
    capability: "O1",
    title: "Take the 40,000 RON order?",
    contextId: env.contextId,
    headline: "Only with a deposit and early collection: otherwise cash goes below the 8,000 RON reserve",
    summary: `Opening business cash ${money(opening)}, reserve ${money(scen.reserveMinor)}. Each line is a dated cash trace, not a profit forecast. No loan or credit approval is implied.`,
    evidence: ["DETERMINISTIC_CALCULATION", "BANK_RECORD"],
    blocks: [
      { kind: "table", title: "Scenarios (days 0–30)", columns: ["Scenario", "Lowest cash", "End", "Reserve kept"], rows: rows.map(({ s, t }: any) => ({ cells: [label[s.id] ?? s.id, money(t.minimumMinor), money(t.finalMinor), t.feasible ? "Yes" : "No"], tone: t.feasible ? ("good" as const) : ("bad" as const) })) },
      { kind: "conditions", title: "Conditions for accepting", items: [
        { label: "Hotel Lumen pays the 12,000 RON deposit by day 1", state: "unknown", detail: "Requested, not received (O4)" },
        { label: "Cafe Aurora pays invoice INV-2026-0142 by day 5", state: "unknown", detail: "Reminder can be sent (O4)" },
        { label: "Stock bought on day 2 (O2)", state: "unknown" },
      ] },
      traceBlock("With deposit and early collection", opening, scen.scenarios.find((s: any) => s.id === "deposit_and_early_collection").events, scen.reserveMinor),
      { kind: "table", title: "Second shop (separate decision)", columns: ["", "Buy oven", "Mock lease"], rows: [
        { cells: ["Cash after setup", money(shop.cash.cashAfterPurchaseMinor), money(shop.lease.cashAfterInitialMinor)] },
        { cells: ["Reserve needed (3 months)", money(shop.cash.reserveMinor), money(shop.lease.reserveMinor)] },
        { cells: ["Reserve gap", money(shop.cash.reserveGapMinor), money(shop.lease.reserveGapMinor)], tone: shop.cash.reserveGapMinor ? "warn" : undefined },
        { cells: ["Break-even per day", `${shop.cash.breakEvenUnitsPerDay} pretzels`, `${shop.lease.breakEvenUnitsPerDay} pretzels`] },
        { cells: ["Lease total (undiscounted)", "—", money(shop.lease.nominalTotalMinor)] },
      ], note: shop.assumptions.join(" ") },
      { kind: "note", tone: "info", text: (scen.assumptions ?? b.assumptions).join(" ") },
    ],
    inputs: [],
    candidates: [],
    numbers: Object.fromEntries(rows.flatMap(({ s, t }: any) => [[`${s.id}MinMinor`, t.minimumMinor], [`${s.id}FinalMinor`, t.finalMinor]])),
    links: [{ label: "Stock and suppliers (O2)", href: "/capabilities/O2" }, { label: "Receivables (O4)", href: "/capabilities/O4" }, { label: "Funding options (O5)", href: "/capabilities/O5" }],
  };
};

/* ------------------------------------------------------------------------------------------------ O2 */
const O2: CapabilityDef = {
  id: "O2",
  title: "Stock for the order",
  short: "800 units to buy; compare MillCo and Dobrogea",
  group: "Business",
  customer: "laziz",
  contextKind: "BUSINESS",
  keywords: ["stock", "inventory", "supplier", "ingredients", "order stock", "millco", "dobrogea", "purchase", "stock for", "flour", "furnizor", "faina"],
  async analyze(env) {
    const inv = record(env, "INVENTORY")!;
    const need = inventoryNeed(inv.data);
    const scen = record(env, "SCENARIOS")!.data;
    const quotes = record(env, "QUOTES") ?? record(env, "SUPPLIER_QUOTES");
    const opening = balanceOf(env.db, `${env.tenantId}:biz-current`);
    const base = scen.scenarios.find((s: any) => s.id === "deposit_and_early_collection").events;
    const rows = compareSupplierQuotes(opening, scen.reserveMinor, base, quotes!.data.quotes);
    const best = [...rows].filter((r) => r.feasible).sort((a, b) => a.totalCostMinor - b.totalCostMinor)[0];
    const placed = inv.data.placedOrder;
    const candidates: Candidate[] = placed
      ? []
      : rows.map((r) => {
          const q = quotes!.data.quotes.find((x: any) => x.id === r.quoteId);
          return {
            key: `order-${q.merchantId}`,
            defaultSelected: r.quoteId === best?.quoteId,
            available: Boolean(r.feasible) && q.units === need.unitsToBuy,
            unavailableReason: !r.feasible ? "Cash would go below the reserve" : q.units !== need.unitsToBuy ? "Quantity differs from what you need" : undefined,
            spec: spec({
              operation: "PLACE_ORDER",
              route: "PARTNER_API",
              capability: "O2",
              merchantId: q.merchantId,
              merchantName: q.supplier,
              subscriberAccountId: merchantAccountId(env.tenantId, q.merchantId, `${q.merchantId}-laziz`),
              subjectRef: inv.row.id,
              params: { quoteId: q.id, units: q.units, unitPriceMinor: q.unitPriceMinor, deliveryDay: q.deliveryDay, paymentSchedule: q.payments.map((p: any) => ({ dueAt: dayToIso(p.day), amountMinor: p.amountMinor, share: p.share })), recordId: inv.row.id, cardChargeMinor: 0 },
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: r.totalCostMinor, feesMinor: 0, forecastChangeMinor: -r.totalCostMinor },
              consequences: { effectiveAt: dayToIso(q.deliveryDay), accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: q.payments.map((p: any) => `${money(p.amountMinor)} on day ${p.day}`).join(", ") },
              display: display(`Order ${q.units} units from ${q.supplier}`, `${money(r.totalCostMinor)} total, delivered day ${q.deliveryDay}.`, [
                { label: "Quote", value: `${q.id} · ${money(q.unitPriceMinor)} per unit` },
                { label: "Quantity", value: `${q.units} units (you need ${need.unitsToBuy})` },
                { label: "Payments", value: q.payments.map((p: any) => `${p.share} ${money(p.amountMinor)} on ${fmtDate(dayToIso(p.day))}`).join("; ") },
                { label: "Lowest business cash", value: `${money(r.minimumMinor)} on day ${r.minimumDay}` },
              ], "Places a synthetic order. Payments are scheduled in the forecast; nothing is paid now."),
            }),
          };
        });
    return {
      capability: "O2",
      title: "Stock and suppliers",
      contextId: env.contextId,
      headline: placed ? `Order placed with ${placed.supplier} (ref ${placed.reference})` : `Buy ${need.unitsToBuy} units: ${best ? `${best.supplier} keeps the reserve at ${money(best.minimumMinor)}` : "no supplier keeps the reserve"}`,
      summary: `${inv.data.requiredUnits} needed, ${inv.data.onHandUnits} on hand. ${need.formula}.`,
      evidence: ["DETERMINISTIC_CALCULATION", "BANK_RECORD", "SIMULATED_MERCHANT_API"],
      blocks: [
        { kind: "metrics", items: [{ label: "To buy", value: `${need.unitsToBuy} units` }, { label: "At 30 RON", value: money(need.purchaseCostMinor) }, { label: "Already held", value: money(need.heldMaterialValueMinor) }] },
        { kind: "table", title: "Quotes inside the cash plan", columns: ["Supplier", "Total", "Lowest cash", "After day 30"], rows: rows.map((r) => ({ cells: [r.supplier, money(r.totalCostMinor), `${money(r.minimumMinor)} (day ${r.minimumDay})`, r.paymentsAfterWindow.length ? r.paymentsAfterWindow.map((p: any) => money(p.amountMinor)).join(", ") : "—"], highlight: r.quoteId === best?.quoteId, tone: r.feasible ? undefined : "bad" })), note: "Dobrogea spreads payment but costs more; the second half falls after the 30-day window and is shown, not dropped." },
      ],
      inputs: [],
      candidates,
      numbers: { unitsToBuy: need.unitsToBuy, purchaseCostMinor: need.purchaseCostMinor, ...Object.fromEntries(rows.map((r) => [`${r.quoteId}MinMinor`, r.minimumMinor])) },
      done: placed ? { label: `Ordered from ${placed.supplier}` } : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ O3 */
const O3: CapabilityDef = {
  id: "O3",
  title: "Owner pay and household bills",
  short: "Household dips below zero before the owner transfer",
  group: "Business",
  customer: "laziz",
  contextKind: "BUSINESS",
  keywords: ["owner", "salary", "transfer", "household", "personal", "reserve", "pay myself"],
  async analyze(env) {
    const ctx = contexts(env);
    const owner = record(env, "OWNER_ARRANGEMENT")!.data;
    const scen = record(env, "SCENARIOS")!.data;
    const biz = `${env.tenantId}:biz-current`;
    const hh = `${env.tenantId}:hh-current`;
    const bizBal = balanceOf(env.db, biz);
    const hhBal = balanceOf(env.db, hh);
    const items = all<any>(env.db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND status='SCHEDULED' ORDER BY due_at", env.tenantId, ctx.household.id);
    const planned = items.find((i) => i.kind === "PLANNED_TRANSFER");
    const events = items.map((i, n) => ({ id: i.id, day: Math.max(0, Math.round((Date.parse(i.due_at) - Date.parse(dayToIso(0))) / 86_400_000)), sequence: n + 1, amountMinor: i.amount_minor, label: i.label }));
    const t = traceCash(hhBal, events, 0);
    const posted = all<any>(env.db, "SELECT * FROM transactions WHERE tenant_id=? AND account_id=? AND category='Transfer' ORDER BY booked_at DESC", env.tenantId, hh);
    const eff = ownerTransferEffect(owner.amountMinor, bizBal, hhBal, ctx.business.reserve_floor_minor ?? scen.reserveMinor);
    const busy = openActionFor(env, `${env.tenantId}:owner-transfer`, "OWNER_TRANSFER");
    const candidates: Candidate[] = planned
      ? [
          {
            key: "owner-transfer",
            defaultSelected: true,
            available: !busy && !eff.businessBelowFloor,
            unavailableReason: busy ? "A transfer is already in progress" : eff.businessBelowFloor ? "The business would go below its reserve" : undefined,
            spec: spec({
              operation: "OWNER_TRANSFER",
              route: "BANK_INTERNAL",
              capability: "O3",
              merchantName: "Laziz household",
              subjectRef: `${env.tenantId}:owner-transfer`,
              params: { fromAccountId: biz, toAccountId: hh, amountMinor: owner.amountMinor, description: "Owner transfer (existing monthly arrangement)", forecastItemId: planned.id, arrangementId: owner.id },
              money: { currency: "RON", immediateDebitMinor: owner.amountMinor, maxDebitMinor: owner.amountMinor, feesMinor: 0, forecastChangeMinor: 0 },
              consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: "Replaces the planned 3 Nov transfer; it is not sent twice" },
              display: display(`Move ${money(owner.amountMinor)} to the household now`, "The planned 3 Nov owner transfer, made before the 1–2 Nov bills.", [
                { label: "From", value: `Business account · ${money(bizBal)} → ${money(eff.businessAfterMinor)}` },
                { label: "To", value: `Household account · ${money(hhBal)} → ${money(eff.householdAfterMinor)}` },
                { label: "Business reserve", value: `${money(ctx.business.reserve_floor_minor ?? scen.reserveMinor)} kept` },
                { label: "Basis", value: owner.basis },
              ], "One balanced posting between your own accounts. Total funds do not change."),
            }),
          },
        ]
      : [];
    return {
      capability: "O3",
      title: "Owner income and household",
      contextId: env.contextId,
      headline: planned ? (t.feasible ? "The household stays above zero" : `Household goes to ${money(t.minimumMinor)} on ${fmtDate(dayToIso(t.minimumDay ?? 0))} before the owner transfer arrives`) : "The owner transfer was posted",
      summary: "Business and household are separate contexts with their own accounts and authority. A planned transfer is not money until it is posted.",
      evidence: ["BANK_LEDGER_POSTING", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Business", value: money(bizBal), sub: `reserve ${money(ctx.business.reserve_floor_minor ?? scen.reserveMinor)}` }, { label: "Household", value: money(hhBal) }, { label: "Total", value: money(bizBal + hhBal), sub: "unchanged by transfers" }] },
        { kind: "timeline", title: `Household forecast: lowest ${money(t.minimumMinor)}`, items: items.map((i) => ({ at: i.due_at, label: `${i.label}${i.condition ? " (planned)" : ""}`, amount: money(i.amount_minor, { sign: true }), state: i.condition ? "PLANNED" : undefined })) },
        { kind: "table", title: "Planned vs posted", columns: ["", "Amount", "Status"], rows: [
          ...(planned ? [{ cells: [planned.label, money(planned.amount_minor), "Planned (not money yet)"], tone: "warn" as const }] : []),
          ...posted.map((p) => ({ cells: [p.note ?? p.merchant_name, money(p.amount_minor), `Posted ${fmtWhen(p.booked_at)}`], tone: "good" as const })),
        ] },
        { kind: "facts", title: "Arrangement", items: [{ label: "Owner transfer", value: `${money(owner.amountMinor)} monthly, day ${owner.day}`, provenance: PROVENANCE.BANK }, { label: "Classification", value: "No tax or payroll classification is inferred", provenance: PROVENANCE.CALCULATED }] },
      ],
      inputs: [],
      candidates,
      numbers: { householdMinMinor: t.minimumMinor, businessMinor: bizBal, householdMinor: hhBal, transferMinor: owner.amountMinor, totalMinor: bizBal + hhBal },
      done: !planned ? { label: "Owner transfer posted" } : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ O4 */
const O4: CapabilityDef = {
  id: "O4",
  title: "Money customers owe you",
  short: "Cafe Aurora 12,000 RON due day 12",
  group: "Business",
  customer: "laziz",
  contextKind: "BUSINESS",
  keywords: ["invoice", "receivable", "customer owes", "reminder", "cafe aurora", "late payment", "collect", "owes us", "owe us", "owe you", "customers owe", "owed", "unpaid", "slow to pay", "hasn't paid", "haven't paid", "datoreaza", "facturi"],
  async analyze(env) {
    const rec = record(env, "RECEIVABLES")!;
    const scen = record(env, "SCENARIOS")!.data;
    const opening = balanceOf(env.db, `${env.tenantId}:biz-current`);
    const invoices: any[] = rec.data.invoices;
    const credits = all<any>(env.db, "SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND category='Customer payment' ORDER BY booked_at", env.tenantId, env.contextId);
    const candidates: Candidate[] = invoices
      .filter((i) => i.status === "OPEN")
      .map((i) => ({
        key: `remind-${i.counterpartyId}`,
        defaultSelected: i.counterpartyId === "cafe-aurora",
        available: !openActionFor(env, `${rec.row.id}:${i.invoiceNumber}`, "SEND_MESSAGE"),
        spec: spec({
          operation: "SEND_MESSAGE",
          route: "PARTNER_API",
          capability: "O4",
          merchantId: i.counterpartyId,
          merchantName: i.customer,
          subscriberAccountId: merchantAccountId(env.tenantId, i.counterpartyId, i.counterpartyId === "cafe-aurora" ? "ca-laziz" : "hl-laziz"),
          subjectRef: `${rec.row.id}:${i.invoiceNumber}`,
          params: {
            subject: `${i.kind === "order_deposit_request" ? "Deposit request" : "Invoice"} ${i.invoiceNumber}`,
            body: i.kind === "order_deposit_request" ? `Hello, a reminder that the ${money(i.amountMinor)} deposit for your order (${i.invoiceNumber}) is due on ${fmtDate(dayToIso(i.dueDay))}. Thank you, Laziz Products SRL.` : `Hello, a friendly reminder about invoice ${i.invoiceNumber} for ${money(i.amountMinor)}, due on ${fmtDate(dayToIso(i.dueDay))}. If you can pay earlier, it would help us prepare a large order. Thank you, Laziz Products SRL.`,
            invoiceNumber: i.invoiceNumber,
            recordId: rec.row.id,
          },
          display: display(`Send a reminder to ${i.customer}`, `${i.invoiceNumber}: ${money(i.amountMinor)} due ${fmtDate(dayToIso(i.dueDay))}.`, [
            { label: "To", value: `${i.customer} (simulated mailbox)` },
            { label: "About", value: `${i.invoiceNumber} · ${money(i.amountMinor)}` },
            { label: "Tone", value: "Friendly reminder; asks for earlier payment if possible" },
          ], "A reminder does not change expected receipts; only a bank credit does."),
        }),
      }));
    const cafe = invoices.find((i) => i.counterpartyId === "cafe-aurora");
    const promised = cafe?.promises?.length ? cafe.promises : null;
    const base = scen.scenarios.find((s: any) => s.id === (promised ? "partial_reply" : "deposit_and_early_collection")).events;
    const t = traceCash(opening, base, scen.reserveMinor);
    return {
      capability: "O4",
      title: "Receivables",
      contextId: env.contextId,
      headline: promised ? `Cafe Aurora promised ${promised.map((p: any) => `${money(p.amountMinor)} on day ${p.day}`).join(" and ")}: lowest cash ${money(t.minimumMinor)}` : `${money(invoices.filter((i) => i.status !== "PAID").reduce((s, i) => s + i.amountMinor - (i.paidMinor ?? 0), 0))} is owed to you`,
      summary: "Promises are shown as promised, not received. Only an actual bank credit counts as money in.",
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_EVENT", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "table", title: "Invoices", columns: ["Customer", "Amount", "Due", "Status"], rows: invoices.map((i) => ({ cells: [`${i.customer} · ${i.invoiceNumber}`, money(i.amountMinor), `day ${i.dueDay}`, `${i.status.replace(/_/g, " ").toLowerCase()}${i.paidMinor ? ` (${money(i.paidMinor)} received)` : ""}`], tone: i.status === "PAID" ? ("good" as const) : i.status === "PROMISED" || i.status === "PARTIALLY_PAID" ? ("warn" as const) : undefined })) },
        ...(cafe?.reply ? [{ kind: "facts" as const, title: "Reply from Cafe Aurora", items: [{ label: "Message", value: `“${cafe.reply.text}”`, provenance: "From the customer (untrusted text)" }, ...cafe.promises.map((p: any) => ({ label: `Day ${p.day}`, value: `${money(p.amountMinor)} · ${p.status.toLowerCase()}`, provenance: p.status === "RECEIVED" ? PROVENANCE.MATCHED_BANK_RECORD : "Promise only" }))] }] : []),
        traceBlock(promised ? "Replanned with the promise" : "Plan if collected early", opening, base, scen.reserveMinor),
        { kind: "table", title: "Bank credits received", columns: ["From", "Amount", "When"], rows: credits.length ? credits.map((c) => ({ cells: [c.merchant_name, money(c.amount_minor), fmtWhen(c.booked_at)], tone: "good" as const })) : [{ cells: ["None yet", "—", "—"] }] },
        ...(promised && !t.feasible ? [{ kind: "note" as const, tone: "warn" as const, text: "The split payment leaves cash below the reserve between day 5 and day 12. Compare bridge funding (O5)." }] : []),
      ],
      inputs: [],
      candidates,
      numbers: { lowestMinor: t.minimumMinor, owedMinor: invoices.reduce((s, i) => s + i.amountMinor - (i.paidMinor ?? 0), 0), creditedMinor: credits.reduce((s, c) => s + c.amount_minor, 0) },
      labs: [
        { action: "counterparty_reply_now", label: "Customer: reply now" },
        { action: "counterparty_pay", label: "Customer: Cafe Aurora pays 4,000 RON", body: { counterparty: "cafe-aurora", amountMinor: 400000, reference: "INV-2026-0142" } },
      ],
      links: [{ label: "Funding options (O5)", href: "/capabilities/O5" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ O5 */
const O5: CapabilityDef = {
  id: "O5",
  title: "Bridge funding options",
  short: "Compare two fictional short-term offers",
  group: "Business",
  customer: "laziz",
  contextKind: "BUSINESS",
  keywords: ["loan", "funding", "credit line", "bridge", "financing", "borrow", "imprumut", "short-term"],
  async analyze(env) {
    const scen = record(env, "SCENARIOS")!.data;
    const fund = record(env, "FUNDING_OFFERS")!.data;
    const opening = balanceOf(env.db, `${env.tenantId}:biz-current`);
    const base = scen.scenarios.find((s: any) => s.id === "partial_reply").events;
    const r = compareFunding(opening, scen.reserveMinor, base, fund.offers);
    const packet = record(env, "FUNDING_PACKET");
    return {
      capability: "O5",
      title: "Bridge funding",
      contextId: env.contextId,
      headline: `Both offers keep cash at ${money(r[0].minimumMinor)}; offer A costs ${money(r[1].feeMinor - r[0].feeMinor)} less in fees`,
      summary: `${fund.lender}. Eligibility is unknown and nothing is approved. The repayment must settle after the day-12 invoice receipt.`,
      evidence: ["DETERMINISTIC_CALCULATION", "FICTIONAL_CATALOG", "PREPARED_NOT_SENT"],
      blocks: [
        { kind: "table", title: "With the split customer payment", columns: ["Offer", "Fee", "Lowest cash", "End", "Eligibility"], rows: r.map((x) => ({ cells: [x.offerId.toUpperCase(), money(x.feeMinor), money(x.minimumMinor), money(x.finalMinor), "Unknown"], tone: x.feasible ? undefined : "bad" })) },
        { kind: "conditions", title: "Same-day ordering", items: r.map((x) => ({ label: `${x.offerId.toUpperCase()}: repayment after the day-12 receipt`, state: x.feasible ? "met" : "unmet", detail: `If repaid first, lowest cash would be ${money(x.orderingCheck.minimumMinor)} (${x.orderingCheck.feasible ? "fine" : "below reserve"})` })) },
        ...(packet ? [{ kind: "status" as const, title: "Discussion packet", state: "PREPARED (not sent)", detail: `Revision ${packet.row.revision}, ${fmtWhen(packet.row.updated_at)}`, href: "/business/packet" }] : []),
        { kind: "note", tone: "info", text: "NextMove prepares a packet for a conversation with a lender. It does not apply, share data or claim approval." },
      ],
      inputs: [],
      candidates: [],
      numbers: Object.fromEntries(r.flatMap((x) => [[`${x.offerId}MinMinor`, x.minimumMinor], [`${x.offerId}FinalMinor`, x.finalMinor], [`${x.offerId}OrderingMinMinor`, x.orderingCheck.minimumMinor]])),
      links: [{ label: packet ? "Open the discussion packet" : "Prepare a discussion packet", href: "/business/packet" }],
    };
  },
};

/** O5 packet: a local, versioned document with the exact computed figures. Never sent anywhere. */
export function buildFundingPacket(env: CapEnv) {
  const scen = record(env, "SCENARIOS")!.data;
  const fund = record(env, "FUNDING_OFFERS")!.data;
  const opening = balanceOf(env.db, `${env.tenantId}:biz-current`);
  const base = scen.scenarios.find((s: any) => s.id === "partial_reply").events;
  const r = compareFunding(opening, scen.reserveMinor, base, fund.offers);
  const lines = [
    `# Bridge funding discussion: Laziz Products SRL`,
    ``,
    `Prepared by NextMove on ${fmtWhen(env.now)}. Fictional lender and offers; not an application.`,
    ``,
    `## Need`,
    `- Order of ${money(scen.orderReceiptMinor)} requires stock bought on day 2.`,
    `- Customer Cafe Aurora promised to pay in two parts (day 5 and day 12).`,
    `- Without bridge funding the lowest business cash is ${money(traceCash(opening, base, scen.reserveMinor).minimumMinor)} against a reserve of ${money(scen.reserveMinor)}.`,
    ``,
    `## Offers compared`,
    ...r.map((x) => `- ${x.offerId.toUpperCase()}: fee ${money(x.feeMinor)}, repay ${money(x.totalRepaidMinor)} on day 12 after the invoice receipt; lowest cash ${money(x.minimumMinor)}, ending cash ${money(x.finalMinor)}.`),
    ``,
    `## Conditions and unknowns`,
    `- Eligibility: unknown. Availability: ${r[0].availability.replace(/_/g, " ")}.`,
    `- Repayment must be processed after the day-12 receipt; otherwise the lowest cash is ${money(r[0].orderingCheck.minimumMinor)}.`,
    `- No tax, legal or credit assessment is implied.`,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------------ A11 */
const A11: CapabilityDef = {
  id: "A11",
  title: "Move a bill's date",
  short: "ElectraCasa on the 2nd would fail; the 5th works",
  group: "Bills",
  customer: "laziz",
  contextKind: "PERSONAL",
  keywords: ["billing date", "due date", "move bill", "electricity", "electracasa", "payment fail", "bill date", "bill's date", "move a bill", "owner transfer", "bills clear", "clear"],
  async analyze(env) {
    const sub = subscription(env, "electracasa");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A11", "ElectraCasa could not be read");
    const d: any = live.details;
    const hh = `${env.tenantId}:hh-current`;
    const flows = all<any>(env.db, "SELECT * FROM forecast_items WHERE tenant_id=? AND context_id=? AND status='SCHEDULED' AND (subscription_id IS NULL OR subscription_id != ?) ORDER BY due_at", env.tenantId, env.contextId, sub.id).map((i) => ({ id: i.id, label: i.label, amountMinor: i.amount_minor, at: i.due_at }));
    const r = billingDateOptions({ balanceMinor: balanceOf(env.db, hh), flows, bill: { id: sub.id, label: "ElectraCasa", amountMinor: live.priceMinor, currentDay: d.billingDay, nextChargeAt: live.nextChargeAt! }, supportedDays: d.supportedBillingDays, failedPaymentFeeMinor: d.failedPaymentFeeMinor, requestAt: env.now, minNoticeDays: 3 });
    const pick = Number(env.inputs.billingDay ?? r.recommendedDay ?? 0);
    const opt = r.options.find((o) => o.billingDay === pick && !o.isCurrent);
    const next = forecastFor(env, sub.id)[0];
    const candidates: Candidate[] = opt
      ? [
          {
            key: "move-date",
            defaultSelected: true,
            available: opt.appliesToNextBill && !opt.paymentWouldFail && !openActionFor(env, sub.id, "CHANGE_BILLING_DATE"),
            unavailableReason: opt.newDateTooSoon ? "The new date is less than 3 days away" : !opt.appliesToNextBill ? "Too late for the next bill" : opt.paymentWouldFail ? "This date would still fail" : undefined,
            spec: spec({
              operation: "CHANGE_BILLING_DATE",
              route: "PARTNER_API",
              capability: "A11",
              ...subjectFields(sub),
              params: { billingDay: opt.billingDay },
              termsRevision: live.termsRevision,
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: live.priceMinor + opt.prorationMinor, feesMinor: opt.prorationMinor, forecastChangeMinor: next ? -opt.prorationMinor : 0 },
              consequences: { effectiveAt: opt.firstChargeAt, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: `Then monthly on day ${opt.billingDay}` },
              display: display(`Move ElectraCasa to the ${ordinal(opt.billingDay)}`, `Next bill ${money(live.priceMinor + opt.prorationMinor)} on ${fmtDate(opt.firstChargeAt)} instead of ${money(live.priceMinor)} on ${fmtDate(live.nextChargeAt)}.`, [
                { label: "Billing day", value: `${ordinal(d.billingDay)} → ${ordinal(opt.billingDay)}` },
                { label: "First new bill", value: `${money(live.priceMinor + opt.prorationMinor)} on ${fmtWhen(opt.firstChargeAt)}` },
                { label: "One-off for extra days", value: money(opt.prorationMinor) },
                { label: "Avoids", value: r.current.paymentWouldFail ? `A failed payment and ${money(d.failedPaymentFeeMinor)} fee` : "Nothing" },
              ], d.changeRule),
            }),
          },
        ]
      : [];
    return {
      capability: "A11",
      title: "ElectraCasa billing date",
      contextId: env.contextId,
      headline: r.current.paymentWouldFail ? `On the ${ordinal(d.billingDay)} the payment would fail (${money(d.failedPaymentFeeMinor)} fee); the ${ordinal(r.recommendedDay ?? 0)} works for a ${money(r.options.find((o) => o.billingDay === r.recommendedDay)?.prorationMinor ?? 0)} one-off` : `Billing on the ${ordinal(d.billingDay)} works`,
      summary: r.note,
      evidence: ["SIMULATED_MERCHANT_API", "BANK_RECORD", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "table", title: "Supported days", columns: ["Day", "First bill", "Extra", "Lowest balance", "Fails?"], rows: r.options.map((o) => ({ cells: [ordinal(o.billingDay) + (o.isCurrent ? " (now)" : ""), o.isCurrent || o.appliesToNextBill ? fmtDate(o.firstChargeAt) : o.newDateTooSoon ? "Under 3 days away" : "Too late for this bill", money(o.prorationMinor), money(o.minimumBalanceMinor), o.paymentWouldFail ? "Yes" : "No"], highlight: o.billingDay === (pick || r.recommendedDay), tone: o.paymentWouldFail ? ("bad" as const) : undefined })) },
        { kind: "timeline", title: "Household timeline", items: [...flows.map((f) => ({ at: f.at, label: f.label, amount: money(f.amountMinor, { sign: true }) })), { at: live.nextChargeAt!, label: "ElectraCasa (current date)", amount: money(-live.priceMinor) }].sort((a, b) => a.at.localeCompare(b.at)) },
      ],
      inputs: [{ key: "billingDay", label: "New billing day", type: "select", value: String(pick || r.recommendedDay || ""), options: r.options.filter((o) => !o.isCurrent).map((o) => ({ value: String(o.billingDay), label: ordinal(o.billingDay) })) }],
      candidates,
      numbers: { prorationMinor: opt?.prorationMinor ?? 0, feeAvoidedMinor: r.current.paymentWouldFail ? d.failedPaymentFeeMinor : 0, recommendedDay: r.recommendedDay ?? 0 },
      done: lastReceipt(env, sub.id, "CHANGE_BILLING_DATE") ? { label: `Billing day is now the ${ordinal(d.billingDay)}`, href: `/receipts/${lastReceipt(env, sub.id, "CHANGE_BILLING_DATE").id}` } : null,
    };
  },
};

function ordinal(n: number) {
  return `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
}

/* ------------------------------------------------------------------------------------------------ A13 */
const A13: CapabilityDef = {
  id: "A13",
  title: "Unused software seats",
  short: "TeamDesk: 3 removable seats",
  group: "Business",
  customer: "laziz",
  contextKind: "BUSINESS",
  keywords: ["seats", "licenses", "licences", "teamdesk", "software", "users"],
  async analyze(env) {
    const sub = subscription(env, "teamdesk");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A13", "TeamDesk could not be read");
    const d: any = live.details;
    const threshold = fixture("demo/capability-scenarios.json").lazizBusiness.teamDesk.inactivityThresholdDays;
    const active = d.seats.filter((s: any) => !s.removedFrom);
    const r = reviewLicenses({ seats: active, seatPriceMinor: d.seatPriceMinor, minimumSeats: d.minimumSeats, inactivityThresholdDays: threshold, asOf: env.now.slice(0, 10) });
    const removed = d.seats.filter((s: any) => s.removedFrom);
    const candidates: Candidate[] = r.candidateSeatIds.length
      ? [
          {
            key: "reduce-seats",
            defaultSelected: true,
            available: !openActionFor(env, sub.id, "REDUCE_SEATS"),
            spec: spec({
              operation: "REDUCE_SEATS",
              route: "PARTNER_API",
              capability: "A13",
              ...subjectFields(sub),
              params: { seatIds: r.candidateSeatIds },
              termsRevision: live.termsRevision,
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: r.invoiceAfterMinor, feesMinor: 0, forecastChangeMinor: r.invoiceAfterMinor - r.invoiceBeforeMinor },
              consequences: { effectiveAt: live.nextChargeAt, accessUntil: null, lostBenefits: [], dataEffect: `Removes ${r.candidateSeatIds.length} seats that own no shared files`, remainingObligations: `${r.invoiceAfterMinor / d.seatPriceMinor} seats from the ${fmtDate(live.nextChargeAt)} invoice; the current period is not refunded` },
              display: display(`Remove ${r.candidateSeatIds.length} TeamDesk seats`, `Next invoice ${money(r.invoiceBeforeMinor)} → ${money(r.invoiceAfterMinor)} from ${fmtDate(live.nextChargeAt)}.`, [
                { label: "Seats", value: r.rows.filter((x: any) => r.candidateSeatIds.includes(x.seatId)).map((x: any) => `${x.seatId} ${x.user ?? "unassigned"}`).join(", ") },
                { label: "Kept", value: "Owner, service account, Sorin (14 shared files), Cristina (on leave)" },
                { label: "Next invoice", value: `${money(r.invoiceAfterMinor)} on ${fmtWhen(live.nextChargeAt)}` },
                { label: "Current period", value: "Not refunded (provider rule)" },
              ], d.rule),
            }),
          },
        ]
      : [];
    return {
      capability: "A13",
      title: "TeamDesk seats",
      contextId: env.contextId,
      headline: r.candidateSeatIds.length ? `${r.candidateSeatIds.length} seats can go: ${money(r.invoiceBeforeMinor)} → ${money(r.invoiceAfterMinor)} per month` : removed.length ? `${removed.length} seats leave at the next invoice` : "Every seat is in use",
      summary: `Inactive means no activity for ${threshold} days. Seats with shared files, owners, service accounts and people on leave are protected.`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "table", title: `Roster (${active.length} active seats, minimum ${d.minimumSeats})`, columns: ["Seat", "Last active", "Status"], rows: r.rows.map((x: any) => ({ cells: [`${x.seatId} · ${x.user ?? "Unassigned"} · ${x.role ?? ""}`, x.lastActive ? fmtDate(x.lastActive) : "—", `${x.status === "CANDIDATE" ? "Remove" : x.status === "PROTECTED" ? "Keep" : "Active"}: ${x.reason}`], tone: x.status === "CANDIDATE" ? ("warn" as const) : x.status === "PROTECTED" ? ("good" as const) : undefined })) },
        ...(removed.length ? [{ kind: "status" as const, title: "Scheduled removals", state: "CONFIRMED", detail: removed.map((s: any) => `${s.seatId} from ${fmtDate(s.removedFrom)}`).join(", ") }] : []),
      ],
      inputs: [],
      candidates,
      numbers: { before: r.invoiceBeforeMinor, after: r.invoiceAfterMinor, seats: r.candidateSeatIds.length },
      done: removed.length && !r.candidateSeatIds.length ? { label: "Seat reduction confirmed for the next invoice" } : null,
    };
  },
};

export const LAZIZ_CAPS = [O2, O3, O4, O5, A11, A13];
export { accountsFor };
