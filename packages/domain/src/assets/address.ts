import { KaadaError } from "../errors/index.js";

/**
 * Knows how to validate and canonicalise addresses for one family of chains.
 *
 * Normalisation is chain-aware on purpose: EVM addresses are case-insensitive (so we store them
 * lowercase for lookup), but other chain families can be case-sensitive and must keep their case.
 * The database currently stores lowercase wallet and contract addresses, which is correct for the
 * EVM/Celo chains Kaada targets today. Adding a case-sensitive chain means adding an AddressCodec
 * here and relaxing those database CHECK constraints in a migration; no domain code changes.
 */
export interface AddressCodec {
  isValid(address: string): boolean;
  /** Canonical form used for storage and comparison. Throws if the address is invalid. */
  normalize(address: string): string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const evmAddressCodec: AddressCodec = {
  isValid: (address) => EVM_ADDRESS.test(address),
  normalize(address) {
    if (!EVM_ADDRESS.test(address)) {
      throw new KaadaError("INVALID_INTENT", "not a valid EVM address");
    }
    return address.toLowerCase();
  },
};

export interface ChainAddressResolver {
  codecFor(chainId: number): AddressCodec;
}

/** Every chain Kaada supports today (Celo and its testnets) is EVM. */
export const evmOnlyResolver: ChainAddressResolver = {
  codecFor: () => evmAddressCodec,
};

export function normalizeAddress(
  chainId: number,
  address: string,
  resolver: ChainAddressResolver = evmOnlyResolver,
): string {
  return resolver.codecFor(chainId).normalize(address.trim());
}

export function isValidAddress(
  chainId: number,
  address: string,
  resolver: ChainAddressResolver = evmOnlyResolver,
): boolean {
  return resolver.codecFor(chainId).isValid(address.trim());
}
