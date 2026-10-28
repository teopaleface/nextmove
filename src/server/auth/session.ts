import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { one, run, all } from "../db/connection";
import { sha256Hex, safeEqual } from "../canonical";

// Server-managed demo sessions. The cookie holds an opaque random token; the database stores only its hash.
// Every API request derives tenant, user and active context from this record — never from client fields.

export const SESSION_COOKIE = "nm_session";
const SESSION_TTL_MS = 12 * 3_600_000;

export interface Session {
  id: string;
  tenantId: string;
  userId: string;
  contextId: string;
  contextKind: "PERSONAL" | "BUSINESS";
  csrfToken: string;
  displayName: string;
  initials: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function createSession(db: DatabaseSync, tenantId: string, userId: string, contextId?: string): { token: string; session: Session } {
  const ctx = contextId
    ? one<any>(db, "SELECT * FROM contexts WHERE id=? AND user_id=? AND tenant_id=?", contextId, userId, tenantId)
    : one<any>(db, "SELECT * FROM contexts WHERE user_id=? AND tenant_id=? ORDER BY ordinal LIMIT 1", userId, tenantId);
  if (!ctx) throw new HttpError(400, "NO_CONTEXT", "User has no context");
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const now = Date.now();
  run(
    db,
    "INSERT INTO sessions(id, tenant_id, user_id, active_context_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
    sha256Hex(token),
    tenantId,
    userId,
    ctx.id,
    csrf,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
  );
  return { token, session: loadSession(db, sha256Hex(token))! };
}

function loadSession(db: DatabaseSync, id: string): Session | null {
  const row = one<any>(
    db,
    `SELECT s.*, c.kind AS context_kind, u.display_name, u.initials FROM sessions s
     JOIN contexts c ON c.id = s.active_context_id AND c.tenant_id = s.tenant_id
     JOIN users u ON u.id = s.user_id
     WHERE s.id=? AND s.revoked_at IS NULL`,
    id,
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    contextId: row.active_context_id,
    contextKind: row.context_kind,
    csrfToken: row.csrf_token,
    displayName: row.display_name,
    initials: row.initials,
  };
}

export function sessionFromToken(db: DatabaseSync, token: string | null | undefined): Session | null {
  if (!token || token.length > 200) return null;
  return loadSession(db, sha256Hex(token));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Same-origin + CSRF token check for every state-changing request. */
export function assertCsrf(req: Request, session: Session): void {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new HttpError(403, "CROSS_SITE", "Cross-site request refused");
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    try {
      if (new URL(origin).host !== host) throw new HttpError(403, "BAD_ORIGIN", "Origin does not match");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(403, "BAD_ORIGIN", "Origin not parseable");
    }
  }
  const token = req.headers.get("x-csrf-token") ?? "";
  if (!token || !safeEqual(token, session.csrfToken)) throw new HttpError(403, "CSRF", "Missing or invalid CSRF token");
}

export function switchContext(db: DatabaseSync, session: Session, contextId: string): Session {
  const ctx = one<any>(db, "SELECT id FROM contexts WHERE id=? AND user_id=? AND tenant_id=?", contextId, session.userId, session.tenantId);
  if (!ctx) throw new HttpError(404, "NOT_FOUND", "Context not found");
  run(db, "UPDATE sessions SET active_context_id=? WHERE id=?", contextId, session.id);
  return loadSession(db, session.id)!;
}

export function revokeSession(db: DatabaseSync, session: Session) {
  run(db, "UPDATE sessions SET revoked_at=? WHERE id=?", new Date().toISOString(), session.id);
}

export function contextsFor(db: DatabaseSync, session: Session) {
  return all<any>(db, "SELECT id, kind, name, subtitle, role, reserve_floor_minor FROM contexts WHERE user_id=? AND tenant_id=? ORDER BY ordinal", session.userId, session.tenantId);
}

/**
 * Object-level authorization: the row must belong to the session's tenant, and to one of the session user's contexts.
 * Returns 404 (not 403) so that identifiers of other tenants reveal nothing.
 */
export function assertOwned(db: DatabaseSync, session: Session, row: { tenant_id?: string; context_id?: string } | undefined | null, opts: { activeContextOnly?: boolean } = {}): asserts row {
  if (!row || row.tenant_id !== session.tenantId) throw new HttpError(404, "NOT_FOUND", "Not found");
  if (row.context_id) {
    const ctx = one<any>(db, "SELECT user_id FROM contexts WHERE id=? AND tenant_id=?", row.context_id, session.tenantId);
    if (!ctx || ctx.user_id !== session.userId) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (opts.activeContextOnly && row.context_id !== session.contextId) throw new HttpError(409, "WRONG_CONTEXT", "This item belongs to another context. Switch context before acting.");
  }
}
