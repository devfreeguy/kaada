/*
 * Textile's TEST environment. Kept apart from the Celo asset seed on purpose: the Asset registry holds
 * Celo mainnet tokens, and Textile has NO Celo testnet deployment. A tx_test_ key reaches only these
 * two chains (anything else is a 400), so Kaada's Celo adapter never uses this table; only the
 * sandbox smoke script does.
 *
 * Source: https://fx-docs.textilecredit.com/testnet.html and
 * https://fx-docs.textilecredit.com/protocol/address-book.html (cNGN decimals on chain 97 are given
 * on the testnet page, 6; the address book omits them). Test tokens, no value.
 */

export interface SandboxToken {
  symbol: string;
  address: string;
  decimals: number;
}

export interface SandboxCorridor {
  chainId: 97 | 84532;
  name: string;
  /** The token whose smallest unit is used as the smoke test's "stablecoin" side. */
  tokens: { cngn: SandboxToken; counter: SandboxToken };
}

export const SANDBOX_CORRIDORS: readonly SandboxCorridor[] = [
  {
    chainId: 97,
    name: "BNB Smart Chain testnet",
    tokens: {
      cngn: { symbol: "cNGN", address: "0x8a078b182bA9649c03982c2a80CDcc81cdc99dA8", decimals: 6 },
      counter: {
        symbol: "USDT",
        address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
        decimals: 18,
      },
    },
  },
  {
    chainId: 84532,
    name: "Base Sepolia",
    tokens: {
      cngn: { symbol: "cNGN", address: "0xe2387F04d3858e7Cb64Ef5Ed6617f9B2fcEEAfa2", decimals: 6 },
      counter: {
        symbol: "USDC",
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
      },
    },
  },
];

/** The only chains a test key may be used with. */
export const SANDBOX_CHAIN_IDS: readonly number[] = SANDBOX_CORRIDORS.map((c) => c.chainId);

/**
 * A key may only be used with the chains of its own environment: a test key with chains 97 and 84532,
 * a live key with a mainnet chain (Kaada: Celo 42220). Throws before any request is built.
 */
export function assertChainForEnvironment(environment: "test" | "live", chainId: number): void {
  if (environment === "test") {
    if (!SANDBOX_CHAIN_IDS.includes(chainId)) {
      throw new Error(
        `the Textile test environment only reaches chains 97 and 84532, not ${String(chainId)}`,
      );
    }
    return;
  }
  if (SANDBOX_CHAIN_IDS.includes(chainId) || chainId !== 42220) {
    throw new Error(
      `the Textile live environment is used for Celo mainnet (42220) here, not ${String(chainId)}`,
    );
  }
}
