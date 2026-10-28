import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, funds, startStack, waitFor, type Api, type Stack } from "./harness";

// Tests 4, 5 (single), 6, 7, 9 (refused), 10 (dependencies) and 11. Each test uses its own isolated tenant and
// starts a worker only when it wants execution to happen, so "nothing ran" is asserted against a live worker.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

const CONTRACT_COLUMNS = "state, auto_renew, next_charge_at, access_until, terms_revision, resource_version, pending_json, price_minor, plan_id, details_json";
const contractState = (t: string, local: string) => stack.mq1<any>(`SELECT ${CONTRACT_COLUMNS} FROM m_contracts WHERE tenant_id=? AND id=?`, t, `${t}:${local}`);
const forecastOf = (subId: string) => stack.q<any>("SELECT id, amount_minor, due_at, status FROM forecast_items WHERE subscription_id=? ORDER BY id", subId);

async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const w = await stack.worker();
  try {
    return await fn();
  } finally {
    await w.stop();
  }
}

/** Approve an A6 pause in another tenant and wait for it: proof that a live worker processed the queue. */
async function sentinel() {
  const s = await stack.login("alex");
  const p = await stack.propose(s, "A6", ["pause"]);
  await stack.approve(s, p);
  return p.actions[0].id;
}

describe("4. expired approval", () => {
  it("grant window passes before any worker runs → not dispatched, EXPIRED, merchant unchanged", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    const approval = await stack.approve(a, p);
    const issued = stack.q1<any>("SELECT issued_at, expires_at, status FROM grants WHERE action_id=?", id)!;
    const windowMs = Date.parse(issued.expires_at) - Date.parse(issued.issued_at);
    expect(windowMs).toBeGreaterThanOrEqual(10 * 60_000 - 1000); // both instants are rounded to whole seconds
    expect(windowMs).toBeLessThanOrEqual(10 * 60_000);
    expect(approval.grants[0].expiresAt).toBe(issued.expires_at);
    const before = { contract: contractState(t, "streamly-standard"), forecast: forecastOf(`${t}:sub:streamly`) };

    await stack.clock(a, 11);
    const done = await withWorker(() => stack.waitAction(id, ["EXPIRED", "CONFIRMED", "BLOCKED", "REFUSED", "UNKNOWN"]));
    expect(done.status).toBe("EXPIRED");

    const attempts = stack.attempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("NOT_DISPATCHED");
    expect(attempts[0].dispatched_at).toBeNull();
    expect(JSON.parse(attempts[0].outcome_json).gate).toBe("GRANT_EXPIRED");
    expect(stack.q1<any>("SELECT status, consumed_by_attempt FROM grants WHERE action_id=?", id)).toEqual({ status: "EXPIRED", consumed_by_attempt: null });
    expect(stack.q("SELECT * FROM dispatch_journal WHERE attempt_id=?", attempts[0].id)).toHaveLength(0);
    expect(stack.q1<any>("SELECT status FROM jobs WHERE kind='ACTION' AND ref_id=?", id)!.status).toBe("DONE");
    expect(stack.q("SELECT id FROM receipts WHERE tenant_id=?", t)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(0);
    expect(contractState(t, "streamly-standard")).toEqual(before.contract);
    expect(forecastOf(`${t}:sub:streamly`)).toEqual(before.forecast);

    // A proposal left unapproved past its 30-minute review window cannot be approved either.
    const stale = await stack.propose(a, "A6", ["pause"]);
    await stack.clock(a, 31);
    const r = await a.post(`/api/proposals/${stale.id}/approve`, { digest: stale.digest, actionIds: [stale.actions[0].id] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("PROPOSAL_EXPIRED");
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", stale.id)!.status).toBe("EXPIRED");
    expect(stack.q("SELECT id FROM grants WHERE action_id=?", stale.actions[0].id)).toHaveLength(0);
  });
});

describe("5. revoked approval (single action)", () => {
  it("stop before dispatch → no attempt, no merchant change; repeat stop and re-approval add nothing", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    const approval = await stack.approve(a, p);
    const before = contractState(t, "streamly-standard");

    const stop = await a.ok(`/api/mandates/${approval.mandateId}/stop`);
    expect(stop).toEqual({ revoked: 1, alreadyStarted: 0, status: "REVOKED" });
    expect(stack.q1<any>("SELECT status, revocation_epoch FROM mandates WHERE id=?", approval.mandateId)).toEqual({ status: "REVOKED", revocation_epoch: 1 });
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", id)!.status).toBe("REVOKED");
    expect(stack.action(id).status).toBe("REVOKED");
    expect(stack.q1<any>("SELECT status, last_error FROM jobs WHERE kind='ACTION' AND ref_id=?", id)).toEqual({ status: "DONE", last_error: "REVOKED" });
    expect(await a.ok(`/api/mandates/${approval.mandateId}/stop`)).toEqual({ revoked: 0, alreadyStarted: 0, status: "REVOKED" });

    const replay = await stack.approve(a, p);
    expect(replay.alreadyApproved).toBe(true);
    expect(replay.mandateId).toBe(approval.mandateId);
    expect(stack.q("SELECT id FROM grants WHERE action_id=?", id)).toHaveLength(1);
    expect(stack.q("SELECT id FROM jobs WHERE ref_id=?", id)).toHaveLength(1);

    const other = await sentinel();
    await withWorker(() => stack.waitAction(other, ["CONFIRMED"]));
    expect(stack.attempts(id)).toHaveLength(0);
    expect(stack.action(id).status).toBe("REVOKED");
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(0);
    expect(contractState(t, "streamly-standard")).toEqual(before);
  });
});

describe("6. changed terms after approval", () => {
  it("offer terms change (labs change_offer_terms) → activation OUTDATED, nothing sent, re-approve → TERMS_CHANGED", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "T3", ["activate-bundle"], { studentIdNumber: "S123456789012" });
    const byOp = Object.fromEntries(p.actions.map((x) => [x.operation, x.id]));
    expect(Object.keys(byOp).sort()).toEqual(["ACTIVATE_OFFER", "VERIFY_ELIGIBILITY"]);
    await stack.approve(a, p);

    const changed = await stack.labs(a, "change_offer_terms", { offerId: "student-bundle", changes: { offlinePlayback: false } });
    expect(changed.revision).toBe(2);
    await waitFor(() => stack.q1("SELECT applied_at FROM inbox_events WHERE tenant_id=? AND kind='offer.terms_changed' AND applied_at IS NOT NULL", t), { label: "offer.terms_changed applied" });

    const activate = byOp.ACTIVATE_OFFER;
    expect(stack.action(activate).status).toBe("OUTDATED");
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", activate)!.status).toBe("INVALIDATED");
    expect(stack.q1<any>("SELECT status, last_error FROM jobs WHERE kind='ACTION' AND ref_id=?", activate)).toEqual({ status: "DONE", last_error: "TERMS_CHANGED" });
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("OUTDATED");

    // The worker still runs the unaffected verification (proof it was live), but never the activation.
    await withWorker(() => stack.waitAction(byOp.VERIFY_ELIGIBILITY, ["CONFIRMED"]));
    expect(stack.attempts(activate)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND operation='ACTIVATE_OFFER'", t)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_contracts WHERE tenant_id=? AND id=?", t, `${t}:student-bundle`)).toHaveLength(0);
    expect(stack.q("SELECT id FROM subscriptions WHERE id=?", `${t}:sub:studyplus-bundle`)).toHaveLength(0);

    const again = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: p.actions.map((x) => x.id) });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("TERMS_CHANGED");
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("OUTDATED");
  });

  it("contract terms change found by the worker's pre-check → TERMS_CHANGED, nothing sent, proposal OUTDATED; a fresh plan works", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    await stack.approve(a, p);
    await stack.labs(a, "fault", { contractId: `${t}:streamly-standard`, kind: "PUBLISH_TERMS_AFTER_READS", params: { afterReads: 0, newRevision: 3, newPriceMinor: 5900 } });

    const done = await withWorker(() => stack.waitAction(id, ["TERMS_CHANGED", "CONFIRMED", "BLOCKED", "REFUSED", "UNKNOWN"]));
    expect(done.status).toBe("TERMS_CHANGED");
    const [attempt] = stack.attempts(id);
    expect(attempt.status).toBe("TERMS_CHANGED");
    expect(attempt.dispatched_at).toBeNull();
    expect(stack.q("SELECT * FROM dispatch_journal WHERE attempt_id=?", attempt.id)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(0);
    expect(contractState(t, "streamly-standard")!.terms_revision).toBe(3);
    expect(contractState(t, "streamly-standard")!.pending_json).toBeNull();
    expect(stack.q1<any>("SELECT observed_revision FROM subscriptions WHERE id=?", `${t}:sub:streamly`)!.observed_revision).toBe(3);
    // The unconsumed grant for the changed subject is invalidated and the plan needs a fresh check.
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", id)!.status).toBe("INVALIDATED");
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("OUTDATED");
    const again = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [id] });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("TERMS_CHANGED");

    // A fresh check proposes the new revision, and that plan executes.
    const fresh = await stack.propose(a, "A6", ["pause"]);
    expect(JSON.parse(stack.action(fresh.actions[0].id).spec_json).termsRevision).toBe(3);
    await stack.approve(a, fresh);
    const ok = await withWorker(() => stack.waitAction(fresh.actions[0].id, ["CONFIRMED", "TERMS_CHANGED", "BLOCKED", "REFUSED", "UNKNOWN"]));
    expect(ok.status).toBe("CONFIRMED");
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(1);
  });
});

