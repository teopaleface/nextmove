import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, startStack, waitFor, rawRequest, type Stack } from "./harness";

// Tests 1–3 and request-hardening negatives: tenant isolation, CSRF/same-origin, forged and tampered approvals.

let stack: Stack;
let digestOf: (v: unknown) => string;
let canonicalJson: (v: unknown) => string;

beforeAll(async () => {
  stack = await startStack();
  ({ digestOf, canonicalJson } = await import("../../src/server/canonical"));
});
afterAll(async () => {
  await stack?.teardown();
});

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

async function multipart(file: { data: Buffer; type: string; filename: string }) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.filename);
  const req = new Request("http://127.0.0.1/", { method: "POST", body: fd });
  return { body: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get("content-type")! };
}

describe("1. wrong session / cross-tenant", () => {
  it("tenant B gets 404 for tenant A's proposal, action, receipt, task, upload, batch, mandate and screenshots", async () => {
    const a = await stack.login("alex");
    const worker = await stack.worker();
    try {
      // Tenant A builds up real objects: a confirmed API action, a confirmed browser action, a task, an upload, a batch.
      const pause = await stack.propose(a, "A6", ["pause"]);
      const pauseApproval = await stack.approve(a, pause);
      const pauseAction = pause.actions[0].id;
      await stack.waitAction(pauseAction, ["CONFIRMED"]);
      const receipt = stack.q1<any>("SELECT id FROM receipts WHERE action_id=?", pauseAction)!;
      const t2 = await stack.propose(a, "T2", ["stop-fitflow"]);
      await stack.approve(a, t2);
      await stack.waitAction(t2.actions[0].id, ["CONFIRMED"], 90_000);
      const browserAttempt = stack.attempts(t2.actions[0].id)[0];
      const shot = JSON.parse(browserAttempt.evidence_json).steps.find((s: any) => s.screenshot)?.screenshot as string;
      expect(shot).toMatch(/^att_[a-f0-9]+-\d+\.png$/);
      const task = await a.ok("/api/tasks", { text: "Which subscriptions should I keep?" });
      const upload = (await a.ok("/api/uploads/sample", { name: "student-id" })).upload;
      const extraction = await a.ok(`/api/uploads/${upload.id}/manual`, { kind: "STUDENT_ID", values: { studentIdNumber: "S000000000000" } });
      const batch = await a.ok("/api/batches");
      const pending = await stack.propose(a, "A3", ["annual"], { horizonMonths: 24 });
      const txn = (await a.json("/api/activity")).transactions[0].id as string;
      const permission = (await a.json("/api/permissions")).permissions[0].id as string;
      const subscription = `${a.tenantId}:sub:streamly`;
      const ctxA = `${a.tenantId}:personal`;

      const probes: [string, string, unknown?][] = [
        ["GET", `/api/proposals/${pending.id}`],
        ["POST", `/api/proposals/${pending.id}/approve`, { digest: pending.digest, actionIds: pending.actions.map((x) => x.id) }],
        ["POST", `/api/proposals/${pending.id}/decline`, {}],
        ["POST", `/api/mandates/${pauseApproval.mandateId}/stop`, {}],
        ["GET", `/api/actions/${pauseAction}`],
        ["POST", `/api/actions/${pauseAction}/check`, {}],
        ["GET", `/api/receipts/${receipt.id}`],
        ["GET", `/api/evidence/screens/${shot}`],
        ["GET", `/api/tasks/${task.taskId}`],
        ["GET", `/api/tasks/${task.taskId}/stream`],
        ["POST", `/api/tasks/${task.taskId}/answer`, { questionId: "q", answer: "yes" }],
        ["GET", `/api/uploads/${upload.id}/image`],
        ["POST", `/api/uploads/${upload.id}/extract`, { kind: "STUDENT_ID" }],
        ["POST", `/api/uploads/${upload.id}/manual`, { kind: "STUDENT_ID", values: { studentIdNumber: "S111111111111" } }],
        ["POST", `/api/extractions/${extraction.extractionId}/confirm`, { edits: {} }],
        ["GET", `/api/batches/${batch.batchId}`],
        ["POST", `/api/batches/${batch.batchId}/approve`, { digest: "x", actionIds: [] }],
        ["POST", `/api/batches/${batch.batchId}/stop`, {}],
        ["GET", `/api/batches/${batch.batchId}/export`],
        ["GET", `/api/transactions/${encodeURIComponent(txn)}`],
        ["GET", `/api/subscriptions/${encodeURIComponent(subscription)}`],
        ["POST", `/api/permissions/${permission}/revoke`, {}],
        ["POST", "/api/session/context", { contextId: ctxA }],
        ["POST", "/api/labs/merchant", { action: "fault", body: { contractId: `${a.tenantId}:streamly-standard`, kind: "MANUAL_REVIEW" } }],
      ];

      // The owner can reach every GET (so a 404 below is about ownership, not a wrong path).
      for (const [method, p] of probes) {
        if (method !== "GET" || p.endsWith("/stream")) continue; // the owner's stream stays open by design
        const r = await a.get(p);
        expect.soft(r.status, `owner ${p}`).toBe(200);
      }

      const before = {
        mandate: stack.q1<any>("SELECT status FROM mandates WHERE id=?", pauseApproval.mandateId)!.status,
        pending: stack.q1<any>("SELECT status FROM proposals WHERE id=?", pending.id)!.status,
        mandates: stack.q1<any>("SELECT COUNT(*) n FROM mandates")!.n,
        extraction: stack.q1<any>("SELECT status FROM extractions WHERE id=?", extraction.extractionId)!.status,
        facts: stack.q1<any>("SELECT COUNT(*) n FROM facts WHERE tenant_id=?", a.tenantId)!.n,
        permission: stack.q1<any>("SELECT status FROM permissions WHERE id=?", permission)!.status,
        extractions: stack.q1<any>("SELECT COUNT(*) n FROM extractions")!.n,
        modelCalls: stack.q1<any>("SELECT COUNT(*) n FROM model_calls")!.n,
        faults: stack.mq1<any>("SELECT COUNT(*) n FROM m_faults WHERE tenant_id=?", a.tenantId)!.n,
      };

      for (const other of [await stack.login("alex"), await stack.login("laziz")]) {
        for (const [method, p, body] of probes) {
          const r = method === "GET" ? await other.get(p) : await other.post(p, body);
          expect.soft(r.status, `${other.tenantId} ${method} ${p}`).toBe(404);
          expect.soft(r.json?.error, `${method} ${p}`).toBe("NOT_FOUND");
        }
        // Their session still points at their own context.
        const s = await other.json("/api/session");
        expect(s.context.id.startsWith(`${other.tenantId}:`)).toBe(true);
      }

      // Nothing about tenant A changed.
      expect(stack.q1<any>("SELECT status FROM mandates WHERE id=?", pauseApproval.mandateId)!.status).toBe(before.mandate);
      expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", pending.id)!.status).toBe(before.pending);
      expect(stack.q1<any>("SELECT COUNT(*) n FROM mandates")!.n).toBe(before.mandates);
      expect(stack.q1<any>("SELECT status FROM extractions WHERE id=?", extraction.extractionId)!.status).toBe(before.extraction);
      expect(stack.q1<any>("SELECT COUNT(*) n FROM facts WHERE tenant_id=?", a.tenantId)!.n).toBe(before.facts);
      expect(stack.q1<any>("SELECT status FROM permissions WHERE id=?", permission)!.status).toBe(before.permission);
      expect(stack.q1<any>("SELECT COUNT(*) n FROM extractions")!.n).toBe(before.extractions);
      expect(stack.q1<any>("SELECT COUNT(*) n FROM model_calls")!.n).toBe(before.modelCalls);
      expect(stack.mq1<any>("SELECT COUNT(*) n FROM m_faults WHERE tenant_id=?", a.tenantId)!.n).toBe(before.faults);
    } finally {
      await worker.stop();
    }
  });

  it("context-scoped items refuse from the wrong context (409 WRONG_CONTEXT)", async () => {
    const l = await stack.login("laziz");
    const session = await l.json("/api/session");
    const business = session.contexts.find((c: any) => c.kind === "BUSINESS").id;
    const personal = session.contexts.find((c: any) => c.kind === "PERSONAL").id;
    expect(session.context.id).toBe(business);

    const seats = await stack.propose(l, "A13", ["reduce-seats"]);
    expect(stack.q1<any>("SELECT context_id FROM proposals WHERE id=?", seats.id)!.context_id).toBe(business);
    await l.ok("/api/session/context", { contextId: personal });

    const approve = await l.post(`/api/proposals/${seats.id}/approve`, { digest: seats.digest, actionIds: seats.actions.map((a) => a.id) });
    expect(approve.status).toBe(409);
    expect(approve.json.error).toBe("WRONG_CONTEXT");
    const decline = await l.post(`/api/proposals/${seats.id}/decline`, {});
    expect(decline.status).toBe(409);
    expect(decline.json.error).toBe("WRONG_CONTEXT");
    const cap = await l.get("/api/capabilities/A13");
    expect(cap.status).toBe(409);
    expect(cap.json.error).toBe("WRONG_CONTEXT");
    const propose = await l.post("/api/capabilities/A13/propose", { keys: ["reduce-seats"] });
    expect(propose.status).toBe(409);
    expect(propose.json.error).toBe("WRONG_CONTEXT");
    const packet = await l.post("/api/business/packet", {});
    expect(packet.status).toBe(409);
    expect(packet.json.error).toBe("WRONG_CONTEXT");

    // Nothing was decided from the wrong context; the proposal is still approvable from its own context.
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", seats.id)!.status).toBe("READY");
    expect(stack.q<any>("SELECT id FROM mandates WHERE proposal_id=?", seats.id)).toHaveLength(0);
    expect(stack.q<any>("SELECT id FROM business_records WHERE tenant_id=? AND kind='FUNDING_PACKET'", l.tenantId)).toHaveLength(0);
    await l.ok("/api/session/context", { contextId: business });
    const ok = await l.post(`/api/proposals/${seats.id}/approve`, { digest: seats.digest, actionIds: seats.actions.map((a) => a.id) });
    expect(ok.status).toBe(200);
    expect(stack.q<any>("SELECT id FROM mandates WHERE proposal_id=?", seats.id)).toHaveLength(1);
  });
});

