import { encodeAbiParameters, keccak256, stringToHex } from "viem";

/**
 * The key id the server derives for a device key (`deviceKeyIdFromPoint` in @kaada/contracts). The browser needs it to file the
 * private key under the same id BEFORE the server records the public key. device-key-id.test.ts keeps the two identical.
 */
export function deviceKeyIdFromPoint(publicKeyX: string, publicKeyY: string): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [
        keccak256(stringToHex("kaada.device-key-id")),
        BigInt(`0x${publicKeyX}`),
        BigInt(`0x${publicKeyY}`),
      ],
    ),
  );
}