describe("6. changed terms before approval", () => {
  it("a fresh read shows new terms → approving the older plan is 409 TERMS_CHANGED and the proposal is persisted OUTDATED", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A6", ["pause"]);
    expect(JSON.parse(stack.action(p.actions[0].id).spec_json).termsRevision).toBe(2);
    await stack.labs(a, "fault", { contractId: `${t}:streamly-standard`, kind: "PUBLISH_TERMS_AFTER_READS", params: { afterReads: 0, newRevision: 4, newPriceMinor: 5900 } });
    await a.json("/api/capabilities/A6"); // the bank reads the provider again and records revision 4
    expect(stack.q1<any>("SELECT observed_revision FROM subscriptions WHERE id=?", `${t}:sub:streamly`)!.observed_revision).toBe(4);

    for (let i = 0; i < 2; i++) {
      const r = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("TERMS_CHANGED");
    }
    expect(stack.q1<any>("SELECT status, outdated_reason FROM proposals WHERE id=?", p.id)).toEqual({ status: "OUTDATED", outdated_reason: "terms changed from revision 2 to 4" });
    expect(stack.action(p.actions[0].id).status).toBe("OUTDATED");
    expect(stack.q("SELECT id FROM mandates WHERE proposal_id=?", p.id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM grants WHERE action_id=?", p.actions[0].id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM jobs WHERE ref_id=?", p.actions[0].id)).toHaveLength(0);
  });
});