describe("2. CSRF, same-origin and authentication", () => {
  it("refuses mutations without the CSRF token, cross-site or from another origin; 401 without a session", async () => {
    const a = await stack.login("alex");
    const pref = () => stack.q<any>("SELECT value_json FROM preferences WHERE tenant_id=? AND key='hotspot_required'", a.tenantId);
    const body = { key: "hotspot_required", value: false };

    const noToken = await a.post("/api/preferences", body, { csrf: false });
    expect(noToken.status).toBe(403);
    expect(noToken.json.error).toBe("CSRF");
    const wrongToken = await a.post("/api/preferences", body, { csrf: "x".repeat(32) });
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.json.error).toBe("CSRF");
    const crossSite = await a.post("/api/preferences", body, { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.json.error).toBe("CROSS_SITE");
    const sameSite = await a.post("/api/preferences", body, { headers: { "sec-fetch-site": "same-site" } });
    expect(sameSite.status).toBe(403);
    const badOrigin = await a.post("/api/preferences", body, { headers: { origin: "http://evil.example" } });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json.error).toBe("BAD_ORIGIN");
    expect(pref()).toHaveLength(0);

    // The approval route is protected the same way: no mandate, no grant, no job.
    const p = await stack.propose(a, "A6", ["pause"]);
    const forged = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] }, { csrf: false });
    expect(forged.status).toBe(403);
    const forgedCross = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] }, { headers: { "sec-fetch-site": "cross-site" } });
    expect(forgedCross.status).toBe(403);
    expect(stack.q("SELECT id FROM mandates WHERE proposal_id=?", p.id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM jobs WHERE ref_id=?", p.actions[0].id)).toHaveLength(0);

    // Same-origin request with the token works.
    const good = await a.post("/api/preferences", body, { headers: { origin: a.base, "sec-fetch-site": "same-origin" } });
    expect(good.status).toBe(200);
    expect(pref()).toHaveLength(1);

    // Unauthenticated / forged cookie.
    const anon = stack.api();
    expect((await anon.get("/api/home")).status).toBe(401);
    expect((await anon.post("/api/preferences", body)).status).toBe(401);
    expect((await anon.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] })).status).toBe(401);
    const forgedCookie = stack.api();
    forgedCookie.cookie = "nm_session=forged-token-value";
    forgedCookie.csrf = a.csrf;
    expect((await forgedCookie.get("/api/home")).status).toBe(401);
    expect((await forgedCookie.post("/api/preferences", body)).status).toBe(401);

    // Login CSRF: a cross-site page cannot start a session.
    const tenants = stack.q1<any>("SELECT COUNT(*) n FROM tenants")!.n;
    const crossLogin = await stack.api().post("/api/session/demo", { customer: "alex", isolated: true }, { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossLogin.status).toBe(403);
    expect(crossLogin.headers["set-cookie"]).toBeUndefined();
    expect(stack.q1<any>("SELECT COUNT(*) n FROM tenants")!.n).toBe(tenants);

    // Cookie flags, then logout revokes server-side.
    const fresh = stack.api();
    const login = await fresh.post("/api/session/demo", { customer: "alex", isolated: true });
    const cookie = (login.headers["set-cookie"] ?? [])[0] ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    fresh.csrf = login.json.csrfToken;
    const saved = fresh.cookie;
    expect((await fresh.post("/api/session/logout", {})).status).toBe(200);
    fresh.cookie = saved; // a stolen copy of the old cookie no longer works
    expect((await fresh.get("/api/home")).status).toBe(401);
  });
});

