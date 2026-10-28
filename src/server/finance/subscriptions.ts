import { assertMinor, sumMinor } from "../../shared/money";
import { inWindow, toMs } from "../../shared/time";

// Subscription forecast and comparison (T2, T3, A1). One explicit end-exclusive window; every saving category
// stays separate: trial conversion avoided, paid-plan reduction (replacement / duplicate removal), conditional estimate.

export interface ForecastWindow {
  startInclusive: string;
  endExclusive: string;
}

export interface ForecastEntry {
  id: string;
  subscriptionId: string | null;
  label: string;
  kind: "RENEWAL" | "TRIAL_CONVERSION" | "BILL" | "NEW_CHARGE";
  amountMinor: number; // positive outflow amount
  dueAt: string;
}

export interface SubscriptionFacts {
  id: string;
  merchantName: string;
  state: "ACTIVE" | "TRIAL" | "RENEWAL_OFF" | "PAUSED" | "CANCELLED";
  amountMinor: number;
  storageGb?: number;
  offlinePlayback?: boolean;
  tvAccess?: boolean;
  /** The service's main purpose. Only a plan whose primary benefit is storage is a duplicate-removal candidate. */
  primaryBenefit?: string;
}

export interface BundleOffer {
  id: string;
  name: string;
  monthlyMinor: number;
  replaces: string[];
  includesCloudStorageGb: number;
  offlinePlayback: boolean;
  studentStatusRequired: boolean;
  termRevision: number;
  firstChargeAt: string;
  priceValidUntil: string;
  postPromotionMonthlyMinor: number;
  activationFeeMinor: number;
}

export type ConditionState = "met" | "unmet" | "unknown";

export interface OptionCondition {
  key: string;
  label: string;
  state: ConditionState;
  detail?: string;
}

export interface ComparisonOption {
  id: "stop-trial" | "switch-bundle" | "remove-duplicate-storage";
  kind: "TRIAL_CHARGE_AVOIDED" | "PAID_PLAN_REDUCTION";
  title: string;
  subjectIds: string[];
  reductionMinor: number;
  removes: string[]; // forecast entry ids removed
  adds: ForecastEntry[];
  conditions: OptionCondition[];
  status: "AVAILABLE" | "CONDITIONAL" | "INCOMPATIBLE" | "NOT_APPLICABLE";
  dependsOn: string[];
}

export interface ComparisonInput {
  window: ForecastWindow;
  entries: ForecastEntry[]; // scheduled outflows (already reflecting confirmed changes)
  subscriptions: SubscriptionFacts[];
  offer: BundleOffer | null;
  protectedBenefits: string[]; // e.g. ["offline_playback"]
  studentStatus: "verified" | "unverified" | "unknown";
  storageUsedGb: number | null;
  migration: { from: string; to: string | null; state: "NOT_STARTED" | "IN_PROGRESS" | "VERIFIED" } | null;
  replacementStorageActive: boolean;
}

export interface ComparisonResult {
  window: ForecastWindow;
  baselineMinor: number;
  baselineEntries: ForecastEntry[];
  options: ComparisonOption[];
  potentialMinor: number;
  optimizedMinor: number;
  paidPlanReductionMinor: number;
  trialAvoidedMinor: number;
  compatibleOnly: { potentialMinor: number; optimizedMinor: number };
  checks: string[];
}

export function windowEntries(window: ForecastWindow, entries: ForecastEntry[]): ForecastEntry[] {
  return entries.filter((e) => inWindow(e.dueAt, window.startInclusive, window.endExclusive)).sort((a, b) => toMs(a.dueAt) - toMs(b.dueAt));
}

export function windowTotal(window: ForecastWindow, entries: ForecastEntry[]): number {
  return sumMinor(windowEntries(window, entries).map((e) => assertMinor(e.amountMinor)));
}

