import type { DatabaseSync } from "node:sqlite";
import { all, json, one, run, tx, ConflictError } from "../db/connection";
import { canonicalJson, digestOf, opaqueId, sha256Hex, shortId } from "../canonical";
import { nowIso, nowMs } from "../clock";
import { toLocalIso, toMs } from "../../shared/time";
import { featureAllowed, featureForRoute } from "./features";
import type { ActionSpec } from "./actions";
import { HttpError, type Session } from "../auth/session";

// Proposals freeze an immutable manifest; approval creates one mandate per proposal revision and one opaque
// grant per exact action. Grants are consumed only by the dispatch gate, under the current fence and epoch.

export const SINGLE_APPROVAL_MINUTES = 10;
export const BATCH_START_MINUTES = 60;
export const PROPOSAL_READY_MINUTES = 30;

export interface ProposalActionInput {
  key: string; // candidate key, unique inside the proposal
  spec: ActionSpec;
}

export function logicalKeyFor(tenantId: string, spec: ActionSpec): string {
  return sha256Hex(canonicalJson({ tenantId, op: spec.operation, key: spec.canonicalKey ?? spec.subjectRef, params: spec.params }));
}

export function createProposal(
  db: DatabaseSync,
  input: { tenantId: string; contextId: string; actorUserId: string; taskId?: string | null; batchId?: string | null; scope: "SINGLE" | "BATCH"; actions: ProposalActionInput[]; inputRevision?: number },
) {
  return tx(db, () => {
    const id = shortId("prop");
    const prior = input.taskId ? one<any>(db, "SELECT MAX(revision) r FROM proposals WHERE task_id=?", input.taskId) : null;
    const revision = (prior?.r ?? 0) + 1;
    const createdAt = nowIso(db, input.tenantId);
    const readyExpires = toLocalIso(nowMs(db, input.tenantId) + PROPOSAL_READY_MINUTES * 60_000);
    const actionIds = input.actions.map(() => shortId("pa"));
    const keyToId = new Map(input.actions.map((a, i) => [a.key, actionIds[i]]));
    const actions = input.actions.map((a, i) => {
      const spec = { ...a.spec, dependsOn: a.spec.dependsOn.map((k) => keyToId.get(k) ?? k) };
      return { actionId: actionIds[i], key: a.key, specDigest: digestOf(spec), spec };
    });
    const manifest = {
      kind: "nextmove.proposal.v1",
      proposalId: id,
      revision,
      tenantId: input.tenantId,
      contextId: input.contextId,
      actorUserId: input.actorUserId,
      taskId: input.taskId ?? null,
      batchId: input.batchId ?? null,
      scope: input.scope,
      inputRevision: input.inputRevision ?? 1,
      createdAt,
      approvalWindowMinutes: input.scope === "BATCH" ? BATCH_START_MINUTES : SINGLE_APPROVAL_MINUTES,
      maxExtraFeeMinor: 0,
      mayAddItems: false,
      actions,
    };
    const digest = digestOf(manifest);
    run(
      db,
      "INSERT INTO proposals(id, tenant_id, context_id, task_id, batch_id, revision, status, scope, manifest_json, digest, created_at, ready_expires_at) VALUES (?,?,?,?,?,?, 'READY', ?,?,?,?,?)",
      id,
      input.tenantId,
      input.contextId,
      input.taskId ?? null,
      input.batchId ?? null,
      revision,
      input.scope,
      canonicalJson(manifest),
      digest,
      createdAt,
      input.scope === "BATCH" ? toLocalIso(nowMs(db, input.tenantId) + 24 * 3_600_000) : readyExpires,
    );
    actions.forEach((a, i) => {
      run(
        db,
        `INSERT INTO proposal_actions(id, proposal_id, tenant_id, context_id, ordinal, operation, route, merchant_id, canonical_key, logical_key, subject_ref, spec_json, spec_digest, terms_revision, status, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PROPOSED', ?)`,
        a.actionId,
        id,
        input.tenantId,
        input.contextId,
        i,
        a.spec.operation,
        a.spec.route,
        a.spec.merchantId,
        a.spec.canonicalKey,
        logicalKeyFor(input.tenantId, a.spec),
        a.spec.subjectRef,
        canonicalJson(a.spec),
        a.specDigest,
        a.spec.termsRevision,
        createdAt,
      );
    });
    return { id, revision, digest, manifest };
  });
}

