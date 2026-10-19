import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";
import type { Wallet } from "@kaada/domain";

import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { createRepositoryRecipientResolver } from "../src/core/recipients/recipient-resolver.js";
import { clarificationText } from "../src/core/responses/clarifications.js";
import { createHarness, SENDER } from "./support/harness.js";

/*
 * "Send @daniel 200 Naira": a Telegram @username is captured from every message a person sends, so the name of someone who is on
 * Kaada finds them, and they are paid at THEIR OWN wallet (never an address the sender typed or the model guessed).
 */

const DANIEL_WALLET = `0x${"d1".repeat(20)}`;

function world(options: { wallets?: Record<string, Partial<Wallet>> } = {}) {
  const h = createHarness();
  const wallets = options.wallets ?? {};
  const resolver = createRepositoryRecipientResolver({
    ...h.world.repositories,
    wallets: {
      findEmbedded: (userId: string) =>
        Promise.resolve((wallets[userId] as Wallet | undefined) ?? null),
    },
  });
  return { h, resolver, wallets };
}

const activeWallet = (address: string): Partial<Wallet> => ({ status: "ACTIVE", address });

describe("a Telegram @username finds the person on Kaada", () => {
  it("'@daniel' (a plain name or handle) resolves to the Telegram user, case-insensitively, and carries THEIR wallet", async () => {
    const { h, resolver, wallets } = world();
    const daniel = h.world.addUser({ id: randomUUID(), displayName: "Daniel S." });
    h.world.addIdentity({
      id: randomUUID(),
      userId: daniel.id,
      type: "TELEGRAM",
      externalId: "555",
      username: "amjustjay",
    });
    wallets[daniel.id] = activeWallet(DANIEL_WALLET);

    for (const value of ["@amjustjay", "amjustjay", "@AmJustJay", " @AMJUSTJAY "]) {
      const result = await resolver.resolve(SENDER, { type: "USERNAME", value });
      assert.equal(result.status, "RESOLVED", value);
      if (result.status !== "RESOLVED") return;
      assert.equal(result.recipient.linkedUserId, daniel.id, value);
      assert.equal(result.recipient.walletAddress, DANIEL_WALLET, "paid at their own wallet");
      assert.equal(result.recipient.displayName, "Daniel S.");
    }
  });

  it("someone who is on Kaada but has no wallet yet is said so plainly, not 'not found'", async () => {
    const { h, resolver } = world();
    const user = h.world.addUser({ id: randomUUID() });
    h.world.addIdentity({
      id: randomUUID(),
      userId: user.id,
      type: "TELEGRAM",
      externalId: "556",
      username: "newbie",
    });
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "@newbie" });
    assert.deepEqual(result, { status: "NOT_FOUND", reason: "NO_WALLET" });
    assert.match(
      clarificationText({
        operation: "SEND",
        field: "RECIPIENT",
        reason: "NOT_FOUND",
        subject: "@newbie",
        detail: "NO_WALLET",
      }),
      /@newbie is on Kaada but hasn't finished setting up their wallet/,
    );
  });

  it("a person who has not used Kaada is not found (a bot cannot look up strangers)", async () => {
    const { resolver } = world();
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "@amjustjay" });
    assert.deepEqual(result, { status: "NOT_FOUND", reason: "NO_MATCH" });
  });

  it("you cannot pay yourself by your own @username", async () => {
    const { h, resolver, wallets } = world();
    h.world.addIdentity({
      id: randomUUID(),
      userId: SENDER,
      type: "TELEGRAM",
      externalId: "1",
      username: "me",
    });
    wallets[SENDER] = activeWallet(`0x${"aa".repeat(20)}`);
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "@me" });
    assert.equal(result.status, "NOT_FOUND");
  });

  it("a username that two accounts claim (one went stale) asks which, and never guesses", async () => {
    const { h, resolver, wallets } = world();
    for (const externalId of ["601", "602"]) {
      const user = h.world.addUser({ id: randomUUID() });
      h.world.addIdentity({
        id: randomUUID(),
        userId: user.id,
        type: "TELEGRAM",
        externalId,
        username: "taken",
      });
      wallets[user.id] = activeWallet(`0x${externalId.padEnd(40, "0")}`);
    }
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "@taken" });
    assert.equal(result.status, "AMBIGUOUS");
  });

  it("a saved contact still wins over a Telegram handle", async () => {
    const { h, resolver } = world();
    const other = h.world.addUser({ id: randomUUID() });
    h.world.addIdentity({
      id: randomUUID(),
      userId: other.id,
      type: "TELEGRAM",
      externalId: "700",
      username: "maria",
    });
    const saved = h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Maria Lopes",
    });
    const result = await resolver.resolve(SENDER, { type: "USERNAME", value: "maria" });
    assert.equal(result.status === "RESOLVED" && result.recipient.recipientId, saved.id);
  });

  it("the explicit TELEGRAM_USER and KAADA_USER types are paid at the person's wallet too", async () => {
    const { h, resolver, wallets } = world();
    const user = h.world.addUser({ id: randomUUID(), username: "daniel" });
    h.world.addIdentity({
      id: randomUUID(),
      userId: user.id,
      type: "TELEGRAM",
      externalId: "800",
      username: "dan_tg",
    });
    wallets[user.id] = activeWallet(DANIEL_WALLET);
    for (const reference of [
      { type: "TELEGRAM_USER" as const, value: "@dan_tg" },
      { type: "KAADA_USER" as const, value: "daniel" },
    ]) {
      const result = await resolver.resolve(SENDER, reference);
      assert.equal(result.status === "RESOLVED" && result.recipient.walletAddress, DANIEL_WALLET);
    }
  });
});

