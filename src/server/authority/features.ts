import { config, type RunMode } from "../config";
import type { Route } from "./actions";

// Server-side feature availability. Checked by the approval route AND by the worker's dispatch gate.
// A badge, a disabled button or an IP-based rule is not an authorization boundary.

export type Feature = "execution.merchant" | "execution.bank_internal" | "preparation.local" | "monitoring" | "vision" | "desktop.computer";

const MATRIX: Record<Feature, Record<RunMode, boolean>> = {
  "execution.merchant": { labs: true, "bank-demo": false },
  "execution.bank_internal": { labs: true, "bank-demo": false },
  "preparation.local": { labs: true, "bank-demo": true },
  monitoring: { labs: true, "bank-demo": true },
  vision: { labs: true, "bank-demo": true },
  // Whole-desktop control is an optional future adapter; it is not implemented in this build.
  "desktop.computer": { labs: false, "bank-demo": false },
};

export function featureForRoute(route: Route): Feature {
  switch (route) {
    case "PARTNER_API":
    case "ISOLATED_BROWSER":
      return "execution.merchant";
    case "BANK_INTERNAL":
      return "execution.bank_internal";
    case "LOCAL_PREPARATION":
      return "preparation.local";
  }
}

export function featureAllowed(feature: Feature, mode: RunMode = config.mode): boolean {
  return MATRIX[feature][mode];
}

export function availabilityReport(mode: RunMode = config.mode) {
  return {
    mode,
    environment: mode === "labs" ? "Labs, synthetic resources only" : "Bank demo, actions are prepared but never executed",
    realOperations: "disabled: no real bank rails, merchants, credentials or payments exist in this build",
    features: Object.fromEntries(Object.entries(MATRIX).map(([k, v]) => [k, v[mode]])),
  };
}
