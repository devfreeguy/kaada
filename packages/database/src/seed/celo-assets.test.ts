import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { celoAssets, seedCeloAssets } from "./celo-assets.js";
import type { CeloSeedClient } from "./celo-assets.js";
import { seedProviderCapabilities, verifiedCapabilities } from "./capabilities.js";
import type { CapabilityDefinition, CapabilitySeedClient } from "./capabilities.js";

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
  it("seeds the verified assets lowercase, with exact decimals and explicit currency metadata", async () => {
    const { client, rows } = fakeAssetClient();
    await seedCeloAssets(client);
    assert.deepEqual(
      rows.map((row) => [
        row["symbol"],
        row["decimals"],
        row["chainId"],
        row["fiatCode"],
        row["countryCode"],
        row["kind"],
        row["contractAddress"],
      ]),
      [
        [
          "USDT",
          6,
          42220,
          "USD",
          undefined,
          "USD_STABLECOIN",
          "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
        ],
        [
          "USDC",
          6,
          42220,
          "USD",
          undefined,
          "USD_STABLECOIN",
          "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
        ],
        [
          "cNGN",
          6,
          42220,
          "NGN",
          "NG",
          "LOCAL_STABLECOIN",
          "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f",
        ],
        [
          "wARS",
          18,
          42220,
          "ARS",
          "AR",
          "LOCAL_STABLECOIN",
          "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d",
        ],
        [
          "wBRL",
          18,
          42220,
          "BRL",
          "BR",
          "LOCAL_STABLECOIN",
          "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0",
        ],
        [
          "IDRX",
          2,
          42220,
          "IDR",
          "ID",
          "LOCAL_STABLECOIN",
          "0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22",
        ],
      ],
    );
  });

  it("is idempotent, reconciles an existing asset, and refuses to change decimals", async () => {
    const { client, rows } = fakeAssetClient();
    await seedCeloAssets(client);
    const ids = rows.map((row) => row.id);
    const first = rows[0];
    assert.ok(first);
    first["name"] = "stale name";
    await seedCeloAssets(client);
    assert.deepEqual(
      rows.map((row) => row.id),
      ids,
    );
    assert.equal(rows.length, celoAssets.length);
    assert.equal(first["name"], "Tether USD", "descriptive metadata is reconciled");
    first["decimals"] = 18;
    await assert.rejects(seedCeloAssets(client), /Refusing to change decimals/);
  });

  it("does not seed unverified assets, or the Mento naira token", () => {
    const symbols = celoAssets.map((asset) => asset.symbol as string);
    for (const unverified of ["wMXN", "wCOP", "wPEN", "wCLP", "USA₮", "NGNm"]) {
      assert.equal(symbols.includes(unverified), false, unverified);
    }
    const addresses = celoAssets.map((asset) => asset.contractAddress.toLowerCase());
    assert.equal(addresses.includes("0xe2702bd97ee33c88c8f6f92da3b733608aa76f71"), false);
  });
});

describe("seedProviderCapabilities", () => {
  it("defines exactly the verified Textile RFQ capabilities, with both directions explicit", () => {
    assert.equal(verifiedCapabilities.length, 40);
    assert.ok(verifiedCapabilities.every((c) => c.provider === "textile"));
    const types = new Set(verifiedCapabilities.map((c) => c.capability));
    assert.deepEqual([...types].sort(), ["EXACT_INPUT", "EXACT_OUTPUT", "QUOTE", "SWAP"]);
    const key = (c: CapabilityDefinition) => JSON.stringify([c.capability, c.input, c.output]);
    assert.equal(new Set(verifiedCapabilities.map(key)).size, 40, "no duplicate definitions");
    for (const c of verifiedCapabilities) {
      const reverse = verifiedCapabilities.find(
        (other) =>
          other.capability === c.capability &&
          JSON.stringify(other.input) === JSON.stringify(c.output) &&
          JSON.stringify(other.output) === JSON.stringify(c.input),
      );
      assert.ok(reverse, "the reverse direction is its own row");
    }
    // Only the RFQ types: no conditional execution, no ramp or payout.
    for (const excluded of ["CONDITIONAL_EXECUTION", "ON_RAMP", "OFF_RAMP", "BANK_PAYOUT"]) {
      assert.equal(types.has(excluded as never), false, excluded);
    }
  });

  it("only references seeded assets, and none of the unverified tokens", () => {
    const seeded = new Set(celoAssets.map((a) => a.contractAddress.toLowerCase()));
    for (const c of verifiedCapabilities) {
      for (const ref of [c.input, c.output]) {
        assert.ok(ref && "contractAddress" in ref && seeded.has(ref.contractAddress.toLowerCase()));
      }
    }
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

  it("creates once, never duplicates, and keeps types separate", async () => {
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
