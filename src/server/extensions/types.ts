import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../auth/session";
import type { ActionSpec } from "../authority/actions";
import type { CapabilityDef } from "../capabilities/core";

// Plug-in contract for the pure domain modules in extensions/src. Each wired module contributes capabilities
// (read + server-built candidates), its own ext_* tables (in extensions/schema/<module>.ts), bank-internal operations that run only after the
// dispatch gate, additive demo seed data and Labs simulations. Nothing here can create authority: candidates
// still become exact proposals, approvals still issue grants, and the worker still runs the final gate.

/** Extension operations are namespaced so they can never collide with, or fall through to, core handlers. */
export type ExtOperation = `EXT_${string}`;

export interface ExtActionContext {
  db: DatabaseSync;
  /** The proposal_actions row (tenant_id, context_id, logical_key, subject_ref, ...). */
  action: any;
  spec: ActionSpec;
  attemptId: string;
}

/**
 * Runs AFTER authorizeDispatch consumed the grant. Must settle the action exactly once with recordConfirmed or
 * recordSettled (inside tx), re-check every precondition against current bank state (fail closed), and scope
 * every read and write to action.tenant_id and action.context_id.
 */
/** Synchronous by contract: the registry runs it in one bank transaction, so a failure leaves nothing changed. */
export type ExtOperationHandler = (c: ExtActionContext) => void;

/**
 * A conditional, pre-approved action (an exit plan's stop) is held by its module before any attempt exists. The hook can
 * only defer the job or close the action unsent; dispatching still goes through the normal route and the final gate.
 */
export type ExtPreDispatch = { wait: string } | { settle: "NO_CHANGE" | "BLOCKED" | "REFUSED" | "TERMS_CHANGED" | "EXPIRED"; reason: string; detail?: Record<string, unknown> } | null;

export interface ExtLabsContext {
  db: DatabaseSync;
  session: Session;
  body: Record<string, unknown>;
}

/** A module API route, mounted at /api/ext/<module key><path>. Always authenticated; POST is CSRF-checked by the router. */
export interface ExtRoute {
  method: "GET" | "POST";
  /** e.g. "/certificates/:id"; params are decoded path segments. */
  path: string;
  fn: (c: { db: DatabaseSync; session: Session; params: Record<string, string>; url: URL; body: () => Promise<any> }) => unknown | Promise<unknown>;
}

export interface ExtensionModule {
  /** Short module key, used in /labs/ext and logs. */
  key: string;
  capabilities: CapabilityDef[];
  operations?: Record<ExtOperation, ExtOperationHandler>;
  /** Additive demo data. Runs inside the tenant seed transaction; must leave existing balances and numbers unchanged. */
  seed?: (db: DatabaseSync, input: { tenantId: string; customer: "alex" | "laziz"; contexts: string[] }) => void;
  /** Tenant reset: removes what the module keeps outside the database (keystore files). Runs before its ext_* rows are deleted. */
  reset?: (db: DatabaseSync, tenantId: string) => void;
  /** Synthetic events for demos and tests. Only reachable in Labs mode. */
  labs?: Record<string, (c: ExtLabsContext) => unknown | Promise<unknown>>;
  routes?: ExtRoute[];
  /** Return undefined for actions this module does not hold. */
  preDispatch?: (c: { db: DatabaseSync; action: any; spec: ActionSpec; grant: any }) => ExtPreDispatch | undefined | Promise<ExtPreDispatch | undefined>;
}

export function isExtOperation(op: string): op is ExtOperation {
  return /^EXT_[A-Z][A-Z0-9_]{1,40}$/.test(op);
}