export function compareSubscriptions(input: ComparisonInput): ComparisonResult {
  const inWin = windowEntries(input.window, input.entries);
  const baseline = sumMinor(inWin.map((e) => e.amountMinor));
  const subs = new Map(input.subscriptions.map((s) => [s.id, s]));
  const options: ComparisonOption[] = [];
  const checks: string[] = [];

  // 1. Trial conversions inside the window that are still scheduled.
  const trials = inWin.filter((e) => e.kind === "TRIAL_CONVERSION" && subs.get(e.subscriptionId ?? "")?.state === "TRIAL");
  for (const t of trials) {
    options.push({
      id: "stop-trial",
      kind: "TRIAL_CHARGE_AVOIDED",
      title: `Stop the ${subs.get(t.subscriptionId!)!.merchantName} renewal`,
      subjectIds: [t.subscriptionId!],
      reductionMinor: t.amountMinor,
      removes: [t.id],
      adds: [],
      conditions: [
        { key: "before_conversion", label: `Merchant confirms renewal-off before ${t.dueAt}`, state: "unknown" },
      ],
      status: "AVAILABLE",
      dependsOn: [],
    });
  }

  // 2. Bundle replacement: replaced renewals in the window minus the offer's charges in the window.
  if (input.offer) {
    const offer = input.offer;
    const replaced = inWin.filter((e) => e.kind === "RENEWAL" && offer.replaces.includes(e.subscriptionId ?? ""));
    const activeReplaced = offer.replaces.every((id) => {
      const s = subs.get(id);
      return s && (s.state === "ACTIVE" || s.state === "TRIAL");
    });
    if (replaced.length && activeReplaced) {
      const offerCharge: ForecastEntry = {
        id: `offer:${offer.id}:${offer.firstChargeAt}`,
        subscriptionId: null,
        label: `${offer.name} first charge`,
        kind: "NEW_CHARGE",
        amountMinor: offer.monthlyMinor + offer.activationFeeMinor,
        dueAt: offer.firstChargeAt,
      };
      const adds = inWindow(offerCharge.dueAt, input.window.startInclusive, input.window.endExclusive) ? [offerCharge] : [];
      const replacedTotal = sumMinor(replaced.map((e) => e.amountMinor));
      const addTotal = sumMinor(adds.map((e) => e.amountMinor));
      const earliestReplaced = Math.min(...replaced.map((e) => toMs(e.dueAt)));
      const activationBeforeRenewals = toMs(offer.firstChargeAt) <= earliestReplaced;
      const conditions: OptionCondition[] = [];
      if (offer.studentStatusRequired) {
        conditions.push({
          key: "student_eligibility",
          label: "Student status verified by the merchant",
          state: input.studentStatus === "verified" ? "met" : "unknown",
          detail: input.studentStatus === "verified" ? "Verified" : "Student status is not verified",
        });
      }
      for (const benefit of input.protectedBenefits) {
        const kept = benefit === "offline_playback" ? offer.offlinePlayback : true;
        conditions.push({
          key: `${benefit}_retained`,
          label: benefit === "offline_playback" ? "Keeps offline playback" : `Keeps ${benefit}`,
          state: kept ? "met" : "unmet",
          detail: kept ? `Included in terms revision ${offer.termRevision}` : `Not included in terms revision ${offer.termRevision}`,
        });
      }
      conditions.push({
        key: "replacement_dates_align",
        label: "Bundle starts before the old renewals, with no overlap charge",
        state: activationBeforeRenewals ? "met" : "unmet",
      });
      const incompatible = conditions.some((c) => c.state === "unmet");
      const conditional = conditions.some((c) => c.state === "unknown");
      options.push({
        id: "switch-bundle",
        kind: "PAID_PLAN_REDUCTION",
        title: `One ${offer.name.toLowerCase()}`,
        subjectIds: [...offer.replaces],
        reductionMinor: replacedTotal - addTotal,
        removes: replaced.map((e) => e.id),
        adds,
        conditions,
        status: incompatible ? "INCOMPATIBLE" : conditional ? "CONDITIONAL" : "AVAILABLE",
        dependsOn: [],
      });
    }
  }

  // 3. Duplicate storage: a paid storage plan whose capacity is covered by storage that remains after the plan.
  const storagePlans = input.subscriptions.filter(
    (s) => s.primaryBenefit === "cloud_storage" && (s.storageGb ?? 0) > 0 && s.state === "ACTIVE" && !(input.offer?.replaces ?? []).includes(s.id),
  );
  const bundleOption = options.find((o) => o.id === "switch-bundle");
  for (const plan of storagePlans) {
    const providers: { id: string; gb: number; viaBundle: boolean }[] = [];
    for (const s of input.subscriptions) {
      if (s.id !== plan.id && (s.storageGb ?? 0) > 0 && s.state === "ACTIVE") providers.push({ id: s.id, gb: s.storageGb!, viaBundle: false });
    }
    if (input.offer && input.offer.includesCloudStorageGb > 0) providers.push({ id: input.offer.id, gb: input.offer.includesCloudStorageGb, viaBundle: true });
    if (providers.length === 0) continue;
    // A storage provider that the plan replaces (e.g. StudyPlus inside the bundle) cannot be relied on after the switch;
    // when the bundle is part of the plan, the remaining storage is the bundle's.
    const relyOnBundle = Boolean(bundleOption && input.offer && input.offer.includesCloudStorageGb > 0);
    const target = relyOnBundle ? providers.find((p) => p.viaBundle)! : providers.find((p) => !p.viaBundle) ?? providers[0];
    const renewals = inWin.filter((e) => e.subscriptionId === plan.id && e.kind === "RENEWAL");
    if (!renewals.length) continue;
    const capacityOk = input.storageUsedGb == null ? "unknown" : input.storageUsedGb <= target.gb ? "met" : "unmet";
    const conditions: OptionCondition[] = [
      {
        key: "replacement_active",
        label: `${relyOnBundle ? input.offer!.name : subs.get(target.id)?.merchantName ?? target.id} storage is active`,
        state: relyOnBundle ? (input.replacementStorageActive ? "met" : "unknown") : "met",
      },
      {
        key: "capacity",
        label: `Enough space: ${input.storageUsedGb ?? "unknown"} GB used, ${target.gb} GB available`,
        state: capacityOk,
      },
      {
        key: "data_migrated",
        label: "Files copied and checked before cancelling",
        state: input.migration?.state === "VERIFIED" ? "met" : "unknown",
        detail: input.migration ? `Migration ${input.migration.state.toLowerCase().replace("_", " ")}` : "Migration not started",
      },
    ];
    const blockedByBundle = relyOnBundle && bundleOption!.status === "INCOMPATIBLE";
    if (blockedByBundle) conditions.push({ key: "bundle_dependency", label: "Depends on the bundle, which no longer fits", state: "unmet" });
    options.push({
      id: "remove-duplicate-storage",
      kind: "PAID_PLAN_REDUCTION",
      title: `Check duplicate cloud storage`,
      subjectIds: [plan.id],
      reductionMinor: sumMinor(renewals.map((e) => e.amountMinor)),
      removes: renewals.map((e) => e.id),
      adds: [],
      conditions,
      status: conditions.some((c) => c.state === "unmet") ? "INCOMPATIBLE" : conditions.some((c) => c.state === "unknown") ? "CONDITIONAL" : "AVAILABLE",
      dependsOn: relyOnBundle ? ["switch-bundle"] : [],
    });
    checks.push(`Storage overlap for ${plan.merchantName} counted once across ${providers.length} overlapping provider(s).`);
  }

  const apply = (opts: ComparisonOption[]) => {
    const removed = new Set(opts.flatMap((o) => o.removes));
    const remaining = inWin.filter((e) => !removed.has(e.id));
    const added = opts.flatMap((o) => o.adds);
    return sumMinor([...remaining, ...added].map((e) => e.amountMinor));
  };

  const optimized = apply(options);
  const potential = baseline - optimized;
  const sumReductions = sumMinor(options.map((o) => o.reductionMinor));
  if (sumReductions !== potential) throw new Error(`Savings double counted: ${sumReductions} vs ${potential}`);
  checks.push("Potential reduction equals the item-level forecast difference (no double counting).");

  const compatible = options.filter((o) => o.status !== "INCOMPATIBLE");
  const compatibleOptimized = apply(compatible);

  return {
    window: input.window,
    baselineMinor: baseline,
    baselineEntries: inWin,
    options,
    potentialMinor: potential,
    optimizedMinor: optimized,
    paidPlanReductionMinor: sumMinor(options.filter((o) => o.kind === "PAID_PLAN_REDUCTION").map((o) => o.reductionMinor)),
    trialAvoidedMinor: sumMinor(options.filter((o) => o.kind === "TRIAL_CHARGE_AVOIDED").map((o) => o.reductionMinor)),
    compatibleOnly: { potentialMinor: baseline - compatibleOptimized, optimizedMinor: compatibleOptimized },
    checks,
  };
}