export function loadProposal(db: DatabaseSync, proposalId: string) {
  const p = one<any>(db, "SELECT * FROM proposals WHERE id=?", proposalId);
  if (!p) return null;
  const actions = all<any>(db, "SELECT * FROM proposal_actions WHERE proposal_id=? ORDER BY ordinal", proposalId).map((a) => ({ ...a, spec: json<ActionSpec>(a.spec_json) }));
  return { ...p, manifest: json(p.manifest_json), actions };
}

/** Fetch the bank's latest observed terms revision for an action's subject, used to fail closed on changes. */
export type CurrentRevisionLookup = (spec: ActionSpec) => number | null;

const ACTIVE_ATTEMPT = "('DISPATCH_AUTHORIZED','SENT','CONFIRMED','PENDING','UNKNOWN')";

export interface ApprovalResult {
  mandateId: string;
  grants: { actionId: string; grantId: string; expiresAt: string }[];
  alreadyApproved: boolean;
}

export function approveProposal(
  db: DatabaseSync,
  session: Session,
  input: { proposalId: string; digest: string; actionIds: string[] },
  currentRevision: CurrentRevisionLookup,
): ApprovalResult {
  // A refusal that demotes the proposal (expired, terms changed) is returned rather than thrown inside the
  // transaction, so the demotion commits; the error is raised after the commit.
  const r = tx(db, (): ApprovalResult | { refused: HttpError } => {
    const p = one<any>(db, "SELECT * FROM proposals WHERE id=?", input.proposalId);
    if (!p || p.tenant_id !== session.tenantId) throw new HttpError(404, "NOT_FOUND", "Not found");
    const ctx = one<any>(db, "SELECT user_id FROM contexts WHERE id=? AND tenant_id=?", p.context_id, session.tenantId);
    if (!ctx || ctx.user_id !== session.userId) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (p.context_id !== session.contextId) throw new HttpError(409, "WRONG_CONTEXT", "This proposal belongs to another context. Switch context before approving.");
    // The displayed digest must match the stored immutable manifest, which must match its own digest.
    if (typeof input.digest !== "string" || input.digest !== p.digest) throw new HttpError(409, "DIGEST_MISMATCH", "The approval does not match the displayed proposal.");
    if (digestOf(JSON.parse(p.manifest_json)) !== p.digest) throw new HttpError(409, "MANIFEST_TAMPERED", "Proposal integrity check failed.");

    const existing = one<any>(db, "SELECT * FROM mandates WHERE proposal_id=?", p.id);
    if (p.status === "APPROVED" && existing) {
      const grants = all<any>(db, "SELECT action_id, id, expires_at FROM grants WHERE mandate_id=?", existing.id);
      const requested = new Set(input.actionIds);
      const granted = new Set(grants.map((g) => g.action_id));
      if (requested.size !== granted.size || [...requested].some((a) => !granted.has(a))) throw new HttpError(409, "ALREADY_DECIDED", "This proposal was already approved with a different selection.");
      return { mandateId: existing.id, grants: grants.map((g) => ({ actionId: g.action_id, grantId: g.id, expiresAt: g.expires_at })), alreadyApproved: true };
    }
    if (p.status !== "READY") throw new HttpError(409, p.status === "OUTDATED" ? "TERMS_CHANGED" : "NOT_READY", p.status === "OUTDATED" ? `This plan needs a fresh check: ${p.outdated_reason ?? "terms changed"}` : `Proposal is ${p.status.toLowerCase()}`);
    const now = nowMs(db, session.tenantId);
    if (now > toMs(p.ready_expires_at)) {
      run(db, "UPDATE proposals SET status='EXPIRED', decided_at=? WHERE id=?", nowIso(db, session.tenantId), p.id);
      return { refused: new HttpError(409, "PROPOSAL_EXPIRED", "This plan needs a fresh check: the proposal expired.") };
    }
    const actions = all<any>(db, "SELECT * FROM proposal_actions WHERE proposal_id=? ORDER BY ordinal", p.id);
    // Grants are issued from the action rows, so each row must be exactly the action frozen in the digested manifest.
    const frozen = new Map<string, string>(json<any>(p.manifest_json, {}).actions?.map((m: any) => [m.actionId, m.specDigest]) ?? []);
    if (frozen.size !== actions.length || actions.some((a) => frozen.get(a.id) !== a.spec_digest || digestOf(json(a.spec_json)) !== a.spec_digest)) throw new HttpError(409, "MANIFEST_TAMPERED", "Proposal integrity check failed.");
    const selected = actions.filter((a) => input.actionIds.includes(a.id));
    if (!Array.isArray(input.actionIds) || selected.length === 0 || selected.length !== new Set(input.actionIds).size) throw new HttpError(400, "BAD_SELECTION", "Select at least one action from this proposal.");
    for (const a of selected) {
      const spec = json<ActionSpec>(a.spec_json);
      if (!featureAllowed(featureForRoute(spec.route))) throw new HttpError(403, "FEATURE_DISABLED", "Execution is disabled in this environment (real-operation-disabled bank demo).");
      for (const dep of spec.dependsOn) {
        const depRow = actions.find((x) => x.id === dep);
        if (depRow && !input.actionIds.includes(dep) && !["CONFIRMED", "PREPARED"].includes(depRow.status)) {
          throw new HttpError(409, "DEPENDENCY", `“${spec.display.title}” depends on another action that is not selected.`);
        }
      }
      const current = currentRevision(spec);
      if (spec.termsRevision != null && current != null && current !== spec.termsRevision) {
        run(db, "UPDATE proposals SET status='OUTDATED', outdated_reason=? WHERE id=?", `terms changed from revision ${spec.termsRevision} to ${current}`, p.id);
        run(db, "UPDATE proposal_actions SET status='OUTDATED', updated_at=? WHERE proposal_id=? AND status='PROPOSED'", nowIso(db, session.tenantId), p.id);
        return { refused: new HttpError(409, "TERMS_CHANGED", `This plan needs a fresh check: terms changed from revision ${spec.termsRevision} to ${current}.`) };
      }
      const inFlight = one<any>(db, `SELECT id, status FROM attempts WHERE tenant_id=? AND logical_key=? AND status IN ${ACTIVE_ATTEMPT}`, session.tenantId, a.logical_key);
      if (inFlight) throw new HttpError(409, "ALREADY_IN_PROGRESS", `This action was already started (${inFlight.status.toLowerCase()}). Check its status instead of repeating it.`);
    }
    const mandateId = opaqueId("mdt");
    const minutes = p.scope === "BATCH" ? BATCH_START_MINUTES : SINGLE_APPROVAL_MINUTES;
    const startExpires = toLocalIso(now + minutes * 60_000);
    const issuedAt = nowIso(db, session.tenantId);
    run(db, "INSERT INTO mandates(id, tenant_id, context_id, actor_user_id, proposal_id, scope, status, revocation_epoch, created_at, start_expires_at) VALUES (?,?,?,?,?,?, 'ACTIVE', 0, ?, ?)", mandateId, session.tenantId, p.context_id, session.userId, p.id, p.scope, issuedAt, startExpires);
    const grants: ApprovalResult["grants"] = [];
    for (const a of selected) {
      const spec = json<ActionSpec>(a.spec_json);
      const grantId = opaqueId("grt");
      const grantExpires = scheduledGrantExpiry(spec, now) ?? startExpires;
      run(
        db,
        `INSERT INTO grants(id, mandate_id, action_id, tenant_id, context_id, actor_user_id, operation, canonical_key, spec_digest, terms_revision, max_debit_minor, currency, status, epoch_at_issue, issued_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'RON', 'ACTIVE', 0, ?, ?)`,
        grantId, mandateId, a.id, session.tenantId, p.context_id, session.userId, a.operation, a.canonical_key, a.spec_digest, a.terms_revision, spec.money.maxDebitMinor, issuedAt, grantExpires,
      );
      run(db, "UPDATE proposal_actions SET status='APPROVED', updated_at=? WHERE id=?", issuedAt, a.id);
      const jobId = shortId("job");
      run(
        db,
        `INSERT INTO jobs(id, tenant_id, kind, ref_id, route, status, priority, available_at, fence, attempts, concurrency_key, user_key, created_at, updated_at)
         VALUES (?,?, 'ACTION', ?, ?, 'QUEUED', ?, ?, 0, 0, ?, ?, ?, ?)`,
        jobId, session.tenantId, a.id, a.route, p.scope === "BATCH" ? 6 : 3, new Date().toISOString(), spec.merchantId && spec.subscriberAccountId ? `${spec.merchantId}|${spec.subscriberAccountId}` : a.subject_ref, `${session.tenantId}|${session.userId}`, new Date().toISOString(), new Date().toISOString(),
      );
      run(db, "INSERT INTO outbox(tenant_id, topic, ref_id, created_at) VALUES (?, 'action.approved', ?, ?)", session.tenantId, a.id, new Date().toISOString());
      grants.push({ actionId: a.id, grantId, expiresAt: grantExpires });
    }
    for (const a of actions) if (!input.actionIds.includes(a.id) && a.status === "PROPOSED") run(db, "UPDATE proposal_actions SET status='NOT_STARTED', updated_at=? WHERE id=?", issuedAt, a.id);
    run(db, "UPDATE proposals SET status='APPROVED', decided_at=? WHERE id=?", issuedAt, p.id);
    return { mandateId, grants, alreadyApproved: false };
  });
  if ("refused" in r) throw r.refused;
  return r;
}

