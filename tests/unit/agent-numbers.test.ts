import { describe, expect, it } from "vitest";
import { checkNumbers } from "../../src/server/agent/orchestrator";
import { allowedNumbers } from "../../src/server/agent/guards";

// The final-answer guard: every amount the model writes must be a number NextMove computed or the customer wrote.

const allowed = new Set(["2050", "20.50", "12.99", "1500", "1500.00"]);

describe("checkNumbers", () => {
  it("accepts allowed amounts in English and Romanian formats", () => {
    for (const t of ["2,050 RON", "1.500 RON", "20.50 RON", "1,500.00 RON", "1.500,00 lei", "12.99"]) expect(checkNumbers(t, allowed), t).toEqual([]);
  });

  it("flags amounts NextMove never computed, including k-suffixed and small ones", () => {
    for (const t of ["12.345 lei", "5k RON", "29.99 RON", "3 RON", "RON 7"]) expect(checkNumbers(t, allowed), t).not.toEqual([]);
  });

  it("lets day numbers and years through in prose but not next to a currency", () => {
    for (const t of ["on the 15th", "in 2026", "within 3 days"]) expect(checkNumbers(t, allowed), t).toEqual([]);
    expect(checkNumbers("2026 lei", allowed)).toEqual(["2026"]);
  });

  it("flags space-grouped thousands, percentages, dollars, other digit scripts and amounts in words", () => {
    for (const t of ["You would save 5 000 RON.", "5 000 lei", "a 20% discount", "$700", "٥٠٠ RON", "save five hundred lei", "save fifty lei", "2.000 RON"]) expect(checkNumbers(t, allowed), t).not.toEqual([]);
    for (const t of ["１５００ RON", "1,5k RON", "two months", "Step 1 of 3", "3 mai multe abonamente"]) expect(checkNumbers(t, allowed), t).toEqual([]);
  });

  it("dates must come from a tool or the customer", () => {
    const steps = [{ tool: "analyze", result: { summary: "converts on 30 Oct 2026, 09:00", at: "2026-11-15T09:00:00Z" } }];
    const ok = allowedNumbers(steps, "I get paid on 10 November");
    for (const t of ["on 2026-10-30", "on 30 October", "October 30", "on 15 November", "Nov 10"]) expect(checkNumbers(t, ok), t).toEqual([]);
    for (const t of ["on 2026-12-24", "on December 3", "15.12.2026", "pe 3 mai"]) expect(checkNumbers(t, ok), t).not.toEqual([]);
  });

  it("amounts in words with look-alike letters are still amounts; Romanian ones the customer wrote still count", () => {
    for (const t of ["save fiv\u0435 hundr\u0435d lei", "a tw\u0435nty percent cut"]) expect(checkNumbers(t, allowed), t).not.toEqual([]);
    expect(checkNumbers("Ai spus dou\u0103 sute lei.", allowedNumbers([], "Pot pune deoparte dou\u0103 sute lei"))).toEqual([]);
  });

  it("the customer's own Romanian amounts count as written", () => {
    expect(checkNumbers("You said 1.500 lei.", allowedNumbers([], "Am 1.500 lei"))).toEqual([]);
  });
});
