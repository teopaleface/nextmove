import net from "node:net";
import { HttpError } from "../auth/session";

// Request limits for the bank API, kept in this process's memory (one Next.js server). Every request is charged to
// its client IP and, once signed in, to its account (tenant + user); the costly or abusable routes also draw on one
// global ceiling, because a client talking to the server directly can forge X-Forwarded-For and so rotate its IP
// key, but cannot rotate its way past a ceiling every IP shares. Failed sign-ins, CSRF refusals, unknown routes and
// misses on other people's ids draw on penalty budgets of their own, so probing gets slower, not cheaper.

export type LimitClass = "read" | "write" | "money" | "agent" | "upload" | "vision" | "labs" | "reset" | "session" | "isolated" | "inbox" | "health";
type Scope = "ip" | "account" | "global";
interface Rule {
  scope: Scope;
  n: number;
  perMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Per-class budgets before scaling: n requests per window, refilled evenly (a token bucket of size n). */
export const RULES: Record<LimitClass, Rule[]> = {
  read: [{ scope: "ip", n: 1200, perMs: MIN }, { scope: "account", n: 600, perMs: MIN }],
  write: [{ scope: "ip", n: 300, perMs: MIN }, { scope: "account", n: 120, perMs: MIN }],
  // Approvals, declines and stops: anything that grants or withdraws authority over money.
  money: [{ scope: "ip", n: 60, perMs: MIN }, { scope: "account", n: 20, perMs: MIN }, { scope: "account", n: 300, perMs: DAY }],
  // A request or an answer to the agent may start live-model calls, which spend real budget.
  agent: [{ scope: "ip", n: 30, perMs: MIN }, { scope: "account", n: 8, perMs: MIN }, { scope: "account", n: 120, perMs: DAY }, { scope: "global", n: 600, perMs: HOUR }],
  upload: [{ scope: "ip", n: 60, perMs: HOUR }, { scope: "account", n: 30, perMs: HOUR }],
  // Reading an image sends it to the live model.
  vision: [{ scope: "ip", n: 20, perMs: HOUR }, { scope: "account", n: 10, perMs: HOUR }, { scope: "global", n: 100, perMs: HOUR }],
  labs: [{ scope: "ip", n: 300, perMs: MIN }, { scope: "account", n: 120, perMs: MIN }],
  // A reset reseeds the whole demo world for the tenant.
  reset: [{ scope: "ip", n: 20, perMs: 10 * MIN }, { scope: "account", n: 10, perMs: 10 * MIN }],
  session: [{ scope: "ip", n: 30, perMs: 10 * MIN }, { scope: "global", n: 300, perMs: 10 * MIN }],
  // Each isolated demo copy seeds a full tenant on disk.
  isolated: [{ scope: "ip", n: 20, perMs: HOUR }, { scope: "global", n: 300, perMs: DAY }],
  inbox: [{ scope: "ip", n: 600, perMs: MIN }],
  health: [{ scope: "ip", n: 120, perMs: MIN }],
};

/** Penalty budgets: spent by failures, checked before any work is done. */
export const PENALTIES = {
  /** 401, CSRF/origin 403s and unknown routes, per IP. */
  probe: { scope: "ip" as Scope, n: 60, perMs: MIN },
  /** 404s on an id the account asked for: guessing other people's ids. */
  miss: { scope: "account" as Scope, n: 200, perMs: 10 * MIN },
};

/** Live event streams held open at once. */
export const STREAMS = { ip: 16, account: 4 };

/** Agent tasks an account may have open (queued, running or waiting for an answer) at once. */
export const OPEN_TASKS = 10;

const MAX_KEYS = 50_000;

interface Bucket {
  tokens: number;
  at: number;
}
interface State {
  buckets: Map<string, Bucket>;
  streams: Map<string, number>;
}
// On globalThis so a dev-mode module reload keeps the counts instead of handing everyone a fresh budget.
const g = globalThis as unknown as { __nextmoveRateLimit?: State };
const state = (g.__nextmoveRateLimit ??= { buckets: new Map(), streams: new Map() });

/** Test and demo knob: multiplies every budget (never below 1). The integration harness raises it; 1 in normal use. */
export function scale(): number {
  const v = Number(process.env.NEXTMOVE_RATE_LIMIT_SCALE ?? 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function capacity(rule: { n: number }, s = scale()): number {
  return Math.max(1, Math.floor(rule.n * s));
}

/** Proxies in front of the server whose X-Forwarded-For entries are trusted (0: none, the server is reached directly). */
function trustedHops(): number {
  const v = Number(process.env.NEXTMOVE_TRUSTED_PROXY_HOPS ?? 0);
  return Number.isInteger(v) && v >= 0 && v <= 5 ? v : 0;
}

/**
 * The client address used as the per-IP key. Next.js fills X-Forwarded-For from the socket only when the request has
 * none; behind `hops` trusted proxies the client is the entry the outermost of them appended. Ports and IPv4-mapped
 * prefixes are dropped, IPv6 is grouped by /64 (one subscriber's whole block), and anything that is not an address
 * shares a single "invalid" key.
 */
export function clientIp(headers: Headers, hops = trustedHops()): string {
  const list = (headers.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length) return "unknown";
  const raw = list[Math.max(0, list.length - Math.max(1, hops))];
  return normalizeIp(raw);
}

export function normalizeIp(raw: string): string {
  let a = raw.trim().toLowerCase();
  const bracket = a.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) a = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  a = a.replace(/%.*$/, "");
  if (a.startsWith("::ffff:") && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return "invalid";
  // Expand "::" and keep the first four groups.
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function refill(key: string, rule: { n: number; perMs: number }, now: number, s: number): Bucket {
  const cap = capacity(rule, s);
  const b = state.buckets.get(key);
  if (!b) return { tokens: cap, at: now };
  // A clock that steps back refills nothing and never moves the bucket's time back (which would refill twice).
  return { tokens: Math.min(cap, b.tokens + (Math.max(0, now - b.at) * cap) / rule.perMs), at: Math.max(now, b.at) };
}

function put(key: string, b: Bucket) {
  // Re-insert so the Map's order stays least-recently-used first.
  state.buckets.delete(key);
  state.buckets.set(key, b);
  if (state.buckets.size > MAX_KEYS) {
    // Rotated keys cannot grow memory without bound: drop the oldest tenth.
    let drop = Math.ceil(MAX_KEYS / 10);
    for (const k of state.buckets.keys()) {
      if (drop-- <= 0) break;
      state.buckets.delete(k);
    }
  }
}

function waitSeconds(b: Bucket, rule: { n: number; perMs: number }, s: number): number {
  return Math.max(1, Math.ceil(((1 - b.tokens) * rule.perMs) / capacity(rule, s) / 1000));
}

export class RateLimitError extends HttpError {
  constructor(public retryAfter: number, code = "RATE_LIMITED", message?: string) {
    super(429, code, message ?? `Too many requests. Try again in ${retryAfter} s.`);
  }
}

export interface Who {
  ip: string;
  account: string | null;
}

function keyFor(name: string, i: number, rule: Rule | { scope: Scope }, who: Who): string | null {
  if (rule.scope === "global") return `${name}#${i}|*`;
  if (rule.scope === "ip") return `${name}#${i}|ip|${who.ip}`;
  return who.account ? `${name}#${i}|acct|${who.account}` : null;
}

/**
 * Charge one request of this class to every bucket it draws on, all or nothing: a refused request spends nothing,
 * so a client over its account budget does not also drain its IP budget. Throws 429 with the longest wait.
 */
export function charge(cls: LimitClass, who: Who, now = Date.now()) {
  const s = scale();
  const rules = RULES[cls];
  const next: [string, Bucket][] = [];
  let wait = 0;
  rules.forEach((rule, i) => {
    const key = keyFor(cls, i, rule, who);
    if (!key) return;
    const b = refill(key, rule, now, s);
    if (b.tokens < 1) wait = Math.max(wait, waitSeconds(b, rule, s));
    next.push([key, b]);
  });
  if (wait) throw new RateLimitError(wait);
  for (const [key, b] of next) put(key, { tokens: b.tokens - 1, at: b.at });
}

/** Refuse when this penalty budget is spent, without spending more of it. */
export function checkPenalty(kind: keyof typeof PENALTIES, who: Who, now = Date.now()) {
  const rule = PENALTIES[kind];
  const key = keyFor(`penalty:${kind}`, 0, rule, who);
  if (!key) return;
  const b = refill(key, rule, now, scale());
  if (b.tokens < 1) throw new RateLimitError(waitSeconds(b, rule, scale()), "RATE_LIMITED", kind === "miss" ? "Too many requests for things that do not exist. Try again later." : undefined);
}

/** Spend one unit of a penalty budget (a failure happened). */
export function penalize(kind: keyof typeof PENALTIES, who: Who, now = Date.now()) {
  const rule = PENALTIES[kind];
  const key = keyFor(`penalty:${kind}`, 0, rule, who);
  if (!key) return;
  const b = refill(key, rule, now, scale());
  put(key, { tokens: Math.max(0, b.tokens - 1), at: b.at });
}

/** Hold a stream slot for this IP and account; the returned function releases it (safe to call twice). */
export function openStream(who: Who): () => void {
  const s = scale();
  const keys = [`ip|${who.ip}`, ...(who.account ? [`acct|${who.account}`] : [])];
  const limits = [Math.max(1, Math.floor(STREAMS.ip * s)), Math.max(1, Math.floor(STREAMS.account * s))];
  keys.forEach((k, i) => {
    if ((state.streams.get(k) ?? 0) >= limits[i]) throw new RateLimitError(5, "TOO_MANY_STREAMS", "Too many live views are open. Close one and try again.");
  });
  for (const k of keys) state.streams.set(k, (state.streams.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) {
      const n = (state.streams.get(k) ?? 1) - 1;
      if (n <= 0) state.streams.delete(k);
      else state.streams.set(k, n);
    }
  };
}

/** Which budget a route draws on. `pattern` is the router's pattern, so ids never change the class. */
export function classify(method: string, pattern: string): LimitClass {
  if (pattern === "/health") return "health";
  if (method === "GET") return "read";
  if (pattern === "/session/demo") return "session";
  if (pattern === "/inbox/merchant") return "inbox";
  if (pattern === "/tasks" || pattern === "/tasks/:id/answer") return "agent";
  if (pattern === "/uploads/:id/extract") return "vision";
  if (pattern === "/uploads" || pattern === "/uploads/sample") return "upload";
  if (pattern === "/labs/reset") return "reset";
  if (pattern.startsWith("/labs/")) return "labs";
  if (/^\/(proposals\/:id\/(approve|decline)|mandates\/:id\/stop|batches\/:id\/(approve|stop)|permissions\/:id\/revoke|actions\/:id\/check|extractions\/:id\/confirm)$/.test(pattern)) return "money";
  return "write";
}

/** Forget every count (tests). */
export function resetRateLimits() {
  state.buckets.clear();
  state.streams.clear();
}