describe("7. duplicate requests and events", () => {
  it("replaying an approval returns the same mandate and creates no new grant or job; the action runs once", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    const first = await stack.approve(a, p);
    const second = await stack.approve(a, p);
    expect(first.alreadyApproved).toBe(false);
    expect(second.alreadyApproved).toBe(true);
    expect(second.mandateId).toBe(first.mandateId);
    expect(second.grants.map((g) => g.grantId)).toEqual(first.grants.map((g) => g.grantId));
    const diff = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [] });
    expect(diff.status).toBe(409);
    expect(diff.json.error).toBe("ALREADY_DECIDED");
    const counts = () => ({
      mandates: stack.q("SELECT id FROM mandates WHERE proposal_id=?", p.id).length,
      grants: stack.q("SELECT id FROM grants WHERE action_id=?", id).length,
      jobs: stack.q("SELECT id FROM jobs WHERE ref_id=?", id).length,
      outbox: stack.q("SELECT id FROM outbox WHERE ref_id=?", id).length,
    });
    expect(counts()).toEqual({ mandates: 1, grants: 1, jobs: 1, outbox: 1 });

    await withWorker(() => stack.waitAction(id, ["CONFIRMED"]));
    const third = await stack.approve(a, p);
    expect(third.mandateId).toBe(first.mandateId);
    expect(counts()).toEqual({ mandates: 1, grants: 1, jobs: 1, outbox: 1 });
    expect(stack.attempts(id)).toHaveLength(1);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(1);
    const receipts = stack.q<any>("SELECT id, issuer_reference FROM receipts WHERE action_id=?", id);
    expect(receipts).toHaveLength(1);
    expect(stack.q("SELECT id FROM forecast_events WHERE tenant_id=? AND id LIKE ?", t, `rcp:streamly:${receipts[0].issuer_reference}%`)).toHaveLength(1);
  });

  it("replayed signed inbox events are deduplicated (one ledger posting, one forecast change); bad signatures → 401, nothing stored", async () => {
    const l = await stack.login("laziz");
    const t = l.tenantId;
    const biz = `${t}:biz-current`;
    const remind = await stack.propose(l, "O4", ["remind-cafe-aurora"]);
    await stack.approve(l, remind);
    await withWorker(() => stack.waitAction(remind.actions[0].id, ["CONFIRMED"]));

    await stack.labs(l, "counterparty_reply_now");
    const reply = await waitFor(() => stack.q1<any>("SELECT * FROM inbox_events WHERE tenant_id=? AND kind='counterparty.reply' AND applied_at IS NOT NULL", t), { label: "counterparty.reply applied" });
    const promises = () => stack.q<any>("SELECT id, amount_minor, status FROM forecast_items WHERE tenant_id=? AND kind='RECEIVABLE' ORDER BY amount_minor", t);
    const promiseEvents = () => stack.q<any>("SELECT id FROM forecast_events WHERE tenant_id=? AND id LIKE 'promise:%'", t);
    expect(promises().map((x) => x.amount_minor)).toEqual([400000, 800000]);
    expect(promiseEvents()).toHaveLength(2);

    const before = balance(stack, biz);
    await stack.labs(l, "counterparty_pay", { counterparty: "cafe-aurora", amountMinor: 400000, reference: "INV-2026-0142" });
    const credit = await waitFor(() => stack.q1<any>("SELECT * FROM inbox_events WHERE tenant_id=? AND kind='credit_transfer' AND applied_at IS NOT NULL", t), { label: "credit_transfer applied" });
    expect(credit.result).toBe("receivable credited");
    const transferId = JSON.parse(credit.payload_json).data.transferId;
    const postings = () => stack.q<any>("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, `credit:${transferId}`);
    const settles = () => stack.q<any>("SELECT id FROM forecast_events WHERE tenant_id=? AND id=?", t, `credit:${transferId}:settle`);
    expect(postings()).toHaveLength(1);
    expect(settles()).toHaveLength(1);
    expect(balance(stack, biz) - before).toBe(400000);

    // Exact replays of both signed events: acknowledged as duplicates, nothing applied again.
    for (const raw of [reply.payload_json, credit.payload_json]) {
      const r = await stack.postInbox(raw);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, duplicate: true });
    }
    // The same transfer re-sent under a new event id is stored but posts nothing.
    const resent = JSON.stringify({ ...JSON.parse(credit.payload_json), eventId: "evt_resent_same_transfer" });
    const r2 = await stack.postInbox(resent);
    expect(r2.json).toEqual({ ok: true, duplicate: false });
    expect(stack.q1<any>("SELECT result FROM inbox_events WHERE tenant_id=? AND event_id='evt_resent_same_transfer'", t)!.result).toBe("duplicate credit ignored");
    expect(postings()).toHaveLength(1);
    expect(settles()).toHaveLength(1);
    expect(promises().map((x) => x.amount_minor)).toEqual([400000, 800000]);
    expect(promiseEvents()).toHaveLength(2);
    expect(balance(stack, biz) - before).toBe(400000);

    // Bad, missing or mismatched signatures: 401 and nothing stored or applied.
    const inbox = stack.q1<any>("SELECT COUNT(*) n FROM inbox_events")!.n;
    const forged = JSON.stringify({ ...JSON.parse(credit.payload_json), eventId: "evt_forged", data: { ...JSON.parse(credit.payload_json).data, transferId: "trf_forged", amountMinor: 999999 } });
    for (const sig of ["sha256=" + "0".repeat(64), null, stack.sign(credit.payload_json), stack.sign(forged).replace("sha256=", "sha1=")]) {
      const r = await stack.postInbox(forged, sig);
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("BAD_SIGNATURE");
    }
    expect(stack.q1<any>("SELECT COUNT(*) n FROM inbox_events")!.n).toBe(inbox);
    expect(stack.q("SELECT id FROM ledger_entries WHERE source_event_id='credit:trf_forged'")).toHaveLength(0);
    expect(balance(stack, biz) - before).toBe(400000);
  });
});

