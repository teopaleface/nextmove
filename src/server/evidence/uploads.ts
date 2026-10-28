import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataDir } from "../config";
import { opaqueId, sha256Hex } from "../canonical";
import { one, run } from "../db/connection";
import { HttpError } from "../auth/session";

// Private, bounded image uploads. The declared type is ignored: the format is sniffed from magic bytes and
// dimensions are parsed from the header. Files live outside any served directory and are only returned to
// their owner through an authenticated route with a fixed content type.

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_DIMENSION = 4096;
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export function sniffImage(buf: Buffer): { mime: ImageMime; width: number; height: number } {
  if (buf.length < 32) throw new HttpError(400, "BAD_IMAGE", "File is too small to be an image");
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString("ascii", 12, 16) !== "IHDR") throw new HttpError(400, "BAD_IMAGE", "Malformed PNG");
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    throw new HttpError(400, "BAD_IMAGE", "Malformed JPEG");
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  throw new HttpError(415, "UNSUPPORTED_TYPE", "Only PNG, JPEG or WebP images are accepted");
}

function uploadDir() {
  const dir = path.join(dataDir(), "uploads");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function saveUpload(db: DatabaseSync, s: { tenantId: string; contextId: string; userId: string }, buf: Buffer, label: string | null, taskId: string | null) {
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "Images must be 4 MB or smaller");
  const info = sniffImage(buf);
  if (!info.width || !info.height || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) throw new HttpError(400, "BAD_DIMENSIONS", `Images must be at most ${MAX_DIMENSION} px per side`);
  const id = opaqueId("upl");
  const storage = `${id}.bin`;
  fs.writeFileSync(path.join(uploadDir(), storage), buf, { mode: 0o600 });
  run(
    db,
    "INSERT INTO uploads(id, tenant_id, context_id, user_id, task_id, mime, bytes, width, height, sha256, storage_name, label, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, s.tenantId, s.contextId, s.userId, taskId, info.mime, buf.length, info.width, info.height, sha256Hex(buf), storage, label ? label.slice(0, 80) : null, new Date().toISOString(),
  );
  return { id, ...info, bytes: buf.length };
}

export function readUpload(db: DatabaseSync, tenantId: string, uploadId: string): { row: any; data: Buffer } | null {
  const row = one<any>(db, "SELECT * FROM uploads WHERE id=? AND tenant_id=?", uploadId, tenantId);
  if (!row || !/^upl_[A-Za-z0-9_-]+\.bin$/.test(row.storage_name)) return null;
  return { row, data: fs.readFileSync(path.join(uploadDir(), row.storage_name)) };
}
