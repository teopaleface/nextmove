import { describe, expect, it } from "vitest";
import { cut } from "../../src/server/agent/events";

// Stored question, option, reason and timeline texts are cut to a length; a cut through an emoji would leave a lone
// surrogate, which SQLite stores as U+FFFD.
describe("cut", () => {
  it("keeps short text whole and cuts long text to n", () => {
    expect(cut("hello", 10)).toBe("hello");
    expect(cut("x".repeat(500), 400)).toBe("x".repeat(400));
  });
  it("never ends on half of an emoji", () => {
    expect(cut(`${"x".repeat(299)}😀 more`, 300)).toBe("x".repeat(299));
    expect(cut(`${"y".repeat(79)}😀`, 80)).toBe("y".repeat(79));
    expect(cut(`${"y".repeat(78)}😀`, 80)).toBe(`${"y".repeat(78)}😀`);
    expect(cut("😀😀", 3)).toBe("😀");
  });
});