describe("9. refused outcomes have no effects", () => {
  it("T3 verification with an invalid student ID is REFUSED; the dependent activation is never sent", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const fc = stack.q<any>("SELECT id, status FROM forecast_items WHERE tenant_id=? ORDER BY id", t);
    const p = await stack.propose(a, "T3", ["activate-bundle"], { studentIdNumber: "STUDENT-42" });
    const byOp = Object.fromEntries(p.actions.map((x) => [x.operation, x.id]));
    await stack.approve(a, p);
    await withWorker(async () => {
      await stack.waitAction(byOp.VERIFY_ELIGIBILITY, ["REFUSED", "CONFIRMED", "BLOCKED", "UNKNOWN"]);
      await stack.waitAction(byOp.ACTIVATE_OFFER, ["BLOCKED", "CONFIRMED", "REFUSED"]);
    });
    const verify = stack.action(byOp.VERIFY_ELIGIBILITY);
    expect(verify.status).toBe("REFUSED");
    expect(JSON.parse(verify.result_json).reason).toMatch(/Student ID number not recognised/);
    expect(stack.attempts(byOp.VERIFY_ELIGIBILITY)).toHaveLength(1);
    const activate = stack.action(byOp.ACTIVATE_OFFER);
    expect(activate.status).toBe("BLOCKED");
    expect(stack.attempts(byOp.ACTIVATE_OFFER)).toHaveLength(0);
    // No receipts, facts, subscriptions or forecast changes; the provider recorded no verification or activation.
    expect(stack.q("SELECT id FROM receipts WHERE tenant_id=?", t)).toHaveLength(0);
    expect(stack.q("SELECT id FROM facts WHERE tenant_id=? AND key='student_status'", t)).toHaveLength(0);
    expect(stack.q("SELECT id FROM subscriptions WHERE id=?", `${t}:sub:studyplus-bundle`)).toHaveLength(0);
    expect(stack.q<any>("SELECT id, status FROM forecast_items WHERE tenant_id=? ORDER BY id", t)).toEqual(fc);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(0);
    expect(JSON.parse(stack.mq1<any>("SELECT details_json FROM m_accounts WHERE tenant_id=? AND merchant_id='studyplus'", t)!.details_json).studentVerification).toBe("NOT_VERIFIED");
    expect(stack.mq("SELECT id FROM m_contracts WHERE tenant_id=? AND id=?", t, `${t}:student-bundle`)).toHaveLength(0);
  });

  it("a provider that refuses cancellations (labs) → REFUSED through the website, subscription and forecast unchanged", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stack.labs(a, "set_cancellation_mode", { merchantId: "fitflow", mode: "refuse" });
    const before = { sub: stack.q1<any>("SELECT state, next_charge_at FROM subscriptions WHERE id=?", `${t}:sub:fitflow`), forecast: forecastOf(`${t}:sub:fitflow`), contract: contractState(t, "fitflow-premium") };
    const p = await stack.propose(a, "T2", ["stop-fitflow"]);
    await stack.approve(a, p);
    const done = await withWorker(() => stack.waitAction(p.actions[0].id, ["REFUSED", "CONFIRMED", "BLOCKED", "UNKNOWN"], 90_000));
    expect(done.status).toBe("REFUSED");
    expect(stack.attempts(p.actions[0].id)).toHaveLength(1);
    expect(stack.q("SELECT id FROM receipts WHERE tenant_id=?", t)).toHaveLength(0);
    expect(stack.q1<any>("SELECT state, next_charge_at FROM subscriptions WHERE id=?", `${t}:sub:fitflow`)).toEqual(before.sub);
    expect(forecastOf(`${t}:sub:fitflow`)).toEqual(before.forecast);
    const reqs = stack.mq<any>("SELECT status, channel FROM m_requests WHERE tenant_id=?", t);
    expect(reqs).toEqual([{ status: "REFUSED", channel: "WEB" }]);
    expect(contractState(t, "fitflow-premium")!.auto_renew).toBe(1);
  });
});

