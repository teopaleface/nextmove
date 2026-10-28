import { all, json } from "../db/connection";
import { SUBSCRIPTION_WINDOW } from "../bank/forecast";
import { pauseEffect } from "../finance/capabilities";
import { behavioralFootprint, coverageOverlap, deliveryMembershipValue, fxMarkup, type CoverRow, type ForeignCharge } from "../finance/hidden-losses";
import { hiddenLossFixture } from "../scenarios/hidden-losses-seed";
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
  fmtDate,
  fmtWhen,
  forecastFor,
  inputOr,
  lastReceipt,
  liveContract,
  money,
  openActionFor,
  routeFor,
  spec,
  stopRenewalCandidate,
  subjectFields,
  subscription,
} from "./core";

// Hidden-loss detectors (Cosman's proposal): losses that are certain from the statement (A15, A16), a behavioural
// footprint that is only a signal (A17), and cover the customer may already have (A18). Each shows its evidence,
// an explicit confidence, and acts only through existing routes (stop renewal, pause) or advisory steps.

function answer(env: CapEnv, key: string): string | null {
  const f = fact(env, key);
  return f ? String(json<any>(f.value_json)?.value ?? "") : null;
}

function debits(env: CapEnv, where: string, ...args: unknown[]) {
  return all<any>(env.db, `SELECT * FROM transactions WHERE tenant_id=? AND context_id=? AND status='POSTED' AND amount_minor<0 AND ${where} ORDER BY booked_at`, env.tenantId, env.contextId, ...args);
}

function doneFor(env: CapEnv, sub: any, op: string) {
  const r = lastReceipt(env, sub.id, op);
  return r ? { label: `${sub.merchant_name}: confirmed by the provider (ref ${r.issuer_reference})`, href: `/receipts/${r.id}` } : null;
}

