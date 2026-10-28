import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Api, type Stack } from "./harness";

// Edge inputs on the read side. Every capability a customer can open is analysed with hostile inputs (empty, text,
// negative, overflowing, non-finite, unsafe integers, very long strings, repeated query keys, arrays, objects and
// unknown keys): the answer is never a server error, and no headline, summary, number, block or candidate carries
// NaN, Infinity, "undefined" or an amount outside safe integers. Then tenant and context isolation on read routes:
// another login gets 404 for every id it does not own, error bodies say nothing about the owner, and capabilities
// from the other context or the other customer are refused.

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.teardown();
});

/* ------------------------------------------------------------------------------------------- helpers */

const LONG = "9".repeat(400);
/** Query-string values (GET /api/capabilities/:id?i.key=value). Digits-only strings arrive as numbers. */
const QUERY_VALUES = ["", "abc", "-5", "1e309", "NaN", "Infinity", "-Infinity", String(2 ** 53), "0", "-0", LONG.slice(0, 120), "x".repeat(150), "1,234.56", "0x10", " 12 ", "true", "null", "undefined", "<script>"];
/** JSON body values (POST /api/capabilities/:id {inputs}). */
const BODY_VALUES: unknown[] = [2 ** 53, -(2 ** 53), 1e300, -1e300, Number.MAX_SAFE_INTEGER, -1, 0.5, 1e15, -1e15, true, false, null, [1, 2], { a: 1 }, "1e309", "", "abc"];

/** Keys every capability might read, plus the ones it declares; unknown and prototype keys must be ignored. */
const KNOWN_KEYS = [
  "months", "horizonMonths", "termMonths", "years", "billingDay", "dataNeedGb", "includeProtection", "keepPlayback", "stillGoing", "needsExtras",
  "keepInDailyMinor", "minDaysAway", "dailyFloorMinor", "savingsKeepMinor", "downPaymentMinor", "transactionCostsMinor", "protectedReserveMinor",
  "monthlyContributionMinor", "atlasFrom", "atlasUntil", "chaosFrom", "chaosUntil", "subscription", "ceilingMinor", "need", "minUses", "evaluateOn",
  "businessUse", "roadblock", "whatIf", "amountMinor", "principalMinor", "annualRateBp", "changeBp", "monthlyMinor", "unknownKey", "__proto__", "constructor",
];

const BAD_TEXT = /\bNaN\b|\bInfinity\b|\bundefined\b|\[object Object\]|\de[+-]\d+/;

/** Every problem in an analysis: bad text in what the customer reads, non-finite or unsafe numbers anywhere. */
function problems(a: any, baseline: any): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string, text: boolean) => {
    if (typeof v === "string") {
      if (text && BAD_TEXT.test(v)) out.push(`${at}: ${v.slice(0, 160)}`);
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) out.push(`${at}: ${v}`);
      else if (Number.isInteger(v) && !Number.isSafeInteger(v)) out.push(`${at}: unsafe ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, text));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`, text && k !== "id");
  };
  for (const k of ["headline", "summary"]) {
    if (typeof a[k] !== "string" || !a[k].trim()) out.push(`${k} missing`);
    else walk(a[k], k, true);
  }
  walk(a.blocks, "blocks", true);
  walk(a.candidates, "candidates", true);
  walk(a.numbers, "numbers", false);
  // JSON turns NaN into null: a number the baseline had must still be a number.
  for (const [k, v] of Object.entries(a.numbers ?? {})) if (v === null && typeof baseline?.numbers?.[k] === "number") out.push(`numbers.${k}: null (NaN?)`);
  for (const c of a.candidates ?? []) for (const [k, v] of Object.entries(c.spec?.money ?? {})) if (typeof v === "number" && !Number.isSafeInteger(v)) out.push(`candidate ${c.key} money.${k}: ${v}`);
  // Declared numeric inputs never echo a non-finite value.
  for (const f of a.inputs ?? []) if ((f.type === "money" || f.type === "number") && f.value !== null && f.value !== undefined && typeof f.value === "number" && !Number.isFinite(f.value)) out.push(`inputs.${f.key}: ${f.value}`);
  return out;
}

async function personas() {
  const alex = await stack.login("alex");
  const lazizBiz = await stack.login("laziz");
  const lazizHome = await stack.login("laziz");
  const s = await lazizHome.json("/api/session");
  await lazizHome.ok("/api/session/context", { contextId: s.contexts.find((c: any) => c.kind === "PERSONAL").id });
  return [
    { name: "alex PERSONAL", api: alex },
    { name: "laziz BUSINESS", api: lazizBiz },
    { name: "laziz PERSONAL", api: lazizHome },
  ];
}

