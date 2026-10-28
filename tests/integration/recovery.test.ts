import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Stack, descendants, funds, startStack, waitFor } from "./harness";

// A worker is killed with SIGKILL while four ACTION jobs are leased, each held at a different point by the
// harness proxy between the worker and the merchant:
//   web     T2 FitFlow stop, isolated browser: the provider committed the web form; its answer is held.
//   commit  A6 Streamly pause, partner API: the provider committed; its answer is held.
//   lost    T3 student verification, partner API: sent by the worker, never reached the provider.
//   claimed A7 StudioMart follow-up: claimed, held at its pre-dispatch read, before the dispatch gate.
// A new worker must recover the expired leases: the claimed attempt is closed NOT_DISPATCHED and runs again
// normally; the three dispatched attempts become UNKNOWN and are reconciled, so each change happens exactly once.

const decodedPath = (p: string) => decodeURIComponent(p.split("?")[0]);
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ proxy: true });
}, 120_000);

afterAll(async () => {
  await stack?.teardown();
});

describe("13. process restart", () => {
  it("kill -9 mid-flight: leases recovered, dispatched attempts reconciled without a second effect, undispatched ones rerun", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const ctx = stack.q1<any>("SELECT active_context_id FROM sessions WHERE csrf_token=?", a.csrf)!.active_context_id;
    const fundsBefore = funds(stack, t, ctx);
    const ledgerBefore = stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=?", t)!.n;
    const contract = (local: string) => stack.q1<any>("SELECT contract_id FROM subscriptions WHERE id=?", `${t}:sub:${local}`)!.contract_id as string;
    const fitflow = contract("fitflow");
    const streamly = contract("streamly");

    const proposals = {
      web: await stack.propose(a, "T2", ["stop-fitflow"]),
      commit: await stack.propose(a, "A6", ["pause"]),
      lost: await stack.propose(a, "T3", ["verify-student"], { studentIdNumber: "S123456789012" }),
      claimed: await stack.propose(a, "A7", ["follow-up"]),
    };
    type K = keyof typeof proposals;
    const id = Object.fromEntries(Object.entries(proposals).map(([k, p]) => [k, p.actions[0].id])) as Record<K, string>;
    const status = (k: K) => stack.attempts(id[k])[0]?.status;
    const proxy = stack.proxy!;
    const webPath = `/m/fitflow/account/contracts/${fitflow}/cancel`;
    const commitPath = `/m/streamly/api/v1/contracts/${streamly}/operations`;
    const lostPath = "/m/studyplus/api/v1/operations";
    proxy.hold({ name: "web", mode: "hold-after", when: (r) => r.method === "POST" && decodedPath(r.path) === webPath });
    proxy.hold({ name: "commit", mode: "hold-after", when: (r) => r.method === "POST" && decodedPath(r.path) === commitPath });
    proxy.hold({ name: "lost", mode: "hold-before", when: (r) => r.method === "POST" && decodedPath(r.path) === lostPath });
    proxy.hold({ name: "claimed", mode: "hold-before", when: (r) => r.method === "GET" && decodedPath(r.path) === "/m/studiomart/api/v1/account" });
    const hit = (rule: string, forwarded: boolean) => proxy.hits.some((h) => h.rule === rule && h.forwarded === forwarded);

    const w1 = await stack.worker();
    // The browser item first (it has to launch Chromium); then the three API items, so every hold is fresh,
    // well inside the worker's own 8-12 s request timeouts, when the worker dies.
    await stack.approve(a, proposals.web);
    await waitFor(() => hit("web", true) && status("web") === "DISPATCH_AUTHORIZED", { timeout: 45_000, interval: 50, label: "web form committed, answer held", onTimeout: () => w1.tail() });
    for (const k of ["commit", "lost", "claimed"] as const) await stack.approve(a, proposals[k]);
    await waitFor(() => hit("commit", true) && hit("lost", false) && hit("claimed", false) && status("commit") === "SENT" && status("lost") === "SENT" && status("claimed") === "CLAIMED", {
      timeout: 6_000,
      interval: 25,
      label: "four items held mid-flight",
      onTimeout: () => `${JSON.stringify(Object.fromEntries((Object.keys(id) as K[]).map((k) => [k, status(k)])))}\n${w1.tail()}`,
    });
    // What the provider has actually recorded at the moment of the crash.
    const mreqs = (where: string, ...p: any[]) => stack.mq<any>(`SELECT * FROM m_requests WHERE tenant_id=? AND ${where}`, t, ...p);
    expect(mreqs("contract_id=?", fitflow).map((r) => [r.channel, r.status])).toEqual([["WEB", "CONFIRMED"]]);
    expect(mreqs("contract_id=?", streamly).map((r) => [r.channel, r.status])).toEqual([["API", "CONFIRMED"]]);
    expect(mreqs("merchant_id='studyplus'")).toHaveLength(0);
    expect(mreqs("merchant_id='studiomart'")).toHaveLength(0);
    const before = Object.fromEntries((Object.keys(id) as K[]).map((k) => [k, stack.attempts(id[k])[0]])) as Record<K, any>;

    const kids = descendants(w1.pid);
    expect(kids.length).toBeGreaterThan(0); // the isolated browser was running
    await w1.kill9();
    expect(w1.exitInfo?.signal).toBe("SIGKILL");
    expect(kids.filter(pidAlive)).toEqual([]); // nothing the dead worker launched is left behind
    proxy.clear();
    expect(stack.q("SELECT id FROM jobs WHERE tenant_id=? AND kind='ACTION' AND status='LEASED'", t)).toHaveLength(4); // until the leases expire

    const w2 = await stack.worker();
    for (const k of Object.keys(id) as K[]) await stack.waitAction(id[k], ["CONFIRMED"], 90_000);

    // The new worker recovered all four leases; three attempts had passed the gate and became UNKNOWN.
    const recovered = w2.logs.map((l) => /recovered (\d+) expired lease\(s\); (\d+) attempt\(s\) marked unknown/.exec(l)).filter((m): m is RegExpExecArray => Boolean(m));
    expect(recovered.reduce((s, m) => s + Number(m[1]), 0)).toBe(4);
    expect(recovered.reduce((s, m) => s + Number(m[2]), 0)).toBe(3);

    const posts = (path: string) => proxy.traffic.filter((x) => x.method === "POST" && decodedPath(x.path) === path);
    const receipts = (k: K) => stack.q<any>("SELECT * FROM receipts WHERE action_id=?", id[k]);
    const journal = (attemptId: string) => stack.q<any>("SELECT * FROM dispatch_journal WHERE attempt_id=?", attemptId);

    for (const k of ["web", "commit", "lost"] as const) {
      // Same attempt, reconciled to CONFIRMED: never a second attempt, one journal entry, one receipt.
      const atts = stack.attempts(id[k]);
      expect([k, atts.map((x) => x.id), atts[0].status]).toEqual([k, [before[k].id], "CONFIRMED"]);
      expect([k, atts[0].reconcile_checks >= 1, journal(atts[0].id).length, receipts(k).length]).toEqual([k, true, 1, 1]);
      expect(receipts(k)[0].attempt_id).toBe(atts[0].id);
    }
    // web: the committed form is found by reading; a website request is never resubmitted.
    expect(mreqs("contract_id=?", fitflow)).toHaveLength(1);
    expect(mreqs("contract_id=?", fitflow)[0].correlation_id).toBe(before.web.correlation_id);
    expect(posts(webPath)).toHaveLength(1);
    expect(stack.q1<any>("SELECT state FROM subscriptions WHERE id=?", `${t}:sub:fitflow`)!.state).toBe("RENEWAL_OFF");
    // commit: the provider shows the request, so it is confirmed from the read-back and not replayed.
    expect(mreqs("contract_id=?", streamly)).toHaveLength(1);
    expect(posts(commitPath)).toHaveLength(1);
    // lost: not visible at the provider, so it was replayed once with the same idempotency key: one effect.
    const verifyReqs = mreqs("merchant_id='studyplus'");
    expect(verifyReqs.map((r) => [r.operation, r.status, r.correlation_id, r.idempotency_key])).toEqual([["VERIFY_ELIGIBILITY", "CONFIRMED", before.lost.correlation_id, before.lost.idempotency_key]]);
    expect(posts(lostPath)).toHaveLength(1); // the replay; the held original never reached the provider
    expect(proxy.hits.filter((h) => h.rule === "lost").every((h) => !h.forwarded)).toBe(true);
    // claimed: closed without dispatch, then run again normally under the same grant.
    const followAtts = stack.attempts(id.claimed);
    expect(followAtts.map((x) => x.status)).toEqual(["NOT_DISPATCHED", "CONFIRMED"]);
    expect(followAtts[0].id).toBe(before.claimed.id);
    expect(JSON.parse(followAtts[0].outcome_json).reason).toMatch(/before the dispatch gate/);
    expect([journal(followAtts[0].id).length, journal(followAtts[1].id).length]).toEqual([0, 1]);
    expect(mreqs("merchant_id='studiomart'").map((r) => [r.operation, r.correlation_id])).toEqual([["FOLLOW_UP", followAtts[1].correlation_id]]);
    expect(receipts("claimed")).toHaveLength(1);

    // Every grant consumed exactly once; no double forecast or ledger change.
    for (const k of Object.keys(id) as K[]) {
      const g = stack.q1<any>("SELECT * FROM grants WHERE action_id=?", id[k])!;
      expect([k, g.status, stack.q("SELECT attempt_id FROM dispatch_journal WHERE grant_id=?", g.id).length]).toEqual([k, "CONSUMED", 1]);
    }
    expect(stack.q("SELECT forecast_item_id FROM forecast_events WHERE tenant_id=? AND id LIKE 'rcp:%' GROUP BY forecast_item_id HAVING COUNT(*) > 1", t)).toEqual([]);
    expect(stack.q<any>("SELECT id FROM forecast_events WHERE tenant_id=? AND id LIKE 'rcp:%'", t).length).toBeGreaterThan(0);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=?", t)!.n).toBe(ledgerBefore);
    expect(funds(stack, t, ctx)).toBe(fundsBefore);
    expect(stack.q("SELECT id FROM jobs WHERE tenant_id=? AND kind='ACTION' AND status != 'DONE'", t)).toEqual([]);
    expect(w2.running).toBe(true);
  }, 180_000);
});
