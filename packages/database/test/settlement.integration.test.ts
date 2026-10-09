/*
 * Settlement assets, provider capabilities and seeding against the real database. Tests that change
 * anything run inside a transaction that is ALWAYS rolled back, so nothing is left behind. Requires
 * the migrations and `pnpm db:seed`. Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createProviderCapabilityRegistry,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
  createMoney,
} from "@kaada/domain";
import type { RoutingRequest } from "@kaada/domain";

import { createDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";
import { createAssetRepository } from "../src/repositories/assets.js";
import { createProviderRepository } from "../src/repositories/recipients-providers.js";
import { seedCeloAssets } from "../src/seed/celo-assets.js";
import { seedProviderCapabilities } from "../src/seed/capabilities.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

class Rollback extends Error {}

const TOKENS = {
  USDT: ["0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", 6, "USD", null],
  USDC: ["0xceba9300f2b948710d2653dd7b07f33a8b32118c", 6, "USD", null],
  cNGN: ["0xf6829d7393dae24509eb1e52ee8e572e2e271a4f", 6, "NGN", "NG"],
  wARS: ["0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d", 18, "ARS", "AR"],
  wBRL: ["0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0", 18, "BRL", "BR"],
  IDRX: ["0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22", 2, "IDR", "ID"],
} as const;
const MENTO_NGN = "0xe2702bd97ee33c88c8f6f92da3b733608aa76f71";
const RFQ = ["EXACT_INPUT", "EXACT_OUTPUT", "QUOTE", "SWAP"];

describe("settlement assets and capabilities on the seeded database", { skip }, () => {
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
        { timeout: 90_000 },
      ),
      (error) => error instanceof Rollback,
    );
  }

  const registry = () => createAssetRegistry(createAssetRepository(database.client));
  const capabilities = () =>
    createProviderCapabilityRegistry(createProviderRepository(database.client), { ttlMs: 0 });

  async function assetId(symbol: keyof typeof TOKENS): Promise<string> {
    const [asset] = await registry().findBySymbol(symbol, { chainId: CELO_CHAIN_ID });
    assert.ok(asset, `${symbol} is seeded (run pnpm db:seed)`);
    return asset.id;
  }

  it("has every verified Celo asset with exact metadata, and not the Mento naira token", async () => {
    for (const [symbol, [address, decimals, fiatCode, countryCode]] of Object.entries(TOKENS)) {
      const rows = await database.client.asset.findMany({
        where: { symbol, chainId: CELO_CHAIN_ID },
      });
      assert.equal(rows.length, 1, `${symbol} appears exactly once`);
      const row = rows[0];
      assert.deepEqual(
        [row?.contractAddress, row?.decimals, row?.fiatCode, row?.countryCode, row?.isActive],
        [address, decimals, fiatCode, countryCode, true],
        symbol,
      );
    }
    assert.equal(
      await database.client.asset.count({ where: { contractAddress: MENTO_NGN } }),
      0,
      "the Mento naira token is a different asset and is not seeded",
    );
    // Fiat stays fiat: the real is not a token.
    assert.deepEqual(
      (await registry().findByFiatCode("BRL")).map((asset) => asset.kind),
      ["FIAT"],
    );
  });

  it("resolves BRL, ARS, NGN and IDR to the Textile tokens, and USD to both stablecoins", async () => {
    const resolver = createSettlementAssetResolver(registry());
    const expected = { BRL: "wBRL", ARS: "wARS", NGN: "cNGN", IDR: "IDRX" } as const;
    for (const [code, symbol] of Object.entries(expected)) {
      const result = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: code });
      assert.equal(result.status, "RESOLVED", code);
      assert.equal(result.status === "RESOLVED" && result.assets[0].symbol, symbol);
    }
    const ngn = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "NGN" });
    assert.equal(
      ngn.status === "RESOLVED" && ngn.assets[0].contractAddress,
      TOKENS.cNGN[0],
      "Textile cNGN, not Mento NGN",
    );

    const usd = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "USD" });
    assert.equal(usd.status, "AMBIGUOUS", "USD offers its stablecoins without choosing one");
    assert.deepEqual(usd.status === "AMBIGUOUS" && usd.assets.map((a) => a.symbol).sort(), [
      "USDC",
      "USDT",
    ]);

    for (const code of ["MXN", "COP", "PEN", "CLP"]) {
      const result = await resolver.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: code });
      assert.equal(result.status, "UNSUPPORTED", code);
    }
  });

  it("knows every Textile corridor in both directions, with exactly the RFQ capabilities", async () => {
    const registryOfCapabilities = capabilities();
    const usdt = await assetId("USDT");
    for (const symbol of ["wBRL", "wARS", "cNGN", "IDRX", "USDC"] as const) {
      const other = await assetId(symbol);
      for (const [input, output] of [
        [usdt, other],
        [other, usdt],
      ] as const) {
        const [support, ...rest] = await registryOfCapabilities.getCapabilitiesForPair({
          chainId: CELO_CHAIN_ID,
          inputAssetId: input,
          outputAssetId: output,
        });
        assert.equal(rest.length, 0);
        assert.equal(support?.providerSlug, "textile", symbol);
        assert.deepEqual([...(support?.capabilities ?? [])].sort(), RFQ, symbol);
      }
    }
    assert.equal(await database.client.providerCapability.count(), 40);
    const types = await database.client.providerCapability.findMany({
      distinct: ["capability"],
      select: { capability: true },
    });
    assert.deepEqual(types.map((t) => t.capability).sort(), RFQ);
  });

  it("does not give Textile wMXN, wCOP, wPEN, wCLP or USA₮, and no ramp capability", async () => {
    const symbols = (await database.client.asset.findMany({ select: { symbol: true } })).map(
      (row) => row.symbol,
    );
    for (const unverified of ["wMXN", "wCOP", "wPEN", "wCLP", "USA₮"]) {
      assert.equal(symbols.includes(unverified), false, unverified);
    }
    const ramps = await database.client.providerCapability.count({
      where: {
        capability: { in: ["ON_RAMP", "OFF_RAMP", "BANK_PAYOUT", "CONDITIONAL_EXECUTION"] },
      },
    });
    assert.equal(ramps, 0);
  });

  it("produces valid candidate sets for BRL, ARS, NGN and IDR without choosing a route", async () => {
    const assets = registry();
    const resolver = createRoutingCandidateResolver({
      assets,
      settlement: createSettlementAssetResolver(assets),
      capabilities: capabilities(),
      countries: defaultCountryDirectory,
    });
    const expected = {
      BRL: ["wBRL", "BR"],
      ARS: ["wARS", "AR"],
      NGN: ["cNGN", "NG"],
      IDR: ["IDRX", "ID"],
    } as const;
    for (const [code, [symbol, country]] of Object.entries(expected)) {
      const [fiat] = await assets.findByFiatCode(code);
      assert.ok(fiat);
      const request: RoutingRequest = {
        intentId: randomUUID(),
        intentRevision: 2,
        userId: randomUUID(),
        operation: "SEND",
        purpose: "PAYMENT",
        amount: createMoney("50000", fiat.id),
        amountMode: "EXACT_OUTPUT",
        destinationAssetId: fiat.id,
        destinationCountry: country,
      };
      const result = await resolver.resolve(request);
      assert.equal(result.status, "READY", code);
      if (result.status !== "READY") continue;
      const { set } = result;
      assert.equal(set.intentRevision, 2);
      assert.deepEqual(
        set.destination.candidates.map((c) => [c.symbol, c.providers]),
        [[symbol, ["textile"]]],
        code,
      );
      assert.deepEqual(
        set.source.candidates.map((c) => c.symbol),
        ["USDT"],
        "USDC has no corridor to this asset",
      );
      assert.deepEqual(set.requiredCapabilities, ["QUOTE", "SWAP", "EXACT_OUTPUT"]);
      assert.ok(set.pairs.every((pair) => pair.kind === "CONVERSION"));
    }

    // USD in, USD stablecoins both offered with USDT/USDC as direct-or-converted pairs.
    const [usd] = await assets.findByFiatCode("USD");
    const [brl] = await assets.findByFiatCode("BRL");
    assert.ok(usd && brl);
    const spend = await resolver.resolve({
      intentId: randomUUID(),
      intentRevision: 1,
      userId: randomUUID(),
      operation: "SEND",
      purpose: "PAYMENT",
      amount: createMoney("2000", usd.id),
      amountMode: "EXACT_INPUT",
      sourceAssetId: usd.id,
      destinationAssetId: brl.id,
      destinationCountry: "BR",
    });
    assert.equal(spend.status, "READY");
    if (spend.status === "READY") {
      assert.deepEqual(
        spend.set.source.candidates.map((c) => c.symbol),
        ["USDT"],
      );
      assert.equal(spend.set.amount.denomination, "USD");
    }
  });

  it("re-seeding assets and capabilities changes nothing", async () => {
    await rolledBack(async (tx) => {
      const assetsBefore = await tx.asset.findMany({ orderBy: { id: "asc" } });
      const capsBefore = await tx.providerCapability.findMany({ orderBy: { id: "asc" } });
      await seedCeloAssets(tx);
      const report = await seedProviderCapabilities(tx);
      assert.deepEqual([report.created, report.existing, report.skipped.length], [0, 40, 0]);
      const assetsAfter = await tx.asset.findMany({ orderBy: { id: "asc" } });
      const capsAfter = await tx.providerCapability.findMany({ orderBy: { id: "asc" } });
      assert.deepEqual(
        assetsAfter.map((row) => row.id),
        assetsBefore.map((row) => row.id),
      );
      assert.deepEqual(
        capsAfter.map((row) => row.id),
        capsBefore.map((row) => row.id),
      );
    });
  });

  it("does not re-enable a capability an operator disabled", async () => {
    await rolledBack(async (tx) => {
      const row = await tx.providerCapability.findFirstOrThrow({
        where: { capability: "SWAP" },
      });
      await tx.providerCapability.update({ where: { id: row.id }, data: { isActive: false } });
      const report = await seedProviderCapabilities(tx);
      assert.deepEqual([report.created, report.existing], [0, 40]);
      const after = await tx.providerCapability.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(after.isActive, false);
      assert.equal(await tx.providerCapability.count(), 40);
    });
  });

  it("the database refuses a duplicate capability, including with NULL columns", async () => {
    await rolledBack(async (tx) => {
      const row = await tx.providerCapability.findFirstOrThrow();
      await assert.rejects(
        tx.providerCapability.create({
          data: {
            id: randomUUID(),
            providerId: row.providerId,
            capability: row.capability,
            chainId: row.chainId,
            inputAssetId: row.inputAssetId,
            outputAssetId: row.outputAssetId,
            countryCode: row.countryCode,
          },
        }),
      );
    });
    await rolledBack(async (tx) => {
      const ripio = await tx.provider.findUniqueOrThrow({ where: { slug: "ripio" } });
      const base = {
        providerId: ripio.id,
        capability: "OFF_RAMP" as const,
        chainId: CELO_CHAIN_ID,
      };
      await tx.providerCapability.create({ data: { id: randomUUID(), ...base } });
      await assert.rejects(tx.providerCapability.create({ data: { id: randomUUID(), ...base } }));
    });
    // A different country or type is a different capability, not a duplicate.
    await rolledBack(async (tx) => {
      const ripio = await tx.provider.findUniqueOrThrow({ where: { slug: "ripio" } });
      const base = {
        providerId: ripio.id,
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
      assert.equal(await tx.providerCapability.count(), 43);
    });
  });

  it("honours a disabled provider, row or asset through the registries", async () => {
    await rolledBack(async (tx) => {
      const assets = createAssetRegistry(createAssetRepository(tx));
      const [usdt] = await assets.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
      const [wbrl] = await assets.findBySymbol("wBRL", { chainId: CELO_CHAIN_ID });
      assert.ok(usdt && wbrl);
      const registryOfCapabilities = createProviderCapabilityRegistry(
        createProviderRepository(tx),
        {
          ttlMs: 0,
        },
      );
      const pair = { chainId: CELO_CHAIN_ID, inputAssetId: usdt.id, outputAssetId: wbrl.id };
      assert.equal(
        await registryOfCapabilities.supportsPair({ ...pair, capability: "SWAP" }),
        true,
      );

      await tx.providerCapability.updateMany({
        where: { capability: "SWAP" },
        data: { isActive: false },
      });
      assert.equal(
        await registryOfCapabilities.supportsPair({ ...pair, capability: "SWAP" }),
        false,
      );
      assert.equal(
        await registryOfCapabilities.supportsPair({ ...pair, capability: "QUOTE" }),
        true,
      );

      await tx.provider.update({ where: { slug: "textile" }, data: { isActive: false } });
      assert.equal(
        await registryOfCapabilities.supportsPair({ ...pair, capability: "QUOTE" }),
        false,
      );

      await tx.asset.update({ where: { id: wbrl.id }, data: { isActive: false } });
      const settlement = createSettlementAssetResolver(assets);
      const brl = await settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "BRL" });
      assert.equal(brl.status, "UNSUPPORTED");
    });
  });
});
