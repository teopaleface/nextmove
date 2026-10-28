import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./harness";

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await stack?.teardown(); });

describe("Simple mode is a scoped display preference", () => {
  it("persists on/off on the server and does not leak to a different customer copy", async () => {
    const owner = await stack.login("alex");
    const other = await stack.login("alex");
    expect((await owner.json("/api/permissions")).preferences.simple_mode).toBeUndefined();
    expect((await owner.post("/api/preferences", { key: "simple_mode", value: true })).status).toBe(200);
    expect((await owner.json("/api/permissions")).preferences.simple_mode).toBe(true);
    expect((await other.json("/api/permissions")).preferences.simple_mode).toBeUndefined();
    expect((await owner.post("/api/preferences", { key: "simple_mode", value: false })).status).toBe(200);
    expect((await owner.json("/api/permissions")).preferences.simple_mode).toBe(false);
  });

  it("requires the same session and CSRF protection as other customer preferences", async () => {
    const owner = await stack.login("alex");
    const value = { key: "simple_mode", value: true };
    const noCsrf = await owner.post("/api/preferences", value, { csrf: false });
    expect(noCsrf.status).toBe(403);
    const noSession = await owner.post("/api/preferences", value, { cookie: false });
    expect(noSession.status).toBeGreaterThanOrEqual(400);
    expect((await owner.json("/api/permissions")).preferences.simple_mode).toBeUndefined();
  });

  it("rejects ambiguous values without replacing the customer's prior choice", async () => {
    const owner = await stack.login("alex");
    await owner.ok("/api/preferences", { key: "simple_mode", value: true });
    for (const value of ["false", 0, null, {}, []]) {
      const result = await owner.post("/api/preferences", { key: "simple_mode", value });
      expect(result.status).toBe(400);
      expect(result.json.error).toBe("BAD_VALUE");
    }
    expect((await owner.json("/api/permissions")).preferences.simple_mode).toBe(true);
  });

  it("does not approve, alter or dispatch a financial proposal", async () => {
    const owner = await stack.login("alex");
    const proposal = await stack.propose(owner, "T2", ["stop-fitflow"]);
    const grantCount = () => stack.q1<{ n: number }>("SELECT COUNT(*) n FROM grants WHERE tenant_id=?", owner.tenantId)!.n;
    const before = grantCount();
    await owner.ok("/api/preferences", { key: "simple_mode", value: true });
    const after = await owner.json(`/api/proposals/${proposal.id}`);
    expect(after.digest).toBe(proposal.digest);
    expect(after.status).toBe("READY");
    expect(grantCount()).toBe(before);
    expect(stack.action(proposal.actions[0].id).status).toBe("PROPOSED");
  });
});
