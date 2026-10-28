import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Integration harness. One stack per test file: a fresh temp data dir, the real merchant process, an in-process
// bank HTTP server that hands every /api request to the production router, and worker processes the test can
// start, kill -9 and restart. Everything binds to 127.0.0.1; teardown stops only the processes started here.
//
// Server modules cache the database handle and the local secrets, so the environment is set before they are
// imported (dynamic imports below) and a test file must not start a second stack.

export const ROOT = path.resolve(__dirname, "../..");

type RouterModule = typeof import("../../src/server/api/router");
type ConnModule = typeof import("../../src/server/db/connection");
type ConfigModule = typeof import("../../src/server/config");
type Row = Record<string, any>;

export interface StackOptions {
  mode?: "labs" | "bank-demo";
  /** Workers started with the stack (default 0: tests start them when they need them). */
  workers?: number;
  /** Route worker → merchant traffic through a proxy that can hold chosen requests (crash tests). */
  proxy?: boolean;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "expect", "proxy-connection"]);
const owned = new Set<ChildProcess>();
let exitHookInstalled = false;
let started = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const c of owned) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

/* ------------------------------------------------------------------------------------------- helpers */

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number; label?: string; onTimeout?: () => string } = {}): Promise<NonNullable<T>> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 150;
  const until = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      last = await fn();
      if (last) return last as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) {
      const extra = opts.onTimeout ? `\n${opts.onTimeout()}` : "";
      throw new Error(`Timed out after ${timeout} ms waiting for ${opts.label ?? "condition"} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})${extra}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

function processTree(): Map<number, number[]> {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !Number.isFinite(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return children;
}

/** Every descendant of pid (e.g. the Chromium processes a worker launched). */
export function descendants(pid: number): number[] {
  const tree = processTree();
  const out: number[] = [];
  const stack = [...(tree.get(pid) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(tree.get(p) ?? []));
  }
  return out;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/* ---------------------------------------------------------------------------------------- http client */

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: any;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });

export function rawRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<HttpResult> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (body) headers["content-length"] = String(body.length);
    const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: init.method ?? "GET", headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`request timeout ${init.method ?? "GET"} ${u.pathname}`)));
    req.end(body);
  });
}

/** Browser-like API client: cookie jar for the HttpOnly session and the per-session CSRF header on mutations. */
export class Api {
  cookie = "";
  csrf = "";
  tenantId = "";
  customer: "alex" | "laziz" | "" = "";

  constructor(readonly base: string) {}

  async call(method: string, p: string, opts: { body?: unknown; raw?: Buffer | string; headers?: Record<string, string>; csrf?: boolean | string; cookie?: boolean } = {}): Promise<HttpResult> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.cookie !== false && this.cookie) headers.cookie = this.cookie;
    if (method !== "GET" && opts.csrf !== false && (typeof opts.csrf === "string" || this.csrf)) headers["x-csrf-token"] = typeof opts.csrf === "string" ? opts.csrf : this.csrf;
    let body: Buffer | string | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] ??= "application/json";
    } else if (method !== "GET") body = "";
    const r = await rawRequest(`${this.base}${p}`, { method, headers, body });
    const set = r.headers["set-cookie"] ?? [];
    for (const c of set) {
      const m = /^nm_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `nm_session=${m[1]}` : "";
    }
    return r;
  }

  get(p: string, opts: Parameters<Api["call"]>[2] = {}) {
    return this.call("GET", p, opts);
  }

  post(p: string, body?: unknown, opts: Parameters<Api["call"]>[2] = {}) {
    return this.call("POST", p, { ...opts, body: body === undefined ? opts.body : body });
  }

  /** GET that must succeed; returns the parsed JSON. */
  async json(p: string): Promise<any> {
    const r = await this.get(p);
    if (r.status !== 200) throw new Error(`GET ${p} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }

  /** POST that must succeed; returns the parsed JSON. */
  async ok(p: string, body?: unknown): Promise<any> {
    const r = await this.post(p, body ?? {});
    if (r.status !== 200) throw new Error(`POST ${p} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }
}

/* ------------------------------------------------------------------------------------- merchant proxy */

export interface ProxyRequestInfo {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface ProxyRule {
  name: string;
  when: (r: ProxyRequestInfo) => boolean;
  /** hold-before: do not forward (the merchant sees nothing). hold-after: forward, then withhold the answer. Both until released. */
  mode: "hold-before" | "hold-after";
}

export interface ProxyHit {
  rule: string;
  method: string;
  path: string;
  at: number;
  forwarded: boolean;
  upstreamStatus: number | null;
  clientClosed: boolean;
  released: boolean;
}

/** Transparent HTTP proxy in front of the merchant for workers; selected requests can be held open. */
export class MerchantProxy {
  rules: ProxyRule[] = [];
  hits: ProxyHit[] = [];
  traffic: { method: string; path: string; status: number | null }[] = [];
  private held = new Set<http.ServerResponse>();
  private pending = new Map<ProxyHit, () => Promise<void>>();
  private server: http.Server;
  port = 0;

  constructor(private target: URL) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  hold(rule: ProxyRule) {
    this.rules.push(rule);
  }

  clear() {
    this.rules = [];
  }

  /** Let held requests for a rule go on: hold-before forwards them now; hold-after delivers the withheld answer. */
  async release(ruleName: string): Promise<number> {
    let n = 0;
    for (const [hit, go] of [...this.pending]) {
      if (hit.rule !== ruleName) continue;
      this.pending.delete(hit);
      await go();
      hit.released = true;
      n++;
    }
    return n;
  }

  private reply(res: http.ServerResponse, up: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }) {
    if (res.destroyed || res.writableEnded) return;
    const headers = { ...up.headers };
    delete headers["transfer-encoding"];
    delete headers.connection;
    res.writeHead(up.status, headers);
    res.end(up.body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const info: ProxyRequestInfo = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: body.toString("utf8") };
    const rule = this.rules.find((r) => r.when(info));
    const hit: ProxyHit | null = rule ? { rule: rule.name, method: info.method, path: info.path, at: Date.now(), forwarded: false, upstreamStatus: null, clientClosed: false, released: false } : null;
    if (hit) {
      this.hits.push(hit);
      this.held.add(res);
      res.on("close", () => {
        hit.clientClosed = true;
        this.held.delete(res);
      });
      if (rule!.mode === "hold-before") {
        // Not forwarded (the merchant sees nothing) unless released.
        this.pending.set(hit, async () => {
          try {
            const up = await this.forward(info, body);
            this.traffic.push({ method: info.method, path: info.path, status: up.status });
            hit.forwarded = true;
            hit.upstreamStatus = up.status;
            this.reply(res, up);
          } catch {
            res.socket?.destroy();
          }
        });
        return;
      }
    }
    try {
      const up = await this.forward(info, body);
      this.traffic.push({ method: info.method, path: info.path, status: up.status });
      if (hit) {
        hit.forwarded = true;
        hit.upstreamStatus = up.status;
        this.pending.set(hit, async () => this.reply(res, up));
        return; // the merchant committed; the caller hears back only if released
      }
      this.reply(res, up);
    } catch {
      this.traffic.push({ method: info.method, path: info.path, status: null });
      res.socket?.destroy(); // mirror a merchant that dropped the connection
    }
  }

  private forward(info: ProxyRequestInfo, body: Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { ...info.headers, host: this.target.host };
      for (const h of HOP_BY_HOP) delete headers[h];
      headers["content-length"] = String(body.length);
      const r = http.request({ host: this.target.hostname, port: this.target.port, method: info.method, path: info.path, headers, agent: false }, (resp) => {
        const parts: Buffer[] = [];
        resp.on("data", (c: Buffer) => parts.push(c));
        resp.on("end", () => resolve({ status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(parts) }));
        resp.on("error", reject);
      });
      r.on("error", reject);
      r.end(body);
    });
  }

  async close() {
    for (const res of this.held) res.socket?.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/* -------------------------------------------------------------------------------------------- workers */

export class WorkerProc {
  readonly logs: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(readonly name: string, readonly child: ChildProcess) {
    const sink = (c: Buffer) => {
      for (const line of c.toString().split("\n")) if (line.trim()) this.logs.push(line);
      if (this.logs.length > 4000) this.logs.splice(0, this.logs.length - 4000);
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    this.exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        owned.delete(child);
        resolve({ code, signal });
      }),
    );
  }

  get pid() {
    return this.child.pid!;
  }

  get running() {
    return this.exitInfo === null;
  }

  tail(n = 40) {
    return this.logs.slice(-n).join("\n");
  }

  /** Crash: SIGKILL the worker, then reap anything it launched (Chromium) that outlived it. */
  async kill9() {
    if (!this.running) return;
    const kids = descendants(this.pid);
    this.child.kill("SIGKILL");
    await this.exited;
    for (const pid of kids) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* exited meanwhile */
        }
      }
    }
    // SIGKILL is asynchronous and orphans are reaped by launchd/init; wait (bounded) until they are really gone.
    await waitFor(() => kids.every((pid) => !alive(pid)), { timeout: 5_000, interval: 50, label: `${this.name} descendants gone` }).catch(() => undefined);
  }

  /** Graceful stop (SIGTERM: the worker finishes in-flight jobs and closes its browser). */
  async stop(timeoutMs = 20_000) {
    if (!this.running) return;
    this.child.kill("SIGTERM");
    const done = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
    if (!done) await this.kill9();
  }
}

/* ---------------------------------------------------------------------------------------------- stack */

export class Stack {
  readonly workers: WorkerProc[] = [];
  merchant!: ChildProcess;
  readonly merchantLogs: string[] = [];
  bankServer!: http.Server;
  bankPort = 0;
  merchantPort = 0;
  proxy: MerchantProxy | null = null;
  router!: RouterModule;
  conn!: ConnModule;
  config!: ConfigModule;
  private mdbHandle: DatabaseSync | null = null;
  private savedEnv: Record<string, string | undefined> = {};
  private workerSeq = 0;

  constructor(readonly dataDir: string, readonly mode: "labs" | "bank-demo") {}

  get bankUrl() {
    return `http://127.0.0.1:${this.bankPort}`;
  }

  get merchantUrl() {
    return `http://127.0.0.1:${this.merchantPort}`;
  }

  /** Environment shared by every child; NEXTMOVE_* from the caller's shell never leaks in. */
  childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NEXTMOVE_") && !k.startsWith("VITEST") && k !== "NODE_OPTIONS") base[k] = v;
    return {
      ...base,
      NODE_ENV: "production",
      NEXTMOVE_ROOT: ROOT,
      NEXTMOVE_DATA_DIR: this.dataDir,
      NEXTMOVE_BANK_PORT: String(this.bankPort),
      NEXTMOVE_MERCHANT_PORT: String(this.merchantPort),
      NEXTMOVE_BANK_BASE_URL: this.bankUrl,
      NEXTMOVE_MERCHANT_BASE_URL: this.merchantUrl,
      NEXTMOVE_MODE: this.mode,
      NEXTMOVE_PLANNER: "simulated",
      NEXTMOVE_SKIP_SMOKE: "1",
      // Never reach the live model from this suite: any accidental call fails as UNAVAILABLE instead.
      NEXTMOVE_CLAUDE_BIN: path.join(this.dataDir, "claude-disabled-in-tests"),
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in this.savedEnv)) this.savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  restoreEnv() {
    for (const [k, v] of Object.entries(this.savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  get db() {
    return this.conn.bankDb();
  }

  /** Bank database rows. */
  q<T = Row>(sql: string, ...params: any[]): T[] {
    return this.conn.all<T>(this.db, sql, ...params);
  }

  q1<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.conn.one<T>(this.db, sql, ...params);
  }

  exec(sql: string, ...params: any[]) {
    return this.conn.run(this.db, sql, ...params);
  }

  /** The merchant's own database (read by the test only, to see what the provider actually recorded). */
  get mdb(): DatabaseSync {
    if (!this.mdbHandle) {
      this.mdbHandle = new DatabaseSync(path.join(this.dataDir, "merchant.sqlite"));
      this.mdbHandle.exec("PRAGMA busy_timeout=8000;");
    }
    return this.mdbHandle;
  }

  mq<T = Row>(sql: string, ...params: any[]): T[] {
    return this.mdb.prepare(sql).all(...params) as T[];
  }

  mq1<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.mdb.prepare(sql).get(...params) as T | undefined;
  }

  get secrets() {
    return this.config.localSecrets();
  }

  /** Sign a raw inbox body the way the merchant / payment network does. */
  sign(raw: string) {
    return `sha256=${createHmac("sha256", this.secrets.partnerHmacKey).update(raw).digest("hex")}`;
  }

  postInbox(raw: string, signature: string | null = this.sign(raw)) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers["x-nextmove-signature"] = signature;
    return rawRequest(`${this.bankUrl}/api/inbox/merchant`, { method: "POST", headers, body: raw });
  }

  api() {
    return new Api(this.bankUrl);
  }

  /** Same-origin demo sign-in. Isolated by default: every test gets its own tenant (bank and merchant side). */
  async login(customer: "alex" | "laziz", opts: { isolated?: boolean } = {}): Promise<Api> {
    const api = this.api();
    const r = await api.post("/api/session/demo", { customer, isolated: opts.isolated ?? true });
    if (r.status !== 200) throw new Error(`login ${customer} -> ${r.status} ${r.text}`);
    api.csrf = r.json.csrfToken;
    api.customer = customer;
    const s = await api.json("/api/session");
    const sess = this.q1<any>("SELECT tenant_id FROM sessions WHERE csrf_token=?", api.csrf);
    api.tenantId = sess!.tenant_id;
    if (!s.authenticated) throw new Error("session not established");
    return api;
  }

  startWorker(opts: { viaProxy?: boolean; env?: Record<string, string> } = {}): WorkerProc {
    const name = `worker-${++this.workerSeq}`;
    const viaProxy = opts.viaProxy ?? Boolean(this.proxy);
    const env = this.childEnv({ ...(viaProxy && this.proxy ? { NEXTMOVE_MERCHANT_BASE_URL: this.proxy.url } : {}), ...(opts.env ?? {}) });
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    owned.add(child);
    const w = new WorkerProc(name, child);
    this.workers.push(w);
    return w;
  }

  /** Start a worker and wait until it heartbeats into the bank database. */
  async worker(opts: Parameters<Stack["startWorker"]>[0] = {}): Promise<WorkerProc> {
    const w = this.startWorker(opts);
    await waitFor(() => !w.running ? Promise.reject(new Error(`worker exited: ${w.tail()}`)) : this.q1("SELECT 1 FROM worker_heartbeats WHERE pid=?", w.pid), { timeout: 30_000, label: `${w.name} heartbeat`, onTimeout: () => w.tail() });
    return w;
  }

  async stopWorkers() {
    await Promise.all(this.workers.filter((w) => w.running).map((w) => w.stop()));
  }

  workerLogs() {
    return this.workers.map((w) => `--- ${w.name} (pid ${w.child.pid})\n${w.tail(60)}`).join("\n");
  }

  async clock(api: Api, minutes: number) {
    const r = await api.post("/api/labs/clock", { minutes });
    if (r.status !== 200) throw new Error(`clock -> ${r.status} ${r.text}`);
    return r.json.demoNow as string;
  }

  async labs(api: Api, action: string, body: Record<string, unknown> = {}) {
    const r = await api.post("/api/labs/merchant", { action, body });
    if (r.status !== 200) throw new Error(`labs ${action} -> ${r.status} ${r.text}`);
    return r.json;
  }

  /** Analyse a capability and create a proposal from the named candidate keys. */
  async propose(api: Api, capability: string, keys: string[], inputs: Record<string, unknown> = {}) {
    const r = await api.post(`/api/capabilities/${capability}/propose`, { keys, inputs });
    if (r.status !== 200) throw new Error(`propose ${capability} ${keys} -> ${r.status} ${r.text}`);
    return r.json as { id: string; digest: string; status: string; scope: string; actions: { id: string; status: string; operation: string; display: any }[] };
  }

  async approve(api: Api, proposal: { id: string; digest: string; actions: { id: string }[] }, actionIds = proposal.actions.map((a) => a.id)) {
    const r = await api.post(`/api/proposals/${proposal.id}/approve`, { digest: proposal.digest, actionIds });
    if (r.status !== 200) throw new Error(`approve ${proposal.id} -> ${r.status} ${r.text}`);
    return r.json as { mandateId: string; grants: { actionId: string; grantId: string; expiresAt: string }[]; alreadyApproved: boolean; proposal: any };
  }

  action(id: string) {
    return this.q1<any>("SELECT * FROM proposal_actions WHERE id=?", id)!;
  }

  attempts(actionId: string) {
    return this.q<any>("SELECT * FROM attempts WHERE action_id=? ORDER BY started_at", actionId);
  }

  async waitAction(id: string, statuses: string[], timeout = 60_000) {
    return waitFor(() => {
      const a = this.action(id);
      return statuses.includes(a.status) ? a : null;
    }, { timeout, label: `action ${id} in ${statuses.join("/")}`, onTimeout: () => `action status ${this.action(id)?.status}\n${this.workerLogs()}` });
  }

  async teardown() {
    await Promise.all(this.workers.filter((w) => w.running).map((w) => w.stop(15_000)));
    if (this.merchant && this.merchant.exitCode === null && this.merchant.signalCode === null) {
      const exited = new Promise((r) => this.merchant.once("exit", r));
      this.merchant.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (this.merchant.exitCode === null && this.merchant.signalCode === null) this.merchant.kill("SIGKILL");
    }
    owned.delete(this.merchant);
    await this.proxy?.close();
    if (this.bankServer) {
      this.bankServer.closeAllConnections?.();
      await new Promise<void>((r) => this.bankServer.close(() => r()));
    }
    agent.destroy();
    try {
      this.mdbHandle?.close();
    } catch {
      /* closed */
    }
    try {
      this.conn?.closeBankDb();
    } catch {
      /* closed */
    }
    this.restoreEnv();
    if (!process.env.NEXTMOVE_TEST_KEEP) fs.rmSync(this.dataDir, { recursive: true, force: true });
    else process.stdout.write(`[harness] kept ${this.dataDir}\n`);
  }
}

