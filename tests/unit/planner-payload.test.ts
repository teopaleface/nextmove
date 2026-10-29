import { describe, expect, it } from "vitest";
import { plannerPayload } from "../../src/server/agent/orchestrator";

// The live planner's input is cut to 24 KB: whole JSON, oldest steps first, never the request, answers or newest step.

const base = { request: "Is PulseGym worth it?", step: 9, answers: [{ question: "Do you still go?", answer: "Not since the summer" }] };
const step = (n: number, size = 3000) => ({ tool: "analyze", args: { capabilityId: "A17" }, result: { n, headline: `step ${n} "${"x".repeat(size)}"` } });

describe("plannerPayload", () => {
  it("keeps everything when it fits", () => {
    const h = [step(1, 10), step(2, 10)];
    expect(JSON.parse(plannerPayload(base, h))).toEqual({ ...base, history: h });
  });

  it("drops the oldest steps first and keeps the request, answers and newest steps", () => {
    const h = Array.from({ length: 8 }, (_, i) => step(i + 1));
    const t = plannerPayload(base, h);
    expect(t.length).toBeLessThanOrEqual(24_000);
    const p = JSON.parse(t);
    expect(p.request).toBe(base.request);
    expect(p.answers).toEqual(base.answers);
    expect(p.omittedSteps).toBeGreaterThan(0);
    expect(p.history.map((s: any) => s.result.n)).toEqual(h.slice(p.omittedSteps).map((s) => s.result.n));
    expect(p.history.at(-1).result.n).toBe(8);
  });

  it("cuts the newest step's result when it alone is too big, still as whole JSON", () => {
    const h = [step(1), step(2, 60_000)];
    const t = plannerPayload(base, h, 24_000);
    expect(t.length).toBeLessThanOrEqual(24_000);
    const p = JSON.parse(t);
    expect(p.omittedSteps).toBe(1);
    expect(p.history).toHaveLength(1);
    expect(p.history[0].tool).toBe("analyze");
    expect(p.history[0].args).toEqual({ capabilityId: "A17" });
    expect(p.history[0].result.cut).toMatch(/^\{"n":2,/);
    expect(p.answers).toEqual(base.answers);
  });

  it("an empty history is sent whole", () => {
    expect(JSON.parse(plannerPayload(base, []))).toEqual({ ...base, history: [] });
  });
});
