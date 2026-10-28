import { describe, expect, it } from "vitest";
import { screenSummary } from "../../src/ui/voice";

// Read-aloud summary: bounded, never cut inside a line, and every listed action is kept.

describe("screenSummary", () => {
  it("keeps every action even when the first ones are long", () => {
    const parts = [{ text: "Review the actions" }];
    for (let i = 0; i < 6; i++) {
      parts.push({ text: `Action ${i + 1}: stop Service ${i + 1}`, item: i } as any);
      for (let j = 0; j < 20; j++) parts.push({ text: `Term ${j} of action ${i + 1}: ${"detail ".repeat(20)}`, item: i } as any);
    }
    parts.push({ text: "Pays now 0.00 RON" });
    const s = screenSummary(parts);
    for (let i = 0; i < 6; i++) expect(s).toContain(`Action ${i + 1}: stop Service ${i + 1}`);
    expect(s).toContain("Pays now 0.00 RON");
    expect(s).toContain("Some details are only on screen.");
    expect(s.length).toBeLessThan(3600 + 200);
  });

  it("never cuts a line in the middle", () => {
    const line = `Most it can cost ${"1,234.56 RON ".repeat(10)}`.trim();
    const s = screenSummary(Array.from({ length: 50 }, (_, i) => ({ text: `${line} #${i}` })), 600);
    for (const piece of s.replace(/^Screen summary\. /, "").split(". ").filter((p) => p.startsWith("Most"))) expect(piece).toMatch(/#\d+$/);
  });

  it("bounds a very long list and says how many items were left on screen", () => {
    const parts = Array.from({ length: 200 }, (_, i) => ({ text: `Action ${i}: ${"x".repeat(100)}`, item: i }));
    const s = screenSummary(parts, 1000);
    expect(s.length).toBeLessThan(2 * 1000 + 300);
    expect(s).toMatch(/\d+ more items on screen\./);
  });

  it("is empty for an empty screen and ends with the approval reminder", () => {
    expect(screenSummary([])).toBe("");
    expect(screenSummary([{ text: "Balance 100 RON" }])).toMatch(/Reading is not approval\.$/);
  });
});