describe("10. dependencies", () => {
  it("T3: activation is only sent after the verification is confirmed", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "T3", ["activate-bundle"], { studentIdNumber: "S123456789012" });
    const byOp = Object.fromEntries(p.actions.map((x) => [x.operation, x.id]));
    // Selecting the activation without its prerequisite is refused.
    const partial = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [byOp.ACTIVATE_OFFER] });
    expect(partial.status).toBe(409);
    expect(partial.json.error).toBe("DEPENDENCY");
    await stack.approve(a, p);
    await withWorker(() => stack.waitAction(byOp.ACTIVATE_OFFER, ["CONFIRMED", "BLOCKED", "REFUSED", "UNKNOWN"]));
    expect(stack.action(byOp.VERIFY_ELIGIBILITY).status).toBe("CONFIRMED");
    expect(stack.action(byOp.ACTIVATE_OFFER).status).toBe("CONFIRMED");
    const [verify] = stack.attempts(byOp.VERIFY_ELIGIBILITY);
    const [activate] = stack.attempts(byOp.ACTIVATE_OFFER);
    expect(Date.parse(activate.dispatched_at)).toBeGreaterThanOrEqual(Date.parse(verify.finished_at));
    const reqs = stack.mq<any>("SELECT operation FROM m_requests WHERE tenant_id=? ORDER BY rowid", t).map((r) => r.operation);
    expect(reqs).toEqual(["VERIFY_ELIGIBILITY", "ACTIVATE_OFFER"]);
    expect(stack.q("SELECT id FROM subscriptions WHERE id=?", `${t}:sub:studyplus-bundle`)).toHaveLength(1);
  });

  it("A1: CloudBox renewal is not stopped until the file migration is VERIFIED", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const p = await stack.propose(a, "A1", ["stop-cloudbox"]);
    const byOp = Object.fromEntries(p.actions.map((x) => [x.operation, x.id]));
    expect(Object.keys(byOp).sort()).toEqual(["START_MIGRATION", "STOP_RENEWAL"]);
    const stop = byOp.STOP_RENEWAL;
    await stack.approve(a, p);
    const w = await stack.worker();
    try {
      await stack.waitAction(byOp.START_MIGRATION, ["CONFIRMED"]);
      expect(JSON.parse(stack.q1<any>("SELECT data_json FROM subscriptions WHERE id=?", `${t}:sub:cloudbox`)!.data_json).migration.state).toBe("IN_PROGRESS");
      // The worker keeps picking the stop up and putting it back while the copy is unverified.
      const claims = () => stack.q1<any>("SELECT attempts FROM jobs WHERE kind='ACTION' AND ref_id=?", stop)!.attempts as number;
      const seen = claims();
      await waitFor(() => claims() >= seen + 2, { label: "stop job re-checked twice", timeout: 30_000 });
      expect(stack.attempts(stop)).toHaveLength(0);
      expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", stop)!.status).toBe("ACTIVE");
      expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND operation='STOP_RENEWAL'", t)).toHaveLength(0);
      expect(contractState(t, "cloudbox-100")!.auto_renew).toBe(1);

      // The provider finishes the copy (20 demo minutes), signs migration.completed, and only then the stop runs.
      await stack.clock(a, 21);
      await stack.waitAction(stop, ["CONFIRMED", "BLOCKED", "REFUSED", "UNKNOWN", "EXPIRED"]);
    } finally {
      await w.stop();
    }
    expect(stack.action(stop).status).toBe("CONFIRMED");
    const verified = stack.q1<any>("SELECT applied_at FROM inbox_events WHERE tenant_id=? AND kind='migration.completed'", t)!;
    const [attempt] = stack.attempts(stop);
    expect(Date.parse(attempt.dispatched_at)).toBeGreaterThan(Date.parse(verified.applied_at));
    expect(JSON.parse(stack.q1<any>("SELECT data_json FROM subscriptions WHERE id=?", `${t}:sub:cloudbox`)!.data_json).migration.state).toBe("VERIFIED");
    expect(stack.mq<any>("SELECT operation FROM m_requests WHERE tenant_id=? ORDER BY rowid", t).map((r) => r.operation)).toEqual(["START_MIGRATION", "STOP_RENEWAL"]);
    expect(contractState(t, "cloudbox-100")!.auto_renew).toBe(0);
  });
});

