import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULES, PENALTIES, capacity, charge, checkPenalty, classify, clientIp, normalizeIp, openStream, penalize, resetRateLimits, RateLimitError } from "../../src/server/api/rate-limit";

// The request limiter on its own: bucket arithmetic on a fake clock, client address parsing, and route classes.

const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });
const who = (ip = "203.0.113.7", account: string | null = "t1|u1") => ({ ip, account });
const refused = (f: () => void) => {
  try {
    f();
  } catch (e) {
    if (e instanceof RateLimitError) return e;
    throw e;
  }
  return null;
};

beforeEach(() => {
  delete process.env.NEXTMOVE_RATE_LIMIT_SCALE;
  delete process.env.NEXTMOVE_TRUSTED_PROXY_HOPS;
  resetRateLimits();
});
afterEach(() => resetRateLimits());

describe("client address", () => {
  it("uses the entry Next.js or the trusted proxy appended, never one further left", () => {
    expect(clientIp(h("127.0.0.1"))).toBe("127.0.0.1");
    // Direct: the rightmost entry. Behind one proxy: still the rightmost (the proxy appended it).
    expect(clientIp(h("6.6.6.6, 198.51.100.4"), 0)).toBe("198.51.100.4");
    expect(clientIp(h("6.6.6.6, 198.51.100.4"), 1)).toBe("198.51.100.4");
    // Behind two proxies the client is the second from the right; the forged leftmost entry is never used.
    expect(clientIp(h("6.6.6.6, 198.51.100.4, 10.0.0.2"), 2)).toBe("198.51.100.4");
    // More hops configured than entries present: the leftmost entry, not an out-of-range read.
    expect(clientIp(h("198.51.100.4"), 3)).toBe("198.51.100.4");
    expect(clientIp(h())).toBe("unknown");
    expect(clientIp(h(" , ,"))).toBe("unknown");
  });

  it("normalises ports, IPv4-mapped IPv6, zones and IPv6 /64 blocks; junk shares one key", () => {
    expect(normalizeIp("198.51.100.4:51234")).toBe("198.51.100.4");
    expect(normalizeIp("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(normalizeIp("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    // Every address in one /64 is the same client: rotating the low bits buys nothing.
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(normalizeIp("2001:0db8:0001:0002::1"));
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(normalizeIp("2001:db8:1:2::1"));
    expect(normalizeIp("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    for (const junk of ["not-an-ip", "999.1.1.1", "<script>", "1.2.3", "' OR 1=1", "a".repeat(5000)]) expect(normalizeIp(junk)).toBe("invalid");
  });
});

describe("buckets", () => {
  it("allows exactly the budget, refuses the next with a wait, and refills evenly", () => {
    const cap = capacity(RULES.agent[1]); // 8 a minute per account
    const t0 = 1_000_000;
    for (let i = 0; i < cap; i++) charge("agent", who(), t0);
    const e = refused(() => charge("agent", who(), t0));
    expect(e?.status).toBe(429);
    expect(e?.code).toBe("RATE_LIMITED");
    expect(e?.retryAfter).toBe(Math.ceil(60 / cap));
    // One token's worth of time later, exactly one more request fits.
    const later = t0 + Math.ceil(60_000 / cap);
    charge("agent", who(), later);
    expect(refused(() => charge("agent", who(), later))).not.toBeNull();
  });

  it("charges all or nothing: a refusal on the account budget does not drain the IP budget", () => {
    const t0 = 2_000_000;
    const acct = capacity(RULES.agent[1]);
    for (let i = 0; i < acct; i++) charge("agent", who("198.51.100.1", "a"), t0);
    for (let i = 0; i < 50; i++) expect(refused(() => charge("agent", who("198.51.100.1", "a"), t0))).not.toBeNull();
    // The same IP, another account: still the full per-IP budget minus the 8 that went through.
    const ipLeft = capacity(RULES.agent[0]) - acct;
    for (let i = 0; i < ipLeft; i++) charge("agent", who("198.51.100.1", `b${i}`), t0);
    expect(refused(() => charge("agent", who("198.51.100.1", "fresh"), t0))).not.toBeNull();
  });

  it("rotating IPs and accounts cannot pass a global ceiling", () => {
    const t0 = 3_000_000;
    const ceiling = capacity(RULES.agent[3]);
    for (let i = 0; i < ceiling; i++) charge("agent", who(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`, `acct-${i}`), t0);
    expect(refused(() => charge("agent", who("192.0.2.200", "brand-new"), t0))).not.toBeNull();
  });

  it("separate classes and separate accounts never share a bucket", () => {
    const t0 = 4_000_000;
    for (let i = 0; i < capacity(RULES.money[1]); i++) charge("money", who(), t0);
    expect(refused(() => charge("money", who(), t0))).not.toBeNull();
    charge("write", who(), t0);
    charge("money", who(undefined, "t2|u1"), t0);
  });

  it("a request with no account draws only on IP and global budgets", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < capacity(RULES.session[0]); i++) charge("session", who("198.51.100.9", null), t0);
    expect(refused(() => charge("session", who("198.51.100.9", null), t0))).not.toBeNull();
    charge("session", who("198.51.100.10", null), t0);
  });

  it("the scale knob multiplies every budget but never goes below one", () => {
    process.env.NEXTMOVE_RATE_LIMIT_SCALE = "0.0001";
    expect(capacity(RULES.agent[1])).toBe(1);
    process.env.NEXTMOVE_RATE_LIMIT_SCALE = "10";
    expect(capacity(RULES.agent[1])).toBe(80);
    for (const bad of ["0", "-5", "NaN", "Infinity", "abc", ""]) {
      process.env.NEXTMOVE_RATE_LIMIT_SCALE = bad;
      expect(capacity(RULES.agent[1])).toBe(8);
    }
  });

  it("a clock that goes backwards never mints extra tokens", () => {
    const t0 = 6_000_000;
    for (let i = 0; i < capacity(RULES.agent[1]); i++) charge("agent", who(), t0);
    expect(refused(() => charge("agent", who(), t0 - 3_600_000))).not.toBeNull();
    expect(refused(() => charge("agent", who(), t0))).not.toBeNull();
  });
});

describe("penalties", () => {
  it("probing is refused once the probe budget is spent, and recovers with time", () => {
    const t0 = 7_000_000;
    const w = who("198.51.100.66", null);
    for (let i = 0; i < PENALTIES.probe.n; i++) {
      checkPenalty("probe", w, t0);
      penalize("probe", w, t0);
    }
    expect(refused(() => checkPenalty("probe", w, t0))?.status).toBe(429);
    // Another IP is unaffected.
    checkPenalty("probe", who("198.51.100.67", null), t0);
    checkPenalty("probe", w, t0 + 60_000);
  });

  it("guessing ids is budgeted per account", () => {
    const t0 = 8_000_000;
    for (let i = 0; i < PENALTIES.miss.n; i++) penalize("miss", who(), t0);
    expect(refused(() => checkPenalty("miss", who(), t0))?.message).toMatch(/do not exist/);
    checkPenalty("miss", who(undefined, "other"), t0);
    // No account (signed out): nothing to charge, nothing refused.
    penalize("miss", who(undefined, null), t0);
    checkPenalty("miss", who(undefined, null), t0);
  });
});

describe("streams", () => {
  it("caps open live views per account and per IP, and releasing twice frees one slot only", () => {
    const held = [0, 1, 2, 3].map(() => openStream(who("198.51.100.20", "acct")));
    expect(refused(() => openStream(who("198.51.100.20", "acct")))?.code).toBe("TOO_MANY_STREAMS");
    held[0]();
    held[0]();
    const again = openStream(who("198.51.100.20", "acct"));
    expect(refused(() => openStream(who("198.51.100.20", "acct")))).not.toBeNull();
    again();
    for (const r of held) r();
    // Per IP: 16 across many accounts.
    const many = Array.from({ length: 16 }, (_, i) => openStream(who("198.51.100.21", `a${i}`)));
    expect(refused(() => openStream(who("198.51.100.21", "a99")))).not.toBeNull();
    many.forEach((r) => r());
  });
});

describe("route classes", () => {
  it("puts every costly route in its own class", () => {
    expect(classify("GET", "/health")).toBe("health");
    expect(classify("GET", "/tasks/:id/stream")).toBe("read");
    expect(classify("POST", "/tasks")).toBe("agent");
    expect(classify("POST", "/tasks/:id/answer")).toBe("agent");
    expect(classify("POST", "/tasks/:id/stop")).toBe("write");
    expect(classify("POST", "/proposals/:id/approve")).toBe("money");
    expect(classify("POST", "/proposals/:id/decline")).toBe("money");
    expect(classify("POST", "/mandates/:id/stop")).toBe("money");
    expect(classify("POST", "/batches/:id/approve")).toBe("money");
    expect(classify("POST", "/permissions/:id/revoke")).toBe("money");
    expect(classify("POST", "/uploads/:id/extract")).toBe("vision");
    expect(classify("POST", "/uploads")).toBe("upload");
    expect(classify("POST", "/labs/reset")).toBe("reset");
    expect(classify("POST", "/labs/clock")).toBe("labs");
    expect(classify("POST", "/session/demo")).toBe("session");
    expect(classify("POST", "/inbox/merchant")).toBe("inbox");
    expect(classify("POST", "/capabilities/:id/propose")).toBe("write");
  });
});
