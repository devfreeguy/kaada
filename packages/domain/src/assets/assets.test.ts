import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isKaadaError } from "../errors/index.js";
import { isValidAddress, normalizeAddress } from "./address.js";
import type { AddressCodec, ChainAddressResolver } from "./address.js";
import type { Asset } from "./asset.js";
import { createAssetRegistry } from "./registry.js";
import type { AssetRepository } from "./registry.js";

const asset = (overrides: Partial<Asset> & Pick<Asset, "id" | "symbol">): Asset => ({
  name: overrides.symbol,
  kind: "USD_STABLECOIN",
  decimals: 6,
  isActive: true,
  ...overrides,
});

const usd = asset({ id: "usd", symbol: "USD", kind: "FIAT", decimals: 2, fiatCode: "USD" });
const usdcCelo = asset({ id: "usdc-celo", symbol: "USDC", chainId: 42220, contractAddress: "0xa" });
const usdcOther = asset({ id: "usdc-other", symbol: "USDC", chainId: 1, contractAddress: "0xb" });
const retired = asset({ id: "old", symbol: "OLD", isActive: false, chainId: 42220 });
const all = [usd, usdcCelo, usdcOther, retired];

const repository: AssetRepository = {
  findById: (id) => Promise.resolve(all.find((a) => a.id === id) ?? null),
  findBySymbol: (symbol, options) =>
    Promise.resolve(
      all.filter(
        (a) =>
          a.symbol.toLowerCase() === symbol.toLowerCase() &&
          (options?.chainId === undefined || a.chainId === options.chainId),
      ),
    ),
  findByFiatCode: (code) =>
    Promise.resolve(all.filter((a) => a.fiatCode?.toLowerCase() === code.toLowerCase())),
  listActive: () => Promise.resolve(all.filter((a) => a.isActive)),
  listAll: () => Promise.resolve([...all]),
};
const registry = createAssetRegistry(repository);

describe("address normalisation", () => {
  const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

  it("lowercases and trims valid EVM addresses", () => {
    assert.equal(normalizeAddress(42220, ` ${mixed} `), mixed.toLowerCase());
    assert.equal(isValidAddress(42220, mixed), true);
  });

  it("rejects malformed EVM addresses", () => {
    for (const bad of [
      "",
      "0x123",
      "abcdef0123456789abcdef0123456789abcdef01",
      `${mixed}00`,
      "0xZZ",
    ]) {
      assert.equal(isValidAddress(42220, bad), false, bad);
      assert.throws(
        () => normalizeAddress(42220, bad),
        (e) => isKaadaError(e, "INVALID_INTENT"),
      );
    }
  });

  it("lets a future chain family keep case-sensitive addresses", () => {
    const caseSensitive: AddressCodec = { isValid: () => true, normalize: (address) => address };
    const resolver: ChainAddressResolver = {
      codecFor: (chainId) =>
        chainId === 999_999 ? caseSensitive : { isValid: () => false, normalize: () => "" },
    };
    assert.equal(normalizeAddress(999_999, "AbC", resolver), "AbC");
  });
});

describe("AssetRegistry", () => {
  it("looks assets up by id", async () => {
    assert.equal((await registry.getById("usd"))?.symbol, "USD");
    assert.equal(await registry.getById("missing"), null);
  });

  it("finds by symbol, narrowed by chain, hiding inactive assets by default", async () => {
    assert.deepEqual(
      (await registry.findBySymbol("usdc")).map((a) => a.id),
      ["usdc-celo", "usdc-other"],
    );
    assert.deepEqual(
      (await registry.findBySymbol("USDC", { chainId: 42220 })).map((a) => a.id),
      ["usdc-celo"],
    );
    assert.deepEqual(await registry.findBySymbol("OLD"), []);
    assert.deepEqual(
      (await registry.findBySymbol("OLD", { includeInactive: true })).map((a) => a.id),
      ["old"],
    );
  });

  it("filters by kind", async () => {
    assert.deepEqual(await registry.findBySymbol("USDC", { kind: "FIAT" }), []);
    assert.deepEqual(
      (await registry.findBySymbol("USD", { kind: "FIAT" })).map((a) => a.id),
      ["usd"],
    );
  });

  it("finds by fiat code", async () => {
    assert.deepEqual(
      (await registry.findByFiatCode("usd")).map((a) => a.id),
      ["usd"],
    );
    assert.deepEqual(await registry.findByFiatCode("XXX"), []);
  });

  it("requireActive returns active assets and rejects missing or inactive ones", async () => {
    assert.equal((await registry.requireActive("usd")).decimals, 2);
    await assert.rejects(registry.requireActive("old"), (e) =>
      isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
    await assert.rejects(registry.requireActive("nope"), (e) =>
      isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
  });

  it("exposes decimals, including for inactive assets", async () => {
    assert.equal(await registry.decimalsOf("usd"), 2);
    assert.equal(await registry.decimalsOf("old"), 6);
    await assert.rejects(registry.decimalsOf("nope"), (e) =>
      isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
  });
});
