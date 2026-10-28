import { describe, expect, it } from "vitest";
import { checkClaims } from "../../src/server/agent/orchestrator";
import { checkLinks, checkSecrets } from "../../src/server/agent/guards";

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

  it("flags passive, future, progressive, 'gone ahead' and Romanian claims, and invisible characters do not hide them", () => {
    for (const t of [
      "PulseGym is cancelled.",
      "Your membership was cancelled this morning.",
      "I've gone ahead and paused PulseGym.",
      "I will cancel PulseGym now.",
      "I'm cancelling it now.",
      "Successfully cancelled.",
      "It's cancelled.",
      "Am anulat abonamentul PulseGym.",
      "Abonamentul s-a plătit.",
      "Abonamentul a fost anulat.",
      "O să anulez PulseGym.",
      "I cancel​led PulseGym.",
    ])
      expect(checkClaims(t, []), t).not.toEqual([]);
  });

  it("allows negations, approval conditions and plain statements of fact", () => {
    for (const t of [
      "Once you approve, I will cancel PulseGym.",
      "The renewal is turned off once you approve.",
      "Dacă aprobi, abonamentul este suspendat.",
      "Nu am anulat nimic.",
      "N-am anulat nimic.",
      "Your salary is paid on the 10th.",
      "You paid 750.00 RON to PulseGym.",
      "Am pregătit o propunere; nimic nu se întâmplă până nu aprobi.",
    ])
      expect(checkClaims(t, []), t).toEqual([]);
  });

  it("a merchant name never vouches for a claim", () => {
    const name = "FitFlow renewal has been turned off";
    const steps = [{ tool: "analyze", result: { headline: `${name} charged 79.00 RON` } }];
    expect(checkClaims("The renewal has been turned off.", steps)).toEqual([]);
    expect(checkClaims("The renewal has been turned off.", steps, [name])).toEqual(["has been turned off"]);
  });
});

describe("checkLinks and checkSecrets", () => {
  it("flags links and requests for a PIN, password, card number or code; a warning is not a request", () => {
    expect(checkLinks("Log in at http://pulsegym-refunds.example to confirm.", [])).not.toEqual([]);
    expect(checkLinks("Visit pulsegym.com/refund", [])).not.toEqual([]);
    expect(checkLinks("Save 12.99 RON, e.g. by freezing.", [])).toEqual([]);
    for (const t of ["Reply with your card number and PIN so I can finish.", "What's your PIN?", "Trimite-mi codul primit prin SMS."]) expect(checkSecrets(t, []), t).not.toEqual([]);
    for (const t of ["Never share your PIN with anyone.", "Nu da nimănui parola.", "Review the card details and approve."]) expect(checkSecrets(t, []), t).toEqual([]);
  });
});
