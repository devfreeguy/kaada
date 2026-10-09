/*
 * Settlement assets, provider capabilities and seeding against the real database. Every test runs
 * inside a transaction that is ALWAYS rolled back, so nothing is left behind. Requires the
 * migrations and `pnpm db:seed`. Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createProviderCapabilityRegistry,
  createSettlementAssetResolver,
} from "@kaada/domain";

import { createDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";
import { createAssetRepository } from "../src/repositories/assets.js";
import { createProviderRepository } from "../src/repositories/recipients-providers.js";
import { seedCeloAssets } from "../src/seed/celo-assets.js";
import { seedProviderCapabilities } from "../src/seed/capabilities.js";
import type { CapabilityDefinition } from "../src/seed/capabilities.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

class Rollback extends Error {}

const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";

describe("settlement assets and capabilities (rolled back)", { skip }, () => {
  let database: Database;
  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 3, poolTimeoutMs: 20_000 });
  });
  after(async () => {
    await database.close();
  });

  type Tx = Parameters<Parameters<Database["client"]["$transaction"]>[0]>[0];
  async function rolledBack(work: (tx: Tx) => Promise<void>): Promise<void> {
    await assert.rejects(
      database.client.$transaction(
        async (tx) => {
          await work(tx);
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
      (error) => error instanceof Rollback,
    );
  }

  const quoteUsdtToUsdc: CapabilityDefinition = {
    provider: "textile",
    capability: "QUOTE",
    chainId: CELO_CHAIN_ID,
    input: { chainId: CELO_CHAIN_ID, contractAddress: USDT },
    output: { chainId: CELO_CHAIN_ID, contractAddress: USDC },
    source: "integration test fixture, not a claim about Textile",
  };

  it("has the verified Celo assets with exact metadata, and keeps fiat apart from tokens", async () => {
    const registry = createAssetRegistry(createAssetRepository(database.client));
    const usdt = await registry.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
    const usdc = await registry.findBySymbol("USDC", { chainId: CELO_CHAIN_ID });
    assert.equal(usdt.length, 1, "run `pnpm db:seed` first");
    assert.deepEqual(
      [usdt[0]?.contractAddress, usdt[0]?.decimals, usdt[0]?.kind, usdt[0]?.fiatCode],
      [USDT, 6, "USD_STABLECOIN", "USD"],
    );
    assert.deepEqual(
      [usdc[0]?.contractAddress, usdc[0]?.decimals, usdc[0]?.kind, usdc[0]?.fiatCode],
      [USDC, 6, "USD_STABLECOIN", "USD"],
    );

    // "USD" is the fiat dollar, never a token; the tokens are reached only through denomination.
    const fiat = await registry.findByFiatCode("USD");
    assert.deepEqual(
      fiat.map((asset) => asset.kind),
      ["FIAT"],
    );
    const tokens = await registry.findByDenomination("USD", { chainId: CELO_CHAIN_ID });
    assert.deepEqual(tokens.map((asset) => asset.symbol).sort(), ["USDC", "USDT"]);
  });

  it("resolves settlement from real data: USD is ambiguous, BRL has no verified asset yet", async () => {
    const resolver = createSettlementAssetResolver(
      createAssetRegistry(createAssetRepository(database.client)),
    );
    const usd = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "USD" });
    assert.equal(usd.status, "AMBIGUOUS");
    const brl = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "BRL" });
    assert.deepEqual(brl, {
      status: "UNSUPPORTED",
      denomination: "BRL",
      reason: "NO_SETTLEMENT_ASSET",
    });
  });

  it("seeds nothing unverified: no capability rows, and no unverified tokens", async () => {
    assert.equal(await database.client.providerCapability.count(), 0);
    const symbols = (await database.client.asset.findMany({ select: { symbol: true } })).map(
      (row) => row.symbol,
    );
    for (const unverified of ["wBRL", "wARS", "wMXN", "wCOP", "wPEN", "wCLP", "cNGN", "IDRX"]) {
      assert.equal(symbols.includes(unverified), false, unverified);
    }
  });

  it("re-seeding assets changes nothing", async () => {
    await rolledBack(async (tx) => {
      const before = await tx.asset.findMany({ orderBy: { id: "asc" } });
      await seedCeloAssets(tx);
      await seedCeloAssets(tx);
      const after = await tx.asset.findMany({ orderBy: { id: "asc" } });
      assert.deepEqual(
        after.map((row) => row.id),
        before.map((row) => row.id),
      );
    });
  });

  it("seeds capabilities idempotently, without duplicates", async () => {
    await rolledBack(async (tx) => {
      const first = await seedProviderCapabilities(tx, [quoteUsdtToUsdc]);
      const second = await seedProviderCapabilities(tx, [quoteUsdtToUsdc]);
      assert.deepEqual([first.created, first.existing], [1, 0]);
      assert.deepEqual([second.created, second.existing], [0, 1]);
      assert.equal(await tx.providerCapability.count(), 1);
    });
  });

  it("the database refuses a duplicate capability, including with NULL columns", async () => {
    await rolledBack(async (tx) => {
      await seedProviderCapabilities(tx, [quoteUsdtToUsdc]);
      const row = await tx.providerCapability.findFirstOrThrow();
      const identity = {
        providerId: row.providerId,
        capability: row.capability,
        chainId: row.chainId,
        inputAssetId: row.inputAssetId,
        outputAssetId: row.outputAssetId,
        countryCode: row.countryCode,
      };
      await assert.rejects(
        tx.providerCapability.create({ data: { id: randomUUID(), ...identity } }),
      );
    });
    await rolledBack(async (tx) => {
      const textile = await tx.provider.findUniqueOrThrow({ where: { slug: "textile" } });
      const base = {
        providerId: textile.id,
        capability: "OFF_RAMP" as const,
        chainId: CELO_CHAIN_ID,
      };
      await tx.providerCapability.create({ data: { id: randomUUID(), ...base } });
      await assert.rejects(tx.providerCapability.create({ data: { id: randomUUID(), ...base } }));
    });
    // A different country or type is a different capability, not a duplicate.
    await rolledBack(async (tx) => {
      const textile = await tx.provider.findUniqueOrThrow({ where: { slug: "textile" } });
      const base = {
        providerId: textile.id,
        capability: "OFF_RAMP" as const,
        chainId: CELO_CHAIN_ID,
      };
      await tx.providerCapability.create({
        data: { id: randomUUID(), ...base, countryCode: "BR" },
      });
      await tx.providerCapability.create({
        data: { id: randomUUID(), ...base, countryCode: "AR" },
      });
      await tx.providerCapability.create({
        data: { id: randomUUID(), ...base, capability: "BANK_PAYOUT", countryCode: "BR" },
      });
      assert.equal(await tx.providerCapability.count(), 3);
    });
  });

  it("serves capabilities through the registry and honours disabled providers and rows", async () => {
    await rolledBack(async (tx) => {
      await seedProviderCapabilities(tx, [
        quoteUsdtToUsdc,
        { ...quoteUsdtToUsdc, capability: "SWAP" },
      ]);
      const registry = createAssetRegistry(createAssetRepository(tx));
      const [usdt] = await registry.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
      const [usdc] = await registry.findBySymbol("USDC", { chainId: CELO_CHAIN_ID });
      assert.ok(usdt && usdc);
      const capabilities = createProviderCapabilityRegistry(createProviderRepository(tx), {
        ttlMs: 0,
      });
      const pair = { chainId: CELO_CHAIN_ID, inputAssetId: usdt.id, outputAssetId: usdc.id };

      const both = await capabilities.getProvidersForPair({
        ...pair,
        capability: "QUOTE",
        alsoRequire: ["SWAP"],
      });
      assert.deepEqual(
        both.map((support) => support.providerSlug),
        ["textile"],
      );
      const reverse = await capabilities.supportsPair({
        ...pair,
        inputAssetId: usdc.id,
        outputAssetId: usdt.id,
        capability: "QUOTE",
      });
      assert.equal(reverse, false, "the reverse direction is not implied");

      await tx.providerCapability.updateMany({
        where: { capability: "SWAP" },
        data: { isActive: false },
      });
      assert.equal(await capabilities.supportsPair({ ...pair, capability: "SWAP" }), false);

      await tx.provider.update({ where: { slug: "textile" }, data: { isActive: false } });
      assert.equal(await capabilities.supportsPair({ ...pair, capability: "QUOTE" }), false);
    });
  });
});
