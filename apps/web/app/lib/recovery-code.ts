/*
 * The Kaada Recovery Code, in the browser. It is generated and used ONLY here: the server never sees it, only the address of
 * the key derived from it. This is the browser twin of packages/contracts/src/recovery-code.ts; recovery-code.test.ts proves
 * the two derive identical keys, so the two can never drift apart silently.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, getAddress, hexToBytes, toBytes } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

export const RECOVERY_CODE_LENGTH = 26;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SALT = "Kaada Recovery Code v1";
const INFO_TAG = "kaada/recovery-key/v1";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** 130 random bits as 26 Crockford base32 characters (canonical form, no separators). */
export function generateRecoveryCode(
  random: (length: number) => Uint8Array = (length) =>
    globalThis.crypto.getRandomValues(new Uint8Array(length)),
): string {
  const bytes = random(17);
  if (bytes.length < 17) throw new Error("too few random bytes");
  let bits = 0n;
  for (let i = 0; i < 17; i += 1) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);
  bits >>= 6n;
  let out = "";
  for (let i = RECOVERY_CODE_LENGTH - 1; i >= 0; i -= 1) {
    out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
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

/** Upper-cases, drops separators, maps look-alikes (O to 0, I and L to 1). Null if it is not a well-formed code. */
export function parseRecoveryCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== RECOVERY_CODE_LENGTH) return null;
  for (const char of cleaned) if (!ALPHABET.includes(char)) return null;
  return cleaned;
}

function secretBytes(canonical: string): Uint8Array {
  let bits = 0n;
  for (const char of canonical) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(char));
  bits <<= 6n;
  const out = new Uint8Array(17);
  for (let i = 16; i >= 0; i -= 1) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

export function deriveRecoveryKey(
  canonical: string,
  binding: { chainId: number; account: Address },
): { privateKey: Hex; address: Address } {
  const chain = new Uint8Array(8);
  new DataView(chain.buffer).setBigUint64(0, BigInt(binding.chainId));
  const info = new Uint8Array([
    ...toBytes(INFO_TAG),
    ...chain,
    ...hexToBytes(getAddress(binding.account)),
  ]);
  const okm = hkdf(sha256, secretBytes(canonical), toBytes(SALT), info, 48);
  const scalar = (BigInt(bytesToHex(okm)) % (SECP256K1_N - 1n)) + 1n;
  const privateKey: Hex = `0x${scalar.toString(16).padStart(64, "0")}`;
  return { privateKey, address: privateKeyToAddress(privateKey) };
}

/** The EIP-712 request the server prepared, exactly as it sent it. */
export interface ServerTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "Initiate";
  message: Record<string, string>;
}

/**
 * Signs the server's `Initiate` request with the key derived from the Recovery Code, after checking it is for THIS chain and
 * THIS account (a request for anything else is refused before any signature exists).
 */
export async function signRecovery(
  canonical: string,
  expected: { chainId: number; account: Address },
  typed: ServerTypedData,
): Promise<Hex> {
  const { privateKey } = deriveRecoveryKey(canonical, expected);
  if (typed.primaryType !== "Initiate") throw new Error("unexpected request");
  if (typed.domain.chainId !== expected.chainId) throw new Error("request is for another chain");
  const account = typed.message["account"];
  if (!account || getAddress(account) !== getAddress(expected.account)) {
    throw new Error("request is for another account");
  }
  return privateKeyToAccount(privateKey).signTypedData({
    domain: {
      name: typed.domain.name,
      version: typed.domain.version,
      chainId: typed.domain.chainId,
      verifyingContract: typed.domain.verifyingContract as Address,
    },
    types: typed.types,
    primaryType: "Initiate",
    message: {
      account: getAddress(account),
      nonce: BigInt(typed.message["nonce"] ?? "0"),
      rootId: typed.message["rootId"] as Hex,
      hook: getAddress(typed.message["hook"] ?? "0x0000000000000000000000000000000000000000"),
      validatorDataHash: typed.message["validatorDataHash"] as Hex,
      hookDataHash: typed.message["hookDataHash"] as Hex,
      deadline: BigInt(typed.message["deadline"] ?? "0"),
    },
  });
}
