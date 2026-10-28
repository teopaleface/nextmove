import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { localSecrets } from "./config";

// Delegated merchant tokens are stored encrypted (AES-256-GCM) with a locally generated key.
// This is a local stand-in for the bank's managed key service; it is not a production key-management claim.

export function encryptSecret(plain: string): string {
  const key = Buffer.from(localSecrets().tokenEncryptionKey, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptSecret(cipherText: string): string {
  const [v, iv, enc, tag] = cipherText.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const key = Buffer.from(localSecrets().tokenEncryptionKey, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
}
