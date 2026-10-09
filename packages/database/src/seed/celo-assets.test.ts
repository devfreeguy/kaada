import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { celoAssets, seedCeloAssets } from "./celo-assets.js";
import type { CeloSeedClient } from "./celo-assets.js";
import { seedProviderCapabilities, verifiedCapabilities } from "./capabilities.js";
import type { CapabilitySeedClient, CapabilityDefinition } from "./capabilities.js";

interface Row {
  id: string;
  [key: string]: unknown;
}

function fakeAssetClient() {
  const rows: Row[] = [];
  const client = {
    asset: {
      findUnique: ({
        where,
      }: {
        where: { chainId_contractAddress: { chainId: number; contractAddress: string } };
      }) => {
        const key = where.chainId_contractAddress;
        return Promise.resolve(
          rows.find(
            (row) =>
              row["chainId"] === key.chainId && row["contractAddress"] === key.contractAddress,
          ) ?? null,
        );
      },
      create: ({ data }: { data: Row }) => {
        rows.push(data);
        return Promise.resolve();
      },
      update: ({ where, data }: { where: { id: string }; data: object }) => {
        Object.assign(rows.find((row) => row.id === where.id) ?? {}, data);
        return Promise.resolve();
      },
    },
  };
  return { client: client as unknown as CeloSeedClient, rows };
}

describe("seedCeloAssets", () => {
  it("seeds only verified assets, lowercase, with explicit currency metadata", async () => {
    const { client, rows } = fakeAssetClient();
    await seedCeloAssets(client);
    assert.deepEqual(
      rows.map((row) => [row["symbol"], row["decimals"], row["chainId"], row["fiatCode"]]),
      [
        ["USDT", 6, 42220, "USD"],
        ["USDC", 6, 42220, "USD"],
      ],
    );
    assert.ok(
      rows.every(
        (row) => String(row["contractAddress"]) === String(row["contractAddress"]).toLowerCase(),
      ),
    );
    assert.equal(rows[0]?.["contractAddress"], "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e");
    assert.equal(rows[1]?.["contractAddress"], "0xceba9300f2b948710d2653dd7b07f33a8b32118c");
  });

  it("is idempotent and refuses to change decimals", async () => {
    const { client, rows } = fakeAssetClient();
    await seedCeloAssets(client);
    const ids = rows.map((row) => row.id);
    await seedCeloAssets(client);
    assert.deepEqual(
      rows.map((row) => row.id),
      ids,
    );
    assert.equal(rows.length, celoAssets.length);
    const first = rows[0];
    assert.ok(first);
    first["decimals"] = 18;
    await assert.rejects(seedCeloAssets(client), /Refusing to change decimals/);
  });

  it("does not seed assets whose metadata could not be verified", () => {
    const symbols = celoAssets.map((asset) => asset.symbol as string);
    for (const unverified of [
      "wBRL",
      "wARS",
      "wMXN",
      "wCOP",
      "wPEN",
      "wCLP",
      "cNGN",
      "IDRX",
      "USA₮",
    ]) {
      assert.equal(symbols.includes(unverified), false, unverified);
    }
  });
});

describe("seedProviderCapabilities", () => {
  it("seeds no capability that has not been verified", () => {
    assert.deepEqual(verifiedCapabilities, []);
  });

  function fakeCapabilityClient() {
    const providers = [{ id: "p-textile", slug: "textile" }];
    const assets = [
      { id: "a-usd", kind: "FIAT", fiatCode: "USD" },
      {
        id: "a-usdt",
        chainId: 42220,
        contractAddress: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
      },
    ];
    const caps: Row[] = [];
    const matches = (row: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    const client = {
      provider: {
        findUnique: ({ where }: { where: { slug: string } }) =>
          Promise.resolve(providers.find((p) => p.slug === where.slug) ?? null),
      },
      asset: {
        findFirst: ({ where }: { where: { fiatCode: string } }) =>
          Promise.resolve(assets.find((a) => a.fiatCode === where.fiatCode) ?? null),
        findUnique: ({
          where,
        }: {
          where: { chainId_contractAddress: { chainId: number; contractAddress: string } };
        }) =>
          Promise.resolve(
            assets.find(
              (a) =>
                a.chainId === where.chainId_contractAddress.chainId &&
                a.contractAddress === where.chainId_contractAddress.contractAddress,
            ) ?? null,
          ),
      },
      providerCapability: {
        findFirst: ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(caps.find((row) => matches(row, where)) ?? null),
        create: ({ data }: { data: Row }) => {
          caps.push(data);
          return Promise.resolve();
        },
      },
    };
    return { client: client as unknown as CapabilitySeedClient, caps };
  }

  const quote: CapabilityDefinition = {
    provider: "textile",
    capability: "QUOTE",
    chainId: 42220,
    input: { chainId: 42220, contractAddress: "0x48065fBBE25f71C9282ddf5e1cD6D6A887483D5e" },
    output: { fiatCode: "USD" },
    source: "test",
  };

  it("creates once, never duplicates, and keeps types and directions separate", async () => {
    const { client, caps } = fakeCapabilityClient();
    const swap: CapabilityDefinition = { ...quote, capability: "SWAP" };
    const first = await seedProviderCapabilities(client, [quote, swap]);
    assert.deepEqual([first.created, first.existing], [2, 0]);
    const again = await seedProviderCapabilities(client, [quote, swap]);
    assert.deepEqual([again.created, again.existing], [0, 2]);
    assert.equal(caps.length, 2, "QUOTE and SWAP are separate rows");
  });

  it("skips a capability whose provider or assets are not seeded", async () => {
    const { client, caps } = fakeCapabilityClient();
    const report = await seedProviderCapabilities(client, [
      { ...quote, provider: "nobody" },
      { ...quote, output: { fiatCode: "BRL" } },
    ]);
    assert.equal(caps.length, 0);
    assert.deepEqual(
      report.skipped.map((s) => s.reason),
      ["provider nobody is not seeded", "output asset is not seeded"],
    );
  });
});
