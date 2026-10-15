/*
 * Puts a TEST network's supported tokens into the asset table, so payments on that network can reference them (an intent or a
 * route points at an asset row). DEVELOPMENT ONLY: it refuses unless WALLET_NETWORK selects a test network, and it never touches
 * mainnet rows. A token is keyed by chain id + contract address (never by symbol), so the test cNGN sits beside the mainnet
 * cNGN as a different asset; a deployment sees only its own network's tokens (scopeAssetsToChain).
 *
 *   pnpm --filter @kaada/api seed:test-network
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

import { loadConfig } from "@kaada/config";
import { createDatabase } from "@kaada/database";
import { evmAddressCodec } from "@kaada/domain";

import { testNetworkAssets } from "../src/wallet/network-tokens.js";

const config = loadConfig(process.env);
const tokens = testNetworkAssets(config);
if (!tokens) {
  console.error(
    "WALLET_NETWORK is not a test network: nothing to seed (mainnet assets come from the main seed).",
  );
  process.exit(1);
}

const database = createDatabase({
  url: config.database.url,
  poolMax: 2,
  poolTimeoutMs: 10_000,
});
try {
  for (const token of tokens) {
    const contractAddress = evmAddressCodec.normalize(token.contractAddress ?? "");
    const row = {
      symbol: token.symbol,
      name: token.name,
      kind: token.kind,
      decimals: token.decimals,
      fiatCode: token.fiatCode ?? null,
      isActive: true,
    };
    await database.client.asset.upsert({
      where: { chainId_contractAddress: { chainId: token.chainId ?? 0, contractAddress } },
      update: row,
      create: { id: token.id, chainId: token.chainId ?? 0, contractAddress, ...row },
    });
    console.log(`${token.symbol} on chain ${String(token.chainId)} ready`);
  }
} finally {
  await database.close();
}
