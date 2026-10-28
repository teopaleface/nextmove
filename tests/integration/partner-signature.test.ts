import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { rawRequest, startStack, type Stack } from "./harness";

// The partner HMAC on merchant operations binds the HTTP method and the request path (including the contract id),
// so a signed request cannot be replayed against another contract or route.

let stack: Stack;
let client: typeof import("../../src/server/merchant-client");
beforeAll(async () => {
  stack = await startStack();
  client = await import("../../src/server/merchant-client");
});
afterAll(async () => {
  await stack?.teardown();
});

describe("partner operation signature", () => {
  it("covers method and path; replays against another path or method are refused", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId!;
    const link = stack.q1<any>("SELECT subscriber_account_id FROM merchant_links WHERE tenant_id=? AND merchant_id='streamly'", t)!;
    const token = client.delegatedToken(stack.db, t, "streamly", link.subscriber_account_id);
    const contractId = `${t}:streamly-standard`;
    const path = `/m/streamly/api/v1/contracts/${encodeURIComponent(contractId)}/operations`;
    // A pause length that is not offered: a valid signature reaches validation (400) and changes nothing.
    const raw = JSON.stringify({ operation: "PAUSE", params: { months: 99 } });
    const send = (to: string, signature: string, corr: string, idem: string) =>
      rawRequest(`${stack.merchantUrl}${to}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-nextmove-correlation": corr, "idempotency-key": idem, "x-nextmove-signature": signature },
        body: raw,
      });
    const ids = () => [randomUUID(), randomUUID()] as const;

    let [corr, idem] = ids();
    const ok = await send(path, client.signOperation("POST", path, corr, idem, raw), corr, idem);
    expect(ok.status, ok.text).toBe(400);
    expect(ok.json.error).toBe("VALIDATION");

    // Signed for another contract's path, sent to this one.
    [corr, idem] = ids();
    const other = `/m/streamly/api/v1/contracts/${encodeURIComponent(`${t}:other-contract`)}/operations`;
    const replayed = await send(path, client.signOperation("POST", other, corr, idem, raw), corr, idem);
    expect(replayed.status).toBe(401);
    expect(replayed.json.error).toBe("BAD_SIGNATURE");

    // Signed for the contract-less route, sent to the contract route.
    [corr, idem] = ids();
    expect((await send(path, client.signOperation("POST", "/m/streamly/api/v1/operations", corr, idem, raw), corr, idem)).status).toBe(401);

    // Same path, different method.
    [corr, idem] = ids();
    expect((await send(path, client.signOperation("GET", path, corr, idem, raw), corr, idem)).status).toBe(401);

    // The old format (correlation id, idempotency key and body only) is no longer accepted.
    [corr, idem] = ids();
    const legacy = `sha256=${createHmac("sha256", stack.secrets.partnerHmacKey).update([corr, idem, raw].join("\n")).digest("hex")}`;
    expect((await send(path, legacy, corr, idem)).status).toBe(401);

    expect(stack.mq<any>("SELECT id FROM m_requests WHERE tenant_id=? AND contract_id=?", t, contractId)).toHaveLength(0);
  });

  it("the bank's own client still gets its operations accepted", async () => {
    const a = await stack.login("alex");
    const t = a.tenantId!;
    const link = stack.q1<any>("SELECT subscriber_account_id FROM merchant_links WHERE tenant_id=? AND merchant_id='streamly'", t)!;
    const mc = new client.MerchantClient(stack.db, t);
    const r = await mc.operate("streamly", link.subscriber_account_id, `${t}:streamly-standard`, { operation: "PAUSE", params: { months: 1 } } as any, { correlationId: randomUUID(), idempotencyKey: randomUUID() });
    expect(r.status, JSON.stringify(r.response)).toBe(200);
    expect((r.response as any).status).toBe("CONFIRMED");
  });
});
