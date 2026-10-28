import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./harness";

let stack: Stack;
beforeAll(async () => { stack = await startStack({ mode: "bank-demo" }); });
afterAll(async () => { await stack?.teardown(); });

describe("Financial Airbag when execution is disabled", () => {
  it("keeps unavailable choices out of the projected reduction and refuses their approval path", async () => {
    const user = await stack.login("alex");
    const initial = await user.ok("/api/capabilities/O9", { inputs: {} });
    const field = initial.inputs.find((f: any) => f.type === "select" && f.label.includes("DashEats"));
    expect(field).toBeDefined();
    const inputs = { [field.key]: "stop" };
    const selected = await user.ok("/api/capabilities/O9", { inputs });
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0].available).toBe(false);
    expect(selected.numbers.conditionalAfterMinor).toBe(selected.numbers.beforeMinor);
    expect(selected.numbers.conditionalAvoidedMinor).toBe(0);
    expect(selected.numbers.selectedActions).toBe(0);
    expect(selected.headline).not.toContain("ready for exact review");
    const proposal = await user.post("/api/capabilities/O9/propose", { keys: [selected.candidates[0].key], inputs });
    expect(proposal.status).toBe(409);
    expect(stack.q("SELECT id FROM grants WHERE tenant_id=?", user.tenantId)).toEqual([]);
    expect(stack.mq("SELECT id FROM m_requests WHERE tenant_id=?", user.tenantId)).toEqual([]);
  });
});
