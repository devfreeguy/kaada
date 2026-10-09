import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fiatAssets, providers, seedFoundation } from "./foundation.js";
import type { SeedClient } from "./foundation.js";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Row {
  id: string;
  [key: string]: unknown;
}

/** Minimal in-memory stand-in for the two delegates the seed touches. */
function fakeClient() {
  const providerRows = new Map<string, Row>();
  const assetRows: Row[] = [];
  const client = {
    provider: {
      upsert: ({
        where,
        update,
        create,
      }: {
        where: { slug: string };
        update: object;
        create: Row;
      }) => {
        const existing = providerRows.get(where.slug);
        providerRows.set(where.slug, existing ? { ...existing, ...update } : create);
        return Promise.resolve();
      },
    },
    asset: {
      findFirst: ({ where }: { where: { fiatCode: string } }) =>
        Promise.resolve(assetRows.find((row) => row["fiatCode"] === where.fiatCode) ?? null),
      create: ({ data }: { data: Row }) => {
        assetRows.push(data);
        return Promise.resolve();
      },
      update: ({ where, data }: { where: { id: string }; data: object }) => {
        const row = assetRows.find((candidate) => candidate.id === where.id);
        Object.assign(row ?? {}, data);
        return Promise.resolve();
      },
    },
  };
  return { client: client as unknown as SeedClient, providerRows, assetRows };
}

describe("seedFoundation", () => {
  it("seeds providers and fiat assets with UUIDv4 ids", async () => {
    const { client, providerRows, assetRows } = fakeClient();
    await seedFoundation(client);
    assert.deepEqual(
      [...providerRows.keys()],
      providers.map((provider) => provider.slug),
    );
    assert.equal(assetRows.length, fiatAssets.length);
    for (const row of [...providerRows.values(), ...assetRows]) {
      assert.match(row.id, uuidV4);
    }
  });

  it("is idempotent and keeps ids stable", async () => {
    const { client, providerRows, assetRows } = fakeClient();
    await seedFoundation(client);
    const before = [...providerRows.values(), ...assetRows].map((row) => row.id);
    await seedFoundation(client);
    assert.deepEqual(
      [...providerRows.values(), ...assetRows].map((row) => row.id),
      before,
    );
    assert.equal(assetRows.length, fiatAssets.length);
  });

  it("refuses to change decimals of an existing asset", async () => {
    const { client, assetRows } = fakeClient();
    await seedFoundation(client);
    const usd = assetRows.find((row) => row["fiatCode"] === "USD");
    assert.ok(usd);
    usd["decimals"] = 6;
    await assert.rejects(seedFoundation(client), /Refusing to change decimals/);
  });

  it("seeds fiat only: no blockchain assets", () => {
    assert.ok(fiatAssets.every((asset) => /^[A-Z]{3}$/.test(asset.fiatCode)));
  });
});
