import { createHash } from "node:crypto";

/*
 * The networks whose balances Kaada can read for a person's wallet, and the tokens it supports on a TEST network.
 *
 * Mainnet's supported tokens are the active assets in the asset registry (the database), exactly as before. A test network's
 * tokens are NOT stored there: a second "cNGN" row in the shared registry would make the symbol ambiguous for every payment
 * request, and would put a worthless test token one wrong flag away from production. They are public, reviewed data in code, and
 * are only ever used when WALLET_NETWORK selects that network.
 *
 * A token is identified by chain id + contract address, never by its symbol. The test cNGN and the Celo mainnet cNGN share a
 * symbol and nothing else.
 */

export const WALLET_NETWORKS = ["celo-mainnet", "celo-sepolia"] as const;
export type WalletNetwork = (typeof WALLET_NETWORKS)[number];

export interface NetworkProfile {
  network: WalletNetwork;
  chainId: number;
  /** How a person is told the network's name. */
  label: string;
  testnet: boolean;
}

export const NETWORK_PROFILES: Readonly<Record<WalletNetwork, NetworkProfile>> = {
  "celo-mainnet": { network: "celo-mainnet", chainId: 42220, label: "Celo", testnet: false },
  "celo-sepolia": {
    network: "celo-sepolia",
    chainId: 11142220,
    label: "Celo Sepolia (test network)",
    testnet: true,
  },
};

export const DEFAULT_CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";

export interface TestNetworkToken {
  symbol: string;
  name: string;
  kind: "USD_STABLECOIN" | "LOCAL_STABLECOIN";
  fiatCode: string;
  decimals: number;
  contractAddress: string;
}

/**
 * Verified on the network itself (symbol and decimals read from the token contract; addresses confirmed to hold the test funds).
 * Not listed means not supported: nothing here is guessed.
 */
export const TEST_NETWORK_TOKENS: Readonly<Record<"celo-sepolia", readonly TestNetworkToken[]>> = {
  "celo-sepolia": [
    {
      symbol: "cNGN",
      name: "cNGN (test)",
      kind: "LOCAL_STABLECOIN",
      fiatCode: "NGN",
      decimals: 6,
      contractAddress: "0xa188439ccCEe9A6aa0E842f9c17C1b00C7B4dd4D",
    },
    {
      symbol: "USDC",
      name: "USDC (test)",
      kind: "USD_STABLECOIN",
      fiatCode: "USD",
      decimals: 6,
      contractAddress: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
    },
  ],
};

/**
 * A stable id for a token that has no database row: derived from chain id + contract address, so the same token always has the
 * same id, and two chains can never share one.
 */
export function networkTokenId(chainId: number, contractAddress: string): string {
  const bytes = createHash("sha1")
    .update(`kaada:token:${String(chainId)}:${contractAddress.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
