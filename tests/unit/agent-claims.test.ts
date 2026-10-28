import { describe, expect, it } from "vitest";
import { checkClaims } from "../../src/server/agent/orchestrator";

// The final-answer guard: the planner only prepares, so it may not claim that anything was carried out.

describe("checkClaims", () => {
  it("passes the prepared-proposal wording and negations", () => {
    for (const t of [
      "I prepared 2 actions for your review. Nothing happens until you approve.",
      "Nothing happens until you approve.",
      "I have not cancelled anything. You can approve the stop on the next screen.",
      "Once you approve, StreamBox will be paused for 2 months.",
      "Your subscription renews on the 15th.",
    ])
      expect(checkClaims(t, []), t).toEqual([]);
  });

  it("flags first-person and passive past-tense outcome claims", () => {
    for (const t of [
      "I cancelled StreamBox for you.",
      "I've already paid the bill.",
      "We have moved 500 RON to savings.",
      "Your gym membership has been paused.",
      "The transfer is now sent.",
      "NextMove successfully stopped the charge.",
      "I’ve turned off the renewal.",
    ])
      expect(checkClaims(t, []), t).not.toEqual([]);
  });

  it("allows a claim a tool result itself states", () => {
    expect(checkClaims("The charge has been refunded.", [{ result: { headline: "The charge has been refunded by the merchant" } }])).toEqual([]);
  });

  it("does not let the model's own final answer or question vouch for a claim", () => {
    const text = "I have already paused PulseGym.";
    expect(checkClaims(text, [{ tool: "ask_user", result: { asked: text } }, { tool: "final_answer", result: { text } }])).toEqual(["I have already paused"]);
  });
});
