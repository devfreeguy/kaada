import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createAssetRegistry } from "@kaada/domain";

import { createAssetResolver } from "../src/core/assets/asset-resolver.js";
import { createRepositoryRecipientResolver } from "../src/core/recipients/recipient-resolver.js";
import { createHarness, SENDER } from "./support/harness.js";

describe("AssetResolver", () => {
  const h = createHarness();
  const resolver = createAssetResolver(createAssetRegistry(h.world.repositories.assets));

  it("resolves fiat currencies and tokens only from the registry", async () => {
    for (const [label, expected] of [
      ["USD", h.assets.USD],
      ["ngn", h.assets.NGN],
      [" BRL ", h.assets.BRL],
      ["USDT", h.assets.USDT],
    ] as const) {
      const result = await resolver.resolve(label);
      assert.equal(result.status, "RESOLVED", label);
      assert.equal(result.status === "RESOLVED" && result.asset.id, expected.id, label);
    }
  });

  it("keeps the dollar and dollar tokens apart", async () => {
    const result = await resolver.resolve("USD");
    assert.equal(result.status === "RESOLVED" && result.asset.kind, "FIAT");
  });

  it("reports ambiguity with every candidate", async () => {
    const result = await resolver.resolve("USDC");
    assert.equal(result.status, "AMBIGUOUS");
    assert.equal(result.status === "AMBIGUOUS" && result.candidates.length, 2);
  });

  it("does not invent assets that are not in the registry", async () => {
    for (const label of ["cNGN", "wBRL", "EUR", "", "   "]) {
      assert.equal((await resolver.resolve(label)).status, "NOT_FOUND", label);
    }
  });
});

describe("RecipientResolver (database data only)", () => {
  function setup() {
    const h = createHarness();
    const resolver = createRepositoryRecipientResolver(h.world.repositories);
    return { h, resolver };
  }

  it("resolves a Kaada username to the linked user, ignoring case and a leading @", async () => {
    const { h, resolver } = setup();
    const daniel = h.world.addUser({
      id: randomUUID(),
      username: "daniel",
      displayName: "Daniel S.",
    });
    for (const value of ["daniel", "@Daniel", " DANIEL "]) {
      const result = await resolver.resolve(SENDER, { type: "KAADA_USER", value });
      assert.equal(result.status, "RESOLVED", value);
      assert.equal(result.status === "RESOLVED" && result.recipient.linkedUserId, daniel.id);
      assert.equal(result.status === "RESOLVED" && result.recipient.displayName, "Daniel S.");
    }
    assert.equal(
      (await resolver.resolve(SENDER, { type: "KAADA_USER", value: "nope" })).status,
      "NOT_FOUND",
    );
  });

  it("prefers the sender's own saved contacts over Kaada users for a generic name", async () => {
    const { h, resolver } = setup();
    h.world.addUser({ id: randomUUID(), username: "maria" });
    const saved = h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Maria Lopes",
      destinationCountry: "AR",
    });
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "maria" });
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.status === "RESOLVED" && result.recipient.recipientId, saved.id);
    assert.equal(result.status === "RESOLVED" && result.recipient.destinationCountry, "AR");
  });

  it("falls back to a Kaada username when no saved contact matches", async () => {
    const { h, resolver } = setup();
    const user = h.world.addUser({ id: randomUUID(), username: "maria" });
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "maria" });
    assert.equal(result.status === "RESOLVED" && result.recipient.linkedUserId, user.id);
  });

  it("never matches another user's saved contacts", async () => {
    const { h, resolver } = setup();
    const other = h.world.addUser({ id: randomUUID() });
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: other.id,
      type: "SAVED_BENEFICIARY",
      displayName: "Secret Sam",
    });
    assert.equal(
      (await resolver.resolve(SENDER, { type: "SAVED_BENEFICIARY", value: "Sam" })).status,
      "NOT_FOUND",
    );
  });

  it("is ambiguous when several saved contacts share a word of the name", async () => {
    const { h, resolver } = setup();
    for (const name of ["Daniel Souza", "Daniel Lee", "Danielle Park"]) {
      h.world.addRecipient({
        id: randomUUID(),
        ownerUserId: SENDER,
        type: "SAVED_BENEFICIARY",
        displayName: name,
      });
    }
    const result = await resolver.resolve(SENDER, { type: "SAVED_BENEFICIARY", value: "Daniel" });
    assert.equal(result.status, "AMBIGUOUS");
    assert.equal(
      result.status === "AMBIGUOUS" && result.candidates.length,
      2,
      "Danielle is a different word",
    );
    const exact = await resolver.resolve(SENDER, {
      type: "SAVED_BENEFICIARY",
      value: "Daniel Lee",
    });
    assert.equal(exact.status, "RESOLVED");
  });

  it("resolves Telegram users only through stored identities", async () => {
    const { h, resolver } = setup();
    const user = h.world.addUser({ id: randomUUID(), displayName: "Tele User" });
    h.world.addIdentity({
      id: randomUUID(),
      userId: user.id,
      type: "TELEGRAM",
      externalId: "12345",
      username: "teleuser",
    });

    const byId = await resolver.resolve(SENDER, { type: "TELEGRAM_USER", value: "12345" });
    assert.equal(byId.status === "RESOLVED" && byId.recipient.linkedUserId, user.id);
    const byName = await resolver.resolve(SENDER, { type: "TELEGRAM_USER", value: "@TeleUser" });
    assert.equal(byName.status === "RESOLVED" && byName.recipient.linkedUserId, user.id);
    assert.equal(
      (await resolver.resolve(SENDER, { type: "TELEGRAM_USER", value: "@ghost" })).status,
      "NOT_FOUND",
    );
    assert.equal(
      (await resolver.resolve(SENDER, { type: "TELEGRAM_USER", value: "999" })).status,
      "NOT_FOUND",
    );
  });

  it("validates and normalises wallet addresses", async () => {
    const { resolver } = setup();
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const ok = await resolver.resolve(SENDER, { type: "WALLET_ADDRESS", value: ` ${mixed} ` });
    assert.equal(ok.status === "RESOLVED" && ok.recipient.walletAddress, mixed.toLowerCase());
    const bad = await resolver.resolve(SENDER, { type: "WALLET_ADDRESS", value: "0x123" });
    assert.deepEqual(bad, { status: "NOT_FOUND", reason: "INVALID_FORMAT" });
  });

  it("does not look up phone numbers or external payment addresses", async () => {
    const { resolver } = setup();
    for (const type of ["PHONE_NUMBER", "EXTERNAL_PAYMENT_ADDRESS"] as const) {
      assert.deepEqual(await resolver.resolve(SENDER, { type, value: "+2348012345678" }), {
        status: "NOT_FOUND",
        reason: "UNSUPPORTED_TYPE",
      });
    }
  });
});
