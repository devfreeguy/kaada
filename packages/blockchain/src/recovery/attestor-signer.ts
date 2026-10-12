import {
  hashMessage,
  hashTypedData,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
} from "viem";
import type { Address, Hex, LocalAccount, TransactionSerializable } from "viem";
import { toAccount } from "viem/accounts";

/**
 * What the attestor needs from whatever holds its key: an address and the ability to sign typed data and a transaction (the
 * veto). It is viem's `LocalAccount`, so a file-held key (`privateKeyToAccount`, development and tests) and an
 * external/KMS-backed signer (`createExternalSigner`, production) are interchangeable. The attestor never sees a key.
 */
export type AttestorSigner = LocalAccount;

/** The only thing a KMS or HSM must do for the attestor: sign a 32-byte digest with its secp256k1 key. */
export interface DigestSigningService {
  /** The Ethereum address of the key the service holds (derived once from its public key by the adapter). */
  readonly address: Address;
  /**
   * Signs the digest with the held key (ECDSA / secp256k1, no further hashing). Returns the raw `r` and `s`, or a
   * 65-byte `r‖s‖v` signature. Cloud KMS APIs return DER without a recovery id: the adapter may pass `r` and `s` only.
   */
  signDigest(digest: Hex): Promise<{ r: Hex; s: Hex } | Hex>;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

/** r and s from a KMS, turned into the signature whose recovered address is the key's (low-s, recovery id found by trial). */
export async function completeSignature(
  digest: Hex,
  address: Address,
  raw: { r: Hex; s: Hex } | Hex,
): Promise<Hex> {
  const parts: { r: Hex; s: Hex } =
    typeof raw === "string" ? { r: `0x${raw.slice(2, 66)}`, s: `0x${raw.slice(66, 130)}` } : raw;
  let s = BigInt(parts.s);
  if (s > HALF_N) s = SECP256K1_N - s; // Ethereum accepts only the low-s form
  const sHex: Hex = `0x${s.toString(16).padStart(64, "0")}`;
  for (const yParity of [0, 1] as const) {
    const signature = serializeSignature({ r: parts.r, s: sHex, yParity });
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() === address.toLowerCase()) return signature;
  }
  throw new Error("the signing service returned a signature that does not belong to its address");
}

/**
 * The production adapter point: wraps a KMS/HSM digest signer as an `AttestorSigner`. Cloud-specific code (AWS KMS, GCP KMS,
 * a PKCS#11 HSM ...) only implements `DigestSigningService`; hashing, serialisation and recovery-id handling live here.
 */
export function createExternalSigner(service: DigestSigningService): AttestorSigner {
  const sign = async (digest: Hex): Promise<Hex> =>
    completeSignature(digest, service.address, await service.signDigest(digest));
  return toAccount({
    address: service.address,
    signMessage: ({ message }) => sign(hashMessage(message)),
    signTypedData: (typedData) =>
      sign(hashTypedData(typedData as Parameters<typeof hashTypedData>[0])),
    async signTransaction(transaction: TransactionSerializable, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const unsigned = await serializer(transaction);
      const hash = keccak256(unsigned);
      const signature = await sign(hash);
      const r: Hex = `0x${signature.slice(2, 66)}`;
      const s: Hex = `0x${signature.slice(66, 130)}`;
      const v = BigInt(`0x${signature.slice(130, 132)}`);
      return await serializer(transaction, { r, s, v, yParity: v === 28n ? 1 : 0 });
    },
    // Authorizations (EIP-7702) are never signed by the attestor.
    signAuthorization: () => Promise.reject(new Error("the attestor does not sign authorizations")),
  });
}
