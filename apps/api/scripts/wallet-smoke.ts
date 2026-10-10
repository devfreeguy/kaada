/*
 * Manual, READ-ONLY check of the wallet stack against Celo mainnet. NOT part of CI. It signs nothing,
 * sends nothing and creates no key that is kept: it makes a throwaway P-256 public key (the private key
 * is discarded immediately), derives the Kernel v3.3 counterfactual address for it, checks that the
 * address is undeployed and stable, and reads token balances and decimals through the real RPC.
 *
 * Needs DATABASE_URL (to read the seeded Celo assets) and reaches CELO_RPC_URL (default forno.celo.org).
 * Run: pnpm --filter @kaada/api smoke:wallet
 */
import { generateKeyPairSync } from "node:crypto";

import {
  ChainBalanceReader,
  KernelProvisioningAdapter,
  createKernelAddressDeriver,
  createViemChainReader,
} from "@kaada/blockchain";
import { createDatabase, createRepositories } from "@kaada/database";
import { CELO_CHAIN_ID, createAssetRegistry, formatSmallestUnit } from "@kaada/domain";
import type { Asset } from "@kaada/domain";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required to read the Celo assets (read only).");
  process.exit(1);
}
const rpcUrl = process.env["CELO_RPC_URL"] || undefined;

// A throwaway PUBLIC key: the private half is not even assigned to a variable we keep.
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const root = {
  credentialId: Buffer.from("kaada-smoke-credential").toString("base64url"),
  publicKeyX: Buffer.from(jwk.x ?? "", "base64url").toString("hex"),
  publicKeyY: Buffer.from(jwk.y ?? "", "base64url").toString("hex"),
  rpId: "localhost",
};

const adapter = new KernelProvisioningAdapter(
  createKernelAddressDeriver({ ...(rpcUrl && { rpcUrl }) }),
);
const first = await adapter.deriveAccount({ chainId: CELO_CHAIN_ID, root });
const second = await adapter.deriveAccount({ chainId: CELO_CHAIN_ID, root });
console.log(`provider=${first.provider}`);
console.log(
  `address=${first.address} deployment=${first.deployment} stable=${String(first.address === second.address)}`,
);

const database = createDatabase({ url: databaseUrl, poolMax: 2, poolTimeoutMs: 20_000 });
try {
  const repositories = createRepositories(database);
  const registry = createAssetRegistry(repositories.assets);
  const tokens: Asset[] = [];
  for (const symbol of ["USDT", "USDC", "wBRL", "wARS", "cNGN", "IDRX"]) {
    const [asset] = await registry.findBySymbol(symbol, { chainId: CELO_CHAIN_ID });
    if (asset) tokens.push(asset);
  }
  const reader = new ChainBalanceReader({
    assets: registry,
    chain: createViemChainReader({ ...(rpcUrl && { rpcUrl }) }),
    verifyDecimals: true, // compares each token's on-chain decimals() with the registry
  });
  const balances = await reader.readBalances({
    chainId: CELO_CHAIN_ID,
    address: first.address,
    assetIds: tokens.map((token) => token.id),
  });
  console.log("balances of the new (empty) account, decimals verified on chain:");
  balances.tokens.forEach((money, index) => {
    const token = tokens[index];
    if (token)
      console.log(
        `  ${token.symbol}: ${formatSmallestUnit(money.amount, token.decimals)} (${money.amount} atoms, ${token.decimals} decimals)`,
      );
  });
} finally {
  await database.close();
}