const month = (ym: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-15T12:00:00Z`));
const shortDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", day: "numeric", month: "short" }).format(new Date(iso));
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/* ------------------------------------------------------------------------------------------------ A15 */
const A15: CapabilityDef = {
  id: "A15",
  title: "Delivery membership that doesn't pay off",
  short: "DashEats Plus costs more than the delivery fees it saves",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["delivery", "dasheats", "food delivery", "delivery fee", "delivery membership", "takeaway"],
  async analyze(env) {
    const sub = subscription(env, "dasheats");
    if (!sub) return unavailable(env, "A15", "No delivery membership found");
    const { contract } = await liveContract(env, sub);
    if (!contract) return unavailable(env, "A15", "DashEats could not be read");
    const d = contract.details as any;
    const toDebit = (t: any) => ({ id: t.id, bookedAt: t.booked_at, amountMinor: -t.amount_minor });
    const charges = debits(env, "merchant_id='dasheats' AND category='Subscriptions'").map(toDebit);
    const orders = debits(env, "merchant_id='dasheats' AND category='Food delivery'").map(toDebit);
    const r = deliveryMembershipValue({ membershipMinor: contract.priceMinor, deliveryFeeMinor: d.standardDeliveryFeeMinor, freeDeliveryMinOrderMinor: d.freeDeliveryMinOrderMinor, charges, orders, now: env.now });
    const next = forecastFor(env, sub.id)[0];
    const open = openActionFor(env, sub.id, "STOP_RENEWAL");
    const candidates: Candidate[] =
      !open && contract.autoRenew && !r.paysOff
        ? [stopRenewalCandidate(env, "A15", sub, contract, { key: "stop-dasheats", reason: `Stop paying ${money(contract.priceMinor)} a month for free delivery you rarely use. Plus stays active until the paid month ends.`, lostBenefits: [`Free delivery on orders over ${money(d.freeDeliveryMinOrderMinor)}`] })]
        : [];
    const blocks: Block[] = [
      {
        kind: "metrics",
        items: [
          { label: `Paid for Plus, last ${r.windowDays} days`, value: money(r.paidMinor), sub: `${r.chargesInWindow.length} charges` },
          { label: "Delivery fees it saved", value: money(r.savedMinor), sub: `${r.qualifyingOrders} order${r.qualifyingOrders === 1 ? "" : "s"} over ${money(d.freeDeliveryMinOrderMinor)}` },
          { label: r.paysOff ? "Net gain" : "Lost", value: money(Math.abs(r.netLossMinor)), tone: r.paysOff ? "good" : "bad", sub: "From your statement" },
        ],
      },
      {
        kind: "table",
        title: "Month by month",
        columns: ["Month", "Orders", "Fees saved"],
        rows: r.monthly.map((m) => ({ cells: [month(m.month), String(m.orders), money(m.savedMinor)], tone: m.paidOff ? "good" : "bad" })),
        note: `Plus costs ${money(contract.priceMinor)} a month, so it pays off from ${r.breakEvenOrdersPerMonth} orders a month (${money(contract.priceMinor)} ÷ ${money(d.standardDeliveryFeeMinor)} delivery fee).`,
      },
      {
        kind: "facts",
        title: "How this is calculated",
        items: [
          { label: "Plus fee", value: `${money(contract.priceMinor)} / month`, provenance: PROVENANCE.MERCHANT },
          { label: "Delivery fee without Plus", value: `${money(d.standardDeliveryFeeMinor)} on orders over ${money(d.freeDeliveryMinOrderMinor)}`, provenance: PROVENANCE.MERCHANT },
          { label: "Orders since " + fmtDate(r.windowStart), value: `${r.ordersInWindow} (needed ${r.neededInWindow} to break even)`, provenance: PROVENANCE.BANK },
          { label: "Last month it paid off", value: r.lastPaidOffMonth ? month(r.lastPaidOffMonth) : "Never", provenance: PROVENANCE.CALCULATED },
        ],
      },
      { kind: "note", tone: "info", text: "Confidence: high. Both sides come from your statement and DashEats's fee terms (simulated). Orders paid with another card or in cash are not visible to NextMove." },
      ...(next && !r.paysOff ? [{ kind: "note" as const, tone: "info" as const, text: `Turning off renewal avoids the ${money(-next.amount_minor)} charge on ${fmtDate(next.due_at)}. That is an avoided future charge, not a refund of past fees.` }] : []),
      ...(open ? [{ kind: "status" as const, title: "In progress", state: open.status, detail: "Follow it in Activity → Tasks.", href: `/actions/${open.id}` }] : []),
    ];
    return {
      capability: "A15",
      title: "DashEats Plus",
      contextId: env.contextId,
      headline: sub.state === "RENEWAL_OFF" ? "DashEats Plus renewal is off. No more Plus charges." : r.paysOff ? `DashEats Plus saved you ${money(-r.netLossMinor)} more than it cost` : `DashEats Plus cost ${money(r.paidMinor)} and saved ${money(r.savedMinor)} in ${r.windowDays} days`,
      summary: `${money(contract.priceMinor)}/month for free delivery. You placed ${r.ordersInWindow} order${r.ordersInWindow === 1 ? "" : "s"} in the last ${r.windowDays} days; it pays off from ${r.breakEvenOrdersPerMonth} a month.`,
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks,
      inputs: [],
      candidates,
      numbers: { paidMinor: r.paidMinor, savedMinor: r.savedMinor, netLossMinor: r.netLossMinor, breakEvenOrdersPerMonth: r.breakEvenOrdersPerMonth, ordersInWindow: r.ordersInWindow, avoidedNextMinor: next ? -next.amount_minor : 0 },
      done: sub.state === "RENEWAL_OFF" ? doneFor(env, sub, "STOP_RENEWAL") : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A16 */
const A16: CapabilityDef = {
  id: "A16",
  title: "Paying extra on foreign-currency subscriptions",
  short: "Lingora and PixelForge convert to RON at a markup",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["currency", "foreign currency", "exchange rate", "conversion", "markup", "lingora", "pixelforge", "dollars", "euros", "fx"],
  async analyze(env) {
    const hl = hiddenLossFixture();
    const charges: ForeignCharge[] = debits(env, "json_extract(data_json, '$.fx.originalMinor') IS NOT NULL").map((t) => {
      const fx = json<any>(t.data_json, {}).fx;
      return { id: t.id, bookedAt: t.booked_at, amountMinor: -t.amount_minor, merchantName: t.merchant_name, originalMinor: fx.originalMinor, currency: fx.currency ?? fx.originalCurrency };
    });
    const r = fxMarkup({ charges, rates: hl.fx.rates });
    const ccy = (minor: number, c: string) => `${(minor / 100).toFixed(2)} ${c}`;
    const blocks: Block[] = [
      {
        kind: "metrics",
        items: [
          { label: "Extra paid so far", value: money(r.observedMinor), tone: r.observedMinor ? "bad" : undefined, sub: `${r.flagged.reduce((s, m) => s + m.charges, 0)} charges` },
          { label: "About a year", value: money(r.annualMinor), sub: "If prices and rates stay the same" },
        ],
      },
      {
        kind: "table",
        title: "Each charge vs the reference rate",
        columns: ["Date", "Charged", "At reference", "Extra"],
        rows: r.rows.map((x) => ({ cells: [`${shortDate(x.bookedAt)} · ${x.merchantName}`, money(x.amountMinor), x.referenceMinor == null ? "No rate" : money(x.referenceMinor), x.markupMinor == null ? "—" : money(x.markupMinor)], tone: x.markupBasisPoints != null && x.markupBasisPoints >= 50 ? "warn" : undefined })),
        note: `Reference: ${hl.fx.source}. Each charge is converted at that day's rate.`,
      },
      {
        kind: "table",
        title: "How to stop the markup",
        columns: ["Subscription", "Change", "Saves a year"],
        rows: r.merchants.map((m) => ({
          cells: [`${m.merchantName} · ${ccy(m.originalMinor, m.currency)}`, m.flagged ? (m.currency === "EUR" ? "Pay in EUR from a NextMove EUR account (fictional), or choose EUR at checkout" : `Choose ${m.currency} at checkout so your card converts`) : "No change needed", m.flagged ? money(m.annualMinor) : money(0)],
          tone: m.flagged ? "warn" : "good",
        })),
      },
      {
        kind: "facts",
        title: "What NextMove knows",
        items: [
          ...r.merchants.map((m) => ({ label: `${m.merchantName} conversion`, value: `Done by the merchant, ${pct(m.avgBasisPoints)} above reference`, provenance: PROVENANCE.BANK })),
          { label: "NextMove card conversion", value: `${pct(hl.fx.cardMarkupBasisPoints)} markup`, provenance: hl.fx.cardTermsSource },
        ],
      },
      { kind: "note", tone: "info", text: "Confidence: high for the extra already paid (your statement shows the original price and the RON charge). The yearly figure assumes the same price and rates." },
      { kind: "note", tone: "warn", text: "Prepared, not sent. Neither merchant has a NextMove connector, so you change the billing currency in their settings. Past charges are not refunded." },
    ];
    return {
      capability: "A16",
      title: "Foreign-currency subscriptions",
      contextId: env.contextId,
      headline: r.flagged.length ? `You paid ${money(r.observedMinor)} extra in currency markup, about ${money(r.annualMinor)} a year` : "No currency markup found",
      summary: r.flagged.length ? `${r.flagged.map((m) => m.merchantName).join(" and ")} convert to RON themselves, at ${r.flagged.map((m) => pct(m.avgBasisPoints)).join(" and ")} above the NextMove reference rate.` : "Foreign-currency charges match the reference rate.",
      evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION", "FICTIONAL_CATALOG", "PREPARED_NOT_SENT"],
      blocks,
      inputs: [],
      candidates: [],
      numbers: { observedMinor: r.observedMinor, annualMinor: r.annualMinor, flagged: r.flagged.length, ...Object.fromEntries(r.merchants.map((m) => [`${m.merchantName.toLowerCase()}AnnualMinor`, m.annualMinor])) },
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A17 */
const A17_Q = "agent:a17:pulsegym";
const A17: CapabilityDef = {
  id: "A17",
  title: "Paid but probably unused",
  short: "PulseGym is still charging; nothing nearby since August",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["gym", "pulsegym", "unused", "not using", "still going", "don't use", "paying for nothing"],
  async analyze(env) {
    const sub = subscription(env, "pulsegym");
    if (!sub) return unavailable(env, "A17", "No gym membership found");
    const { contract } = await liveContract(env, sub);
    if (!contract) return unavailable(env, "A17", "PulseGym could not be read");
    const location = json<any>(sub.data_json, {}).location;
    const charges = debits(env, "merchant_id='pulsegym'").map((t) => ({ id: t.id, bookedAt: t.booked_at, amountMinor: -t.amount_minor }));
    const nearby = debits(env, "merchant_id != 'pulsegym' AND json_extract(data_json, '$.location') = ?", location).map((t) => ({ id: t.id, bookedAt: t.booked_at, amountMinor: -t.amount_minor, merchantName: t.merchant_name }));
    const fp = behavioralFootprint({ membershipCharges: charges, related: nearby, now: env.now });
    const said = String(inputOr(env, "stillGoing", answer(env, A17_Q) ?? "")) || null;
    const pause = (contract.details as any).pause;
    const paused = (contract.pending as any)?.pause;
    const busy = openActionFor(env, sub.id, "STOP_RENEWAL") || openActionFor(env, sub.id, "PAUSE");
    const months = Number(inputOr(env, "months", 1));
    const p = pause ? pauseEffect({ monthlyMinor: contract.priceMinor, pauseStartsAt: pause.startsAt, months: pause.allowedMonths.includes(months) ? months : 1, allowedMonths: pause.allowedMonths, feeMinor: pause.feeMinor, window: SUBSCRIPTION_WINDOW }) : null;
    const riskLabel = { HIGH: "High", MEDIUM: "Medium", LOW: "Low", UNKNOWN: "Can't tell" }[fp.risk];
    const ask = "Answer first: are you still going to PulseGym?";

    const candidates: Candidate[] = [];
    if (!paused && !busy && contract.autoRenew && fp.risk !== "LOW") {
      if (said !== "yes" && said !== "no" && p) {
        candidates.push({
          key: "pause-pulsegym",
          defaultSelected: true,
          available: said === "break",
          unavailableReason: said === "break" ? undefined : ask,
          spec: spec({
            operation: "PAUSE",
            route: routeFor(env.db, env.tenantId, "pulsegym") ?? "PARTNER_API",
            capability: "A17",
            ...subjectFields(sub),
            params: { months: p.skippedCharges.length },
            termsRevision: contract.termsRevision,
            money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: p.feeMinor, forecastChangeMinor: -p.skippedInWindowMinor },
            consequences: { effectiveAt: pause.startsAt, accessUntil: p.accessEndsAt, lostBenefits: ["Gym access while frozen"], dataEffect: null, remainingObligations: `Restarts ${fmtWhen(p.resumesAt)} at ${money(p.resumePriceMinor)}/month` },
            display: display(`Freeze PulseGym for ${p.skippedCharges.length} month${p.skippedCharges.length > 1 ? "s" : ""}`, `Skip ${money(p.totalSkippedMinor)}; restarts ${fmtDate(p.resumesAt)}.`, [
              { label: "Freeze starts", value: fmtWhen(pause.startsAt) },
              { label: "Restarts", value: `${fmtWhen(p.resumesAt)} at ${money(p.resumePriceMinor)}` },
              { label: "Skipped", value: money(p.totalSkippedMinor) },
              { label: "Fee", value: money(p.feeMinor) },
              { label: "You said", value: "Taking a break" },
            ], p.note),
          }),
        });
      }
      if (said !== "yes" && said !== "break") {
        const stop = stopRenewalCandidate(env, "A17", sub, contract, { key: "stop-pulsegym", reason: said === "no" ? "You told us you stopped going. Membership stays active until the paid month ends." : "Stop future charges. Membership stays active until the paid month ends.", lostBenefits: ["PulseGym access after the paid month"] });
        if (said === "no") stop.spec.display.lines.push({ label: "You said", value: "I stopped going" });
        candidates.push({ ...stop, defaultSelected: said === "no", available: stop.available && said === "no", unavailableReason: said === "no" ? stop.unavailableReason : ask });
      }
    }

    const signals = [...new Set(nearby.map((n) => n.merchantName))].map((m) => {
      const xs = nearby.filter((n) => n.merchantName === m);
      return { label: m, value: `${xs.length} payments, last ${fmtDate(xs[xs.length - 1].bookedAt)}`, provenance: `${PROVENANCE.BANK} · card terminal in ${location}` };
    });
    const next = forecastFor(env, sub.id)[0];
    const blocks: Block[] = [
      {
        kind: "metrics",
        items: [
          { label: "Paid with no sign of a visit", value: money(fp.silentPaidMinor), tone: fp.silentCycles ? "bad" : undefined, sub: `${fp.silentCycles} payment${fp.silentCycles === 1 ? "" : "s"} in a row` },
          { label: "Last sign nearby", value: fp.lastSignalAt ? fmtDate(fp.lastSignalAt) : "None", sub: fp.daysSinceLastSignal != null ? `${fp.daysSinceLastSignal} days ago` : undefined },
          { label: "Risk you don't use it", value: riskLabel, tone: fp.risk === "HIGH" ? "warn" : undefined, sub: "A signal, not proof" },
        ],
      },
      {
        kind: "table",
        title: "Each payment and what we saw nearby",
        columns: ["Membership paid", `Payments in ${location}`],
        rows: fp.cycles.map((c) => ({ cells: [`${shortDate(c.chargedAt)} · ${money(c.paidMinor)}`, String(c.signals)], tone: c.signals ? undefined : "warn" })),
        note: `Before, you averaged ${fp.baselinePerCycle} payments near the gym per month.`,
      },
      { kind: "facts", title: "Signs we used", items: signals },
      { kind: "note", tone: "warn", text: "This is a guess, not a fact. NextMove can't see gym check-ins. You may walk there, pay in cash, or use another card." },
      { kind: "question", id: A17_Q, text: "Are you still going to PulseGym?", options: [{ value: "yes", label: "Yes, I still go" }, { value: "break", label: "Taking a break" }, { value: "no", label: "I stopped going" }], answer: said },
      ...(said === "yes" ? [{ kind: "note" as const, tone: "info" as const, text: "Thanks. Nothing to change. NextMove won't suggest this again unless the pattern continues." }] : []),
      ...(said && said !== "yes" && next ? [{ kind: "note" as const, tone: "info" as const, text: `The next ${money(-next.amount_minor)} charge is on ${fmtDate(next.due_at)}. A freeze or stop avoids future charges; the ${money(fp.silentPaidMinor)} already paid is not refunded.` }] : []),
      ...(busy ? [{ kind: "status" as const, title: "In progress", state: busy.status, detail: "Follow it in Activity → Tasks.", href: `/actions/${busy.id}` }] : []),
    ];
    return {
      capability: "A17",
      title: "PulseGym",
      contextId: env.contextId,
      headline: paused ? `PulseGym is frozen until ${fmtDate(paused.resumesAt)}` : sub.state === "RENEWAL_OFF" ? "PulseGym renewal is off. No more charges." : said === "yes" ? "You still use PulseGym. Nothing to change." : fp.silentCycles ? `You paid ${money(fp.silentPaidMinor)} to PulseGym with no sign of a visit since ${fmtDate(fp.lastSignalAt)}` : "PulseGym looks used",
      summary: `${money(contract.priceMinor)}/month. In your first months, café and parking payments in ${location} came with each membership month. The last ${fp.silentCycles} months show only the membership.`,
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION", ...(said ? (["MANUAL_INPUT"] as const) : [])],
      blocks,
      inputs: said === "break" && pause && !paused ? [{ key: "months", label: "Freeze length", type: "select", value: String(p?.skippedCharges.length ?? 1), options: pause.allowedMonths.map((m: number) => ({ value: String(m), label: `${m} month${m > 1 ? "s" : ""}` })) }] : [],
      candidates,
      numbers: { silentPaidMinor: fp.silentPaidMinor, silentCycles: fp.silentCycles, daysSinceLastSignal: fp.daysSinceLastSignal ?? 0, baselinePerCycle: fp.baselinePerCycle, nextChargeMinor: next ? -next.amount_minor : 0 },
      done: paused ? { label: `Frozen until ${fmtDate(paused.resumesAt)}`, href: lastReceipt(env, sub.id, "PAUSE") ? `/receipts/${lastReceipt(env, sub.id, "PAUSE").id}` : undefined } : sub.state === "RENEWAL_OFF" ? doneFor(env, sub, "STOP_RENEWAL") : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A18 */
const A18_Q = "agent:a18:safetrip";
const A18: CapabilityDef = {
  id: "A18",
  title: "Insurance your card may already include",
  short: "SafeTrip overlaps the travel cover on your card",
  group: "Travel",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["insurance", "travel insurance", "safetrip", "card cover", "already covered", "covered"],
  async analyze(env) {
    const hl = hiddenLossFixture();
    const sub = subscription(env, "safetrip");
    if (!sub) return unavailable(env, "A18", "No travel insurance found");
    const { contract } = await liveContract(env, sub);
    if (!contract) return unavailable(env, "A18", "SafeTrip could not be read");
    const card = json<any>(all<any>(env.db, "SELECT card_json FROM accounts WHERE tenant_id=? AND context_id=? AND card_json IS NOT NULL ORDER BY ordinal LIMIT 1", env.tenantId, env.contextId)[0]?.card_json, null);
    const trip = json<any>(all<any>(env.db, "SELECT inputs_json FROM goals WHERE tenant_id=? AND context_id=? AND kind='TRIP' LIMIT 1", env.tenantId, env.contextId)[0]?.inputs_json, null);
    const tripPayment = trip && card ? debits(env, "category='Travel' AND card_last4=?", card.last4).slice(-1)[0] : null;
    const rows: CoverRow[] = hl.travelCover.rows;
    const c = coverageOverlap({ rows, tripPaidWithCard: trip ? Boolean(tripPayment) : null });
    const said = String(inputOr(env, "needsExtras", answer(env, A18_Q) ?? "")) || null;
    const open = openActionFor(env, sub.id, "STOP_RENEWAL");
    const gapsText = c.gaps.map((g) => `${g.label}: ${g.gap?.toLowerCase()}`);
    const candidates: Candidate[] = [];
    if (!open && contract.autoRenew && said !== "yes") {
      const stop = stopRenewalCandidate(env, "A18", sub, contract, { key: "stop-safetrip", reason: "Rely on your card's travel cover from the next policy year. You keep SafeTrip until the paid year ends.", lostBenefits: gapsText });
      if (said === "no") stop.spec.display.lines.push({ label: "You said", value: "Card cover is enough" });
      candidates.push({ ...stop, defaultSelected: said === "no", available: stop.available && said === "no", unavailableReason: said === "no" ? stop.unavailableReason : "Answer first: do you need what only SafeTrip covers?" });
    }
    const blocks: Block[] = [
      {
        kind: "metrics",
        items: [
          { label: "SafeTrip", value: `${money(contract.priceMinor)} / year`, sub: `Renews ${fmtDate(contract.nextChargeAt)}` },
          { label: "Differences", value: `${c.gaps.length} of ${rows.length}`, tone: "warn", sub: "Not equivalent" },
        ],
      },
      {
        kind: "table",
        title: "SafeTrip vs your card's travel cover",
        columns: ["Cover", "SafeTrip", "Card"],
        rows: rows.map((r) => ({ cells: [r.label, r.policy, r.card], tone: r.gap ? "warn" : "good" })),
        note: `Sources: ${hl.travelCover.source}.`,
      },
      { kind: "conditions", title: "What you would lose without SafeTrip", items: c.gaps.map((g) => ({ label: g.label, state: "unmet" as const, detail: `${g.gap}. Card: ${g.card}` })) },
      ...(trip
        ? [{ kind: "facts" as const, title: `${trip.destination}, ${fmtDate(trip.start)} – ${fmtDate(trip.end)}`, items: [
            { label: "Paid with your card", value: tripPayment ? `${tripPayment.merchant_name} ${money(tripPayment.amount_minor)} on ${fmtDate(tripPayment.booked_at)}` : "No card payment found", provenance: PROVENANCE.BANK },
            { label: "Covered by SafeTrip", value: `Yes, paid until ${fmtDate(contract.nextChargeAt)}`, provenance: PROVENANCE.MERCHANT },
          ] }]
        : []),
      { kind: "note", tone: "info", text: "Confidence: medium. This compares the two policies line by line (both fictional). The covers are not the same; only you can say which gaps matter." },
      { kind: "question", id: A18_Q, text: "Do you need trip cancellation, winter sports, trips over 30 days or the higher medical limit?", options: [{ value: "no", label: "No, card cover is enough" }, { value: "yes", label: "Yes, keep SafeTrip" }], answer: said },
      ...(said === "yes" ? [{ kind: "note" as const, tone: "info" as const, text: "Keep SafeTrip. Nothing changes." }] : []),
      ...(said === "no" ? [{ kind: "note" as const, tone: "info" as const, text: `Turning off renewal avoids ${money(contract.priceMinor)} on ${fmtDate(contract.nextChargeAt)}. It is an avoided future charge, not money back.` }] : []),
      ...(open ? [{ kind: "status" as const, title: "In progress", state: open.status, detail: "Follow it in Activity → Tasks.", href: `/actions/${open.id}` }] : []),
    ];
    return {
      capability: "A18",
      title: "Travel insurance",
      contextId: env.contextId,
      headline: sub.state === "RENEWAL_OFF" ? "SafeTrip renewal is off. Your card cover applies from the next policy year." : `Your card already includes travel cover. SafeTrip costs ${money(contract.priceMinor)} a year for ${c.gaps.length} differences`,
      summary: "Your NextMove card includes travel cover for trips paid with the card (fictional terms). It overlaps SafeTrip, with lower limits and fewer risks covered.",
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "FICTIONAL_CATALOG", ...(said ? (["MANUAL_INPUT"] as const) : [])],
      blocks,
      inputs: [],
      candidates,
      numbers: { annualMinor: contract.priceMinor, gaps: c.gaps.length, rows: rows.length },
      done: sub.state === "RENEWAL_OFF" ? doneFor(env, sub, "STOP_RENEWAL") : null,
    };
  },
};

export const HIDDEN_LOSS_CAPS = [A15, A16, A17, A18];