async function ownCapabilities(api: Api): Promise<string[]> {
  const list = (await api.json("/api/capabilities")).capabilities as { id: string; inThisContext: boolean }[];
  return list.filter((c) => c.inThisContext).map((c) => c.id);
}

/* ------------------------------------------------------------------------------------- hostile inputs */

describe("capability analysis with hostile inputs", () => {
  it("never fails and never shows NaN, Infinity, undefined or unsafe amounts, for every capability in every context", async () => {
    const failures: string[] = [];
    let analysed = 0;
    for (const { name, api } of await personas()) {
      const ids = await ownCapabilities(api);
      expect(ids.length, name).toBeGreaterThan(0);
      for (const id of ids) {
        const base = await api.get(`/api/capabilities/${id}`);
        expect(base.status, `${name} ${id} baseline ${base.text.slice(0, 200)}`).toBe(200);
        const baseProblems = problems(base.json, base.json);
        if (baseProblems.length) failures.push(`${name} ${id} baseline: ${baseProblems.join(" | ")}`);
        const keys = [...new Set([...KNOWN_KEYS, ...(base.json.inputs ?? []).map((f: any) => f.key)])];
        const record = (label: string, r: { status: number; text: string; json: any }) => {
          analysed++;
          if (r.status !== 200) failures.push(`${name} ${id} ${label}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
          else {
            const p = problems(r.json, base.json);
            if (p.length) failures.push(`${name} ${id} ${label}: ${p.slice(0, 4).join(" | ")}`);
          }
        };
        // Query string: every key at once with the same hostile value, then each declared input alone.
        for (const v of QUERY_VALUES) {
          const qs = keys.map((k) => `i.${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
          record(`GET all=${JSON.stringify(v.slice(0, 20))}`, await api.get(`/api/capabilities/${id}?${qs}`));
        }
        for (const f of base.json.inputs ?? []) {
          for (const v of ["abc", "-5", "1e309", String(2 ** 53), LONG, "x".repeat(4000), ""]) record(`GET ${f.key}=${JSON.stringify(v.slice(0, 20))}`, await api.get(`/api/capabilities/${id}?i.${encodeURIComponent(f.key)}=${encodeURIComponent(v)}`));
          // Repeated keys: the last one wins and is still sanitised.
          record(`GET ${f.key} repeated`, await api.get(`/api/capabilities/${id}?i.${f.key}=1&i.${f.key}=abc&i.${f.key}=-99999999999999999999`));
        }
        // JSON body: typed values the query string cannot carry (unsafe integers, arrays, objects, booleans, null).
        for (const v of BODY_VALUES) record(`POST all=${JSON.stringify(v)}`, await api.post(`/api/capabilities/${id}`, { inputs: Object.fromEntries(keys.map((k) => [k, v])) }));
        // A malformed inputs container is ignored, not trusted.
        for (const inputs of ["abc", 5, [1, 2, 3], null, { "": 1, "1abc": 2, ["k".repeat(100)]: 3 }]) record(`POST inputs=${JSON.stringify(inputs).slice(0, 30)}`, await api.post(`/api/capabilities/${id}`, { inputs }));
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(analysed).toBeGreaterThan(500);
  }, 600_000);
});

/* ---------------------------------------------------------------------------------- saved O1 inputs */

describe("saving the home plan with hostile inputs", () => {
  it("never stores NaN or an unsafe amount in the goal, and every read afterwards still works", async () => {
    const a = await stack.login("alex");
    const goalOf = () => stack.q1<any>("SELECT * FROM goals WHERE tenant_id=? AND kind='HOME'", a.tenantId)!;
    const before = JSON.parse(goalOf().inputs_json);
    for (const v of ["abc", "NaN", "1e309", -5, 2 ** 53, 1e300, [1], { a: 1 }, true, "  ", 0.5]) {
      const inputs = Object.fromEntries(["monthlyContributionMinor", "transactionCostsMinor", "protectedReserveMinor", "downPaymentMinor"].map((k) => [k, v]));
      const r = await a.post("/api/capabilities/O1/save", { inputs });
      expect.soft(r.status, `save ${JSON.stringify(v)}: ${r.text.slice(0, 160)}`).toBe(400);
      expect.soft(r.json?.error).toBe("BAD_INPUT");
    }
    // Refused saves changed nothing.
    expect(JSON.parse(goalOf().inputs_json)).toEqual(before);

    // Only the transaction costs may be unknown; a contribution of zero would make the plan never finish.
    for (const inputs of [{ monthlyContributionMinor: 0 }, { monthlyContributionMinor: null }, { downPaymentMinor: "" }, { protectedReserveMinor: "unknown" }]) {
      expect.soft((await a.post("/api/capabilities/O1/save", { inputs })).status, JSON.stringify(inputs)).toBe(400);
    }
    expect(JSON.parse(goalOf().inputs_json)).toEqual(before);

    // Valid saves still work: a whole amount, "unknown" (null) for the optional costs, and a digits-only string.
    const ok = await a.ok("/api/capabilities/O1/save", { inputs: { monthlyContributionMinor: 650_000, transactionCostsMinor: "unknown", downPaymentMinor: "2000000" } });
    expect(ok.saved).toMatch(/^cmp_/);
    const saved = JSON.parse(goalOf().inputs_json);
    expect(saved).toMatchObject({ monthlyContributionMinor: 650_000, transactionCostsMinor: null, downPaymentMinor: 2_000_000 });

    // Every read of the goal keeps working with what was stored.
    for (const p of ["/api/goals", `/api/goals/${goalOf().id}`, "/api/home", "/api/capabilities/O1", "/api/capabilities/O6"]) {
      const r = await a.get(p);
      expect.soft(r.status, `${p} ${r.text.slice(0, 160)}`).toBe(200);
      expect.soft(BAD_TEXT.test(r.text), p).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------------------------ isolation */

/** An error body says what went wrong and nothing about whose item it was. */
function expectQuietError(r: { status: number; json: any; text: string }, label: string, status: number, forbidden: string[]) {
  expect.soft(r.status, `${label}: ${r.text.slice(0, 160)}`).toBe(status);
  expect.soft(Object.keys(r.json ?? {}).sort(), label).toEqual(["error", "message"]);
  for (const f of forbidden) expect.soft(r.text.includes(f), `${label} leaks ${f}`).toBe(false);
}

describe("isolation on read routes", () => {
  it("every capability id is refused from the wrong context (409) or the wrong customer (404), with no data in the body", async () => {
    const alex = await stack.login("alex");
    const laziz = await stack.login("laziz");
    const all = async (api: Api) => (await api.json("/api/capabilities")).capabilities as { id: string; inThisContext: boolean }[];
    const alexIds = (await all(alex)).map((c) => c.id);
    const lazizCaps = await all(laziz);
    const business = lazizCaps.filter((c) => c.inThisContext).map((c) => c.id);
    const personalOnly = lazizCaps.filter((c) => !c.inThisContext).map((c) => c.id);
    expect(personalOnly.length).toBeGreaterThan(0);
    const foreign = alexIds.filter((id) => !lazizCaps.some((c) => c.id === id));
    expect(foreign.length).toBeGreaterThan(0);
    const leaks = [alex.tenantId, laziz.tenantId];

    for (const id of personalOnly) {
      for (const r of [await laziz.get(`/api/capabilities/${id}`), await laziz.post(`/api/capabilities/${id}`, { inputs: {} }), await laziz.post(`/api/capabilities/${id}/propose`, { keys: [] })]) {
        expectQuietError(r, `laziz BUSINESS ${id}`, 409, leaks);
        expect.soft(r.json?.error).toBe("WRONG_CONTEXT");
      }
    }
    for (const id of foreign) {
      for (const r of [await laziz.get(`/api/capabilities/${id}`), await laziz.post(`/api/capabilities/${id}/propose`, { keys: [] })]) expectQuietError(r, `laziz ${id}`, 404, leaks);
    }
    // Lower-case ids are the same capability; unknown and odd ids are a plain 404, never a server error.
    expect((await laziz.get(`/api/capabilities/${business[0].toLowerCase()}`)).status).toBe(200);
    for (const odd of ["ZZ9", "A", "A999999999999", "%20", "A3%00", "..%2F..%2Fsession", "'%20OR%201=1--", "%E2%80%AE", "x".repeat(2000)]) {
      expectQuietError(await alex.get(`/api/capabilities/${odd}`), `odd ${odd.slice(0, 20)}`, 404, leaks);
    }
  });

  it("another login gets a quiet 404 for goals, accounts, proposals, actions and certificates it does not own; malformed ids never fail", async () => {
    const a = await stack.login("alex");
    const goal = stack.q1<any>("SELECT id FROM goals WHERE tenant_id=? LIMIT 1", a.tenantId)!.id as string;
    const account = stack.q1<any>("SELECT id FROM accounts WHERE tenant_id=? LIMIT 1", a.tenantId)!.id as string;
    const proposal = await stack.propose(a, "A3", ["annual"], { horizonMonths: 24 });
    const action = proposal.actions[0].id;
    const owned = [`/api/goals/${goal}`, `/api/accounts/${encodeURIComponent(account)}`, `/api/proposals/${proposal.id}`, `/api/actions/${action}`];
    for (const p of owned) expect.soft((await a.get(p)).status, `owner ${p}`).toBe(200);

    const leaks = [a.tenantId, goal, account, proposal.id];
    for (const other of [await stack.login("alex"), await stack.login("laziz")]) {
      for (const p of owned) expectQuietError(await other.get(p), `${other.tenantId} ${p}`, 404, leaks);
    }

    // Malformed, encoded and oversized ids on every parameterised read route: 404 (or 400), never 500, never a leak.
    const odd = ["x", "0", "-1", "%00", "..%2F..%2Fetc%2Fpasswd", "'%20OR%201=1--", "%F0%9F%92%A5", "a".repeat(3000), `${encodeURIComponent(a.tenantId)}%3Apersonal`];
    const routes = ["/api/transactions/", "/api/subscriptions/", "/api/goals/", "/api/accounts/", "/api/recoveries/", "/api/proposals/", "/api/actions/", "/api/receipts/", "/api/evidence/screens/", "/api/tasks/", "/api/uploads/%ID%/image", "/api/batches/", "/api/batches/%ID%/followups", "/api/batches/%ID%/export", "/api/ext/certificate/certificates/"];
    const b = await stack.login("laziz");
    for (const route of routes) {
      for (const id of odd) {
        const p = route.includes("%ID%") ? route.replace("%ID%", id) : route + id;
        const r = await b.get(p);
        expect.soft([400, 404], `${p.slice(0, 80)} ${r.status} ${r.text.slice(0, 120)}`).toContain(r.status);
        for (const f of [a.tenantId, "INTERNAL"]) expect.soft(r.text.includes(f), `${p.slice(0, 80)} leaks ${f}`).toBe(false);
      }
    }
    // Well-formed certificate ids that do not exist are as quiet as foreign ones.
    for (const id of ["cert_000000000000000000000000", "cert_ffffffffffffffffffffffff", "CERT_000000000000000000000000", "cert_00000000000000000000000g"]) {
      expectQuietError(await b.get(`/api/ext/certificate/certificates/${id}`), id, 404, [a.tenantId]);
    }
  });

  it("switching to a context the user does not own is refused and leaves the session where it was", async () => {
    const alex = await stack.login("alex");
    const laziz = await stack.login("laziz");
    const lazizSession = await laziz.json("/api/session");
    const lazizBusiness = lazizSession.context.id as string;
    const lazizPersonal = lazizSession.contexts.find((c: any) => c.kind === "PERSONAL").id as string;
    const alexContext = (await alex.json("/api/session")).context.id as string;

    for (const contextId of [lazizBusiness, lazizPersonal, `${alex.tenantId}:business`, "", "x", null, 5, [lazizBusiness], { id: alexContext }, `${alexContext} `, alexContext.toUpperCase(), "a".repeat(5000)]) {
      const r = await alex.post("/api/session/context", { contextId });
      expectQuietError(r, `switch ${JSON.stringify(contextId).slice(0, 40)}`, 404, [laziz.tenantId, lazizBusiness, lazizPersonal]);
      expect((await alex.json("/api/session")).context.id).toBe(alexContext);
    }
    // Switching to your own context is the one that works, and it is idempotent.
    expect((await alex.ok("/api/session/context", { contextId: alexContext })).context.id).toBe(alexContext);
    // A one-element array is read as its string (String([id]) === id). Harmless: ownership is still checked, so it
    // can only ever name the user's own context.
    expect((await alex.post("/api/session/context", { contextId: [alexContext] })).status).toBe(200);

    // The same user may read an item from their other context (it is theirs), but acting on it needs that context:
    // reads are allowed by design, decisions are refused with 409 (covered in security.test.ts).
    const seats = await stack.propose(laziz, "A13", ["reduce-seats"]);
    await laziz.ok("/api/session/context", { contextId: lazizPersonal });
    expect((await laziz.get(`/api/proposals/${seats.id}`)).status).toBe(200);
    const goal = stack.q1<any>("SELECT id FROM goals WHERE tenant_id=? AND context_id=? LIMIT 1", laziz.tenantId, lazizBusiness);
    if (goal) {
      const r = await laziz.get(`/api/goals/${goal.id}`);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("WRONG_CONTEXT");
    }
  });
});
