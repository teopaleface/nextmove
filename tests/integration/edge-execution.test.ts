import http from "node:http";
import type net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, type Stack, type WorkerProc, balance, startStack, waitFor } from "./harness";

// Edge cases around proposals, approval and execution.
//   Approval: stale or wrong digests, bad selections (empty, unknown, foreign, duplicated ids), repeated and
//   concurrent approvals, approve/decline races, expiry and another tenant's proposal. Nothing is granted on refusal.
//   Merchant faults: a fault proxy sits between the worker and the merchant and answers a chosen operation with a
//   500, malformed JSON, a forged success or no answer at all. The action must stay UNKNOWN (never REFUSED, never
//   CONFIRMED without the merchant's own record), and reconciliation later confirms it exactly once.
//   Worker crash: kill -9 while the merchant's answer is withheld; the next worker reconciles instead of resending.
//   Money: exact-balance and one-ban-short payments, two payments that together exceed the balance on two workers,
//   paying from an account whose card is frozen, and a transfer whose spec names the same account on both sides.
//   Invariants at the end: one receipt per confirmed action and every ledger entry balanced.

/* ------------------------------------------------------------------------------------- fault proxy */

interface Fault {
  name: string;
  when: (method: string, path: string) => boolean;
  /** Forward to the merchant first (it commits) before answering with the fault. */
  forward: boolean;
  /** The answer the worker gets instead of the merchant's, or "hang" to never answer. */
  reply: { status: number; body: string } | "hang";
  times: number;
}

interface FaultHit {
  name: string;
  path: string;
  forwarded: boolean;
  upstreamStatus: number | null;
}

/** Worker → merchant proxy that can replace the answer to chosen requests. Unmatched traffic passes through. */
class FaultProxy {
  faults: Fault[] = [];
  hits: FaultHit[] = [];
  private open = new Set<http.ServerResponse>();
  private server = http.createServer((req, res) => void this.handle(req, res));
  port = 0;

  constructor(private target: URL) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  add(f: Omit<Fault, "times"> & { times?: number }) {
    this.faults.push({ times: 1, ...f });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const method = req.method ?? "GET";
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const fault = this.faults.find((f) => f.times > 0 && f.when(method, path));
    if (!fault) {
      try {
        const up = await this.forward(req, body);
        res.writeHead(up.status, up.headers);
        res.end(up.body);
      } catch {
        res.socket?.destroy();
      }
      return;
    }
    fault.times--;
    const hit: FaultHit = { name: fault.name, path, forwarded: false, upstreamStatus: null };
    this.hits.push(hit);
    if (fault.forward) {
      const up = await this.forward(req, body);
      hit.forwarded = true;
      hit.upstreamStatus = up.status;
    }
    if (fault.reply === "hang") {
      this.open.add(res);
      res.on("close", () => this.open.delete(res));
      return;
    }
    res.writeHead(fault.reply.status, { "content-type": "application/json" });
    res.end(fault.reply.body);
  }