/**
 * A bank-internal leg approved for a later date (a scheduled return from a pocket) keeps its grant until a bounded
 * window after that date. The date is part of the digested spec, so it cannot move without a new approval.
 */
export const SCHEDULED_GRANT_GRACE_DAYS = 14;
function scheduledGrantExpiry(spec: ActionSpec, nowMs_: number): string | null {
  // An exit plan's conditional stop is useless after the provider's cancel deadline, so its grant ends exactly there.
  const exitDeadline = spec.capability === "E2" && spec.operation === "STOP_RENEWAL" ? (spec.params as any)?.exitPlan?.terms?.cancelDeadline : null;
  if (typeof exitDeadline === "string" && Number.isFinite(Date.parse(exitDeadline))) return toLocalIso(Math.max(nowMs_, Date.parse(exitDeadline)));
  const at = spec.route === "BANK_INTERNAL" && spec.operation === "INTERNAL_TRANSFER" ? (spec.params as any)?.executeAt : null;
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return toLocalIso(Math.max(nowMs_, ms) + SCHEDULED_GRANT_GRACE_DAYS * 86_400_000);
}

export function declineProposal(db: DatabaseSync, session: Session, proposalId: string) {
  return tx(db, () => {
    const p = one<any>(db, "SELECT * FROM proposals WHERE id=?", proposalId);
    if (!p || p.tenant_id !== session.tenantId) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (p.context_id !== session.contextId) throw new HttpError(409, "WRONG_CONTEXT", "This proposal belongs to another context.");
    if (p.status === "DECLINED") return { declined: true, already: true };
    if (p.status !== "READY") throw new HttpError(409, "NOT_READY", `Proposal is ${p.status.toLowerCase()}`);
    const at = nowIso(db, session.tenantId);
    run(db, "UPDATE proposals SET status='DECLINED', decided_at=? WHERE id=?", at, proposalId);
    run(db, "UPDATE proposal_actions SET status='NOT_STARTED', updated_at=? WHERE proposal_id=?", at, proposalId);
    return { declined: true, already: false };
  });
}

