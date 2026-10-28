import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { dataDir } from "../../config";
import { sha256Hex } from "../../canonical";

// The certificate signing key. Generated once per data directory on first use; the private half lives only in
// <dataDir>/keystore/<id>.json (mode 0600, never committed: .data/ is ignored). The database keeps the reference
// `keystore:<id>` and the public key, so a copied database cannot sign anything.

export const KEYSTORE_ID = "certificate-signing-v1";
export const KEY_REF = `keystore:${KEYSTORE_ID}`;

export interface LoadedKey {
  keyId: string;
  privateKey: KeyObject;
  publicKeySpki: string;
}

let cached: { dir: string; key: LoadedKey } | null = null;

const keyIdOf = (spki: string) => `nmk_${sha256Hex(Buffer.from(spki, "base64")).slice(0, 16)}`;

function read(file: string): LoadedKey {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.algorithm !== "Ed25519" || typeof raw.privateKeyPkcs8 !== "string") throw new Error(`keystore ${KEYSTORE_ID} is not an Ed25519 key`);
  const privateKey = createPrivateKey({ key: Buffer.from(raw.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
  const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  return { keyId: keyIdOf(publicKeySpki), privateKey, publicKeySpki };
}

export function signingKey(): LoadedKey {
  const dir = path.join(dataDir(), "keystore");
  if (cached?.dir === dir) return cached.key;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${KEYSTORE_ID}.json`);
  if (!fs.existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const body = { algorithm: "Ed25519", privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
    try {
      fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600, flag: "wx" });
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e; // another process created it first; use theirs
    }
  }
  const key = read(file);
  cached = { dir, key };
  return key;
}

export function publicKeyOf(spki: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
}
