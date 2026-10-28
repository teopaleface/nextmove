import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Api, type Stack } from "./harness";

// E8 Cancellation certificate end to end: only a real, read-back STOP_RENEWAL can be certified; issuance is an exact
// bank-internal proposal; the private key stays in the data directory's keystore; the owner can fetch and selectively
// disclose; verification rejects tampering, other tenants and certificates the provider's later state contradicts.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ workers: 1 });
});
afterAll(async () => {
  await stack?.teardown();
});

const verify = (a: Api, certificate: unknown, opts: { csrf?: boolean } = {}) => a.post("/api/ext/certificate/verify", { certificate }, opts);
const sub = (t: string) => stack.q1<any>("SELECT * FROM subscriptions WHERE tenant_id=? AND merchant_id='dasheats'", t)!;

async function stopDashEats(a: Api) {
  const p = await stack.propose(a, "A15", ["stop-dasheats"]);
  await stack.approve(a, p);
  expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "UNKNOWN"])).status).toBe("CONFIRMED");
}

async function issue(a: Api) {
  const e8 = await a.json("/api/capabilities/E8");
  const key = `certificate-${sub(a.tenantId).id}`;
  const p = await stack.propose(a, "E8", [key]);
  await stack.approve(a, p);
  const done = await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN"]);
  return { e8, p, done, key };
}

describe("E8 before any confirmed stop", () => {
  it("offers nothing and verifies nothing", async () => {
    const a = await stack.login("alex");
    const e8 = await a.json("/api/capabilities/E8");
    expect(e8.candidates).toEqual([]);
    expect(e8.blocks.find((b: any) => b.kind === "note").text).toContain("nothing to certify");
    expect((await a.get("/api/ext/certificate/certificates/cert_000000000000000000000000")).status).toBe(404);
    expect((await verify(a, "NMC1.e30.AAAA")).json).toMatchObject({ ok: false });
    expect((await verify(a, 42)).status).toBe(400);
    expect((await verify(a, "x".repeat(5000))).status).toBe(400);
  });
});

