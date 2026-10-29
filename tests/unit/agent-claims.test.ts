import { describe, expect, it } from "vitest";
import { checkClaims } from "../../src/server/agent/orchestrator";
import { checkLinks, checkMixedScripts, checkSecrets, textProblem } from "../../src/server/agent/guards";

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

// Look-alike letters: Cyrillic and Greek letters, fullwidth and small-capital forms and combining accents read like
// Latin on screen, so every check folds them to Latin first. Romanian diacritics keep working.
describe("look-alike letters", () => {
  it("claims written with look-alike letters are still claims", () => {
    for (const t of [
      "PulseGym was canc\u0435lled.", // Cyrillic е
      "I \u0440\u0430id the bill.", // Cyrillic р, а
      "\u0399 cancelled PulseGym.", // Greek capital iota
      "PulseGym was \uff43\uff41\uff4e\uff43\uff45\uff4c\uff4c\uff45\uff44.", // fullwidth
      "PulseGym was \u1d04\u1d00\u0274\u1d04\u1d07\u029f\u029f\u1d07\u1d05.", // small capitals
      "PulseGym was cance\u0301lled.", // combining acute
      "Am \u0430nulat abonamentul.", // Cyrillic а in Romanian
      "Abonamentul a fost \u00eenghe\u021bat.",
      "Abonamentul a fost \u00eenghe\u0163at.", // cedilla ţ
    ])
      expect(checkClaims(t, []), t).not.toEqual([]);
  });

  it("Romanian negations and approval conditions still pass", () => {
    for (const t of ["Nu am anulat nimic.", "Dac\u0103 aprobi, abonamentul este \u00eenghe\u021bat.", "Dup\u0103 ce aprobi, plata este suspendat\u0103."]) expect(checkClaims(t, []), t).toEqual([]);
  });

  it("links and requests for secrets written with look-alike letters are still caught; warnings still pass", () => {
    for (const t of ["Claim it at htt\u0440s://pulsegym.example/claim", "Visit puls\u0435gym.com", "Visit pulsegym\u3002com", "Visit pulsegym[.]com/refund"]) expect(checkLinks(t, []), t).not.toEqual([]);
    for (const t of ["Reply with your P\u0406N.", "Send me your \u0440\u0430ssword.", "What's your \u0420IN?"]) expect(checkSecrets(t, []), t).not.toEqual([]);
    expect(checkSecrets("Never share your P\u0406N with anyone.", [])).toEqual([]);
  });

  it("a word that mixes Latin with Cyrillic or Greek letters is withheld; Romanian and whole words in other scripts are not", () => {
    expect(checkMixedScripts("Your R\u0435volut card is fine.", [], "")).toEqual(["R\u0435volut"]);
    expect(checkMixedScripts("Pay \u0430t the desk.", [], "")).toEqual(["\u0430t"]);
    for (const t of [
      "\u021ai-am preg\u0103tit o analiz\u0103; nimic nu se \u00eent\u00e2mpl\u0103 p\u00e2n\u0103 nu aprobi.",
      "\u015ei \u0163ine minte: a\u015fa e.",
      "\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0432\u043e\u0442 \u0432\u0430\u0448 \u043e\u0431\u0437\u043e\u0440 PulseGym.",
      "\u0395\u03c5\u03c7\u03b1\u03c1\u03b9\u03c3\u03c4\u03ce, PulseGym.",
      "Caf\u00e9 na\u00efve \uff26\uff55\uff4c\uff4c\uff57\uff49\uff44\uff54\uff48.",
    ])
      expect(checkMixedScripts(t, [], ""), t).toEqual([]);
    // A name the customer wrote or a tool returned is theirs to see again.
    expect(checkMixedScripts("You asked about R\u0435volut.", [], "Is R\u0435volut safe?")).toEqual([]);
    expect(checkMixedScripts("R\u0435volut charged you.", [{ tool: "analyze", result: { merchant: "R\u0435volut" } }], "")).toEqual([]);
  });

  it("textProblem names look-alike letters when nothing else is wrong", () => {
    expect(textProblem("Your R\u0435volut card is fine.", [], "")).toMatch(/look-alike letters/);
    expect(textProblem("PulseGym was canc\u0435lled.", [], "")).toMatch(/"was cancelled"/);
  });
});