/**
 * Stop new actions for a mandate. Increments the revocation epoch and revokes unconsumed grants in the same
 * transaction as the dispatch gate's writes are serialized, so either revocation or dispatch authorization wins.
 */
export function revokeMandate(db: DatabaseSync, tenantId: string, mandateId: string, by: string) {
  return tx(db, () => {
    const m = one<any>(db, "SELECT * FROM mandates WHERE id=? AND tenant_id=?", mandateId, tenantId);
    if (!m) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (m.status !== "ACTIVE") return { revoked: 0, alreadyStarted: countStarted(db, mandateId), status: m.status };
    const at = nowIso(db, tenantId);
    run(db, "UPDATE mandates SET status='REVOKED', revocation_epoch=revocation_epoch+1, revoked_at=? WHERE id=?", at, mandateId);
    const pending = all<any>(db, "SELECT id, action_id FROM grants WHERE mandate_id=? AND status='ACTIVE'", mandateId);
    for (const g of pending) {
      run(db, "UPDATE grants SET status='REVOKED', invalid_reason=? WHERE id=?", `stopped by ${by}`, g.id);
      run(db, "UPDATE proposal_actions SET status='REVOKED', updated_at=? WHERE id=? AND status IN ('APPROVED')", at, g.action_id);
      run(db, "UPDATE jobs SET status='DONE', last_error='REVOKED', updated_at=? WHERE kind='ACTION' AND ref_id=? AND status IN ('QUEUED')", new Date().toISOString(), g.action_id);
    }
    return { revoked: pending.length, alreadyStarted: countStarted(db, mandateId), status: "REVOKED" };
  });
}