function createBankServer(stack: Stack) {
  return http.createServer(async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${stack.bankPort}`}`);
      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].toLowerCase();
        if (!HOP_BY_HOP.has(k)) headers.append(k, req.rawHeaders[i + 1]);
      }
      const method = req.method ?? "GET";
      const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks), signal: ac.signal });
      // Same segments Next.js hands the catch-all route: decoded path parts after /api/.
      const segments = url.pathname.slice("/api/".length).split("/").filter(Boolean).map((s) => decodeURIComponent(s));
      const response = await stack.router.handleApi(request, segments);
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => {
        if (k !== "set-cookie") out[k] = v;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch {
          /* client went away */
        }
      }
      res.end();
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "HARNESS", message: String(e?.message ?? e).slice(0, 200) }));
    }
  });
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  if (started) throw new Error("One stack per test file: server modules cache the data directory and secrets");
  started = true;
  installExitHook();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nextmove-it-"));
  const stack = new Stack(dataDir, opts.mode ?? "labs");

  // Bank first (port 0), so the merchant can be told where to deliver signed events.
  stack.bankServer = createBankServer(stack);
  await new Promise<void>((resolve) => stack.bankServer.listen(0, "127.0.0.1", () => resolve()));
  stack.bankPort = (stack.bankServer.address() as net.AddressInfo).port;
  stack.merchantPort = await freePort();
  const env = stack.childEnv();
  stack.setEnv(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("NEXTMOVE_"))) as Record<string, string>);

  stack.config = await import("../../src/server/config");
  // Create the shared secrets file before any child starts, so every process reads the same keys.
  const secrets = stack.config.localSecrets();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "local-secrets.json"), "utf8"));
  if (onDisk.partnerHmacKey !== secrets.partnerHmacKey) throw new Error("Server modules were loaded before the harness set the data directory");
  stack.conn = await import("../../src/server/db/connection");
  stack.router = await import("../../src/server/api/router");
  if (stack.config.config.bankDbPath !== path.join(dataDir, "bank.sqlite")) throw new Error("bank database path is not inside the test data directory");
  stack.db; // open + migrate before children start

  stack.merchant = spawn(process.execPath, ["--import", "tsx", "src/merchant/main.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  owned.add(stack.merchant);
  const sink = (c: Buffer) => {
    for (const line of c.toString().split("\n")) if (line.trim()) stack.merchantLogs.push(line);
    if (stack.merchantLogs.length > 4000) stack.merchantLogs.splice(0, stack.merchantLogs.length - 4000);
  };
  stack.merchant.stdout?.on("data", sink);
  stack.merchant.stderr?.on("data", sink);
  await waitFor(async () => (await rawRequest(`${stack.merchantUrl}/health`)).status === 200, { timeout: 30_000, label: "merchant health", onTimeout: () => stack.merchantLogs.slice(-20).join("\n") });

  if (opts.proxy) {
    stack.proxy = new MerchantProxy(new URL(stack.merchantUrl));
    await stack.proxy.listen();
  }
  for (let i = 0; i < (opts.workers ?? 0); i++) await stack.worker();
  return stack;
}

/* ------------------------------------------------------------------------------------------- fixtures */

export function fixture(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

export function balance(stack: Stack, accountId: string): number {
  const a = stack.q1<any>("SELECT opening_minor FROM accounts WHERE id=?", accountId);
  const s = stack.q1<any>("SELECT COALESCE(SUM(amount_minor),0) s FROM ledger_lines WHERE account_id=?", accountId);
  return (a?.opening_minor ?? 0) + (s?.s ?? 0);
}

/** Customer funds in a context: every account except the external clearing account. */
export function funds(stack: Stack, tenantId: string, contextId: string): number {
  return stack.q<any>("SELECT id FROM accounts WHERE tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING'", tenantId, contextId).reduce((s, a) => s + balance(stack, a.id), 0);
}
