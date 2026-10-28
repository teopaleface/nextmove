import { createHash, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, no whitespace. Used for manifest digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Opaque, unguessable identifier for authority-bearing records (sessions, grants, upload references). */
export function opaqueId(prefix: string, bytes = 18): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

/** Short random id for ordinary records; ownership is always checked separately. */
export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}