function countStarted(db: DatabaseSync, mandateId: string) {
  return one<any>(db, "SELECT COUNT(*) n FROM grants WHERE mandate_id=? AND status='CONSUMED'", mandateId)?.n ?? 0;
}

/** Changed terms invalidate unexecuted proposals and unconsumed grants for the affected subject only. */
export function invalidateForSubject(db: DatabaseSync, tenantId: string, match: { canonicalKey?: string; offerId?: string; subjectRef?: string }, reason: string) {
  return tx(db, () => {
    const at = nowIso(db, tenantId);
    const rows = all<any>(db, "SELECT pa.*, p.status AS pstatus FROM proposal_actions pa JOIN proposals p ON p.id = pa.proposal_id WHERE pa.tenant_id=? AND pa.status IN ('PROPOSED','APPROVED')", tenantId);
    const affected = rows.filter((r) => {
      const spec = json<ActionSpec>(r.spec_json);
      return (match.canonicalKey && r.canonical_key === match.canonicalKey) || (match.subjectRef && r.subject_ref === match.subjectRef) || (match.offerId && spec.params?.offerId === match.offerId);
    });
    const proposals = new Set<string>();
    let grantsInvalidated = 0;
    for (const a of affected) {
      proposals.add(a.proposal_id);
      run(db, "UPDATE proposal_actions SET status='OUTDATED', updated_at=? WHERE id=?", at, a.id);
      const g = one<any>(db, "SELECT id FROM grants WHERE action_id=? AND status='ACTIVE'", a.id);
      if (g) {
        run(db, "UPDATE grants SET status='INVALIDATED', invalid_reason=? WHERE id=?", reason, g.id);
        run(db, "UPDATE jobs SET status='DONE', last_error='TERMS_CHANGED', updated_at=? WHERE kind='ACTION' AND ref_id=? AND status='QUEUED'", new Date().toISOString(), a.id);
        grantsInvalidated++;
      }
    }
    for (const pid of proposals) {
      // Dependent actions in the same proposal cannot proceed either.
      for (const d of all<any>(db, "SELECT * FROM proposal_actions WHERE proposal_id=? AND status IN ('PROPOSED','APPROVED')", pid)) {
        const spec = json<ActionSpec>(d.spec_json);
        if (spec.dependsOn.some((dep) => affected.some((x) => x.id === dep))) {
          run(db, "UPDATE proposal_actions SET status='OUTDATED', updated_at=? WHERE id=?", at, d.id);
          const g = one<any>(db, "SELECT id FROM grants WHERE action_id=? AND status='ACTIVE'", d.id);
          if (g) {
            run(db, "UPDATE grants SET status='INVALIDATED', invalid_reason=? WHERE id=?", `depends on changed terms: ${reason}`, g.id);
            run(db, "UPDATE jobs SET status='DONE', last_error='TERMS_CHANGED', updated_at=? WHERE kind='ACTION' AND ref_id=? AND status='QUEUED'", new Date().toISOString(), d.id);
            grantsInvalidated++;
          }
        }
      }
      run(db, "UPDATE proposals SET status='OUTDATED', outdated_reason=? WHERE id=? AND status IN ('READY','APPROVED')", reason, pid);
    }
    return { proposals: [...proposals], grantsInvalidated };
  });
}

