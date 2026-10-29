import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

const at = (p: string) => proxy(new NextRequest(`http://127.0.0.1:3210${p}`));

// Broken percent-encoding used to get Next's bare "400: Bad Request" page, even under /api.
describe("proxy: malformed addresses", () => {
  it("API paths get the API's JSON error", async () => {
    const r = at("/api/tasks/%E0%A4%A");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "BAD_URL", message: "This address is not valid." });
  });
  it("pages are rewritten to the app's not-found page", () => {
    for (const p of ["/agent/tasks/%", "/agent/tasks/%E0%A4%A", "/%zz"]) expect(at(p).headers.get("x-middleware-rewrite"), p).toContain("/not-a-page");
  });
  it("valid addresses, including encoded ones, pass through untouched", () => {
    for (const p of ["/home", "/agent/tasks/abc", "/api/tasks/x%20y", "/agent/tasks/%C8%99"]) {
      const r = at(p);
      expect(r.headers.get("x-middleware-next"), p).toBe("1");
      expect(r.headers.get("x-middleware-rewrite"), p).toBeNull();
    }
  });
});