  private forward(req: http.IncomingMessage, body: Buffer): Promise<{ status: number; headers: http.OutgoingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: this.target.host, "content-length": String(body.length) };
      delete headers.connection;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const r = http.request({ host: this.target.hostname, port: this.target.port, method: req.method, path: req.url, headers, agent: false }, (resp) => {
        const parts: Buffer[] = [];
        resp.on("data", (c: Buffer) => parts.push(c));
        resp.on("end", () => {
          const h = { ...resp.headers };
          delete h["transfer-encoding"];
          delete h.connection;
          resolve({ status: resp.statusCode ?? 0, headers: h, body: Buffer.concat(parts) });
        });
        resp.on("error", reject);
      });
      r.on("error", reject);
      r.end(body);
    });
  }

  async close() {
    for (const res of this.open) res.socket?.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/* ------------------------------------------------------------------------------------------- setup */

let stack: Stack;
let proxy: FaultProxy;

beforeAll(async () => {
  stack = await startStack();
  proxy = new FaultProxy(new URL(stack.merchantUrl));
  await proxy.listen();
}, 120_000);
afterAll(async () => {
  await stack?.teardown();
  await proxy?.close();
});

/** Workers always reach the merchant through the fault proxy; with no fault armed it is transparent. */
const worker = () => stack.worker({ env: { NEXTMOVE_MERCHANT_BASE_URL: proxy.url } });

async function ensureWorkers(n: number) {
  const live = stack.workers.filter((w) => w.running);
  for (let i = live.length; i < n; i++) await worker();
}

const SETTLED = ["CONFIRMED", "REFUSED", "UNKNOWN", "BLOCKED", "TERMS_CHANGED", "NO_CHANGE", "OUTDATED", "REVOKED", "EXPIRED", "PENDING"];

const approveRaw = (a: Api, id: string, body: unknown) => a.post(`/api/proposals/${id}/approve`, body);
const grantsOf = (proposalId: string) => stack.q<any>("SELECT g.id FROM grants g JOIN proposal_actions pa ON pa.id=g.action_id WHERE pa.proposal_id=?", proposalId);
const jobsOf = (proposalId: string) => stack.q<any>("SELECT j.id FROM jobs j JOIN proposal_actions pa ON pa.id=j.ref_id WHERE pa.proposal_id=?", proposalId);
const mandatesOf = (proposalId: string) => stack.q<any>("SELECT id FROM mandates WHERE proposal_id=?", proposalId);
const receiptsOf = (actionId: string) => stack.q<any>("SELECT * FROM receipts WHERE action_id=?", actionId);
const merchantRequests = (t: string) => stack.mq<any>("SELECT id, correlation_id, idempotency_key, status, receipt_ref FROM m_requests WHERE tenant_id=?", t);

function sessionOf(a: Api) {
  return stack.q1<any>("SELECT tenant_id, user_id, active_context_id FROM sessions WHERE csrf_token=?", a.csrf)!;
}

/** Move an account's balance to exactly `target` (test setup: adjusts the opening balance, not the ledger). */
function setBalance(accountId: string, target: number) {
  stack.exec("UPDATE accounts SET opening_minor = opening_minor + ? WHERE id=?", target - balance(stack, accountId), accountId);
  expect(balance(stack, accountId)).toBe(target);
}

function streamlyOpsPath(t: string) {
  const contractId = stack.q1<any>("SELECT contract_id FROM subscriptions WHERE id=?", `${t}:sub:streamly`)!.contract_id as string;
  return { contractId, path: `/m/streamly/api/v1/contracts/${contractId}/operations` };
}

/* --------------------------------------------------------------------------------------- approval */

describe("approval edge cases", () => {
  it("a wrong, stale, empty or missing digest is refused and grants nothing", async () => {
    const a = await stack.login("alex");
    const p = await stack.propose(a, "A6", ["pause"]);
    const ids = p.actions.map((x) => x.id);
    // A second proposal for the same change has its own digest: the first proposal's digest is stale for it.
    const other = await stack.propose(a, "A6", ["pause"]);
    expect(other.digest).not.toBe(p.digest);
    for (const body of [{ digest: other.digest, actionIds: ids }, { digest: "", actionIds: ids }, { actionIds: ids }, { digest: p.digest.toUpperCase(), actionIds: ids }, { digest: ` ${p.digest}`, actionIds: ids }, { digest: [p.digest, "x"], actionIds: ids }, { digest: { d: p.digest }, actionIds: ids }]) {
      const r = await approveRaw(a, p.id, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.json.error).toBe("DIGEST_MISMATCH");
    }
    // Note: the router reads the digest with String(), so a one-element array holding the exact digest is accepted.
    // Harmless: it still has to equal the displayed digest character for character.
    // A body that is not JSON at all is not an approval either.
    const junk = await a.post(`/api/proposals/${p.id}/approve`, undefined, { raw: "digest=x", headers: { "content-type": "application/json" } });
    expect([400, 409]).toContain(junk.status);
    expect(mandatesOf(p.id)).toHaveLength(0);
    expect(grantsOf(p.id)).toHaveLength(0);
    expect(jobsOf(p.id)).toHaveLength(0);
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("READY");
    // The right digest still works afterwards.
    expect((await stack.approve(a, p)).alreadyApproved).toBe(false);
  });

  it("empty, unknown, foreign or malformed action selections are 400 BAD_SELECTION; duplicates of one id grant once", async () => {
    const a = await stack.login("alex");
    const p = await stack.propose(a, "A6", ["pause"]);
    const foreign = await stack.propose(a, "T3", ["verify-student"], { studentIdNumber: "S123456789012" });
    const mine = p.actions[0].id;
    for (const actionIds of [[], ["pa_does_not_exist"], [foreign.actions[0].id], [mine, "pa_does_not_exist"], [mine, foreign.actions[0].id], "pa_x", null, [{ id: mine }]]) {
      const r = await approveRaw(a, p.id, { digest: p.digest, actionIds });
      expect(r.status, JSON.stringify(actionIds)).toBe(400);
      expect(r.json.error).toBe("BAD_SELECTION");
    }
    expect(mandatesOf(p.id)).toHaveLength(0);
    expect(grantsOf(p.id)).toHaveLength(0);
    expect(grantsOf(foreign.id)).toHaveLength(0);
    expect(stack.action(foreign.actions[0].id).status).toBe("PROPOSED");

    // The same id repeated is one selection, not two grants.
    const dup = await approveRaw(a, p.id, { digest: p.digest, actionIds: [mine, mine, mine] });
    expect(dup.status).toBe(200);
    expect(dup.json.grants).toHaveLength(1);
    expect(grantsOf(p.id)).toHaveLength(1);
    expect(jobsOf(p.id)).toHaveLength(1);
    // Replaying with the deduplicated selection is the same approval.
    expect((await stack.approve(a, p)).alreadyApproved).toBe(true);
  });

  it("approving twice, sequentially and concurrently, yields one mandate, one grant and one job", async () => {
    const a = await stack.login("alex");
    const p = await stack.propose(a, "A6", ["pause"]);
    const results = await Promise.all(Array.from({ length: 6 }, () => approveRaw(a, p.id, { digest: p.digest, actionIds: [p.actions[0].id] })));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(results.filter((r) => r.json.alreadyApproved === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json.mandateId)).size).toBe(1);
    expect(new Set(results.map((r) => r.json.grants[0].grantId)).size).toBe(1);
    const again = await stack.approve(a, p);
    expect(again.alreadyApproved).toBe(true);
    expect(mandatesOf(p.id)).toHaveLength(1);
    expect(grantsOf(p.id)).toHaveLength(1);
    expect(jobsOf(p.id)).toHaveLength(1);
    expect(stack.q("SELECT id FROM outbox WHERE ref_id=?", p.actions[0].id)).toHaveLength(1);
  });

  it("decline and approve exclude each other, in either order and when raced", async () => {
    const a = await stack.login("alex");
    // Decline, then approve: refused, nothing granted. Declining again is idempotent.
    const d = await stack.propose(a, "A6", ["pause"]);
    expect((await a.ok(`/api/proposals/${d.id}/decline`)).already).toBe(false);
    const late = await approveRaw(a, d.id, { digest: d.digest, actionIds: [d.actions[0].id] });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("NOT_READY");
    expect((await a.ok(`/api/proposals/${d.id}/decline`)).already).toBe(true);
    expect(grantsOf(d.id)).toHaveLength(0);
    expect(stack.action(d.actions[0].id).status).toBe("NOT_STARTED");

    // Approve, then decline: the decline is refused and the approval stands. (A fresh tenant each time: while one
    // Streamly change is approved, another cannot be proposed.)
    const b = await stack.login("alex");
    const p = await stack.propose(b, "A6", ["pause"]);
    await stack.approve(b, p);
    const dec = await b.post(`/api/proposals/${p.id}/decline`, {});
    expect(dec.status).toBe(409);
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("APPROVED");
    expect(stack.action(p.actions[0].id).status).toBe("APPROVED");
    expect(stack.q1<any>("SELECT status FROM grants WHERE action_id=?", p.actions[0].id)!.status).toBe("ACTIVE");

    // Raced: exactly one of the two wins and the stored state agrees with the winner.
    for (let i = 0; i < 3; i++) {
      const c = await stack.login("alex");
      const r = await stack.propose(c, "A6", ["pause"]);
      const [ap, de] = await Promise.all([approveRaw(c, r.id, { digest: r.digest, actionIds: [r.actions[0].id] }), c.post(`/api/proposals/${r.id}/decline`, {})]);
      expect([ap.status, de.status].sort()).toEqual([200, 409]);
      const status = stack.q1<any>("SELECT status FROM proposals WHERE id=?", r.id)!.status;
      if (ap.status === 200) {
        expect(status).toBe("APPROVED");
        expect(grantsOf(r.id)).toHaveLength(1);
      } else {
        expect(status).toBe("DECLINED");
        expect(grantsOf(r.id)).toHaveLength(0);
        expect(jobsOf(r.id)).toHaveLength(0);
      }
    }
  });

  it("an expired proposal cannot be approved or declined into life", async () => {
    const a = await stack.login("alex");
    const p = await stack.propose(a, "A6", ["pause"]);
    await stack.clock(a, 31);
    const r = await approveRaw(a, p.id, { digest: p.digest, actionIds: [p.actions[0].id] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("PROPOSAL_EXPIRED");
    // Retrying the approval after the refusal is still refused (the proposal is persisted EXPIRED).
    const again = await approveRaw(a, p.id, { digest: p.digest, actionIds: [p.actions[0].id] });
    expect(again.status).toBe(409);
    expect((await a.post(`/api/proposals/${p.id}/decline`, {})).status).toBe(409);
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("EXPIRED");
    expect(grantsOf(p.id)).toHaveLength(0);
  });

  it("another tenant cannot approve, decline or read a proposal; the owner still can", async () => {
    const owner = await stack.login("alex");
    const intruder = await stack.login("alex");
    const p = await stack.propose(owner, "A6", ["pause"]);
    const ap = await approveRaw(intruder, p.id, { digest: p.digest, actionIds: [p.actions[0].id] });
    expect(ap.status).toBe(404);
    expect((await intruder.post(`/api/proposals/${p.id}/decline`, {})).status).toBe(404);
    expect((await intruder.get(`/api/proposals/${p.id}`)).status).toBe(404);
    expect((await intruder.get(`/api/actions/${p.actions[0].id}`)).status).toBe(404);
    expect(grantsOf(p.id)).toHaveLength(0);
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("READY");
    expect((await stack.approve(owner, p)).alreadyApproved).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------- merchant faults */

describe("merchant failures between the worker and the merchant", () => {
  let w: WorkerProc;
  beforeAll(async () => {
    await stack.stopWorkers();
    w = await worker();
  });

  /** Arm a fault on the A6 pause operation, approve it and wait for the first settlement. */
  async function pauseWithFault(fault: Omit<Fault, "when" | "times" | "name">) {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const { path } = streamlyOpsPath(t);
    const name = `${fault.forward ? "after" : "before"}-${t}`;
    proxy.add({ name, when: (m, p) => m === "POST" && p === path, ...fault });
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    await stack.approve(a, p);
    await waitFor(() => proxy.hits.find((h) => h.name === name), { label: `fault ${name} hit`, onTimeout: () => w.tail() });
    const first = await stack.waitAction(id, SETTLED, 30_000);
    return { a, t, id, first, hit: proxy.hits.find((h) => h.name === name)! };
  }

  /** Move the demo clock past the first reconciliation check and wait for the action to be confirmed. */
  async function reconcile(a: Api, id: string) {
    await stack.clock(a, 6);
    return stack.waitAction(id, ["CONFIRMED"], 45_000);
  }

  function expectHonestUnknown(id: string) {
    const action = stack.action(id);
    expect(action.status).toBe("UNKNOWN");
    expect(stack.attempts(id).map((x) => x.status)).toEqual(["UNKNOWN"]);
    expect(stack.attempts(id)[0].next_reconcile_at).toBeTruthy();
    expect(receiptsOf(id)).toHaveLength(0);
  }

  function expectConfirmedOnce(t: string, id: string) {
    const reqs = merchantRequests(t);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("CONFIRMED");
    const receipts = receiptsOf(id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].issuer_reference).toBe(reqs[0].receipt_ref);
    expect(stack.attempts(id)).toHaveLength(1);
    expect(stack.attempts(id)[0].status).toBe("CONFIRMED");
    expect(stack.attempts(id)[0].idempotency_key).toBe(reqs[0].idempotency_key);
    expect(stack.q("SELECT id FROM forecast_events WHERE tenant_id=? AND id LIKE ?", t, `rcp:streamly:${receipts[0].issuer_reference}%`).length).toBeLessThanOrEqual(1);
  }

  it("a 500 before the merchant saw the request is UNKNOWN, then the same idempotent request is replayed once", async () => {
    const { a, t, id, hit } = await pauseWithFault({ forward: false, reply: { status: 500, body: JSON.stringify({ error: "INTERNAL", message: "Merchant error" }) } });
    expect(hit.forwarded).toBe(false);
    expectHonestUnknown(id);
    expect(merchantRequests(t)).toHaveLength(0);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("a 500 after the merchant committed is UNKNOWN, and reconciliation finds the commit without resending", async () => {
    const { a, t, id, hit } = await pauseWithFault({ forward: true, reply: { status: 500, body: JSON.stringify({ error: "INTERNAL", message: "Merchant error" }) } });
    expect(hit.upstreamStatus).toBe(200);
    expectHonestUnknown(id);
    expect(merchantRequests(t)).toHaveLength(1);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("a 502 with an HTML body from something in between is UNKNOWN, not a refusal", async () => {
    const { a, t, id } = await pauseWithFault({ forward: true, reply: { status: 502, body: "<html><body>Bad gateway</body></html>" } });
    expectHonestUnknown(id);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("a 200 with malformed JSON after the commit is UNKNOWN, then confirmed from the merchant's records", async () => {
    const { a, t, id } = await pauseWithFault({ forward: true, reply: { status: 200, body: '{"status":"CONFIRMED","request":{' } });
    expectHonestUnknown(id);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("an empty 200 answer is UNKNOWN, not a crash and not a success", async () => {
    const { a, t, id } = await pauseWithFault({ forward: true, reply: { status: 200, body: "" } });
    expectHonestUnknown(id);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("a forged success the merchant never recorded is not confirmed; the forged reference never becomes a receipt", async () => {
    const forged = {
      status: "CONFIRMED",
      request: { requestId: "req_forged", correlationId: "corr_forged", operation: "PAUSE", status: "CONFIRMED", receipt: null, reason: null, createdAt: new Date().toISOString(), resolvedAt: null },
      receipt: { reference: "FORGED-0001", merchantId: "streamly", accountId: "x", contractId: "x", operation: "PAUSE", status: "CONFIRMED", effectiveAt: null, accessUntil: null, termsRevision: 99, correlationId: "corr_forged", channel: "API", details: {}, createdAt: new Date().toISOString() },
    };
    const { a, t, id } = await pauseWithFault({ forward: false, reply: { status: 200, body: JSON.stringify(forged) } });
    expectHonestUnknown(id);
    expect(JSON.parse(stack.action(id).result_json).reason).toMatch(/do not show the request/i);
    expect(merchantRequests(t)).toHaveLength(0);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
    expect(stack.q("SELECT id FROM receipts WHERE issuer_reference='FORGED-0001'")).toHaveLength(0);
  });

  it("no answer at all (client timeout) after the commit is UNKNOWN; reconciliation confirms it once", async () => {
    const { a, t, id, first } = await pauseWithFault({ forward: true, reply: "hang" });
    expect(first.status).toBe("UNKNOWN");
    expectHonestUnknown(id);
    expect(JSON.parse(stack.action(id).result_json).reason).toMatch(/no answer/i);
    await reconcile(a, id);
    expectConfirmedOnce(t, id);
  });

  it("kill -9 while the merchant's answer is withheld: the next worker reconciles instead of resending", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    const { path } = streamlyOpsPath(t);
    const name = `crash-${t}`;
    proxy.add({ name, when: (m, p) => m === "POST" && p === path, forward: true, reply: "hang" });
    const p = await stack.propose(a, "A6", ["pause"]);
    const id = p.actions[0].id;
    await stack.approve(a, p);
    await waitFor(() => proxy.hits.find((h) => h.name === name && h.forwarded) && stack.attempts(id)[0]?.status === "SENT", { label: "committed, answer withheld", onTimeout: () => w.tail() });
    await w.kill9();
    expect(merchantRequests(t)).toHaveLength(1);
    // The lease would run out after 30 s; expire it now instead of waiting.
    stack.exec("UPDATE jobs SET lease_expires_at=? WHERE kind='ACTION' AND ref_id=?", new Date(Date.now() - 1000).toISOString(), id);
    w = await worker();
    await stack.waitAction(id, ["CONFIRMED"], 45_000);
    expectConfirmedOnce(t, id);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM dispatch_journal d JOIN attempts at ON at.id=d.attempt_id WHERE at.action_id=?", id)!.n).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------ money */

describe("money", () => {
  beforeAll(async () => {
    await ensureWorkers(1);
  });

  async function billAndAccount(a: Api, index = 0) {
    const pp = await a.json("/api/payments/payees");
    const bill = pp.payees[index];
    const from = pp.accounts.find((x: any) => x.kind !== "EXTERNAL_CLEARING" && x.card) ?? pp.accounts[0];
    return { bill, from, pp };
  }

  const paymentPostings = (t: string, actionId: string) => stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, `payment:${stack.action(actionId).logical_key}`);

  it("a payment of exactly the whole balance goes through and leaves zero", async () => {
    const a = await stack.login("alex");
    const { bill, from } = await billAndAccount(a);
    setBalance(from.id, bill.amountMinor);
    const d = await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    await stack.approve(a, d);
    const done = await stack.waitAction(d.actions[0].id, ["CONFIRMED", "REFUSED"]);
    expect(done.status).toBe("CONFIRMED");
    expect(balance(stack, from.id)).toBe(0);
    expect(paymentPostings(a.tenantId, d.actions[0].id)).toHaveLength(1);
    expect(receiptsOf(d.actions[0].id)).toHaveLength(1);
    expect(stack.q1<any>("SELECT status FROM forecast_items WHERE id=?", bill.forecastItemId)!.status).not.toBe("SCHEDULED");
  });

  it("one ban short is refused: nothing posted, no receipt, and the bill can be paid later", async () => {
    const a = await stack.login("alex");
    const { bill, from } = await billAndAccount(a);
    setBalance(from.id, bill.amountMinor - 1);
    const d = await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    expect(JSON.stringify(d)).toMatch(/does not hold enough money/);
    await stack.approve(a, d);
    const done = await stack.waitAction(d.actions[0].id, ["CONFIRMED", "REFUSED"]);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toMatch(/insufficient funds/i);
    expect(balance(stack, from.id)).toBe(bill.amountMinor - 1);
    expect(paymentPostings(a.tenantId, d.actions[0].id)).toHaveLength(0);
    expect(receiptsOf(d.actions[0].id)).toHaveLength(0);
    expect(stack.q1<any>("SELECT status FROM forecast_items WHERE id=?", bill.forecastItemId)!.status).toBe("SCHEDULED");
    // After funds arrive, a fresh draft for the same bill is allowed and pays.
    setBalance(from.id, bill.amountMinor);
    const again = await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    await stack.approve(a, again);
    expect((await stack.waitAction(again.actions[0].id, ["CONFIRMED", "REFUSED"])).status).toBe("CONFIRMED");
    expect(balance(stack, from.id)).toBe(0);
  });

  it("two payments that together exceed the balance, run by two workers: one pays, the other is refused, no overdraft", async () => {
    await ensureWorkers(2);
    const a = await stack.login("alex");
    const { pp, from } = await billAndAccount(a);
    expect(pp.payees.length).toBeGreaterThanOrEqual(2);
    const [b1, b2] = pp.payees;
    const start = b1.amountMinor + b2.amountMinor - 1;
    setBalance(from.id, start);
    const d1 = await a.ok("/api/payments/draft", { forecastItemId: b1.forecastItemId, fromAccountId: from.id });
    const d2 = await a.ok("/api/payments/draft", { forecastItemId: b2.forecastItemId, fromAccountId: from.id });
    await Promise.all([stack.approve(a, d1), stack.approve(a, d2)]);
    const [r1, r2] = await Promise.all([stack.waitAction(d1.actions[0].id, ["CONFIRMED", "REFUSED"]), stack.waitAction(d2.actions[0].id, ["CONFIRMED", "REFUSED"])]);
    expect([r1.status, r2.status].sort()).toEqual(["CONFIRMED", "REFUSED"]);
    const paid = r1.status === "CONFIRMED" ? b1.amountMinor : b2.amountMinor;
    expect(balance(stack, from.id)).toBe(start - paid);
    expect(balance(stack, from.id)).toBeGreaterThanOrEqual(0);
    expect(receiptsOf(d1.actions[0].id).length + receiptsOf(d2.actions[0].id).length).toBe(1);
  });

  it("a frozen card does not stop a bill payment from its account (only card payments are declined)", async () => {
    const a = await stack.login("alex");
    const { bill, from } = await billAndAccount(a);
    expect(from.card?.status).toBe("ACTIVE");
    const freeze = await a.ok(`/api/cards/${encodeURIComponent(from.id)}/draft`, { freeze: true });
    await stack.approve(a, freeze);
    expect((await stack.waitAction(freeze.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED"])).status).toBe("CONFIRMED");
    // Freezing twice is refused at the draft: nothing to change.
    expect((await a.post(`/api/cards/${encodeURIComponent(from.id)}/draft`, { freeze: true })).status).toBe(409);
    setBalance(from.id, bill.amountMinor + 500);
    const d = await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id });
    await stack.approve(a, d);
    expect((await stack.waitAction(d.actions[0].id, ["CONFIRMED", "REFUSED"])).status).toBe("CONFIRMED");
    expect(balance(stack, from.id)).toBe(500);
    expect(JSON.parse(stack.q1<any>("SELECT card_json FROM accounts WHERE id=?", from.id)!.card_json).status).toBe("FROZEN");
  });

  it("a transfer whose spec names the same account on both sides is refused before the gate; nothing posts", async () => {
    const a = await stack.login("alex");
    const s = sessionOf(a);
    const { from } = await billAndAccount(a);
    const before = balance(stack, from.id);
    const { createProposal } = await import("../../src/server/authority/authority");
    const { internalTransferSpec } = await import("../../src/server/execution/internal-transfer");
    const acct = { id: from.id, name: from.name, balanceMinor: before };
    const spec = internalTransferSpec({
      capability: "O8",
      subjectRef: from.id,
      from: acct,
      to: acct,
      params: { amountMinor: 1000, mode: "EXACT", executeAt: null, returnEarlyBelowMinor: null, purpose: "MANUAL", description: "Same-account test", planId: null, legId: "leg-same", openPocket: null },
      title: "Move to the same account",
      summary: "Test",
    });
    const created = createProposal(stack.db, { tenantId: s.tenant_id, contextId: s.active_context_id, actorUserId: s.user_id, scope: "SINGLE", actions: [{ key: "same", spec }] });
    const actionId = stack.q1<any>("SELECT id FROM proposal_actions WHERE proposal_id=?", created.id)!.id;
    const r = await approveRaw(a, created.id, { digest: created.digest, actionIds: [actionId] });
    expect(r.status).toBe(200);
    const done = await stack.waitAction(actionId, ["CONFIRMED", "REFUSED", "BLOCKED"]);
    expect(done.status).toBe("REFUSED");
    expect(JSON.parse(done.result_json).reason).toMatch(/same account/i);
    expect(stack.attempts(actionId).map((x) => x.dispatched_at)).toEqual([null]);
    expect(stack.q("SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", s.tenant_id, `transfer:${done.logical_key}`)).toHaveLength(0);
    expect(balance(stack, from.id)).toBe(before);
    expect(receiptsOf(actionId)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------- invariants */

describe("invariants across everything this file ran", () => {
  it("every confirmed action has exactly one receipt, no unconfirmed action has one, and every ledger entry balances", () => {
    const confirmed = stack.q<any>("SELECT pa.id, (SELECT COUNT(*) FROM receipts r WHERE r.action_id=pa.id) n FROM proposal_actions pa WHERE pa.status='CONFIRMED'");
    expect(confirmed.length).toBeGreaterThan(5);
    expect(confirmed.filter((x) => x.n !== 1)).toEqual([]);
    const stray = stack.q<any>("SELECT r.id, pa.status FROM receipts r JOIN proposal_actions pa ON pa.id=r.action_id WHERE pa.status != 'CONFIRMED'");
    expect(stray).toEqual([]);
    const unbalanced = stack.q<any>("SELECT entry_id, SUM(amount_minor) s FROM ledger_lines GROUP BY entry_id HAVING SUM(amount_minor) != 0");
    expect(unbalanced).toEqual([]);
    // Each confirmed attempt carries its own dispatch authorization; no action was dispatched twice.
    const twice = stack.q<any>("SELECT at.action_id, COUNT(*) n FROM dispatch_journal d JOIN attempts at ON at.id=d.attempt_id GROUP BY at.action_id HAVING COUNT(*) > 1");
    expect(twice).toEqual([]);
    // The merchant never saw one idempotency key twice as two requests.
    const dupKeys = stack.mq<any>("SELECT idempotency_key, COUNT(*) n FROM m_requests WHERE idempotency_key IS NOT NULL GROUP BY tenant_id, merchant_id, idempotency_key HAVING COUNT(*) > 1");
    expect(dupKeys).toEqual([]);
  });
});