describe("3. forged and tampered approvals", () => {
  async function noDispatchFor(actionIds: string[]) {
    for (const id of actionIds) {
      expect(stack.q("SELECT id FROM attempts WHERE action_id=? AND dispatched_at IS NOT NULL", id)).toHaveLength(0);
      expect(stack.q("SELECT d.attempt_id FROM dispatch_journal d JOIN attempts t ON t.id=d.attempt_id WHERE t.action_id=?", id)).toHaveLength(0);
    }
  }

  it("wrong digest → 409 DIGEST_MISMATCH; foreign action ids → 400; nothing is granted", async () => {
    const a = await stack.login("alex");
    const b = await stack.login("alex");
    const p = await stack.propose(a, "A6", ["pause"]);
    const other = await stack.propose(a, "T2", ["stop-fitflow"]);
    const foreign = await stack.propose(b, "A6", ["pause"]);
    const id = p.actions[0].id;

    for (const digest of ["0".repeat(64), other.digest, "", p.digest.toUpperCase()]) {
      const r = await a.post(`/api/proposals/${p.id}/approve`, { digest, actionIds: [id] });
      expect(r.status, `digest ${digest.slice(0, 8)}`).toBe(409);
      expect(r.json.error).toBe("DIGEST_MISMATCH");
    }
    for (const actionIds of [[], ["pa_0000000000000000"], [id, "pa_0000000000000000"], [other.actions[0].id], [id, other.actions[0].id], [foreign.actions[0].id]]) {
      const r = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds });
      expect(r.status, JSON.stringify(actionIds)).toBe(400);
      expect(r.json.error).toBe("BAD_SELECTION");
    }
    expect(stack.q1<any>("SELECT status FROM proposals WHERE id=?", p.id)!.status).toBe("READY");
    expect(stack.q("SELECT id FROM mandates WHERE proposal_id IN (?,?,?)", p.id, other.id, foreign.id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM grants WHERE action_id IN (?,?,?)", id, other.actions[0].id, foreign.actions[0].id)).toHaveLength(0);
    expect(stack.q("SELECT id FROM jobs WHERE kind='ACTION' AND ref_id IN (?,?,?)", id, other.actions[0].id, foreign.actions[0].id)).toHaveLength(0);
  });

  it("a manifest or action spec modified in the database is refused (MANIFEST_TAMPERED) and never dispatched", async () => {
    const a = await stack.login("alex");
    const tenant = a.tenantId;

    // (a) the frozen manifest itself is edited (months 1 → 3), digest left alone.
    const p1 = await stack.propose(a, "A6", ["pause"]);
    const m1 = stack.q1<any>("SELECT manifest_json FROM proposals WHERE id=?", p1.id)!.manifest_json as string;
    expect(m1).toContain('"months":1');
    stack.exec("UPDATE proposals SET manifest_json=? WHERE id=?", m1.replace('"months":1', '"months":3'), p1.id);

    // (b) only the executable action row is edited; the manifest (what the digest covers) still says 1 month.
    const p2 = await stack.propose(a, "A6", ["pause"]);
    const spec2 = JSON.parse(stack.action(p2.actions[0].id).spec_json);
    spec2.params.months = 3;
    stack.exec("UPDATE proposal_actions SET spec_json=? WHERE id=?", canonicalJson(spec2), p2.actions[0].id);

    // (c) the action row and its spec digest are edited consistently (an attacker who recomputes the row digest).
    const p3 = await stack.propose(a, "A6", ["pause"]);
    const spec3 = JSON.parse(stack.action(p3.actions[0].id).spec_json);
    spec3.params.months = 3;
    stack.exec("UPDATE proposal_actions SET spec_json=?, spec_digest=? WHERE id=?", canonicalJson(spec3), digestOf(spec3), p3.actions[0].id);

    for (const p of [p1, p2, p3]) {
      const r = await a.post(`/api/proposals/${p.id}/approve`, { digest: p.digest, actionIds: [p.actions[0].id] });
      expect.soft(r.status, `approve ${p.id}`).toBe(409);
      expect.soft(r.json?.error, `approve ${p.id}`).toBe("MANIFEST_TAMPERED");
    }

    // (d) a legitimate approval whose action row is edited afterwards is stopped at the dispatch gate.
    const p4 = await stack.propose(a, "A6", ["pause"]);
    await stack.approve(a, p4);
    const spec4 = JSON.parse(stack.action(p4.actions[0].id).spec_json);
    spec4.params.months = 3;
    stack.exec("UPDATE proposal_actions SET spec_json=?, spec_digest=? WHERE id=?", canonicalJson(spec4), digestOf(spec4), p4.actions[0].id);

    const w = await stack.worker();
    try {
      const blocked = await stack.waitAction(p4.actions[0].id, ["BLOCKED", "CONFIRMED", "REFUSED", "UNKNOWN"]);
      expect(blocked.status).toBe("BLOCKED");
      expect(JSON.parse(stack.attempts(p4.actions[0].id)[0].outcome_json).gate).toBe("DIGEST_MISMATCH");
      // Let the worker drain anything else that might be runnable, then check nothing reached the merchant.
      await waitFor(() => stack.q1<any>("SELECT COUNT(*) n FROM jobs WHERE tenant_id=? AND status IN ('QUEUED','LEASED')", tenant)!.n === 0, { label: "queue drained" });
    } finally {
      await w.stop();
    }
    await noDispatchFor([p1, p2, p3, p4].map((p) => p.actions[0].id));
    expect(stack.q("SELECT id FROM grants WHERE action_id IN (?,?,?)", p1.actions[0].id, p2.actions[0].id, p3.actions[0].id)).toHaveLength(0);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", tenant)).toHaveLength(0);
    expect(stack.mq1<any>("SELECT pending_json FROM m_contracts WHERE tenant_id=? AND id=?", tenant, `${tenant}:streamly-standard`)!.pending_json).toBeNull();
  });
});

