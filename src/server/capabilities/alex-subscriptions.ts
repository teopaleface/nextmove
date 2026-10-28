import { all, json } from "../db/connection";
import { scheduledItems, toEntries, SUBSCRIPTION_WINDOW } from "../bank/forecast";
import { compareSubscriptions, type ComparisonResult, type SubscriptionFacts } from "../finance/subscriptions";
import { rightSizePlan, monthlyVsAnnual, detectPriceChanges, planContentSchedule, pauseEffect } from "../finance/capabilities";
import { formatMoney } from "../../shared/money";
import { merchantAccountId } from "../../shared/ids";
import {
  type Analysis,
  type Block,
  type CapEnv,
  type CapabilityDef,
  type Candidate,
  display,
  fact,
  fixture,
  fmtDate,
  fmtWhen,
  forecastFor,
  inputOr,
  inputInt,
  lastReceipt,
  liveContract,
  money,
  openActionFor,
  preference,
  routeFor,
  spec,
  stopRenewalCandidate,
  subjectFields,
  subscription,
} from "./core";

const UI_IDS = ["fitflow", "studyplus", "streamly", "cloudbox"];

/** The shared subscription comparison used by T2, T3 and A1 so their savings are never double-counted. */
export async function comparison(env: CapEnv) {
  const subs = UI_IDS.map((id) => subscription(env, id)).filter(Boolean);
  const bundleSub = subscription(env, "studyplus-bundle");
  const entries = toEntries(scheduledItems(env.db, env.tenantId, env.contextId, "ui")).map((e) => {
    const s = [...subs, bundleSub].find((x) => x && x.id === e.subscriptionId);
    return { ...e, subscriptionId: s ? (s.id === bundleSub?.id ? "studyplus-bundle" : s.merchant_id) : e.subscriptionId };
  });
  const facts: SubscriptionFacts[] = subs.map((s) => {
    const b = json<any>(s.benefits_json, {});
    return {
      id: s.merchant_id,
      merchantName: s.merchant_name,
      state: (["ACTIVE", "TRIAL", "RENEWAL_OFF", "PAUSED", "CANCELLED"].includes(s.state) ? s.state : "ACTIVE") as SubscriptionFacts["state"],
      amountMinor: s.amount_minor,
      storageGb: b.cloudStorageGb,
      offlinePlayback: b.offlinePlayback,
      tvAccess: b.tvAccess,
      primaryBenefit: b.primary,
    };
  });
  const sp = subscription(env, "studyplus");
  let offer: any = null;
  let offerRevision: number | null = null;
  let student: "verified" | "unverified" | "unknown" = "unknown";
  try {
    const o = await env.merchant.getOffer("studyplus", sp.subscriber_account_id, "student-bundle");
    if (o.offer) {
      offer = { ...o.offer.terms, termRevision: o.offer.revision };
      offerRevision = o.offer.revision;
    }
    const acct = await env.merchant.getAccount("studyplus", sp.subscriber_account_id);
    if (acct.account?.details?.studentVerification === "VERIFIED") student = "verified";
  } catch {
    /* provider unreachable: offer stays unknown */
  }
  const cb = subscription(env, "cloudbox");
  const mig = json<any>(cb?.data_json, {})?.migration ?? null;
  const usedGb = (await liveContract(env, cb)).contract?.details?.usedGb as number | undefined;
  const protectedBenefits: string[] = preference(env, "protected_benefits") ?? ["offline_playback"];
  const result = compareSubscriptions({
    window: SUBSCRIPTION_WINDOW,
    entries,
    subscriptions: facts,
    offer: bundleSub ? null : offer,
    protectedBenefits,
    studentStatus: student,
    storageUsedGb: usedGb ?? null,
    migration: mig ? { from: "cloudbox", to: mig.destination ?? null, state: mig.state === "VERIFIED" ? "VERIFIED" : "IN_PROGRESS" } : null,
    replacementStorageActive: Boolean(bundleSub),
  });
  return { result, offer, offerRevision, student, subs, bundleSub, usedGb, protectedBenefits, migration: mig };
}

function comparisonBlocks(r: ComparisonResult): Block[] {
  return [
    {
      kind: "metrics",
      items: [
        { label: "Upcoming in 30 days", value: money(r.baselineMinor), sub: `${fmtDate(r.window.startInclusive)} – ${fmtDate(r.window.endExclusive)}` },
        { label: "If every option is used", value: money(r.optimizedMinor), sub: `${money(r.potentialMinor)} less, not yet executed`, tone: "good" },
      ],
    },
    {
      kind: "table",
      title: "Options (counted once each)",
      columns: ["Option", "Reduction", "Status"],
      rows: r.options.map((o) => ({ cells: [o.title, money(o.reductionMinor), o.status === "AVAILABLE" ? "Available" : o.status === "CONDITIONAL" ? "Conditional" : o.status === "INCOMPATIBLE" ? "Not compatible" : "Not applicable"], tone: o.status === "INCOMPATIBLE" ? "bad" : o.status === "CONDITIONAL" ? "warn" : "good" })),
      note: "Avoided future charges are not money in your account. Funds stay unchanged until a payment would have happened.",
    },
  ];
}

function doneFor(env: CapEnv, local: string, op = "STOP_RENEWAL") {
  const sub = subscription(env, local);
  if (!sub) return null;
  const r = lastReceipt(env, sub.id, op);
  return r ? { label: `${sub.merchant_name}: confirmed by the provider (ref ${r.issuer_reference})`, href: `/receipts/${r.id}` } : null;
}

