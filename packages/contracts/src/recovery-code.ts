// The Kaada Recovery Code: generated and used ONLY on the user's device. The server never sees it; it stores
// only the public address of the key derived from it (the recovery validator's `recoveryKey`).
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, getAddress, hexToBytes, toBytes } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/*
 * FORMAT
 *   26 characters of Crockford base32 = 130 bits of entropy, displayed as 5-5-5-5-6 groups
 *   ("7QX2M-9TD4K-HZ3VN-0B8RC-WF6YJ4"). The alphabet has no I, L, O or U; the parser also accepts the usual look-alikes
 *   (O -> 0, I and L -> 1), ignores case, spaces and dashes.
 *
 * KEY DERIVATION (documented domain: Kaada, version, chain, account)
 *   secret = the 130 code bits, big-endian, zero-padded on the right to 17 bytes
 *   okm    = HKDF-SHA256(ikm = secret,
 *                        salt = "Kaada Recovery Code v1",
 *                        info = "kaada/recovery-key/v1" || chainId (8 bytes, big-endian) || account (20 bytes),
 *                        length = 48)
 *   key    = (int(okm) mod (n - 1)) + 1          n = the secp256k1 group order, so the key is in [1, n-1]
 *   verifier = address(key)                      the only thing the server stores
 *
 * The code already carries 130 bits, so a deliberately slow KDF would add nothing; HKDF binds the key to the chain
 * and the account so the same code can never produce a key (or a signature) valid anywhere else.
 */

export const RECOVERY_CODE_LENGTH = 26;
export const RECOVERY_CODE_BITS = 130;
export const RECOVERY_CODE_VERSION = 1;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SALT = "Kaada Recovery Code v1";
const INFO_TAG = "kaada/recovery-key/v1";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A Recovery Code that refuses to be printed: `toString`, `toJSON` and string coercion yield a placeholder, so a
 * careless `console.log` or JSON body cannot leak it. The only way to read it is `reveal()`, for display ONCE.
 */
export class RecoveryCode {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The code in its display form (grouped). Call this only to show it to the user, once. */
  reveal(): string {
    return formatRecoveryCode(this.#value);
  }

  /** The canonical 26 characters, for key derivation. */
  canonical(): string {
    return this.#value;
  }

  toString(): string {
    return "[Recovery Code redacted]";
  }

  toJSON(): string {
    return "[Recovery Code redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[Recovery Code redacted]";
  }
}

export interface RandomSource {
  (length: number): Uint8Array;
}

const webRandom: RandomSource = (length) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

/** A fresh Recovery Code from a cryptographically secure source (override only in tests). */
export function generateRecoveryCode(random: RandomSource = webRandom): RecoveryCode {
  const bytes = random(17);
  if (bytes.length < 17) throw new Error("the random source returned too few bytes");
  let bits = 0n;
  for (let i = 0; i < 17; i += 1) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);
  // Keep the top 130 of the 136 bits.
  bits >>= 6n;
  let out = "";
  for (let i = RECOVERY_CODE_LENGTH - 1; i >= 0; i -= 1) {
    out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return new RecoveryCode(out);
}

export function formatRecoveryCode(canonical: string): string {
  return [
    canonical.slice(0, 5),
    canonical.slice(5, 10),
    canonical.slice(10, 15),
    canonical.slice(15, 20),
    canonical.slice(20),
  ].join("-");
}

/** Upper-cases, drops separators and maps the look-alike characters. Returns null if it is not a well-formed code. */
export function parseRecoveryCode(input: string): RecoveryCode | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== RECOVERY_CODE_LENGTH) return null;
  for (const char of cleaned) if (!ALPHABET.includes(char)) return null;
  return new RecoveryCode(cleaned);
}

function secretBytes(canonical: string): Uint8Array {
  let bits = 0n;
  for (const char of canonical) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(char));
  // 130 bits -> 17 bytes (136 bits), zero-padded on the right.
  bits <<= 6n;
  const out = new Uint8Array(17);
  for (let i = 16; i >= 0; i -= 1) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

export interface RecoveryKeyBinding {
  chainId: number | bigint;
  /** The Kernel account the code protects. */
  account: Address;
}

/** The recovery signing key bound to (code, chain, account), and the public verifier address derived from it. */
export function deriveRecoveryKey(
  code: RecoveryCode,
  binding: RecoveryKeyBinding,
): { privateKey: Hex; address: Address } {
  const chain = new Uint8Array(8);
  new DataView(chain.buffer).setBigUint64(0, BigInt(binding.chainId));
  const info = new Uint8Array([
    ...toBytes(INFO_TAG),
    ...chain,
    ...hexToBytes(getAddress(binding.account)),
  ]);
  const okm = hkdf(sha256, secretBytes(code.canonical()), toBytes(SALT), info, 48);
  const scalar = (BigInt(bytesToHex(okm)) % (SECP256K1_N - 1n)) + 1n;
  const privateKey: Hex = `0x${scalar.toString(16).padStart(64, "0")}`;
  return { privateKey, address: privateKeyToAddress(privateKey) };
}