describe("request hardening", () => {
  it("uploads: a non-image is 415 even when labelled image/png; tiny files 400; nothing stored", async () => {
    const a = await stack.login("alex");
    const text = await multipart({ data: Buffer.from("<html><script>alert(1)</script></html>".repeat(4)), type: "image/png", filename: "cat.png" });
    const r = await a.post("/api/uploads", undefined, { raw: text.body, headers: { "content-type": text.contentType } });
    expect(r.status).toBe(415);
    expect(r.json.error).toBe("UNSUPPORTED_TYPE");
    const svg = await multipart({ data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>'), type: "image/svg+xml", filename: "x.svg" });
    expect((await a.post("/api/uploads", undefined, { raw: svg.body, headers: { "content-type": svg.contentType } })).status).toBe(415);
    const tiny = await multipart({ data: Buffer.from("GIF8"), type: "image/gif", filename: "x.gif" });
    const t = await a.post("/api/uploads", undefined, { raw: tiny.body, headers: { "content-type": tiny.contentType } });
    expect(t.status).toBe(400);
    expect(stack.q("SELECT id FROM uploads WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
    // A real PNG is accepted and served back only with a fixed image type and nosniff.
    const png = await multipart({ data: fs.readFileSync(path.join(ROOT, "fixtures/images/student-id.png")), type: "application/octet-stream", filename: "id.bin" });
    const ok = await a.post("/api/uploads", undefined, { raw: png.body, headers: { "content-type": png.contentType } });
    expect(ok.status).toBe(200);
    expect(ok.json.upload.mime).toBe("image/png");
    const img = await a.get(`/api/uploads/${ok.json.upload.id}/image`);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("oversized bodies: JSON > 256 KB → 413, inbox > 64 KB → 413, nothing stored", async () => {
    const a = await stack.login("alex");
    const big = await a.post("/api/preferences", { key: "hotspot_required", value: true, pad: "x".repeat(300 * 1024) });
    expect(big.status).toBe(413);
    expect(stack.q("SELECT id FROM preferences WHERE tenant_id=?", a.tenantId)).toHaveLength(0);
    const inboxBefore = stack.q1<any>("SELECT COUNT(*) n FROM inbox_events")!.n;
    const raw = JSON.stringify({ eventId: "evt_big", issuer: "payment-network", tenantId: a.tenantId, kind: "credit_transfer", resourceVersion: null, occurredAt: new Date().toISOString(), data: { pad: "y".repeat(70 * 1024) } });
    const r = await stack.postInbox(raw);
    expect(r.status).toBe(413);
    expect(stack.q1<any>("SELECT COUNT(*) n FROM inbox_events")!.n).toBe(inboxBefore);
  });

  it("CSV export neutralises spreadsheet formulas in provider-supplied text", async () => {
    const a = await stack.login("alex");
    const w = await stack.worker();
    try {
      const { batchId } = await a.ok("/api/batches");
      await waitFor(async () => (await a.json(`/api/batches/${batchId}`)).status === "REVIEW", { timeout: 60_000, label: "batch review" });
    } finally {
      await w.stop();
    }
    const hostile = ['=HYPERLINK("http://evil.example","x")', "+SUM(1,2)", "-2+3", "@cmd", "\tTabbed", 'Quote "inside"'];
    const subs = stack.q<any>("SELECT id FROM subscriptions WHERE tenant_id=? AND dataset='bulk' ORDER BY id LIMIT ?", a.tenantId, hostile.length);
    hostile.forEach((name, i) => stack.exec("UPDATE subscriptions SET merchant_name=? WHERE id=?", name, subs[i].id));
    const batchId = stack.q1<any>("SELECT id FROM batches WHERE tenant_id=?", a.tenantId)!.id;
    const csv = await a.get(`/api/batches/${batchId}/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment/);
    const rows = parseCsv(csv.text);
    expect(rows[0][0]).toBe("Merchant");
    expect(rows).toHaveLength(201);
    const merchants = rows.slice(1).map((r) => r[0]);
    expect(merchants).toContain(`'=HYPERLINK("http://evil.example","x")`);
    expect(merchants).toContain("'+SUM(1,2)");
    expect(merchants).toContain("'-2+3");
    expect(merchants).toContain("'@cmd");
    expect(merchants).toContain("'\tTabbed");
    expect(merchants).toContain('Quote "inside"');
    // No cell in the whole file starts with a formula trigger.
    for (const r of rows) for (const cell of r) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  it("evidence paths cannot traverse; labs cannot target another tenant's contract", async () => {
    const a = await stack.login("alex");
    for (const f of ["..%2F..%2Flocal-secrets.json", "att_x-1.png%2F..%2F..%2Fbank.sqlite", "local-secrets.json"]) {
      const r = await a.get(`/api/evidence/screens/${f}`);
      expect(r.status, f).toBe(404);
    }
    const r = await rawRequest(`${stack.bankUrl}/api/evidence/screens/..%2F..%2Fbank.sqlite`, { headers: { cookie: a.cookie } });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("SQLite");

    // Labs controls only reach the caller's own simulated world.
    const other = await stack.login("alex");
    const target = `${other.tenantId}:streamly-standard`;
    const faults = () => stack.mq("SELECT kind FROM m_faults WHERE tenant_id=? AND contract_id=?", other.tenantId, target).length;
    const before = faults();
    const l = await a.post("/api/labs/merchant", { action: "fault", body: { contractId: target, kind: "MANUAL_REVIEW", params: {} } });
    expect([l.status, l.json.error]).toEqual([404, "NOT_FOUND"]);
    expect(faults()).toBe(before);
  });
});
