import http from "node:http";
import { randomBytes, createHmac, timingSafeEqual, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mall, mget, mrun, mtx } from "./db";
import { seedWorld } from "./world";
import { authenticate, contractView, executeOperation, merchantNow, merchantNowIso, readContract, requestView, receiptView, emitEvent, tick, payout } from "./ops";
import { accountPage, cancelPage, resultPage, loginPage, inspectorIndex, inspectorTenant } from "./pages";
import { ADMIN_HEADER, CORRELATION_HEADER, IDEMPOTENCY_HEADER, SIGNATURE_HEADER, type MerchantDirectoryEntry, type OperationRequestBody } from "../shared/merchant-contract";
import { toLocalIso, toMs } from "../shared/time";

export interface MerchantServerOptions {
  db: DatabaseSync;
  root: string;
  adminToken: string;
  partnerKey: string;
  bankBaseUrl: string;
  log?: (msg: string) => void;
}

const MAX_BODY = 64 * 1024;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

function cookie(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signBody(key: string, ...parts: string[]) {
  return `sha256=${createHmac("sha256", key).update(parts.join("\n")).digest("hex")}`;
}

function isLoopback(req: http.IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

export function directoryFor(db: DatabaseSync, tenantId: string): MerchantDirectoryEntry[] {
  return mall<any>(db, "SELECT * FROM m_merchants WHERE tenant_id=? ORDER BY id", tenantId).map((m) => ({
    id: m.id,
    name: m.name,
    connector: m.connector,
    readApi: Boolean(m.read_api),
    operations: JSON.parse(m.operations_json),
    manualRoute: m.manual_route,
    category: m.category,
  }));
}

export function createMerchantServer(opts: MerchantServerOptions) {
  const { db } = opts;
  const log = opts.log ?? (() => {});

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!isLoopback(req)) return send(res, 403, { error: "loopback only" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/health") return send(res, 200, { ok: true, service: "nextmove-simulated-merchant", tenants: (mget<any>(db, "SELECT COUNT(*) n FROM m_tenants")?.n ?? 0) });

    // ---------------------------------------------------------------- admin (seed, clock, Labs controls)
    let m = p.match(/^\/__admin\/tenants\/([^/]+)(?:\/(seed|clock|labs))?$/);
    if (m) {
      const token = String(req.headers[ADMIN_HEADER] ?? "");
      if (!safeEq(token, opts.adminToken)) return send(res, 401, { error: "admin token required" });
      const tenantId = decodeURIComponent(m[1]);
      const action = m[2];
      const body = method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      if (method === "DELETE" && !action) {
        deleteTenant(db, tenantId);
        return send(res, 200, { deleted: tenantId });
      }
      if (action === "seed") {
        deleteTenant(db, tenantId);
        const tokens = seedWorld(db, opts.root, tenantId, body.customer, Number(body.fixtureInstantMs));
        return send(res, 200, { tenantId, tokens, directory: directoryFor(db, tenantId) });
      }
      if (action === "clock") {
        mrun(db, "INSERT INTO m_clocks(tenant_id, base_ms, anchor_real_ms) VALUES (?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET base_ms=excluded.base_ms, anchor_real_ms=excluded.anchor_real_ms", tenantId, Number(body.nowMs), Date.now());
        const changes = tick(db, tenantId);
        return send(res, 200, { now: merchantNowIso(db, tenantId), changes });
      }
      if (action === "labs") return send(res, 200, labsAction(db, tenantId, body));
      return send(res, 404, { error: "unknown admin route" });
    }

    // ---------------------------------------------------------------- inspector (read-only)
    if (p === "/__inspect" && method === "GET") {
      const tenants = mall<any>(db, "SELECT id, customer FROM m_tenants ORDER BY created_at DESC").map((t) => ({
        id: t.id,
        customer: t.customer,
        merchants: mget<any>(db, "SELECT COUNT(*) n FROM m_merchants WHERE tenant_id=?", t.id).n,
        receipts: mget<any>(db, "SELECT COUNT(*) n FROM m_receipts WHERE tenant_id=?", t.id).n,
      }));
      return send(res, 200, inspectorIndex(tenants), "text/html");
    }
    m = p.match(/^\/__inspect\/([^/]+)$/);
    if (m && method === "GET") {
      const t = decodeURIComponent(m[1]);
      const q = url.searchParams.get("q");
      const like = q ? `%${q}%` : "%";
      return send(
        res,
        200,
        inspectorTenant(
          t,
          mall(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND merchant_id LIKE ? ORDER BY merchant_id", t, like),
          mall(db, "SELECT * FROM m_receipts WHERE tenant_id=? AND merchant_id LIKE ? ORDER BY created_at DESC", t, like),
          mall(db, "SELECT * FROM m_requests WHERE tenant_id=? AND merchant_id LIKE ? ORDER BY created_at DESC", t, like),
          mall(db, "SELECT * FROM m_cases WHERE tenant_id=? AND merchant_id LIKE ? ORDER BY updated_at DESC", t, like),
          mall(db, "SELECT * FROM m_messages WHERE tenant_id=? ORDER BY received_at DESC", t),
          q,
        ),
        "text/html",
      );
    }

    // ---------------------------------------------------------------- partner API
    m = p.match(/^\/m\/([a-z0-9-]+)\/api\/v1\/(.*)$/);
    if (m) {
      const merchantId = m[1];
      const rest = m[2];
      const isWrite = method === "POST";
      const auth = authenticate(db, bearer(req), merchantId, !isWrite);
      if (!auth) return send(res, 401, { error: "UNAUTHENTICATED", message: "Unknown delegated token" });
      if ("expired" in auth) return send(res, 401, { error: "AUTH_EXPIRED", message: "The delegated session has expired; the account holder must sign in on the provider's page." });
      const t = auth.tenantId;
      const nowIso = merchantNowIso(db, t);
      if (method === "GET" && rest === "contracts") {
        const rows = mall<any>(db, "SELECT id FROM m_contracts WHERE tenant_id=? AND account_id=?", t, auth.accountId);
        return send(res, 200, { contracts: rows.map((r) => contractView(db, readContract(db, t, r.id, auth.accountId), nowIso)) });
      }
      let mm = rest.match(/^contracts\/([^/]+)$/);
      if (method === "GET" && mm) {
        const row = readContract(db, t, decodeURIComponent(mm[1]), auth.accountId);
        if (!row) return send(res, 404, { error: "NOT_FOUND" });
        return send(res, 200, { contract: contractView(db, row, nowIso) });
      }
      if (method === "GET" && rest === "account") {
        const acc = mget<any>(db, "SELECT * FROM m_accounts WHERE tenant_id=? AND merchant_id=? AND id=?", t, merchantId, auth.accountId);
        const cases = mall<any>(db, "SELECT id, kind, state, amount_minor, reference, details_json, updated_at FROM m_cases WHERE tenant_id=? AND account_id=?", t, auth.accountId).map((c) => ({ ...c, details: JSON.parse(c.details_json), details_json: undefined }));
        return send(res, 200, { accountId: auth.accountId, holder: acc.holder, details: JSON.parse(acc.details_json), cases, observedAt: nowIso });
      }
      if (method === "GET" && rest === "requests") {
        const corr = url.searchParams.get("correlationId");
        if (!corr) return send(res, 400, { error: "VALIDATION", message: "correlationId required" });
        const rows = mall<any>(db, "SELECT * FROM m_requests WHERE tenant_id=? AND account_id=? AND correlation_id=?", t, auth.accountId, corr);
        // A lagging read model does not show requests whose receipt is not yet visible.
        const visible = rows.filter((r) => {
          if (!r.receipt_ref) return true;
          const rc = mget<any>(db, "SELECT visible_at FROM m_receipts WHERE tenant_id=? AND ref=?", t, r.receipt_ref);
          return !rc || toMs(nowIso) >= toMs(rc.visible_at);
        });
        return send(res, 200, { requests: visible.map((r) => requestView(db, r, nowIso)), observedAt: nowIso });
      }
      mm = rest.match(/^offers\/([^/]+)$/);
      if (method === "GET" && mm) {
        const offer = mget<any>(db, "SELECT * FROM m_offers WHERE tenant_id=? AND merchant_id=? AND id=? AND current=1", t, merchantId, decodeURIComponent(mm[1]));
        if (!offer) return send(res, 404, { error: "NOT_FOUND" });
        return send(res, 200, { offer: { id: offer.id, revision: offer.revision, terms: JSON.parse(offer.terms_json), publishedAt: offer.published_at }, observedAt: nowIso });
      }
      const opMatch = rest.match(/^contracts\/([^/]+)\/operations$/);
      if (isWrite && (opMatch || rest === "operations")) {
        const raw = await readBody(req);
        const corr = String(req.headers[CORRELATION_HEADER] ?? "");
        const idem = String(req.headers[IDEMPOTENCY_HEADER] ?? "");
        const sig = String(req.headers[SIGNATURE_HEADER] ?? "");
        if (!corr || !idem) return send(res, 400, { error: "VALIDATION", message: "Correlation and idempotency headers are required" });
        if (!safeEq(sig, signBody(opts.partnerKey, corr, idem, raw))) return send(res, 401, { error: "BAD_SIGNATURE", message: "Partner signature invalid" });
        let body: OperationRequestBody;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "VALIDATION", message: "Invalid JSON" });
        }
        const contractId = opMatch ? decodeURIComponent(opMatch[1]) : null;
        if (contractId) readContract(db, t, contractId, auth.accountId); // access counts toward provider-side term publication
        const result = executeOperation(db, auth, contractId, body, { channel: "API", correlationId: corr, idempotencyKey: idem });
        log(`[merchant] ${merchantId} ${body.operation} -> ${"status" in result.response ? result.response.status : result.response.error}`);
        return send(res, result.httpStatus, result.response);
      }
      return send(res, 404, { error: "NOT_FOUND" });
    }

    // ---------------------------------------------------------------- website
    m = p.match(/^\/m\/([a-z0-9-]+)\/(account|login)(?:\/contracts\/([^/]+)\/cancel)?$/);
    if (m) {
      const merchantId = m[1];
      const section = m[2];
      const contractId = m[3] ? decodeURIComponent(m[3]) : null;
      const anyMerchant = mget<any>(db, "SELECT id, name FROM m_merchants WHERE id=? LIMIT 1", merchantId);
      if (!anyMerchant) return send(res, 404, "Not found", "text/plain");
      if (section === "login") {
        if (method === "GET") return send(res, 200, loginPage(anyMerchant, url.searchParams.get("return") ?? `/m/${merchantId}/account`, url.searchParams.get("account")), "text/html");
        const form = new URLSearchParams(await readBody(req));
        const accountId = form.get("account");
        if (accountId) mrun(db, "UPDATE m_accounts SET token_state='VALID', expire_after_reads=NULL WHERE merchant_id=? AND id=?", merchantId, accountId);
        res.writeHead(303, { location: form.get("return")?.startsWith(`/m/${merchantId}/`) ? form.get("return")! : `/m/${merchantId}/account` });
        return res.end();
      }
      const token = cookie(req, "fm_session");
      const auth = authenticate(db, token, merchantId, method === "GET");
      if (!auth || "expired" in auth) {
        const acct = token ? mget<any>(db, "SELECT id FROM m_accounts WHERE token_hash=?", sha(token))?.id ?? null : null;
        res.writeHead(303, { location: `/m/${merchantId}/login?return=${encodeURIComponent(p)}${acct ? `&account=${encodeURIComponent(acct)}` : ""}` });
        return res.end();
      }
      const t = auth.tenantId;
      const merchant = mget<any>(db, "SELECT id, name FROM m_merchants WHERE tenant_id=? AND id=?", t, merchantId);
      const nowIso = merchantNowIso(db, t);
      if (!contractId) {
        const rows = mall<any>(db, "SELECT id FROM m_contracts WHERE tenant_id=? AND account_id=?", t, auth.accountId);
        const views = rows.map((r) => contractView(db, readContract(db, t, r.id, auth.accountId), nowIso));
        return send(res, 200, accountPage(merchant, auth.holder, views, merchantId === "fitflow"), "text/html");
      }
      if (method === "GET") {
        const row = readContract(db, t, contractId, auth.accountId);
        if (!row) return send(res, 404, "Not found", "text/plain");
        const view = contractView(db, row, nowIso);
        if (!view.autoRenew) return send(res, 200, resultPage(merchant, "ALREADY_OFF", {}), "text/html");
        const formToken = randomBytes(12).toString("hex");
        mrun(db, "INSERT INTO m_web_forms(token, tenant_id, contract_id, created_at) VALUES (?,?,?,?)", formToken, t, contractId, new Date().toISOString());
        return send(res, 200, cancelPage(merchant, view, formToken), "text/html");
      }
      // POST: the website's final commit. Not idempotent by design (like ordinary websites).
      const form = new URLSearchParams(await readBody(req));
      const ft = form.get("formToken") ?? "";
      const formRow = mget<any>(db, "SELECT * FROM m_web_forms WHERE token=? AND tenant_id=? AND contract_id=?", ft, t, contractId);
      if (!formRow || formRow.used_at) return send(res, 400, resultPage(merchant, "REFUSED", { reason: "This form has expired. Start again from your account page." }), "text/html");
      mrun(db, "UPDATE m_web_forms SET used_at=? WHERE token=?", new Date().toISOString(), ft);
      const correlation = String(req.headers[CORRELATION_HEADER] ?? "") || null;
      const result = executeOperation(db, auth, contractId, { operation: "STOP_RENEWAL", expectedTermsRevision: Number(form.get("termsRevision")), params: {} }, { channel: "WEB", correlationId: correlation, idempotencyKey: null });
      log(`[merchant] web ${merchantId} STOP_RENEWAL -> ${"status" in result.response ? result.response.status : result.response.error}${result.dropResponse ? " (response dropped)" : ""}`);
      if (result.dropResponse) {
        // Committed, then the connection is lost before any response bytes are written.
        req.socket.destroy();
        return;
      }
      const r = result.response;
      if ("error" in r) {
        if (r.error === "TERMS_CHANGED") return send(res, 409, resultPage(merchant, "TERMS_CHANGED", { currentRevision: r.currentRevision }), "text/html");
        return send(res, 409, resultPage(merchant, "REFUSED", { reason: r.message }), "text/html");
      }
      if (r.status === "CONFIRMED") return send(res, 200, resultPage(merchant, r.receipt.effectiveAt ? "CONFIRMED" : "ALREADY_OFF", { reference: r.receipt.reference, accessUntil: r.receipt.accessUntil }), "text/html");
      if (r.status === "PENDING_REVIEW") return send(res, 202, resultPage(merchant, "PENDING_REVIEW", {}), "text/html");
      return send(res, 422, resultPage(merchant, "REFUSED", { reason: r.reason }), "text/html");
    }

    return send(res, 404, { error: "NOT_FOUND" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[merchant] error ${String(err?.message ?? err)}`);
      if (!res.headersSent) send(res, 500, { error: "INTERNAL", message: "Merchant error" });
      else res.end();
    });
  });
  return server;
}

function deleteTenant(db: DatabaseSync, tenantId: string) {
  mtx(db, () => {
    for (const table of ["m_tenants", "m_clocks", "m_merchants", "m_accounts", "m_contracts", "m_faults", "m_requests", "m_receipts", "m_offers", "m_cases", "m_messages", "m_events", "m_web_forms"]) {
      const col = table === "m_tenants" ? "id" : "tenant_id";
      mrun(db, `DELETE FROM ${table} WHERE ${col}=?`, tenantId);
    }
  });
}

/** Developer Labs controls: explicit, labelled interventions in the fictional provider world. */
function labsAction(db: DatabaseSync, t: string, body: any) {
  const nowIso = merchantNowIso(db, t);
  switch (body.action) {
    case "set_cancellation_mode": {
      const m = mget<any>(db, "SELECT policy_json FROM m_merchants WHERE tenant_id=? AND id=?", t, body.merchantId);
      const policy = { ...JSON.parse(m.policy_json), cancellationMode: body.mode };
      mrun(db, "UPDATE m_merchants SET policy_json=? WHERE tenant_id=? AND id=?", JSON.stringify(policy), t, body.merchantId);
      return { ok: true, merchantId: body.merchantId, mode: body.mode };
    }
    case "change_offer_terms": {
      return mtx(db, () => {
        const cur = mget<any>(db, "SELECT * FROM m_offers WHERE tenant_id=? AND id=? AND current=1", t, body.offerId);
        const terms = { ...JSON.parse(cur.terms_json), ...body.changes, termRevision: cur.revision + 1 };
        mrun(db, "UPDATE m_offers SET current=0 WHERE tenant_id=? AND id=?", t, body.offerId);
        mrun(db, "INSERT INTO m_offers(tenant_id,id,merchant_id,revision,terms_json,published_at,current) VALUES (?,?,?,?,?,?,1)", t, body.offerId, cur.merchant_id, cur.revision + 1, JSON.stringify(terms), nowIso);
        emitEvent(db, t, cur.merchant_id, "offer.terms_changed", { offerId: body.offerId, revision: cur.revision + 1, changes: body.changes }, cur.revision + 1);
        return { ok: true, offerId: body.offerId, revision: cur.revision + 1 };
      });
    }
    case "refund_payout": {
      const k = mget<any>(db, "SELECT * FROM m_cases WHERE tenant_id=? AND reference=? AND kind='REFUND'", t, body.reference);
      if (!k) return { ok: false, error: "case not found" };
      if (k.state === "PAID") return { ok: true, alreadyPaid: true };
      mtx(db, () => payout(db, t, k, nowIso));
      return { ok: true };
    }
    case "claims_fast_forward": {
      mtx(db, () => {
        for (const k of mall<any>(db, "SELECT * FROM m_cases WHERE tenant_id=? AND state IN ('SUBMITTED','ACCEPTED_PAYOUT_DUE')", t)) {
          const d = JSON.parse(k.details_json);
          if (k.state === "SUBMITTED") d.reviewAt = nowIso;
          else d.payoutAt = nowIso;
          mrun(db, "UPDATE m_cases SET details_json=? WHERE tenant_id=? AND id=?", JSON.stringify(d), t, k.id);
        }
      });
      return { ok: true, changes: tick(db, t) };
    }
    case "counterparty_pay": {
      mtx(db, () =>
        emitEvent(db, t, "payment-network", "credit_transfer", {
          transferId: `trf_${randomBytes(8).toString("hex")}`,
          payer: body.counterparty,
          amountMinor: Number(body.amountMinor),
          currency: "RON",
          reference: body.reference,
          accountRef: body.accountRef ?? null,
        }),
      );
      return { ok: true };
    }
    case "counterparty_reply_now": {
      mrun(db, "UPDATE m_cases SET details_json=json_set(details_json, '$.replyAt', ?) WHERE tenant_id=? AND kind='COUNTERPARTY_REPLY' AND state='SCHEDULED'", nowIso, t);
      return { ok: true, changes: tick(db, t) };
    }
    case "resolve_reviews": {
      mrun(db, "UPDATE m_requests SET resolve_at=? WHERE tenant_id=? AND status='PENDING_REVIEW'", nowIso, t);
      if (body.to) mrun(db, "UPDATE m_requests SET resolve_to=? WHERE tenant_id=? AND status='PENDING_REVIEW'", body.to, t);
      return { ok: true, changes: tick(db, t) };
    }
    case "finish_migrations": {
      for (const c of mall<any>(db, "SELECT * FROM m_contracts WHERE tenant_id=? AND details_json LIKE '%IN_PROGRESS%'", t)) {
        const d = JSON.parse(c.details_json);
        if (d.migration?.state === "IN_PROGRESS") {
          d.migration.completesAt = nowIso;
          mrun(db, "UPDATE m_contracts SET details_json=? WHERE tenant_id=? AND id=?", JSON.stringify(d), t, c.id);
        }
      }
      return { ok: true, changes: tick(db, t) };
    }
    case "fault": {
      mrun(db, "INSERT OR REPLACE INTO m_faults(tenant_id,contract_id,kind,params_json) VALUES (?,?,?,?)", t, body.contractId, body.kind, JSON.stringify(body.params ?? {}));
      return { ok: true };
    }
    case "expire_session": {
      mrun(db, "UPDATE m_accounts SET token_state='EXPIRED' WHERE tenant_id=? AND merchant_id=?", t, body.merchantId);
      return { ok: true };
    }
    case "restore_session": {
      // Stands in for the account holder signing in again on the provider's own page (never done by the agent).
      const ids = Array.isArray(body.merchantIds) ? body.merchantIds.map(String).slice(0, 50) : [String(body.merchantId ?? "")];
      let restored = 0;
      for (const id of ids) restored += Number(mrun(db, "UPDATE m_accounts SET token_state='VALID', expire_after_reads=NULL WHERE tenant_id=? AND merchant_id=? AND (token_state != 'VALID' OR expire_after_reads IS NOT NULL)", t, id).changes ?? 0);
      return { ok: true, restored };
    }
    default:
      return { ok: false, error: "unknown labs action" };
  }
}

/** Deliver signed events to the bank inbox with retries; the bank deduplicates by issuer + event id. */
export async function deliverEvents(db: DatabaseSync, bankBaseUrl: string, partnerKey: string, log: (m: string) => void) {
  const due = mall<any>(db, "SELECT * FROM m_events WHERE delivered_at IS NULL AND attempts < 30 ORDER BY created_at LIMIT 25");
  for (const ev of due) {
    const backoffMs = Math.min(30_000, 500 * 2 ** ev.attempts);
    if (ev.attempts > 0 && Date.now() - Date.parse(ev.created_at) < backoffMs) continue;
    const body = ev.payload_json;
    try {
      const resp = await fetch(`${bankBaseUrl}/api/inbox/merchant`, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(partnerKey, body) },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) mrun(db, "UPDATE m_events SET delivered_at=?, attempts=attempts+1 WHERE id=?", new Date().toISOString(), ev.id);
      else mrun(db, "UPDATE m_events SET attempts=attempts+1, last_error=? WHERE id=?", `HTTP ${resp.status}`, ev.id);
    } catch (e: any) {
      mrun(db, "UPDATE m_events SET attempts=attempts+1, last_error=? WHERE id=?", String(e?.message ?? e).slice(0, 200), ev.id);
    }
  }
}

export function tickAll(db: DatabaseSync) {
  let n = 0;
  for (const t of mall<any>(db, "SELECT id FROM m_tenants")) n += tick(db, t.id);
  return n;
}

export { merchantNow, toLocalIso };