/* ------------------------------------------------------------------------------------------------ T2 */
const T2: CapabilityDef = {
  id: "T2",
  title: "Free trial about to charge",
  short: "Stop the FitFlow trial before 79 RON is charged",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["trial", "fitflow", "free trial", "cancel", "stop", "renewal", "perioada de proba", "proba gratuita", "anuleaza", "anulez", "opreste"],
  async analyze(env) {
    const sub = subscription(env, "fitflow");
    const { contract, status } = await liveContract(env, sub);
    const { result } = await comparison(env);
    const trial = result.options.find((o) => o.id === "stop-trial");
    const items = forecastFor(env, sub.id);
    const watch = all<any>(env.db, "SELECT * FROM watches WHERE tenant_id=? AND subject_ref=?", env.tenantId, sub.id)[0];
    const candidates: Candidate[] = contract && contract.autoRenew ? [stopRenewalCandidate(env, "T2", sub, contract, { key: "stop-fitflow", reason: "Turn off renewal so the trial ends without becoming a paid plan." })] : [];
    const open = openActionFor(env, sub.id, "STOP_RENEWAL");
    return {
      capability: "T2",
      title: "FitFlow trial",
      contextId: env.contextId,
      headline: trial ? `Stopping the trial lowers upcoming charges from ${money(result.baselineMinor)} to ${money(result.baselineMinor - trial.reductionMinor)}` : sub.state === "RENEWAL_OFF" ? "FitFlow renewal is off. No charge is coming." : "No trial charge in this window",
      summary: contract && !contract.nextChargeAt ? `Renewal is off: FitFlow Premium will not charge the ${money(contract.priceMinor)}/month plan. If FitFlow still charges you, ask "FitFlow charged me after I cancelled" to dispute it.` : contract ? `FitFlow Premium converts to a paid plan on ${fmtWhen(contract.nextChargeAt)} for ${money(contract.priceMinor)}/month unless renewal is turned off.` : `Provider read failed (${status}).`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION", "BANK_RECORD"],
      blocks: [
        { kind: "metrics", items: [{ label: "Upcoming in 30 days", value: money(result.baselineMinor) }, { label: "After stopping the trial", value: money(result.baselineMinor - (trial?.reductionMinor ?? 0)), tone: "good" }, { label: "Funds", value: "Unchanged", sub: "No money moves" }] },
        {
          kind: "timeline",
          title: "What happens",
          items: [
            ...(watch ? [{ at: watch.last_checked_at ?? env.now, label: `Watching the conversion date (${json<any>(watch.condition_json, {}).thresholdsHours?.join(" h and ")} h warnings)`, state: watch.status }] : []),
            ...(contract ? [{ at: contract.nextChargeAt ?? contract.accessUntil ?? env.now, label: contract.autoRenew ? "Trial becomes paid" : "Trial ends, no charge", amount: contract.autoRenew ? money(-contract.priceMinor) : undefined }] : []),
            ...items.map((i) => ({ at: i.due_at, label: i.label, amount: money(i.amount_minor) })),
          ],
        },
        { kind: "facts", title: "What NextMove knows", items: contract ? [
          { label: "Plan", value: contract.planName, provenance: "From the provider (simulated)" },
          { label: "Trial ends", value: fmtWhen(contract.accessUntil), provenance: "From the provider (simulated)" },
          { label: "Price after trial", value: `${money(contract.priceMinor)} / month`, provenance: "From the provider (simulated)" },
          { label: "Cancellation fee", value: money(0), provenance: "From the provider (simulated)" },
          { label: "Connector", value: routeFor(env.db, env.tenantId, "fitflow") === "ISOLATED_BROWSER" ? "Provider website (no partner write API)" : "Partner API", provenance: "NextMove bank record" },
        ] : [] },
        ...(open ? [{ kind: "status" as const, title: "In progress", state: open.status, detail: "Follow it in Activity → Tasks.", href: `/actions/${open.id}` }] : []),
      ],
      inputs: [],
      candidates: open ? [] : candidates,
      numbers: { baselineMinor: result.baselineMinor, afterMinor: result.baselineMinor - (trial?.reductionMinor ?? 0), trialMinor: trial?.reductionMinor ?? 0 },
      done: sub.state === "RENEWAL_OFF" ? doneFor(env, "fitflow") : null,
      labs: [
        { action: "set_cancellation_mode", label: "Provider: review cancellations manually", body: { merchantId: "fitflow", mode: "review" } },
        { action: "set_cancellation_mode", label: "Provider: refuse cancellations", body: { merchantId: "fitflow", mode: "refuse" } },
        { action: "set_cancellation_mode", label: "Provider: instant cancellations", body: { merchantId: "fitflow", mode: "instant" } },
      ],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ T3 */
const T3: CapabilityDef = {
  id: "T3",
  title: "Student bundle offer",
  short: "Compare the StudyPlus + Streamly student bundle",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["student", "bundle", "offer", "studyplus", "streamly", "discount"],
  async analyze(env) {
    const c = await comparison(env);
    const bundle = c.result.options.find((o) => o.id === "switch-bundle");
    const sp = subscription(env, "studyplus");
    const st = subscription(env, "streamly");
    const spLive = (await liveContract(env, sp)).contract;
    const stLive = (await liveContract(env, st)).contract;
    const idFact = fact(env, "student_id_number");
    const enteredId = inputOr<string>(env, "studentIdNumber", "");
    const studentId = enteredId || (idFact ? json<any>(idFact.value_json)?.value : "");
    const offer = c.offer;
    const candidates: Candidate[] = [];
    const busy = openActionFor(env, sp.id, "STOP_RENEWAL") || openActionFor(env, st.id, "STOP_RENEWAL");
    if (offer && !c.bundleSub && bundle && bundle.status !== "INCOMPATIBLE" && spLive && stLive && !busy) {
      const acct = sp.subscriber_account_id;
      if (c.student !== "verified") {
        candidates.push({
          key: "verify-student",
          defaultSelected: true,
          available: Boolean(studentId),
          unavailableReason: studentId ? undefined : "Add your student ID number (type it or upload the card) first",
          spec: spec({
            operation: "VERIFY_ELIGIBILITY",
            route: "PARTNER_API",
            capability: "T3",
            merchantId: "studyplus",
            merchantName: "StudyPlus",
            subscriberAccountId: acct,
            subjectRef: `${env.tenantId}:offer:student-bundle`,
            params: { studentIdNumber: studentId },
            consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: "Shares your student ID number with StudyPlus for verification", remainingObligations: null },
            display: display("Verify student status with StudyPlus", "StudyPlus checks your student ID number. Nothing is bought.", [
              { label: "Shared with StudyPlus", value: `Student ID number ${maskId(studentId)}` },
              { label: "Cost", value: money(0) },
            ], "Only the student ID number is shared."),
          }),
        });
      }
      candidates.push({
        key: "activate-bundle",
        defaultSelected: true,
        available: true,
        spec: spec({
          operation: "ACTIVATE_OFFER",
          route: "PARTNER_API",
          capability: "T3",
          merchantId: "studyplus",
          merchantName: "StudyPlus",
          subscriberAccountId: acct,
          subjectRef: `${env.tenantId}:offer:student-bundle`,
          params: { offerId: "student-bundle", offerRevision: c.offerRevision, offerName: offer.name, benefits: { cloudStorageGb: offer.includesCloudStorageGb, offlinePlayback: offer.offlinePlayback, studyTools: true, streaming: true } },
          termsRevision: null,
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: offer.monthlyMinor, feesMinor: offer.activationFeeMinor ?? 0, forecastChangeMinor: offer.monthlyMinor },
          consequences: { effectiveAt: offer.activationDateAssumed ?? offer.firstChargeAt, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: `${money(offer.monthlyMinor)}/month until ${fmtDate(offer.priceValidUntil)}, then ${money(offer.postPromotionMonthlyMinor)}/month` },
          dependsOn: c.student !== "verified" ? ["verify-student"] : [],
          display: display(`Activate ${offer.name}`, `Starts ${fmtWhen(offer.firstChargeAt)}; replaces StudyPlus and Streamly.`, [
            { label: "Offer", value: `${offer.name} · terms revision ${c.offerRevision}` },
            { label: "Price", value: `${money(offer.monthlyMinor)}/month until ${fmtDate(offer.priceValidUntil)}` },
            { label: "After the promotion", value: `${money(offer.postPromotionMonthlyMinor)}/month` },
            { label: "First charge", value: fmtWhen(offer.firstChargeAt) },
            { label: "Includes", value: `${offer.includesCloudStorageGb} GB storage, ${offer.offlinePlayback ? "offline playback" : "no offline playback"}, study tools` },
          ], "If the offer terms change before this starts, the approval is cancelled and nothing is sent."),
        }),
      });
      candidates.push(stopRenewalCandidate(env, "T3", sp, spLive, { key: "stop-studyplus", dependsOn: ["activate-bundle"], reason: "Replaced by the bundle once it is active." }));
      candidates.push(stopRenewalCandidate(env, "T3", st, stLive, { key: "stop-streamly", dependsOn: ["activate-bundle"], reason: "Replaced by the bundle once it is active." }));
    }
    const conds = bundle?.conditions ?? [];
    const changed = c.offerRevision && c.offerRevision > 1;
    return {
      capability: "T3",
      title: "Student bundle",
      contextId: env.contextId,
      headline: c.bundleSub ? "The student bundle is active" : bundle ? `Bundle would save ${money(bundle.reductionMinor)} in the next 30 days${bundle.status === "CONDITIONAL" ? " if you qualify" : ""}` : "No compatible bundle",
      summary: offer ? `${offer.name}: ${money(offer.monthlyMinor)}/month for StudyPlus + Streamly (${offer.offlinePlayback ? "with" : "without"} offline playback), price fixed until ${fmtDate(offer.priceValidUntil)}.` : "The offer could not be read.",
      evidence: ["SIMULATED_MERCHANT_API", "FICTIONAL_CATALOG", "DETERMINISTIC_CALCULATION"],
      blocks: [
        ...comparisonBlocks(c.result),
        {
          kind: "table",
          title: "Same benefits, same period",
          columns: ["", "Now", "Bundle"],
          rows: [
            { cells: ["Monthly price", money((spLive?.priceMinor ?? 0) + (stLive?.priceMinor ?? 0)), offer ? money(offer.monthlyMinor) : "—"] },
            { cells: ["Billing period", "Monthly", "Monthly"] },
            { cells: ["Storage", `${json<any>(sp.benefits_json, {}).cloudStorageGb ?? 0} GB (StudyPlus)`, offer ? `${offer.includesCloudStorageGb} GB` : "—"] },
            { cells: ["Offline playback", stLive?.benefits?.offlinePlayback ? "Yes" : "No", offer ? (offer.offlinePlayback ? "Yes" : "No") : "—"], tone: offer && !offer.offlinePlayback ? "bad" : undefined },
            { cells: ["Price after promotion", "—", offer ? `${money(offer.postPromotionMonthlyMinor)}/month from ${fmtDate(offer.priceValidUntil)}` : "—"] },
          ],
        },
        { kind: "conditions", title: "Conditions", items: conds.map((x) => ({ label: x.label, state: x.state, detail: x.detail })) },
        ...(changed ? [{ kind: "note" as const, tone: "warn" as const, text: `The provider changed the offer to terms revision ${c.offerRevision}. Any earlier approval was cancelled before anything was sent.` }] : []),
        { kind: "facts", title: "Eligibility", items: [{ label: "Student status", value: c.student === "verified" ? "Verified by StudyPlus" : "Unknown until verified", provenance: c.student === "verified" ? "From the provider (simulated)" : "Needs checking" }, ...(studentId ? [{ label: "Student ID number", value: maskId(studentId), provenance: enteredId ? "You entered" : idFact?.provenance === "READ_FROM_IMAGE" ? "Read from your image" : "You entered" }] : [])] },
      ],
      inputs: c.student === "verified" || c.bundleSub ? [] : [{ key: "studentIdNumber", label: "Student ID number", type: "text", value: studentId, help: "Format S + 12 digits. Or upload a photo of the card in Evidence." }],
      candidates,
      numbers: { baselineMinor: c.result.baselineMinor, bundleReductionMinor: bundle?.reductionMinor ?? 0, bundleMonthlyMinor: offer?.monthlyMinor ?? 0, postPromotionMinor: offer?.postPromotionMonthlyMinor ?? 0 },
      done: c.bundleSub ? { label: "Bundle activated (scheduled to start)", href: "/activity" } : null,
      labs: [{ action: "change_offer_terms", label: "Provider: remove offline playback from the offer", body: { offerId: "student-bundle", changes: { offlinePlayback: false } } }],
    };
  },
};

function maskId(id: string) {
  return id ? `${id.slice(0, 3)}••••••${id.slice(-3)}` : "";
}

/* ------------------------------------------------------------------------------------------------ A1 */
const A1: CapabilityDef = {
  id: "A1",
  title: "Paying twice for storage",
  short: "CloudBox duplicates storage you already have",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["duplicate", "storage", "cloudbox", "overlap", "twice", "cloud", "stocare"],
  async analyze(env) {
    const c = await comparison(env);
    const storage = c.result.options.find((o) => o.id === "remove-duplicate-storage");
    const cb = subscription(env, "cloudbox");
    const live = (await liveContract(env, cb)).contract;
    const candidates: Candidate[] = [];
    const mig = c.migration;
    if (live && live.autoRenew && storage && storage.status !== "INCOMPATIBLE") {
      const dest = c.bundleSub || storage.dependsOn.includes("switch-bundle") ? "Student bundle storage" : "StudyPlus storage";
      if (!mig) {
        candidates.push({
          key: "migrate-files",
          defaultSelected: true,
          available: true,
          spec: spec({
            operation: "START_MIGRATION",
            route: "PARTNER_API",
            capability: "A1",
            ...subjectFields(cb),
            params: { destination: dest },
            termsRevision: live.termsRevision,
            consequences: { effectiveAt: null, accessUntil: null, lostBenefits: [], dataEffect: `Copies ${c.usedGb ?? "your"} GB from CloudBox to ${dest}; CloudBox keeps its copy until renewal ends`, remainingObligations: null },
            display: display("Copy CloudBox files first", `Copy ${c.usedGb} GB to ${dest} and verify before anything is cancelled.`, [
              { label: "Files", value: `${c.usedGb} GB on CloudBox` },
              { label: "Destination", value: dest },
              { label: "Cost", value: money(0) },
            ], "CloudBox renewal is only turned off after the copy is verified."),
          }),
        });
      }
      candidates.push(stopRenewalCandidate(env, "A1", cb, live, { key: "stop-cloudbox", dependsOn: mig ? [] : ["migrate-files"], reason: "Only after your files are copied and verified.", lostBenefits: ["CloudBox storage after the paid period"] }));
    }
    const conds = storage?.conditions ?? [];
    return {
      capability: "A1",
      title: "Duplicate storage",
      contextId: env.contextId,
      headline: storage ? `${money(storage.reductionMinor)} of storage is duplicated` : "No duplicate benefit found",
      summary: `CloudBox (${money(cb.amount_minor)}/month, ${c.usedGb ?? "?"} GB used) overlaps the 100 GB already included with ${c.bundleSub ? "the student bundle" : "StudyPlus"}. Savings are counted once.`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        ...comparisonBlocks(c.result),
        { kind: "conditions", title: "Protected dependencies", items: [...conds.map((x) => ({ label: x.label, state: x.state, detail: x.detail })), { label: "Files copied and verified before CloudBox stops", state: mig?.state === "VERIFIED" ? "met" : mig ? "unknown" : "unmet", detail: mig ? `Copy ${mig.state === "VERIFIED" ? "verified" : "in progress"}` : "Not started" }] },
      ],
      inputs: [],
      candidates,
      numbers: { storageReductionMinor: storage?.reductionMinor ?? 0, usedGb: c.usedGb ?? 0, baselineMinor: c.result.baselineMinor },
      done: cb.state === "RENEWAL_OFF" ? doneFor(env, "cloudbox") : null,
      labs: [{ action: "finish_migrations", label: "Provider: finish file copy now" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A2 */
const A2: CapabilityDef = {
  id: "A2",
  title: "Phone plan bigger than needed",
  short: "MobileNet: use 11.5 GB of 100 GB",
  group: "Bills",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["mobile", "phone plan", "data", "mobilenet", "right size", "downgrade", "gb"],
  async analyze(env) {
    const sub = subscription(env, "mobilenet");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A2", "MobileNet could not be read");
    const d: any = live.details;
    const pref = preference(env, "hotspot_required");
    const hotspotRequired = typeof pref === "boolean" ? pref : d.hotspotUsedGbLastCycle > 0 ? true : null;
    const r = rightSizePlan({ currentPlanId: live.planId, plans: d.plans, usageGb: d.usageGb.map((u: any) => u.gb), hotspotRequired });
    const rec = r.rows.find((x) => x.id === r.recommendedId);
    const next = forecastFor(env, sub.id)[0];
    const candidates: Candidate[] = rec
      ? [
          {
            key: "change-plan",
            defaultSelected: true,
            available: !openActionFor(env, sub.id, "CHANGE_PLAN"),
            spec: spec({
              operation: "CHANGE_PLAN",
              route: "PARTNER_API",
              capability: "A2",
              ...subjectFields(sub),
              params: { planId: rec.id },
              termsRevision: live.termsRevision,
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: rec.monthlyMinor, feesMinor: 0, forecastChangeMinor: next ? rec.monthlyMinor - live.priceMinor : 0 },
              consequences: { effectiveAt: live.nextChargeAt, accessUntil: null, lostBenefits: rec.lostBenefits, dataEffect: null, remainingObligations: `${money(rec.monthlyMinor)}/month from ${fmtWhen(live.nextChargeAt)}` },
              display: display(`Switch MobileNet to ${rec.name}`, `From the ${fmtDate(live.nextChargeAt)} bill: ${money(live.priceMinor)} → ${money(rec.monthlyMinor)}/month.`, [
                { label: "From", value: `${live.planName} · ${money(live.priceMinor)}` },
                { label: "To", value: `${rec.name} · ${money(rec.monthlyMinor)}` },
                { label: "Your peak use", value: `${r.peakGb} GB (headroom ${rec.headroomGb} GB)` },
                { label: "Keeps", value: `Hotspot ${rec.hotspotOk ? "yes" : "no"}` },
                { label: "Applies from", value: fmtWhen(live.nextChargeAt) },
                { label: "Change fee", value: money(0) },
              ], d.changeRule ?? ""),
            }),
          },
        ]
      : [];
    return {
      capability: "A2",
      title: "MobileNet plan",
      contextId: env.contextId,
      headline: rec ? `${rec.name} fits your use and saves ${money(rec.monthlySavingMinor)}/month` : "Your current plan is the right size",
      summary: `Peak ${r.peakGb} GB, average ${r.averageGb} GB over the last ${d.usageGb.length} cycles on your ${live.planName} plan.`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Peak use", value: `${r.peakGb} GB` }, { label: "Current plan", value: `${money(live.priceMinor)}/mo` }, ...(rec ? [{ label: "Suggested", value: `${money(rec.monthlyMinor)}/mo`, tone: "good" as const }] : [])] },
        { kind: "table", title: "Plans from MobileNet (catalog revision " + live.termsRevision + ")", columns: ["Plan", "Price", "Fits", "Loses"], rows: r.rows.map((x) => ({ cells: [x.name, money(x.monthlyMinor), x.compatible ? "Yes" : x.fitsPeak ? "Hotspot" : "No", x.lostBenefits.join(", ") || "—"], highlight: x.id === r.recommendedId, tone: x.compatible ? undefined : "bad" })) },
        { kind: "timeline", title: "Cellular data per cycle", items: d.usageGb.map((u: any) => ({ at: `${u.cycle}-15T12:00:00+03:00`, label: `${u.cycle}: ${u.gb} GB` })) },
        { kind: "question", id: "hotspot_required", text: `You used ${d.hotspotUsedGbLastCycle} GB of hotspot last cycle. Do you still need hotspot?`, options: [{ value: "true", label: "Yes, keep hotspot" }, { value: "false", label: "No" }], answer: typeof pref === "boolean" ? String(pref) : null },
        { kind: "note", tone: "info", text: r.note },
      ],
      inputs: [],
      candidates,
      numbers: { peakGb: r.peakGb, savingMinor: rec?.monthlySavingMinor ?? 0, currentMinor: live.priceMinor, recommendedMinor: rec?.monthlyMinor ?? live.priceMinor },
      done: lastReceipt(env, sub.id, "CHANGE_PLAN") ? { label: `Plan changed to ${live.planName}`, href: `/receipts/${lastReceipt(env, sub.id, "CHANGE_PLAN").id}` } : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A3 */
const A3: CapabilityDef = {
  id: "A3",
  title: "Monthly or annual",
  short: "StudyPlus: is the annual plan worth it?",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["annual", "yearly", "monthly", "break-even", "commitment", "studyplus", "go annual", "annual plan"],
  async analyze(env) {
    const sub = subscription(env, "studyplus");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A3", "StudyPlus could not be read");
    const annual = (live.details as any).annualPlan;
    const horizon = inputInt(env, "horizonMonths", 12, 1, 60);
    const r = monthlyVsAnnual({ monthlyMinor: annual.monthlyMinor, annualMinor: annual.annualMinor, horizonMonths: horizon });
    const replacing = openActionFor(env, sub.id, "STOP_RENEWAL") || subscription(env, "studyplus-bundle");
    const candidates: Candidate[] =
      live.billingPeriod !== "ANNUAL"
        ? [
            {
              key: "annual",
              defaultSelected: r.better === "ANNUAL",
              available: r.better === "ANNUAL" && !replacing,
              unavailableReason: replacing ? "StudyPlus is being replaced by the student bundle" : r.better !== "ANNUAL" ? `Monthly is cheaper for ${horizon} months` : undefined,
              spec: spec({
                operation: "CHANGE_BILLING_PERIOD",
                route: "PARTNER_API",
                capability: "A3",
                ...subjectFields(sub),
                params: { period: "ANNUAL" },
                termsRevision: live.termsRevision,
                money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: annual.annualMinor, feesMinor: 0, forecastChangeMinor: r.nextRenewalCashImpactMinor },
                consequences: { effectiveAt: annual.switchEffectiveAt, accessUntil: null, lostBenefits: [], dataEffect: null, remainingObligations: `${money(annual.annualMinor)} charged at once on ${fmtWhen(annual.switchEffectiveAt)}; ${annual.annualRefundRule}` },
                display: display("Switch StudyPlus to annual billing", `${money(annual.annualMinor)} once on ${fmtDate(annual.switchEffectiveAt)} instead of ${money(annual.monthlyMinor)} that month.`, [
                  { label: "Next charge", value: `${money(annual.annualMinor)} on ${fmtWhen(annual.switchEffectiveAt)}` },
                  { label: "Instead of", value: `${money(annual.monthlyMinor)}/month` },
                  { label: `Over ${horizon} months`, value: `${money(r.annualTotalMinor)} vs ${money(r.monthlyTotalMinor)}` },
                  { label: "Refund rule", value: annual.annualRefundRule },
                ], r.note),
              }),
            },
          ]
        : [];
    return {
      capability: "A3",
      title: "StudyPlus billing",
      contextId: env.contextId,
      headline: r.better === "ANNUAL" ? `Annual saves ${money(r.differenceMinor)} over ${horizon} months` : r.better === "MONTHLY" ? `Monthly is ${money(r.differenceMinor)} cheaper over ${horizon} months` : "Same cost",
      summary: `Break-even is month ${r.breakEvenMonths}. Annual is only better if you keep StudyPlus at least that long; the annual charge is ${money(r.nextRenewalCashImpactMinor)} more cash at the next renewal.`,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Break-even", value: `${r.breakEvenMonths} months` }, { label: `Monthly × ${horizon}`, value: money(r.monthlyTotalMinor) }, { label: `Annual (${r.annualPayments}×)`, value: money(r.annualTotalMinor) }] },
        { kind: "table", title: "Commitment", columns: ["", "Monthly", "Annual"], rows: [
          { cells: ["Total for your horizon", money(r.monthlyTotalMinor), money(r.annualTotalMinor)], highlight: true },
          { cells: ["Months paid but unused", "0", String(r.unusedCommittedMonths)] },
          { cells: ["Next renewal cash", money(annual.monthlyMinor), money(annual.annualMinor)] },
        ] },
        { kind: "note", tone: "info", text: r.note },
        ...(replacing ? [{ kind: "note" as const, tone: "warn" as const, text: "StudyPlus is part of the student bundle plan, so the annual switch is not offered." }] : []),
      ],
      inputs: [{ key: "horizonMonths", label: "How long will you keep StudyPlus?", type: "number", value: horizon, min: 1, max: 36, suffix: "months" }],
      candidates,
      numbers: { breakEvenMonths: r.breakEvenMonths, differenceMinor: r.differenceMinor, monthlyTotalMinor: r.monthlyTotalMinor, annualTotalMinor: r.annualTotalMinor, cashImpactMinor: r.nextRenewalCashImpactMinor },
      done: live.billingPeriod === "ANNUAL" ? { label: "StudyPlus is on annual billing" } : null,
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A4 */
const A4: CapabilityDef = {
  id: "A4",
  title: "Price went up",
  short: "Streamly rose from 39 to 49 RON",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["price increase", "price went up", "more expensive", "streamly", "price change", "raised the price", "raised its price", "price hike", "costs more", "went up", "price rose"],
  async analyze(env) {
    const sub = subscription(env, "streamly");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A4", "Streamly could not be read");
    const charges = all<any>(env.db, "SELECT id, amount_minor, booked_at FROM transactions WHERE tenant_id=? AND context_id=? AND merchant_name='Streamly' AND status='POSTED' AND amount_minor<0 ORDER BY booked_at", env.tenantId, env.contextId).map((t) => ({ id: t.id, amountMinor: -t.amount_minor, bookedAt: t.booked_at }));
    const d: any = live.details;
    const r = detectPriceChanges({ contractKey: sub.canonical_key, charges, notices: d.priceHistory ?? [] });
    const f = r.findings[r.findings.length - 1];
    const alt = (d.alternatives ?? [])[0];
    const protectedB: string[] = preference(env, "protected_benefits") ?? ["offline_playback"];
    const loses = alt && !alt.offlinePlayback ? ["Offline playback", ...(alt.ads ? ["Ad-free viewing"] : [])] : [];
    const blockedByProtection = loses.includes("Offline playback") && protectedB.includes("offline_playback");
    const busy = openActionFor(env, sub.id, "STOP_RENEWAL") || openActionFor(env, sub.id, "PAUSE");
    const next = forecastFor(env, sub.id)[0];
    const candidates: Candidate[] = alt
      ? [
          {
            key: "basic-plan",
            defaultSelected: false,
            available: !blockedByProtection && !busy,
            unavailableReason: blockedByProtection ? "You marked offline playback as must-keep" : busy ? "Another Streamly change is in progress" : undefined,
            spec: spec({
              operation: "CHANGE_PLAN",
              route: "PARTNER_API",
              capability: "A4",
              ...subjectFields(sub),
              params: { planId: alt.id },
              termsRevision: live.termsRevision,
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: alt.monthlyMinor, feesMinor: 0, forecastChangeMinor: next ? alt.monthlyMinor - live.priceMinor : 0 },
              consequences: { effectiveAt: live.nextChargeAt, accessUntil: null, lostBenefits: loses, dataEffect: null, remainingObligations: `${money(alt.monthlyMinor)}/month` },
              display: display(`Move Streamly to ${alt.name}`, `${money(live.priceMinor)} → ${money(alt.monthlyMinor)}/month from ${fmtDate(live.nextChargeAt)}.`, [
                { label: "From", value: `${live.planName} · ${money(live.priceMinor)}` },
                { label: "To", value: `${alt.name} · ${money(alt.monthlyMinor)}` },
                { label: "You lose", value: loses.join(", ") || "Nothing" },
              ], "Plan changes apply from the next renewal."),
            }),
          },
        ]
      : [];
    return {
      capability: "A4",
      title: "Streamly price",
      contextId: env.contextId,
      headline: f ? `Streamly went from ${money(f.fromMinor)} to ${money(f.toMinor)} (+${(f.changeBasisPoints / 100).toFixed(2)}%)` : "No price change found",
      summary: f?.notice ? `Streamly notified the change on ${fmtDate(f.notice.noticeDate)}: “${(f.notice as any).noticeText ?? ""}”` : "No merchant notice found for the change.",
      evidence: ["BANK_RECORD", "SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "timeline", title: "Dated evidence", items: [...charges.map((c) => ({ at: c.bookedAt, label: "Streamly charge (bank)", amount: money(-c.amountMinor) })), ...(d.priceHistory ?? []).filter((n: any) => n.noticeDate).map((n: any) => ({ at: n.noticeDate, label: `Price notice: terms revision ${n.termsRevision}` }))].sort((a, b) => a.at.localeCompare(b.at)) },
        { kind: "table", title: "Your options", columns: ["Option", "Per month", "Trade-off"], rows: [
          { cells: ["Keep Standard", money(live.priceMinor), "Nothing changes"] },
          ...(alt ? [{ cells: [alt.name, money(alt.monthlyMinor), loses.join(", ")], tone: blockedByProtection ? ("bad" as const) : undefined }] : []),
          { cells: ["Pause 1 month (A6)", money(0), "No access while paused; resumes automatically"] },
          { cells: ["Turn off renewal", money(0), "Access ends after the paid period"] },
        ] },
        ...(blockedByProtection ? [{ kind: "note" as const, tone: "warn" as const, text: "The cheaper plan removes offline playback, which you marked as must-keep." }] : []),
      ],
      inputs: [],
      candidates,
      numbers: { fromMinor: f?.fromMinor ?? 0, toMinor: f?.toMinor ?? 0, changeMinor: f?.changeMinor ?? 0, alternativeMinor: alt?.monthlyMinor ?? 0 },
      links: [{ label: "Pause instead", href: "/capabilities/A6" }],
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A5 */
const A5: CapabilityDef = {
  id: "A5",
  title: "Watch what you want, pay less",
  short: "Time CinemaMax around the shows you want",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["shows", "tv show", "series", "content", "cinemax", "schedule", "rotate", "watch"],
  async analyze(env) {
    const cat = fixture("demo/capability-scenarios.json").alex.contentCatalog;
    const wanted = [
      { titleId: "atlas-files", watchFrom: String(inputOr(env, "atlasFrom", "2026-11-20")), watchUntil: String(inputOr(env, "atlasUntil", "2026-12-10")) },
      { titleId: "code-and-chaos-s2", watchFrom: String(inputOr(env, "chaosFrom", "2027-01-08")), watchUntil: String(inputOr(env, "chaosUntil", "2027-02-05")) },
    ];
    const r = planContentSchedule({ wanted, titles: cat.titles, services: cat.services, alreadySubscribed: [] });
    const acct = merchantAccountId(env.tenantId, "cinemax", "cm-alex");
    const candidates: Candidate[] = r.periods
      .filter((p) => !p.alreadySubscribed)
      .map((p, i) => ({
        key: `start-${p.start}`,
        defaultSelected: true,
        available: Boolean(routeFor(env.db, env.tenantId, "cinemax")),
        spec: spec({
          operation: "SCHEDULE_START",
          route: "PARTNER_API",
          capability: "A5",
          merchantId: "cinemax",
          merchantName: "CinemaMax",
          subscriberAccountId: acct,
          subjectRef: `${env.tenantId}:content:cinemax:${p.start}`,
          params: { startDate: p.start, priceMinor: p.costMinor, titles: p.titles, catalogRevision: cat.revision },
          money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: p.costMinor, feesMinor: 0, forecastChangeMinor: p.costMinor },
          consequences: { effectiveAt: `${p.start}T00:00:00+02:00`, accessUntil: `${p.end}T23:59:59+02:00`, lostBenefits: [], dataEffect: null, remainingObligations: "One 30-day period; renewal off at sign-up" },
          display: display(`Start CinemaMax on ${fmtDate(p.start)}`, `${money(p.costMinor)} for 30 days (${p.start} – ${p.end}), renewal off.`, [
            { label: "Period", value: `${fmtDate(p.start)} – ${fmtDate(p.end)}` },
            { label: "Covers", value: p.titles.map((t: string) => cat.titles.find((x: any) => x.id === t)?.title ?? t).join(", ") },
            { label: "Charge", value: `${money(p.costMinor)} on ${fmtDate(p.start)}` },
            { label: "Renewal", value: "Off" },
            { label: "Catalog", value: `Revision ${cat.revision} (fictional)` },
          ], "Each period is its own commitment. Re-check the catalog before each start."),
        }),
        ...(i > 99 ? {} : {}),
      }));
    return {
      capability: "A5",
      title: "Content schedule",
      contextId: env.contextId,
      headline: `Rotating saves ${money(r.differenceMinor)}: ${money(r.rotationTotalMinor)} instead of ${money(r.continuousTotalMinor)}`,
      summary: "Two separate 30-day CinemaMax periods cover both shows; staying subscribed between them would cost more.",
      evidence: ["FICTIONAL_CATALOG", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Rotation", value: money(r.rotationTotalMinor), tone: "good" }, { label: "Continuous", value: money(r.continuousTotalMinor) }] },
        { kind: "timeline", title: "Plan", items: r.periods.map((p) => ({ at: `${p.start}T12:00:00+02:00`, label: `${p.serviceName}: ${p.titles.map((t: string) => cat.titles.find((x: any) => x.id === t)?.title ?? t).join(", ")} (until ${fmtDate(p.end)})`, amount: money(-p.costMinor) })) },
        ...r.issues.map((t: string) => ({ kind: "note" as const, tone: "warn" as const, text: t })),
        { kind: "note", tone: "info", text: r.assumptions.join(" ") },
      ],
      inputs: [
        { key: "atlasFrom", label: "The Atlas Files from", type: "text", value: wanted[0].watchFrom },
        { key: "atlasUntil", label: "until", type: "text", value: wanted[0].watchUntil },
        { key: "chaosFrom", label: "Code & Chaos S2 from", type: "text", value: wanted[1].watchFrom },
        { key: "chaosUntil", label: "until", type: "text", value: wanted[1].watchUntil },
      ],
      candidates,
      numbers: { rotationMinor: r.rotationTotalMinor, continuousMinor: r.continuousTotalMinor, differenceMinor: r.differenceMinor },
    };
  },
};

/* ------------------------------------------------------------------------------------------------ A6 */
const A6: CapabilityDef = {
  id: "A6",
  title: "Pause instead of paying",
  short: "Pause Streamly for a month",
  group: "Subscriptions",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["pause", "break", "skip a month", "streamly"],
  async analyze(env) {
    const sub = subscription(env, "streamly");
    const live = (await liveContract(env, sub)).contract;
    if (!live) return unavailable(env, "A6", "Streamly could not be read");
    const pause = (live.details as any).pause;
    // A pause length the provider does not offer falls back to one month instead of failing the analysis.
    const asked = inputInt(env, "months", 1, 1, 12);
    const months = pause.allowedMonths.includes(asked) ? asked : pause.allowedMonths.includes(1) ? 1 : pause.allowedMonths[0];
    const r = pauseEffect({ monthlyMinor: live.priceMinor, pauseStartsAt: pause.startsAt, months, allowedMonths: pause.allowedMonths, feeMinor: pause.feeMinor, window: SUBSCRIPTION_WINDOW });
    const already = (live.pending as any)?.pause;
    const busy = openActionFor(env, sub.id, "STOP_RENEWAL") || openActionFor(env, sub.id, "CHANGE_PLAN") || openActionFor(env, sub.id, "PAUSE");
    const candidates: Candidate[] = already
      ? []
      : [
          {
            key: "pause",
            defaultSelected: true,
            available: !busy && live.autoRenew,
            unavailableReason: busy ? "Another Streamly change is in progress" : !live.autoRenew ? "Renewal is off" : undefined,
            spec: spec({
              operation: "PAUSE",
              route: "PARTNER_API",
              capability: "A6",
              ...subjectFields(sub),
              params: { months },
              termsRevision: live.termsRevision,
              money: { currency: "RON", immediateDebitMinor: 0, maxDebitMinor: 0, feesMinor: r.feeMinor, forecastChangeMinor: -r.skippedInWindowMinor },
              consequences: { effectiveAt: pause.startsAt, accessUntil: r.accessEndsAt, lostBenefits: ["Streamly access while paused"], dataEffect: null, remainingObligations: `Resumes ${fmtWhen(r.resumesAt)} at ${money(r.resumePriceMinor)}/month` },
              display: display(`Pause Streamly for ${months} month${months > 1 ? "s" : ""}`, `Skip ${r.skippedCharges.length} charge${r.skippedCharges.length > 1 ? "s" : ""}; resumes ${fmtDate(r.resumesAt)}.`, [
                { label: "Pause starts", value: fmtWhen(pause.startsAt) },
                { label: "Access until", value: fmtWhen(r.accessEndsAt) },
                { label: "Resumes", value: `${fmtWhen(r.resumesAt)} at ${money(r.resumePriceMinor)}` },
                { label: "Skipped", value: money(r.totalSkippedMinor) },
                { label: "Fee", value: money(r.feeMinor) },
              ], r.note),
            }),
          },
        ];
    return {
      capability: "A6",
      title: "Pause Streamly",
      contextId: env.contextId,
      headline: already ? `Streamly is paused until ${fmtDate(already.resumesAt)}` : `A ${months}-month pause skips ${money(r.totalSkippedMinor)}`,
      summary: pause.rule,
      evidence: ["SIMULATED_MERCHANT_API", "DETERMINISTIC_CALCULATION"],
      blocks: [
        { kind: "metrics", items: [{ label: "Skipped", value: money(r.totalSkippedMinor), tone: "good" }, { label: "In this 30-day window", value: money(r.skippedInWindowMinor) }, { label: "Resumes", value: fmtDate(r.resumesAt) }] },
        { kind: "timeline", title: "Dates", items: [{ at: pause.startsAt, label: "Pause starts (access ends)" }, ...r.skippedCharges.map((s) => ({ at: s, label: "Charge skipped", amount: money(-live.priceMinor) })), { at: r.resumesAt, label: "Resumes automatically", amount: money(-r.resumePriceMinor) }] },
        { kind: "note", tone: "info", text: r.note },
      ],
      inputs: already ? [] : [{ key: "months", label: "Pause length", type: "select", value: String(months), options: pause.allowedMonths.map((m: number) => ({ value: String(m), label: `${m} month${m > 1 ? "s" : ""}` })) }],
      candidates,
      numbers: { skippedMinor: r.totalSkippedMinor, inWindowMinor: r.skippedInWindowMinor, resumePriceMinor: r.resumePriceMinor },
      done: already ? { label: `Paused until ${fmtDate(already.resumesAt)}`, href: lastReceipt(env, sub.id, "PAUSE") ? `/receipts/${lastReceipt(env, sub.id, "PAUSE").id}` : undefined } : null,
    };
  },
};

export function unavailable(env: CapEnv, id: string, why: string): Analysis {
  return { capability: id, title: id, contextId: env.contextId, headline: why, summary: "Try again in a moment.", evidence: [], blocks: [{ kind: "note", tone: "warn", text: why }], inputs: [], candidates: [], numbers: {} };
}

export const ALEX_SUBSCRIPTION_CAPS = [T2, T3, A1, A2, A3, A4, A5, A6];
export { formatMoney };