export type GateDenial = "LEASE_LOST" | "GRANT_NOT_ACTIVE" | "GRANT_EXPIRED" | "MANDATE_REVOKED" | "EPOCH_CHANGED" | "FEATURE_DISABLED" | "DIGEST_MISMATCH" | "ALREADY_EXECUTED";

/**
 * The final local write gate. Persists the dispatch authorization (and consumes the grant) only when the worker
 * still holds the current fence and the grant is active, unexpired and issued under the mandate's current epoch.
 */
export function authorizeDispatch(db: DatabaseSync, input: { tenantId: string; attemptId: string; jobId: string; fence: number; workerId: string }): { ok: true } | { ok: false; reason: GateDenial } {
  return tx(db, () => {
    const job = one<any>(db, "SELECT * FROM jobs WHERE id=?", input.jobId);
    if (!job || job.lease_owner !== input.workerId || job.fence !== input.fence || !job.lease_expires_at || Date.parse(job.lease_expires_at) < Date.now()) return { ok: false, reason: "LEASE_LOST" };
    const attempt = one<any>(db, "SELECT * FROM attempts WHERE id=?", input.attemptId);
    if (!attempt || attempt.fence !== input.fence || attempt.status !== "CLAIMED") return { ok: false, reason: "LEASE_LOST" };
    const grant = one<any>(db, "SELECT * FROM grants WHERE id=?", attempt.grant_id);
    if (!grant) return { ok: false, reason: "GRANT_NOT_ACTIVE" };
    const mandate = one<any>(db, "SELECT * FROM mandates WHERE id=?", grant.mandate_id);
    if (!mandate || mandate.status === "REVOKED") return { ok: false, reason: "MANDATE_REVOKED" };
    if (grant.status !== "ACTIVE") return { ok: false, reason: grant.status === "REVOKED" ? "MANDATE_REVOKED" : "GRANT_NOT_ACTIVE" };
    if (mandate.revocation_epoch !== grant.epoch_at_issue) return { ok: false, reason: "EPOCH_CHANGED" };
    if (nowMs(db, input.tenantId) > toMs(grant.expires_at)) {
      run(db, "UPDATE grants SET status='EXPIRED' WHERE id=?", grant.id);
      return { ok: false, reason: "GRANT_EXPIRED" };
    }
    const action = one<any>(db, "SELECT * FROM proposal_actions WHERE id=?", grant.action_id);
    const spec = json<ActionSpec>(action.spec_json);
    if (!featureAllowed(featureForRoute(spec.route))) return { ok: false, reason: "FEATURE_DISABLED" };
    if (digestOf(spec) !== grant.spec_digest || action.spec_digest !== grant.spec_digest) return { ok: false, reason: "DIGEST_MISMATCH" };
    const other = one<any>(db, `SELECT id FROM attempts WHERE tenant_id=? AND logical_key=? AND id != ? AND status IN ${ACTIVE_ATTEMPT}`, input.tenantId, action.logical_key, input.attemptId);
    if (other) return { ok: false, reason: "ALREADY_EXECUTED" };
    const at = new Date().toISOString();
    run(db, "INSERT INTO dispatch_journal(attempt_id, grant_id, fence, epoch, authorized_at) VALUES (?,?,?,?,?)", input.attemptId, grant.id, input.fence, mandate.revocation_epoch, at);
    run(db, "UPDATE attempts SET status='DISPATCH_AUTHORIZED', dispatched_at=? WHERE id=?", at, input.attemptId);
    run(db, "UPDATE grants SET status='CONSUMED', consumed_by_attempt=? WHERE id=?", input.attemptId, grant.id);
    run(db, "UPDATE proposal_actions SET status='EXECUTING', updated_at=? WHERE id=?", nowIso(db, input.tenantId), action.id);
    return { ok: true };
  });
}
