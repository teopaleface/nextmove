import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { config, localSecrets } from "./config";
import { one } from "./db/connection";
import { decryptSecret } from "./crypto";
import {
  ADMIN_HEADER,
  CORRELATION_HEADER,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  type MerchantContractView,
  type MerchantRequestView,
  type OperationRequestBody,
  type OperationResponse,
} from "../shared/merchant-contract";

// Bank-side client for the simulated merchant origin. Egress is restricted to one registered loopback origin and
// path prefix per merchant; redirects are never followed; URL userinfo and other schemes are rejected.

export class EgressError extends Error {}
export class NetworkUncertainError extends Error {
  constructor(message: string, public sent: boolean) {
    super(message);
  }
}

const SAFE_SEGMENT = /^[a-z0-9-]{2,40}$/;

export function validateMerchantUrl(raw: string, merchantId: string): URL {
  const base = new URL(config.merchantBaseUrl);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError("Unparseable URL");
  }
  if (url.protocol !== "http:" || url.hostname !== base.hostname || url.port !== base.port) throw new EgressError(`Destination ${url.host} is not the registered merchant origin`);
  if (url.username || url.password) throw new EgressError("Credentials in URL are not allowed");
  if (!SAFE_SEGMENT.test(merchantId) || !url.pathname.startsWith(`/m/${merchantId}/`)) throw new EgressError("Path outside the merchant's registered prefix");
  return url;
}

async function safeFetch(merchantId: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; json: any }> {
  const url = validateMerchantUrl(`${config.merchantBaseUrl}${path}`, merchantId);
  const resp = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs ?? 8000) });
  if (resp.status >= 300 && resp.status < 400) throw new EgressError("Redirects are not followed");
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: "NON_JSON", message: text.slice(0, 200) };
  }
  return { status: resp.status, json };
}

export function delegatedToken(db: DatabaseSync, tenantId: string, merchantId: string, accountId: string): string {
  const link = one<any>(db, "SELECT token_cipher, status FROM merchant_links WHERE tenant_id=? AND merchant_id=? AND subscriber_account_id=?", tenantId, merchantId, accountId);
  if (!link) throw new EgressError(`No merchant link for ${merchantId}`);
  return decryptSecret(link.token_cipher);
}

export function signOperation(correlationId: string, idempotencyKey: string, rawBody: string) {
  return `sha256=${createHmac("sha256", localSecrets().partnerHmacKey).update([correlationId, idempotencyKey, rawBody].join("\n")).digest("hex")}`;
}

export class MerchantClient {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  private auth(merchantId: string, accountId: string) {
    return { authorization: `Bearer ${delegatedToken(this.db, this.tenantId, merchantId, accountId)}` };
  }

  async listContracts(merchantId: string, accountId: string): Promise<{ status: number; contracts?: MerchantContractView[]; error?: string }> {
    const r = await safeFetch(merchantId, `/m/${merchantId}/api/v1/contracts`, { headers: this.auth(merchantId, accountId) });
    return r.status === 200 ? { status: 200, contracts: r.json.contracts } : { status: r.status, error: r.json?.error };
  }

  async getContract(merchantId: string, accountId: string, contractId: string): Promise<{ status: number; contract?: MerchantContractView; error?: string }> {
    const r = await safeFetch(merchantId, `/m/${merchantId}/api/v1/contracts/${encodeURIComponent(contractId)}`, { headers: this.auth(merchantId, accountId) });
    return r.status === 200 ? { status: 200, contract: r.json.contract } : { status: r.status, error: r.json?.error };
  }

  async getAccount(merchantId: string, accountId: string): Promise<{ status: number; account?: any; error?: string }> {
    const r = await safeFetch(merchantId, `/m/${merchantId}/api/v1/account`, { headers: this.auth(merchantId, accountId) });
    return r.status === 200 ? { status: 200, account: r.json } : { status: r.status, error: r.json?.error };
  }

  async getOffer(merchantId: string, accountId: string, offerId: string): Promise<{ status: number; offer?: any }> {
    const r = await safeFetch(merchantId, `/m/${merchantId}/api/v1/offers/${encodeURIComponent(offerId)}`, { headers: this.auth(merchantId, accountId) });
    return { status: r.status, offer: r.json?.offer };
  }

  async findRequests(merchantId: string, accountId: string, correlationId: string): Promise<{ status: number; requests?: MerchantRequestView[]; error?: string }> {
    const r = await safeFetch(merchantId, `/m/${merchantId}/api/v1/requests?correlationId=${encodeURIComponent(correlationId)}`, { headers: this.auth(merchantId, accountId) });
    return r.status === 200 ? { status: 200, requests: r.json.requests } : { status: r.status, error: r.json?.error };
  }

  /**
   * Mutating partner call. A transport failure after the request may have been written is reported as
   * NetworkUncertainError(sent=true): the caller must treat the outcome as unknown and reconcile.
   */
  async operate(merchantId: string, accountId: string, contractId: string | null, body: OperationRequestBody, ids: { correlationId: string; idempotencyKey: string }): Promise<{ status: number; response: OperationResponse }> {
    const raw = JSON.stringify(body);
    const path = contractId ? `/m/${merchantId}/api/v1/contracts/${encodeURIComponent(contractId)}/operations` : `/m/${merchantId}/api/v1/operations`;
    try {
      const r = await safeFetch(merchantId, path, {
        method: "POST",
        headers: {
          ...this.auth(merchantId, accountId),
          "content-type": "application/json",
          [CORRELATION_HEADER]: ids.correlationId,
          [IDEMPOTENCY_HEADER]: ids.idempotencyKey,
          [SIGNATURE_HEADER]: signOperation(ids.correlationId, ids.idempotencyKey, raw),
        },
        body: raw,
        timeoutMs: 10_000,
      });
      return { status: r.status, response: r.json };
    } catch (e: any) {
      if (e instanceof EgressError) throw e;
      throw new NetworkUncertainError(`Transport failure: ${String(e?.message ?? e).slice(0, 120)}`, true);
    }
  }
}

/* ------------------------------------------------------------------ admin (seed / clock / Labs) */

async function admin(path: string, body: unknown, method = "POST") {
  const url = new URL(`${config.merchantBaseUrl}${path}`);
  if (!url.pathname.startsWith("/__admin/")) throw new EgressError("Admin path only");
  const resp = await fetch(url, {
    method,
    headers: { "content-type": "application/json", [ADMIN_HEADER]: localSecrets().merchantAdminToken },
    body: method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Merchant admin ${path} failed: ${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export const merchantAdmin = {
  seed: (tenantId: string, customer: string, fixtureInstantMs: number) => admin(`/__admin/tenants/${encodeURIComponent(tenantId)}/seed`, { customer, fixtureInstantMs }),
  setClock: (tenantId: string, nowMs: number) => admin(`/__admin/tenants/${encodeURIComponent(tenantId)}/clock`, { nowMs }),
  labs: (tenantId: string, body: Record<string, unknown>) => admin(`/__admin/tenants/${encodeURIComponent(tenantId)}/labs`, body),
  remove: (tenantId: string) => admin(`/__admin/tenants/${encodeURIComponent(tenantId)}`, null, "DELETE"),
  health: async () => {
    try {
      const r = await fetch(`${config.merchantBaseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
};