describe("11. refund accounting (A7 StudioMart 249 RON)", () => {
  async function analysis(a: Api) {
    return (await a.json("/api/capabilities/A7")).numbers as { amountMinor: number; creditedMinor: number; balanceMinor: number };
  }

  it("acceptance never changes cash; only the payment-network credit posts, once, for exactly 249.00 RON", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const daily = `${t}:daily`;
    const ctx = `${t}:personal`;
    const rec = () => stack.q1<any>("SELECT state, credit_transaction_id FROM recoveries WHERE id=?", `${t}:rec:studiomart`)!;
    const entries = () => stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=?", t)!.n;
    const start = { daily: balance(stack, daily), funds: funds(stack, t, ctx), entries: entries() };
    expect(rec().state).toBe("AWAITING_CREDIT");
    expect(await analysis(a)).toMatchObject({ amountMinor: 24900, creditedMinor: 0 });

    // The merchant (re)confirms acceptance: tracked, not money.
    const accepted = JSON.stringify({ eventId: "evt_sm_accept_1", issuer: "studiomart", tenantId: t, kind: "refund.accepted", resourceVersion: null, occurredAt: "2026-10-28T10:00:00+02:00", data: { reference: "SM-2048", payoutExpectedAt: "2026-10-31T12:00:00+02:00" } });
    expect((await stack.postInbox(accepted)).json).toEqual({ ok: true, duplicate: false });
    expect(stack.q1<any>("SELECT result FROM inbox_events WHERE tenant_id=? AND event_id='evt_sm_accept_1'", t)!.result).toBe("recovery accepted (no cash change)");
    // A merchant cannot pay itself into the account: credits are accepted only from the payment network.
    const selfCredit = JSON.stringify({ eventId: "evt_sm_selfcredit", issuer: "studiomart", tenantId: t, kind: "credit_transfer", resourceVersion: null, occurredAt: "2026-10-28T10:00:00+02:00", data: { transferId: "trf_from_merchant", amountMinor: 24900, reference: "SM-2048" } });
    await stack.postInbox(selfCredit);
    expect(stack.q1<any>("SELECT result FROM inbox_events WHERE tenant_id=? AND event_id='evt_sm_selfcredit'", t)!.result).toMatch(/^ignored/);
    expect(balance(stack, daily)).toBe(start.daily);
    expect(entries()).toBe(start.entries);
    expect(rec()).toEqual({ state: "AWAITING_CREDIT", credit_transaction_id: null });

    // The simulated payment network pays the refund.
    await stack.labs(a, "refund_payout", { reference: "SM-2048" });
    const credit = await waitFor(() => stack.q1<any>("SELECT * FROM inbox_events WHERE tenant_id=? AND kind='credit_transfer' AND issuer='payment-network' AND applied_at IS NOT NULL", t), { label: "payment-network credit applied" });
    expect(credit.result).toBe("recovery credited");
    const transferId = JSON.parse(credit.payload_json).data.transferId as string;
    expect(balance(stack, daily) - start.daily).toBe(24900);
    expect(funds(stack, t, ctx) - start.funds).toBe(24900);
    const entry = stack.q<any>("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, `credit:${transferId}`);
    expect(entry).toHaveLength(1);
    const lines = stack.q<any>("SELECT account_id, amount_minor FROM ledger_lines WHERE entry_id=? ORDER BY amount_minor", entry[0].id);
    expect(lines).toEqual([{ account_id: `${t}:clearing`, amount_minor: -24900 }, { account_id: daily, amount_minor: 24900 }]);
    expect(rec().state).toBe("CREDITED");
    expect(stack.q1<any>("SELECT amount_minor, category, status FROM transactions WHERE id=?", rec().credit_transaction_id)).toEqual({ amount_minor: 24900, category: "Refund", status: "POSTED" });

    // Replays: the delivered event again, the same transfer under a new id, a second payout request.
    expect((await stack.postInbox(credit.payload_json)).json).toEqual({ ok: true, duplicate: true });
    await stack.postInbox(JSON.stringify({ ...JSON.parse(credit.payload_json), eventId: "evt_pn_resend" }));
    expect(stack.q1<any>("SELECT result FROM inbox_events WHERE tenant_id=? AND event_id='evt_pn_resend'", t)!.result).toBe("duplicate credit ignored");
    expect((await stack.labs(a, "refund_payout", { reference: "SM-2048" })).alreadyPaid).toBe(true);
    await waitFor(() => stack.mq1<any>("SELECT COUNT(*) n FROM m_events WHERE tenant_id=? AND delivered_at IS NULL", t)!.n === 0, { label: "merchant outbox drained" });
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id LIKE 'credit:%'", t)).toHaveLength(1);
    expect(entries()).toBe(start.entries + 1);
    expect(balance(stack, daily) - start.daily).toBe(24900);
    expect(await analysis(a)).toMatchObject({ amountMinor: 24900, creditedMinor: 24900, balanceMinor: start.daily + 24900 });
  });
});
