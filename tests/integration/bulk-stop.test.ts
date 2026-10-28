import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Stack, fixture, funds, startStack, waitFor } from "./harness";

// Stop pressed while the 200-item batch is running: the revocation and the dispatch gate are serialized, so no
// dispatch is authorized after Stop. Items already past the gate may finish; everything else is NOT_STARTED.
// The worker talks to the merchant through the harness proxy, so two items are deterministically in flight when
// Stop is pressed: sub-001 already sent (the provider committed, its answer is held) and sub-002 claimed but held
// at its pre-dispatch read, before the gate.

const BULK = fixture("demo/bulk-cancellations.json");
const RECORD = new Map<string, any>(BULK.records.map((r: any) => [r.id, r]));
const local = (subscriptionId: string) => subscriptionId.split(":").pop()!;
const countBy = (rows: any[], key: string) => rows.reduce((m: Record<string, number>, r) => ((m[r[key] ?? "NONE"] = (m[r[key] ?? "NONE"] ?? 0) + 1), m), {});
const decodedPath = (p: string) => decodeURIComponent(p.split("?")[0]);

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ proxy: true });
  await stack.worker();
}, 120_000);

afterAll(async () => {
  await stack?.teardown();
});

describe("5. stop a running batch", () => {
  it("no dispatch after Stop; started items may finish; the rest are NOT_STARTED with revoked grants; a replayed approval changes nothing", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const ctx = stack.q1<any>("SELECT active_context_id FROM sessions WHERE csrf_token=?", a.csrf)!.active_context_id;
    const fundsBefore = funds(stack, t, ctx);
    const batchId = (await a.ok("/api/batches")).batchId;
    const review = await waitFor(async () => {
      const s = await a.json(`/api/batches/${batchId}`);
      return s.status === "REVIEW" && s.proposalId ? s : null;
    }, { timeout: 90_000, interval: 200, label: "batch review" });
    const ready = review.items.filter((i: any) => i.reviewStatus === "READY").map((i: any) => i.actionId);
    expect(ready).toHaveLength(120);
    const item = (sub: string) => review.items.find((i: any) => local(i.subscriptionId) === sub);
    const subRow = (sub: string) => stack.q1<any>("SELECT merchant_id, contract_id FROM subscriptions WHERE id=?", item(sub).subscriptionId)!;
    const sent = subRow("sub-001");
    const claimed = subRow("sub-002");
    const proxy = stack.proxy!;
    proxy.hold({ name: "sent", mode: "hold-after", when: (r) => r.method === "POST" && decodedPath(r.path) === `/m/${sent.merchant_id}/api/v1/contracts/${sent.contract_id}/operations` });
    proxy.hold({ name: "claimed", mode: "hold-before", when: (r) => r.method === "GET" && decodedPath(r.path) === `/m/${claimed.merchant_id}/api/v1/contracts/${claimed.contract_id}` });

    const approval = await a.ok(`/api/batches/${batchId}/approve`, { digest: review.proposalDigest, actionIds: ready });
    expect(approval.grants).toBe(120);
    const mandateId = approval.mandateId as string;
    const sentAction = item("sub-001").actionId as string;
    const claimedAction = item("sub-002").actionId as string;

    await waitFor(() => {
      const s1 = stack.attempts(sentAction)[0]?.status;
      const s2 = stack.attempts(claimedAction)[0]?.status;
      const confirmed = stack.q1<any>("SELECT COUNT(*) n FROM batch_items WHERE batch_id=? AND outcome='CONFIRMED'", batchId)!.n;
      return s1 === "SENT" && s2 === "CLAIMED" && proxy.hits.some((h) => h.rule === "sent" && h.forwarded) && proxy.hits.some((h) => h.rule === "claimed") && confirmed >= 5;
    }, { timeout: 60_000, interval: 20, label: "two items in flight and five confirmed", onTimeout: () => stack.workerLogs() });
    const stop = await a.ok(`/api/batches/${batchId}/stop`);
    // Read right after the stop committed: no gate can pass after this point, so these are final.
    const journalAtStop = stack.q<any>("SELECT j.* FROM dispatch_journal j JOIN grants g ON g.id=j.grant_id WHERE g.mandate_id=?", mandateId);
    const queuedAtStop = stack.q1<any>("SELECT COUNT(*) n FROM jobs WHERE tenant_id=? AND kind='ACTION' AND last_error='REVOKED'", t)!.n;
    expect(stop).toMatchObject({ status: "REVOKED", alreadyStarted: journalAtStop.length });
    expect(stop.revoked).toBeGreaterThan(0);
    expect(stop.batch.status).toBe("STOPPED");
    expect(journalAtStop.length).toBeGreaterThanOrEqual(6); // five confirmed + the one held after sending
    expect(queuedAtStop).toBeGreaterThan(0); // queued work was cancelled, not merely not reached yet
    expect(stack.q1<any>("SELECT status, revocation_epoch FROM mandates WHERE id=?", mandateId)).toEqual({ status: "REVOKED", revocation_epoch: 1 });
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", sentAction)!.status).toBe("CONSUMED");
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", claimedAction)!.status).toBe("REVOKED");

    // Let both in-flight items continue: the claimed one now reaches the gate, the sent one gets its answer.
    expect(await proxy.release("claimed")).toBe(1);
    expect(await proxy.release("sent")).toBe(1);
    proxy.clear();

    // Let whatever was already in flight settle.
    await waitFor(() => {
      const busy = stack.q1<any>("SELECT COUNT(*) n FROM jobs WHERE tenant_id=? AND kind='ACTION' AND status IN ('QUEUED','LEASED')", t)!.n;
      const open = stack.q1<any>("SELECT COUNT(*) n FROM attempts WHERE tenant_id=? AND status IN ('CLAIMED','DISPATCH_AUTHORIZED','SENT')", t)!.n;
      return busy === 0 && open === 0;
    }, { timeout: 60_000, label: "in-flight items settled", onTimeout: () => stack.workerLogs() });

    const journal = stack.q<any>("SELECT j.* FROM dispatch_journal j JOIN grants g ON g.id=j.grant_id WHERE g.mandate_id=?", mandateId);
    expect(journal.map((j) => j.attempt_id).sort()).toEqual(journalAtStop.map((j) => j.attempt_id).sort());
    expect(journal.every((j) => j.epoch === 0)).toBe(true);

    // sub-001 had already been sent: it finishes and is confirmed with one request and one receipt.
    const s1 = stack.attempts(sentAction);
    expect([s1.length, s1[0].status, stack.action(sentAction).status]).toEqual([1, "CONFIRMED", "CONFIRMED"]);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND contract_id=?", t, sent.contract_id)).toHaveLength(1);
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", sentAction)).toHaveLength(1);
    // sub-002 was claimed but had not reached the gate: refused there, never sent.
    const s2 = stack.attempts(claimedAction);
    expect([s2.length, s2[0].status, JSON.parse(s2[0].outcome_json).gate, stack.action(claimedAction).status]).toEqual([1, "NOT_DISPATCHED", "MANDATE_REVOKED", "REVOKED"]);
    expect(stack.q("SELECT attempt_id FROM dispatch_journal WHERE attempt_id=?", s2[0].id)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND contract_id=?", t, claimed.contract_id)).toHaveLength(0);
    expect(proxy.traffic.some((x) => x.method === "POST" && decodedPath(x.path).includes(`/contracts/${claimed.contract_id}/`))).toBe(false);
    expect(stack.q1<any>("SELECT outcome FROM batch_items WHERE action_id=?", claimedAction)!.outcome).toBe("NOT_STARTED");
    // Exactly one provider request per authorized dispatch, and nothing else reached the provider.
    const reqs = stack.mq<any>("SELECT * FROM m_requests WHERE tenant_id=?", t);
    expect(reqs).toHaveLength(journal.length);
    const dispatchedCorrelations = new Set(stack.q<any>("SELECT a.correlation_id FROM attempts a JOIN dispatch_journal j ON j.attempt_id=a.id WHERE a.tenant_id=?", t).map((x) => x.correlation_id));
    for (const r of reqs) expect(dispatchedCorrelations.has(r.correlation_id)).toBe(true);

    const grants = stack.q<any>("SELECT status, COUNT(*) n FROM grants WHERE mandate_id=? GROUP BY status", mandateId);
    const g = Object.fromEntries(grants.map((x) => [x.status, x.n]));
    expect(g.CONSUMED).toBe(journal.length);
    expect(g.REVOKED).toBe(stop.revoked);
    expect((g.CONSUMED ?? 0) + (g.REVOKED ?? 0) + (g.INVALIDATED ?? 0)).toBe(120);

    const items = stack.q<any>("SELECT bi.*, s.contract_id FROM batch_items bi JOIN subscriptions s ON s.id=bi.subscription_id WHERE bi.batch_id=? AND bi.selected=1", batchId);
    expect(items).toHaveLength(120);
    const dispatchedActions = new Set(stack.q<any>("SELECT a.action_id FROM attempts a JOIN dispatch_journal j ON j.attempt_id=a.id WHERE a.tenant_id=?", t).map((x) => x.action_id));
    let notStarted = 0;
    for (const it of items) {
      const sub = local(it.subscription_id);
      const attempts = stack.attempts(it.action_id);
      if (dispatchedActions.has(it.action_id)) {
        // Already past the gate when Stop was pressed: allowed to finish exactly as it would have.
        expect([sub, it.outcome]).toEqual([sub, RECORD.get(sub).expectedOutcomeAfterFirstPass]);
        expect([sub, attempts.length]).toEqual([sub, 1]);
        continue;
      }
      expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=? AND contract_id=?", t, it.contract_id)).toHaveLength(0);
      expect(stack.mq1<any>("SELECT auto_renew FROM m_contracts WHERE tenant_id=? AND id=?", t, it.contract_id)!.auto_renew).toBe(1);
      if (it.outcome === "NOT_STARTED") {
        notStarted++;
        expect([sub, stack.action(it.action_id).status, stack.q1<any>("SELECT status FROM grants WHERE action_id=?", it.action_id)!.status]).toEqual([sub, "REVOKED", "REVOKED"]);
        // Never claimed, or claimed and then stopped at the gate.
        expect(attempts.length).toBeLessThanOrEqual(1);
        if (attempts[0]) expect([sub, attempts[0].status, JSON.parse(attempts[0].outcome_json).gate]).toEqual([sub, "NOT_DISPATCHED", expect.stringMatching(/^(MANDATE_REVOKED|EPOCH_CHANGED)$/)]);
      } else {
        // Started before Stop and settled without dispatch (provider sign-in or changed terms).
        expect([sub, it.outcome]).toEqual([sub, expect.stringMatching(/^(NEEDS_AUTH|TERMS_CHANGED)$/)]);
        expect([sub, it.outcome]).toEqual([sub, RECORD.get(sub).expectedOutcomeAfterFirstPass]);
      }
    }
    expect(notStarted).toBeGreaterThan(0);
    expect(notStarted + journal.length + items.filter((i) => !dispatchedActions.has(i.action_id) && i.outcome !== "NOT_STARTED").length).toBe(120);
    expect(stack.q1<any>("SELECT status FROM batches WHERE id=?", batchId)!.status).toBe("STOPPED");
    const outcomesAfterStop = countBy(items, "outcome");

    // A replayed approval (double submit, retry) must not restart or reshape a stopped batch.
    const replay = await a.post(`/api/batches/${batchId}/approve`, { digest: review.proposalDigest, actionIds: ready });
    expect([200, 409]).toContain(replay.status);
    expect(stack.q1<any>("SELECT status FROM batches WHERE id=?", batchId)!.status).toBe("STOPPED");
    expect(countBy(stack.q<any>("SELECT outcome FROM batch_items WHERE batch_id=? AND selected=1", batchId), "outcome")).toEqual(outcomesAfterStop);
    expect(stack.q("SELECT id FROM mandates WHERE proposal_id=?", review.proposalId)).toHaveLength(1);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM grants WHERE mandate_id=?", mandateId)!.n).toBe(120);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM jobs WHERE tenant_id=? AND kind='ACTION' AND status IN ('QUEUED','LEASED')", t)!.n).toBe(0);

    // Sentinel: the worker is alive and has drained the queue since; the stopped batch still has no new dispatch.
    const s = await stack.login("alex");
    const pause = await stack.propose(s, "A6", ["pause"]);
    await stack.approve(s, pause);
    await stack.waitAction(pause.actions[0].id, ["CONFIRMED"], 60_000);
    expect(stack.q("SELECT j.attempt_id FROM dispatch_journal j JOIN grants g ON g.id=j.grant_id WHERE g.mandate_id=?", mandateId)).toHaveLength(journal.length);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", t)).toHaveLength(journal.length);
    expect(stack.q1<any>("SELECT status FROM batches WHERE id=?", batchId)!.status).toBe("STOPPED");
    expect(funds(stack, t, ctx)).toBe(fundsBefore);

    const summary = await a.json(`/api/batches/${batchId}`);
    expect(summary.status).toBe("STOPPED");
    expect(summary.mandate.status).toBe("REVOKED");
    process.stdout.write(`[bulk-stop] stopped after ${journal.length} dispatches: ${JSON.stringify(outcomesAfterStop)}\n`);
  }, 240_000);
});