describe("the @username is captured from the messages people send", () => {
  function identities() {
    const h = createHarness();
    const service = new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: h.world.repositories.identities,
    });
    return { h, service };
  }

  const sender = (username?: string) => ({
    channel: "TELEGRAM" as const,
    externalUserId: "9001",
    ...(username && { username }),
    displayName: "Ada",
  });

  it("is stored when the account is created", async () => {
    const { h, service } = identities();
    await service.resolve(sender("ada_l"));
    const found = await h.world.repositories.identities.findByUsername("TELEGRAM", "ADA_L");
    assert.equal(found.length, 1);
  });

  it("is filled in by a later message when it was empty, and follows a change", async () => {
    const { h, service } = identities();
    await service.resolve(sender());
    assert.equal(
      (await h.world.repositories.identities.findByUsername("TELEGRAM", "ada_l")).length,
      0,
    );
    await service.resolve(sender("ada_l"));
    assert.equal(
      (await h.world.repositories.identities.findByUsername("TELEGRAM", "ada_l")).length,
      1,
    );
    await service.resolve(sender("ada_new"));
    assert.equal(
      (await h.world.repositories.identities.findByUsername("TELEGRAM", "ada_l")).length,
      0,
    );
    assert.equal(
      (await h.world.repositories.identities.findByUsername("TELEGRAM", "ada_new")).length,
      1,
    );
  });

  it("a failure to save it is reported, never silent, and never fails the message", async () => {
    const h = createHarness();
    const logs: { event: string; error?: string | undefined }[] = [];
    const service = new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: {
        ...h.world.repositories.identities,
        updateProfile: () => Promise.reject(new Error("database unavailable")),
      },
      log: (_level, event, fields) =>
        void logs.push({ event, error: fields["message"] as string | undefined }),
    });
    await service.resolve(sender());
    const second = await service.resolve(sender("ada_l"));
    assert.equal(second.created, false, "the message still goes through");
    assert.equal(logs[0]?.event, "identity.profile_update_failed");
    assert.match(String(logs[0]?.error), /database unavailable/);
    void createId;
  });
});
