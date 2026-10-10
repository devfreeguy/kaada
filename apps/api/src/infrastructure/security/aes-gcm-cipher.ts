import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { SecretCipher } from "../../core/execution/ports.js";

/**
 * Authenticated encryption for execution secrets (a provider claim token) with the standard AES-256-GCM
 * from node:crypto. Nothing custom: a fresh random 96-bit nonce per message, the 128-bit tag appended,
 * and the record the secret belongs to bound in as additional authenticated data, so a ciphertext copied
 * to another record fails to decrypt.
 *
 * Stored form: `v<key version>.<nonce>.<ciphertext+tag>` (base64url). The key is server configuration
 * and is never stored with the data. The first key encrypts; every configured key can decrypt, which
 * is what makes rotation possible (add a new key, keep the old one until nothing uses it).
 */
export interface CipherKey {
  version: number;
  /** 32 random bytes, base64 or base64url. */
  key: string;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class AesGcmSecretCipher implements SecretCipher {
  private readonly keys: Map<number, Buffer>;
  private readonly current: { version: number; key: Buffer };

  constructor(keys: readonly CipherKey[]) {
    const [first] = keys;
    if (!first) throw new Error("at least one execution secret key is required");
    this.keys = new Map(keys.map((entry) => [entry.version, decodeKey(entry.key)]));
    this.current = { version: first.version, key: decodeKey(first.key) };
  }

  encrypt(plaintext: string, context: string): { keyVersion: number; ciphertext: string } {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.current.key, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      keyVersion: this.current.version,
      ciphertext: `v${this.current.version}.${nonce.toString("base64url")}.${body.toString("base64url")}`,
    };
  }

  decrypt(ciphertext: string, context: string): string {
    const match = /^v([0-9]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(ciphertext);
    if (!match) throw new Error("malformed execution secret");
    const key = this.keys.get(Number(match[1]));
    if (!key) throw new Error("no key for this execution secret version");
    const nonce = Buffer.from(match[2] ?? "", "base64url");
    const body = Buffer.from(match[3] ?? "", "base64url");
    if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
      throw new Error("malformed execution secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new Error("an execution secret key must be 32 bytes");
  return bytes;
}
