import type { MerchantContractView } from "../../shared/merchant-contract";
import { inWindow } from "../../shared/time";

export interface AirbagForecastItem {
  id: string;
  subscription_id: string | null;
  amount_minor: number;
  due_at: string;
}

export type AirbagChange =
  | { operation: "STOP_RENEWAL"; subscriptionId: string }
  | { operation: "PAUSE"; subscriptionId: string; itemId: string; resumesAt: string };

/** Fail closed on essentials, storage/education dependencies and required playback benefits. */
export function airbagProtection(input: {
  category: string;
  merchantCategory?: string;
  localBenefits: Record<string, unknown>;
  contract: MerchantContractView | null;
  keepPlayback: boolean;
}): string | null {
  const c = input.contract;
  const category = `${input.category} ${input.merchantCategory ?? ""}`.replace(/[_-]/g, " ");
  if (/\b(rent|mortgage|loans?|utilities|utility|insurance|healthcare|health|medical|telecom|groceries|transport)\b/i.test(category)) {
    return "Protected essential bill or cover; Financial Airbag cannot stop it.";
  }
  if (/\b(storage|education|student|data)\b/i.test(category)) return "Protected data, storage or student tools; use a separate dependency review.";
  // Inspect both records: a live response must not silently erase a known storage/benefit dependency.
  const active = Object.entries(input.localBenefits).concat(Object.entries(c?.benefits ?? {})).filter(([, value]) => value !== false && value !== null && value !== undefined && value !== 0 && value !== "");
  if (active.some(([key, value]) => /storage|backup|study|education|student|insurance|medical|health|dataGb|hotspot|required|essential/i.test(key) || (key === "primary" && typeof value === "string" && /storage|backup|education|student|health|insurance/i.test(value)))) {
    return "Protected data, storage, student tools or required benefits; review dependencies separately.";
  }
  if (c?.protectedReason) return `Protected by provider: ${c.protectedReason}`;
  if (c && (c.ownerKind !== "SELF" || c.shared)) return "Shared or household-owned access needs a separate owner review.";
  if (input.keepPlayback && active.some(([key]) => key === "tvAccess" || key === "offlinePlayback")) return "TV and offline playback are protected by your choice below.";
  return null;
}

/** Project only dated bank records. Match the existing worker: pause moves its first item, renewal-off removes all. */
export function airbagProjection<T extends AirbagForecastItem>(items: T[], changes: AirbagChange[], window: { startInclusive: string; endExclusive: string }) {
  const beforeMinor = items.filter((i) => i.amount_minor < 0 && inWindow(i.due_at, window.startInclusive, window.endExclusive)).reduce((s, i) => s - i.amount_minor, 0);
  const rows = items.filter((i) => i.amount_minor < 0).map((item) => {
    const change = changes.find((c) => c.subscriptionId === item.subscription_id);
    const dueAfter = change?.operation === "STOP_RENEWAL" ? null : change?.operation === "PAUSE" && change.itemId === item.id ? change.resumesAt : item.due_at;
    const beforeMinor = inWindow(item.due_at, window.startInclusive, window.endExclusive) ? -item.amount_minor : 0;
    const afterMinor = dueAfter && inWindow(dueAfter, window.startInclusive, window.endExclusive) ? -item.amount_minor : 0;
    return { item, dueAfter, beforeMinor, afterMinor };
  });
  return { beforeMinor, afterMinor: rows.reduce((s, r) => s + r.afterMinor, 0), rows };
}