describe("E8 issue, disclose, verify, withdraw", () => {
  it("issues an exact certificate whose private key never enters the database", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    const { e8, p, done } = await issue(a);
    const cand = e8.candidates[0];
    expect(cand.spec).toMatchObject({ operation: "EXT_ISSUE_CERTIFICATE", route: "BANK_INTERNAL", capability: "E8", subjectRef: sub(t).id, params: { validityDays: 365 } });
    expect(cand.spec.display.note).toContain("not a document issued by the provider");
    expect(p.actions[0].operation).toBe("EXT_ISSUE_CERTIFICATE");
    expect(done.status).toBe("CONFIRMED");

    const cert = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    expect(cert).toMatchObject({ action_id: p.actions[0].id, subscription_id: sub(t).id, revoked_at: null });
    const keyRow = stack.q1<any>("SELECT * FROM ext_certificate_key WHERE tenant_id=?", t)!;
    expect(keyRow).toMatchObject({ private_key_ref: "keystore:certificate-signing-v1", algorithm: "Ed25519", status: "ACTIVE" });
    const file = path.join(stack.dataDir, "keystore", "certificate-signing-v1.json");
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const priv = JSON.parse(fs.readFileSync(file, "utf8")).privateKeyPkcs8 as string;
    for (const table of ["ext_certificate_key", "ext_certificate", "ext_certificate_revocation", "receipts"]) {
      const dump = JSON.stringify(stack.q(`SELECT * FROM ${table} WHERE tenant_id=?`, t));
      expect(dump).not.toContain(priv.slice(-40));
    }

    // An issued stop is not offered again.
    expect((await a.json("/api/capabilities/E8")).candidates).toEqual([]);
    const receipt = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", p.actions[0].id)!;
    expect(receipt).toMatchObject({ issuer: "nextmove-bank", operation: "EXT_ISSUE_CERTIFICATE" });
  });

  it("lets only the owner fetch it, verifies selective disclosure and rejects tampering and other tenants", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    expect((await issue(a)).done.status).toBe("CONFIRMED");
    const certId = stack.q1<any>("SELECT cert_id FROM ext_certificate WHERE tenant_id=?", t)!.cert_id;

    const full = await a.json(`/api/ext/certificate/certificates/${certId}`);
    expect(full.statement).toContain("NextMove's signed statement");
    expect(full.publicKey).toMatchObject({ algorithm: "Ed25519" });
    expect(JSON.stringify(full)).not.toMatch(/privateKey|pkcs8/i);
    const ok = (await verify(a, full.certificate)).json;
    expect(ok).toMatchObject({ ok: true, certId });
    expect(Object.keys(ok.disclosed).sort()).toEqual(["effectiveDate", "merchant", "subscriptionRef"]);
    expect(ok.disclosed.merchant.merchantId).toBe("dasheats");

    const dateOnly = await a.json(`/api/ext/certificate/certificates/${certId}?reveal=effectiveDate`);
    const v = (await verify(a, dateOnly.certificate)).json;
    expect(v.ok).toBe(true);
    expect(Object.keys(v.disclosed)).toEqual(["effectiveDate"]);
    expect((await a.get(`/api/ext/certificate/certificates/${certId}?reveal=amount`)).status).toBe(400);

    // Altered claim or signature.
    const [head, ...disc] = full.certificate.split("~");
    const forged = Buffer.from(JSON.stringify(["c2FsdA", "effectiveDate", "2020-01-01"])).toString("base64url");
    expect((await verify(a, [head, forged].join("~"))).json).toMatchObject({ ok: false, reason: "DISCLOSURE_MISMATCH" });
    const parts = head.split(".");
    const sig = parts[2];
    const flipped = `${parts[0]}.${parts[1]}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect((await verify(a, [flipped, ...disc].join("~"))).json.ok).toBe(false);

    // CSRF and tenancy.
    expect((await verify(a, full.certificate, { csrf: false })).status).toBe(403);
    const b = await stack.login("alex");
    expect((await b.get(`/api/ext/certificate/certificates/${certId}`)).status).toBe(404);
    expect((await verify(b, full.certificate)).json.ok).toBe(false);
    await stopDashEats(b);
    expect((await issue(b)).done.status).toBe("CONFIRMED");
    expect((await verify(b, full.certificate)).json).toMatchObject({ ok: false, reason: "ISSUER_MISMATCH" });
  });

  it("withdraws the certificate when the provider's state no longer matches the stop", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    expect((await issue(a)).done.status).toBe("CONFIRMED");
    const cert = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    expect((await verify(a, cert.holder_copy)).json.ok).toBe(true);

    // The bank later observes renewal back on at the provider (simulated observation).
    const demoNow = await stack.clock(a, 60);
    stack.exec("UPDATE subscriptions SET state='ACTIVE', last_observed_at=? WHERE id=?", demoNow, cert.subscription_id);
    const r = (await verify(a, cert.holder_copy)).json;
    expect(r).toMatchObject({ ok: false, reason: "REVOKED" });
    const e8 = await a.json("/api/capabilities/E8");
    expect(e8.numbers).toMatchObject({ valid: 0, withdrawn: 1 });
    expect(e8.candidates).toEqual([]);
  });

  it("does not revive a withdrawn certificate after a Labs reset re-registers the same key", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    expect((await issue(a)).done.status).toBe("CONFIRMED");
    const old = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    const demoNow = await stack.clock(a, 60);
    stack.exec("UPDATE subscriptions SET state='ACTIVE', last_observed_at=? WHERE id=?", demoNow, old.subscription_id);
    expect((await verify(a, old.holder_copy)).json).toMatchObject({ ok: false, reason: "REVOKED" });

    expect((await a.post("/api/labs/reset", {})).status).toBe(200);
    a.csrf = (await a.json("/api/session")).csrfToken; // the reset signs in again with a fresh session
    await stack.clock(a, 5); // certificate ids are derived from the issue time; a later one is a different certificate
    await stopDashEats(a);
    expect((await issue(a)).done.status).toBe("CONFIRMED");
    const fresh = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    expect(fresh.cert_id).not.toBe(old.cert_id);
    expect((await verify(a, fresh.holder_copy)).json.ok).toBe(true);
    expect((await verify(a, old.holder_copy)).json).toMatchObject({ ok: false, reason: "NOT_ON_RECORD" });
  });
});

describe("E8 receipt identity and read-only fetch", () => {
  it("keys certificates on the bank's receipt, so two stops sharing a provider reference are both certified", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    // A second confirmed stop, Streamly (offered as an alternative once Streamly sends a retention offer).
    expect((await a.post("/api/labs/ext", { module: "retention-offers", action: "send_offer", body: { subscription: "streamly", variant: "valid", plan: "discount" } })).status).toBe(200);
    const ps = await stack.propose(a, "E3", ["stop-streamly"]);
    await stack.approve(a, ps);
    expect((await stack.waitAction(ps.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "UNKNOWN"])).status).toBe("CONFIRMED");
    // Both providers happen to use the same confirmation number (each provider is its own receipt issuer).
    const dash = stack.q1<any>("SELECT r.* FROM receipts r JOIN proposal_actions a ON a.id=r.action_id WHERE r.tenant_id=? AND a.subject_ref=? AND r.operation='STOP_RENEWAL'", t, sub(t).id)!;
    const streamly = stack.q1<any>("SELECT * FROM receipts WHERE action_id=?", ps.actions[0].id)!;
    stack.exec("UPDATE receipts SET issuer_reference=? WHERE id=?", dash.issuer_reference, streamly.id);

    const e8 = await a.json("/api/capabilities/E8");
    const keys = e8.candidates.filter((c: any) => c.available).map((c: any) => c.key).sort();
    expect(keys).toEqual([`certificate-${t}:sub:streamly`, `certificate-${sub(t).id}`].sort());
    expect(e8.candidates.map((c: any) => c.spec.params.receiptId).sort()).toEqual([dash.id, streamly.id].sort());
    for (const key of keys) {
      const p = await stack.propose(a, "E8", [key]);
      await stack.approve(a, p);
      expect((await stack.waitAction(p.actions[0].id, ["CONFIRMED", "REFUSED", "BLOCKED", "NO_CHANGE", "UNKNOWN"])).status).toBe("CONFIRMED");
    }
    const certs = stack.q<any>("SELECT * FROM ext_certificate WHERE tenant_id=? ORDER BY bank_receipt_id", t);
    expect(certs.map((c) => c.bank_receipt_id)).toEqual([dash.id, streamly.id].sort());
    // The provider's reference is what the customer and the provider see; it is display data only.
    expect(certs.map((c) => c.receipt_id)).toEqual([dash.issuer_reference, dash.issuer_reference]);
    const got = await a.json(`/api/ext/certificate/certificates/${certs[0].cert_id}`);
    expect(got.stopReference).toBe(dash.issuer_reference);
    expect((await verify(a, got.certificate)).json.disclosed.subscriptionRef).toBe(dash.issuer_reference);
  });

  it("fetching a certificate writes nothing; verifying applies the provider's later state", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId;
    await stopDashEats(a);
    expect((await issue(a)).done.status).toBe("CONFIRMED");
    const cert = stack.q1<any>("SELECT * FROM ext_certificate WHERE tenant_id=?", t)!;
    const lists = () => stack.q<any>("SELECT seq FROM ext_certificate_revocation WHERE tenant_id=?", t).length;
    const before = lists();
    expect(before).toBeGreaterThan(0);

    const demoNow = await stack.clock(a, 60);
    stack.exec("UPDATE subscriptions SET state='ACTIVE', last_observed_at=? WHERE id=?", demoNow, cert.subscription_id);
    const got = await a.json(`/api/ext/certificate/certificates/${cert.cert_id}`);
    expect(got.revocationList).toBe(stack.q1<any>("SELECT signed_text FROM ext_certificate_revocation WHERE tenant_id=? ORDER BY seq DESC LIMIT 1", t)!.signed_text);
    expect(lists()).toBe(before);
    expect(stack.q1<any>("SELECT revoked_at FROM ext_certificate WHERE cert_id=?", cert.cert_id)!.revoked_at).toBeNull();

    expect((await verify(a, cert.holder_copy)).json).toMatchObject({ ok: false, reason: "REVOKED" });
    expect(lists()).toBe(before + 1);
  });
});
