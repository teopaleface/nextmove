import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, ROOT, type Stack, startStack, waitFor } from "./harness";

// Regressions from the core trust-boundary audit:
//   L2  a bank-internal step that crashed after the dispatch gate is reconciled against the bank's own records
//       (never the merchant): nothing recorded means nothing changed; a recorded result is confirmed once.
//   L5  request bodies and uploads are read incrementally and cut off at their limit, even without content-length.
//   L6  a merchant order charged above the approved maximum is not a success: no receipt, and the attempt and the
//       action agree.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 120_000);
afterAll(async () => {
  await stack?.teardown();
});

/* ------------------------------------------------------------------------------------------- helpers */

/** A body that streams `chunk` until `max` bytes, recording how much the server pulled and whether it gave up. */
function endless(chunk: Uint8Array, max: number) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (seen.pulled >= max) return ctrl.close();
      seen.pulled += chunk.byteLength;
      ctrl.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

/** Call the router directly with a streamed (chunked, no content-length) body; the harness server would buffer it. */
async function streamed(api: Api | null, p: string, body: ReadableStream<Uint8Array>, contentType: string) {
  const headers: Record<string, string> = { "content-type": contentType, host: `127.0.0.1:${stack.bankPort}` };
  if (api) {
    headers.cookie = api.cookie;
    headers["x-csrf-token"] = api.csrf;
  }
  const req = new Request(`${stack.bankUrl}/api${p}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  const res = await stack.router.handleApi(req, p.split("/").filter(Boolean));
  return { status: res.status, json: await res.json().catch(() => null) };
}

function chunked(bytes: Uint8Array, size: number) {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (at >= bytes.byteLength) return ctrl.close();
      ctrl.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

const CHUNK = new Uint8Array(16 * 1024).fill(0x20);

/** Pretend a worker claimed the action's job, passed the dispatch gate and died before its bank step committed. */
function crashAfterGate(actionId: string) {
  const action = stack.action(actionId);
  const grant = stack.q1<any>("SELECT * FROM grants WHERE action_id=?", actionId)!;
  const job = stack.q1<any>("SELECT * FROM jobs WHERE kind='ACTION' AND ref_id=?", actionId)!;
  const fence = job.fence + 1;
  const attemptId = `att_crash_${actionId.slice(-8)}`;
  const past = new Date(Date.now() - 60_000).toISOString();
  stack.exec("UPDATE jobs SET status='LEASED', lease_owner='worker-that-died', lease_expires_at=?, fence=?, attempts=attempts+1 WHERE id=?", past, fence, job.id);
  stack.exec(
    `INSERT INTO attempts(id, action_id, logical_key, grant_id, tenant_id, job_id, fence, route, status, idempotency_key, correlation_id, started_at, dispatched_at)
     VALUES (?,?,?,?,?,?,?, 'BANK_INTERNAL', 'DISPATCH_AUTHORIZED', ?, ?, ?, ?)`,
    attemptId, actionId, action.logical_key, grant.id, action.tenant_id, job.id, fence, `idem_crash_${actionId}`, `corr_crash_${actionId}`, past, past,
  );
  stack.exec("UPDATE grants SET status='CONSUMED', consumed_by_attempt=? WHERE id=?", attemptId, grant.id);
  stack.exec("UPDATE proposal_actions SET status='EXECUTING' WHERE id=?", actionId);
  return attemptId;
}

async function paymentDraft(a: Api) {
  const pp = await a.json("/api/payments/payees");
  const bill = pp.payees[0];
  const from = pp.accounts.find((x: any) => x.balanceMinor >= bill.amountMinor) ?? pp.accounts[0];
  return { draft: await a.ok("/api/payments/draft", { forecastItemId: bill.forecastItemId, fromAccountId: from.id }), from };
}

const postings = (t: string, src: string) => stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", t, src)!.n as number;

/* --------------------------------------------------------------------------------------------- L5 */

describe("L5: bounded request bodies", () => {
  it("cuts off a chunked JSON body at 256 KB instead of buffering it", async () => {
    const a = await stack.login("alex");
    const { body, seen } = endless(CHUNK, 50 * 1024 * 1024);
    const r = await streamed(a, "/preferences", body, "application/json");
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "TOO_LARGE", message: "Request too large" });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(256 * 1024 + 4 * CHUNK.byteLength);
  });

  it("still accepts a small chunked JSON body", async () => {
    const a = await stack.login("alex");
    const r = await streamed(a, "/preferences", chunked(new TextEncoder().encode(JSON.stringify({ key: "simple_mode", value: true })), 7), "application/json");
    expect(r.status).toBe(200);
    expect(r.json.value).toBe(true);
  });

  it("refuses a declared content-length over the limit before reading", async () => {
    const a = await stack.login("alex");
    const r = await a.post("/api/preferences", undefined, { raw: Buffer.alloc(300 * 1024, 0x20), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
  });

  it("cuts off a chunked upload at 5 MB", async () => {
    const a = await stack.login("alex");
    const { body, seen } = endless(new Uint8Array(64 * 1024).fill(0x41), 200 * 1024 * 1024);
    const r = await streamed(a, "/uploads", body, "multipart/form-data; boundary=----nm");
    expect(r.status).toBe(413);
    expect(r.json.error).toBe("TOO_LARGE");
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(5 * 1024 * 1024 + 4 * 64 * 1024);
  });

  it("still accepts a chunked image upload under the limit", async () => {
    const a = await stack.login("alex");
    const png = fs.readFileSync(path.join(ROOT, "fixtures", "images", "student-id.png"));
    const form = new FormData();
    form.set("file", new Blob([png], { type: "image/png" }), "student-id.png");
    form.set("label", "Student ID");
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const r = await streamed(a, "/uploads", chunked(bytes, 32 * 1024), encoded.headers.get("content-type")!);
    expect(r.status).toBe(200);
    expect(r.json.upload.bytes).toBe(png.length);
  });

  it("cuts off a chunked inbox event at 64 KB (unauthenticated route)", async () => {
    const { body, seen } = endless(CHUNK, 50 * 1024 * 1024);
    const r = await streamed(null, "/inbox/merchant", body, "application/json");
    expect(r.status).toBe(413);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(64 * 1024 + 4 * CHUNK.byteLength);
  });
});

/* --------------------------------------------------------------------------------------------- L2 */

describe("L2: bank-internal steps reconcile against the bank's records", () => {
  it("a payment that crashed after the gate with nothing posted settles as nothing changed, without asking the merchant", async () => {
    await stack.stopWorkers();
    const a = await stack.login("alex");
    const t = a.tenantId;
    const { draft } = await paymentDraft(a);
    await stack.approve(a, draft);
    const actionId = draft.actions[0].id;
    const action = stack.action(actionId);
    const attemptId = crashAfterGate(actionId);
    const w = await stack.worker();
    const settled = await stack.waitAction(actionId, ["BLOCKED", "CONFIRMED"], 30_000);
    expect(settled.status, w.tail()).toBe("BLOCKED");
    expect(JSON.parse(settled.result_json).reason).toMatch(/nothing was changed/i);
    expect(stack.attempts(actionId).map((x) => [x.id, x.status])).toEqual([[attemptId, "BLOCKED"]]);
    expect(postings(t, `payment:${action.logical_key}`)).toBe(0);
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", actionId)).toHaveLength(0);
    // Read from the bank, once: no merchant lookup with null ids, no five-check UNKNOWN tail.
    expect(stack.q1<any>("SELECT reconcile_checks FROM attempts WHERE id=?", attemptId)!.reconcile_checks).toBe(1);
    expect(w.tail(200)).not.toMatch(/reconcile .* error/);
    // The bill is free to pay again with a fresh approval.
    expect((await a.json("/api/payments/payees")).payees.find((p: any) => p.forecastItemId === JSON.parse(action.spec_json).params.forecastItemId)?.draftPending).toBe(false);
  });

  it("a payment the bank did post is confirmed from its receipt and ledger entry, never posted twice", async () => {
    if (!stack.workers.some((w) => w.running)) await stack.worker();
    const a = await stack.login("alex");
    const t = a.tenantId;
    const { draft } = await paymentDraft(a);
    await stack.approve(a, draft);
    const actionId = draft.actions[0].id;
    await stack.waitAction(actionId, ["CONFIRMED"], 30_000);
    const action = stack.action(actionId);
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", actionId)!;
    // The worker's own bookkeeping is lost (as if it died after the commit was durable but before it was observed).
    const att = stack.attempts(actionId)[0];
    stack.exec("UPDATE attempts SET status='UNKNOWN', finished_at=NULL, next_reconcile_at=?, reconcile_checks=0 WHERE id=?", new Date(0).toISOString(), att.id);
    stack.exec("UPDATE proposal_actions SET status='UNKNOWN' WHERE id=?", actionId);
    await stack.waitAction(actionId, ["CONFIRMED", "BLOCKED"], 30_000);
    expect(stack.action(actionId).status).toBe("CONFIRMED");
    expect(stack.attempts(actionId)[0].status).toBe("CONFIRMED");
    expect(JSON.parse(stack.action(actionId).result_json).receiptId).toBe(receipt.id);
    expect(postings(t, `payment:${action.logical_key}`)).toBe(1);
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", actionId)).toHaveLength(1);
  });

  it("a card freeze that crashed after the gate leaves the card as it was", async () => {
    await stack.stopWorkers();
    const a = await stack.login("alex");
    const acct = (await a.json("/api/payments/payees")).accounts.find((x: any) => x.card?.status === "ACTIVE");
    const draft = await a.ok(`/api/cards/${encodeURIComponent(acct.id)}/draft`, { freeze: true });
    await stack.approve(a, draft);
    const actionId = draft.actions[0].id;
    crashAfterGate(actionId);
    await stack.worker();
    const settled = await stack.waitAction(actionId, ["BLOCKED", "CONFIRMED"], 30_000);
    expect(settled.status).toBe("BLOCKED");
    expect(JSON.parse(stack.q1<any>("SELECT card_json FROM accounts WHERE id=?", acct.id)!.card_json).status).toBe("ACTIVE");
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", actionId)).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------------------------- L6 */

describe("L6: an order charged above the approval", () => {
  it("is not confirmed: no receipt, no booking, and the attempt and action agree", async () => {
    await stack.stopWorkers();
    const a = await stack.login("alex");
    const t = a.tenantId;
    await a.ok("/api/capabilities/A14/verify");
    const p = await stack.propose(a, "A14", ["buy-datapass"]);
    await stack.approve(a, p);
    const actionId = p.actions[0].id;
    const spec = JSON.parse(stack.action(actionId).spec_json);
    const charge = Number(spec.params.cardChargeMinor);
    expect(charge).toBeGreaterThan(0);
    // The merchant charges what the order says; the approval now covers less than that.
    stack.exec("UPDATE grants SET max_debit_minor=? WHERE action_id=?", charge - 100, actionId);
    await stack.worker();
    await waitFor(() => stack.attempts(actionId).find((x) => !["CLAIMED", "DISPATCH_AUTHORIZED", "SENT"].includes(x.status)), { timeout: 30_000, label: "order attempt settled", onTimeout: () => stack.workerLogs() });
    const action = stack.action(actionId);
    const attempts = stack.attempts(actionId);
    expect(action.status).toBe("UNKNOWN");
    expect(attempts.map((x) => x.status)).toEqual(["UNKNOWN"]);
    const result = JSON.parse(action.result_json);
    expect(result.code).toBe("CHARGE_ABOVE_APPROVED");
    expect(result.reason).toMatch(/more than the .* you approved/);
    expect(JSON.parse(attempts[0].outcome_json).code).toBe("CHARGE_ABOVE_APPROVED");
    expect(stack.q("SELECT id FROM receipts WHERE action_id=?", actionId)).toHaveLength(0);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM ledger_entries WHERE tenant_id=? AND source_event_id LIKE 'card:%'", t)!.n).toBe(0);
    expect(stack.q("SELECT id FROM notifications WHERE tenant_id=? AND title LIKE '%confirmed%'", t).length).toBe(0);
  });
});
