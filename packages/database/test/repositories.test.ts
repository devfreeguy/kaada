/*
 * Round-trip tests against the real database. They only run when DATABASE_URL is set (the repo
 * root .env is loaded if present) and require the Build 2 migrations and seed to be applied.
 *
 * Every test runs inside a transaction that is ALWAYS rolled back, so no data is ever left behind.
 * Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createCachedAssetRepository, createId, createMoney, isKaadaError } from "@kaada/domain";
import type { AgentIntent } from "@kaada/domain";

import {
  createDatabase,
  createDatabaseAssetRegistry,
  createRepositories,
  withTransaction,
} from "../src/index.js";
import type { Database, Repositories } from "../src/index.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

class Rollback extends Error {}

describe("repositories (database round trips, rolled back)", { skip }, () => {
  let database: Database;

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 3, poolTimeoutMs: 20_000 });
  });
  after(async () => {
    await database.close();
  });

  /** Runs `work` in a transaction and rolls it back, surfacing any assertion failure. */
  async function rolledBack(work: (repos: Repositories) => Promise<void>): Promise<void> {
    await assert.rejects(
      withTransaction(
        database,
        async (repos) => {
          await work(repos);
          throw new Rollback();
        },
        { timeoutMs: 30_000 },
      ),
      (error) => error instanceof Rollback,
    );
  }

  async function seeded(repos: Repositories) {
    const [usd] = await repos.assets.findByFiatCode("USD");
    const [ngn] = await repos.assets.findByFiatCode("NGN");
    const textile = await repos.providers.findBySlug("textile");
    assert.ok(usd && ngn && textile, "run `pnpm db:seed` first");
    return { usd, ngn, textile };
  }

  async function newConversation(repos: Repositories) {
    const user = createId();
    await repos.users.createWithIdentity({
      user: { id: user, username: `u${user.slice(0, 8)}` },
      identity: { id: createId(), userId: user, type: "TELEGRAM", externalId: `tg-${user}` },
    });
    const conversation = await repos.conversations.create({
      id: createId(),
      userId: user,
      channel: "TELEGRAM",
      status: "ACTIVE",
      externalConversationId: `chat-${user}`,
    });
    return { userId: user, conversation };
  }

  it("serves the seeded assets through the AssetRegistry", async () => {
    const registry = createDatabaseAssetRegistry(database);
    const [usd] = await registry.findByFiatCode("usd");
    assert.equal(usd?.decimals, 2);
    assert.equal(usd?.kind, "FIAT");
    assert.ok(!("chainId" in (usd ?? {})));
    assert.equal((await registry.requireActive(usd?.id ?? "")).symbol, "USD");
    assert.equal((await registry.findBySymbol("ngn", { kind: "FIAT" })).length, 1);
    await assert.rejects(registry.requireActive(createId()), (e) =>
      isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
  });

  it("lists every asset, and the cache answers like the live repository", async () => {
    const live = createRepositories(database).assets;
    const cached = createCachedAssetRepository(live);
    const all = await live.listAll();
    assert.ok(all.length >= 5 && all.every((asset) => asset.id));
    assert.deepEqual(await cached.listAll(), all);

    for (const code of ["USD", "ngn", " brl "]) {
      assert.deepEqual(await cached.findByFiatCode(code), await live.findByFiatCode(code), code);
    }
    for (const symbol of ["USD", "usd", "NOPE"]) {
      assert.deepEqual(await cached.findBySymbol(symbol), await live.findBySymbol(symbol), symbol);
    }
    const [usd] = await live.findByFiatCode("USD");
    assert.deepEqual(await cached.findById(usd?.id ?? ""), usd ?? null);
    assert.deepEqual(await cached.listActive(), await live.listActive());
  });

  it("serves seeded providers and only the verified Textile capabilities", async () => {
    await rolledBack(async (repos) => {
      const slugs = (await repos.providers.listActive()).map((p) => p.slug);
      assert.deepEqual(slugs, ["celo", "ripio", "textile"]);
      const capabilities = await repos.providers.listCapabilities();
      assert.equal(capabilities.length, 40);
      assert.equal(new Set(capabilities.map((c) => c.providerId)).size, 1, "all Textile");
    });
  });

  it("round-trips users, identities, conversations and messages (with webhook de-duplication)", async () => {
    await rolledBack(async (repos) => {
      const { userId, conversation } = await newConversation(repos);

      const identity = await repos.identities.findByExternalId("TELEGRAM", `tg-${userId}`);
      assert.equal(identity?.userId, userId);
      assert.equal((await repos.identities.listForUser(userId)).length, 1);
      assert.equal((await repos.users.findById(userId))?.id, userId);
      assert.equal(
        (await repos.conversations.findByExternalId("TELEGRAM", `chat-${userId}`))?.id,
        conversation.id,
      );

      const first = await repos.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "USER",
        content: "Send $20",
        externalMessageId: "m-1",
        structuredData: { n: 1 },
      });
      const duplicate = await repos.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "USER",
        content: "Send $20",
        externalMessageId: "m-1",
      });
      assert.equal(first.created, true);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.message.id, first.message.id);

      await repos.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "To whom?",
      });
      const recent = await repos.messages.listRecent(conversation.id, 10);
      assert.deepEqual(
        recent.map((m) => m.role),
        ["USER", "ASSISTANT"],
      );
      assert.deepEqual(recent[0]?.structuredData, { n: 1 });
      assert.equal(
        (await repos.conversations.updateStatus(conversation.id, "ARCHIVED")).status,
        "ARCHIVED",
      );
    });
  });

  it("round-trips an incomplete intent, then completes it with canonical money", async () => {
    await rolledBack(async (repos) => {
      const { usd, ngn } = await seeded(repos);
      const { userId, conversation } = await newConversation(repos);
      const parsed: AgentIntent = {
        type: "SEND",
        amount: { value: "20.50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      };

      const draft = await repos.intents.create({
        id: createId(),
        userId,
        conversationId: conversation.id,
        type: "SEND",
        status: "AWAITING_DETAILS",
        parsed,
        missingFields: ["RECIPIENT"],
        revision: 1,
      });
      assert.deepEqual(draft.parsed, parsed);
      assert.equal(draft.amount, undefined, "human amount is not canonical money");
      assert.deepEqual(draft.missingFields, ["RECIPIENT"]);
      assert.equal((await repos.intents.findOpenByConversation(conversation.id))?.id, draft.id);

      const recipient = await repos.recipients.create({
        id: createId(),
        ownerUserId: userId,
        type: "USERNAME",
        identifier: "maria",
        displayName: "Maria",
        destinationCountry: "NG",
        preferredAssetId: ngn.id,
        isSaved: true,
        metadata: { note: "friend" },
      });

      const resolved = await repos.intents.update(draft.id, {
        status: "RESOLVED",
        sourceAssetId: usd.id,
        destinationAssetId: ngn.id,
        recipientId: recipient.id,
        destinationCountry: "NG",
        amount: { money: createMoney("2050", usd.id), mode: "EXACT_INPUT" },
        constraints: { maxSlippageBps: 100 },
        missingFields: [],
      });
      assert.deepEqual(resolved.amount, {
        money: createMoney("2050", usd.id),
        mode: "EXACT_INPUT",
      });
      assert.equal(resolved.recipientId, recipient.id);
      assert.deepEqual(resolved.parsed, parsed, "update keeps untouched fields");
      assert.deepEqual(resolved.constraints, { maxSlippageBps: 100 });
      assert.deepEqual(await repos.intents.findById(draft.id), resolved);

      assert.deepEqual(
        (await repos.recipients.listSavedByOwner(userId)).map((r) => r.id),
        [recipient.id],
      );
      assert.deepEqual((await repos.recipients.findById(recipient.id))?.metadata, {
        note: "friend",
      });

      await assert.rejects(
        repos.intents.update(draft.id, {
          amount: { money: createMoney("1", ngn.id), mode: "EXACT_INPUT" },
        }),
        (e) => isKaadaError(e, "ASSET_MISMATCH"),
      );
    });
  });

  it("round-trips quotes, routes with ordered steps, and idempotent executions", async () => {
    await rolledBack(async (repos) => {
      const { usd, ngn, textile } = await seeded(repos);
      const { userId, conversation } = await newConversation(repos);
      const intent = await repos.intents.create({
        id: createId(),
        userId,
        conversationId: conversation.id,
        type: "SEND",
        status: "QUOTING",
        missingFields: [],
        revision: 1,
      });

      const quote = await repos.quotes.create({
        id: createId(),
        intentId: intent.id,
        intentRevision: 1,
        providerId: textile.id,
        input: createMoney("2000", usd.id),
        output: createMoney("3000000", ngn.id),
        fee: createMoney("15", usd.id),
        slippageBps: 25,
        providerQuoteId: "q-1",
        expiresAt: new Date(Date.now() + 60_000),
        rawProviderData: { rate: "1500" },
      });
      assert.deepEqual(await repos.quotes.findById(quote.id), quote);
      assert.deepEqual(
        (await repos.quotes.listByIntent(intent.id)).map((q) => q.id),
        [quote.id],
      );

      const routeId = createId();
      const step = (
        position: number,
        input: ReturnType<typeof createMoney>,
        output: ReturnType<typeof createMoney>,
      ) => ({
        id: createId(),
        routeId,
        position,
        type: "SWAP" as const,
        input,
        output,
      });
      const route = await repos.routes.createWithSteps({
        id: routeId,
        intentId: intent.id,
        intentRevision: 1,
        status: "VALID",
        input: createMoney("2000", usd.id),
        output: createMoney("3000000", ngn.id),
        totalFee: createMoney("15", usd.id),
        steps: [
          {
            ...step(1, createMoney("1985", usd.id), createMoney("3000000", ngn.id)),
            providerId: textile.id,
            quoteId: quote.id,
          },
          {
            ...step(0, createMoney("2000", usd.id), createMoney("1985", usd.id)),
            type: "TRANSFER" as const,
          },
        ],
      });
      assert.deepEqual(
        route.steps.map((s) => s.position),
        [0, 1],
      );
      assert.deepEqual(await repos.routes.findById(routeId), route);
      assert.equal((await repos.routes.updateStatus(routeId, "SELECTED")).status, "SELECTED");
      assert.deepEqual(
        (await repos.routes.listByIntent(intent.id)).map((r) => r.id),
        [routeId],
      );
      assert.equal(await repos.routes.invalidateOlderThan(intent.id, 1), 0, "same revision stays");
      assert.equal(
        await repos.routes.invalidateOlderThan(intent.id, 2),
        1,
        "older revision retired",
      );
      assert.equal((await repos.routes.findById(routeId))?.status, "INVALID");
      assert.equal(await repos.routes.invalidateOlderThan(intent.id, 2), 0, "already retired");
      assert.equal((await repos.quotes.findById(quote.id))?.intentRevision, 1, "quotes are kept");

      await assert.rejects(
        repos.routes.createWithSteps({
          id: createId(),
          intentId: intent.id,
          intentRevision: 1,
          status: "CREATED",
          input: createMoney("1", usd.id),
          output: createMoney("1", ngn.id),
          steps: [],
        }),
        (e) => isKaadaError(e, "NO_ROUTE_AVAILABLE"),
      );

      const key = `idem-${createId()}`;
      const base = {
        intentId: intent.id,
        routeId,
        userId,
        status: "CREATED" as const,
        idempotencyKey: key,
      };
      const first = await repos.executions.create({ id: createId(), ...base });
      const replay = await repos.executions.create({ id: createId(), ...base });
      assert.equal(first.created, true);
      assert.equal(replay.created, false);
      assert.equal(replay.execution.id, first.execution.id);

      const confirmedAt = new Date();
      const updated = await repos.executions.update(first.execution.id, {
        status: "CONFIRMED",
        confirmedAt,
      });
      assert.equal(updated.status, "CONFIRMED");
      assert.equal(updated.confirmedAt?.getTime(), confirmedAt.getTime());
      assert.deepEqual(await repos.executions.findByIdempotencyKey(key), updated);
    });
  });

  it("supports the operations the agent core needs", async () => {
    await rolledBack(async (repos) => {
      const { usd } = await seeded(repos);
      const { userId, conversation } = await newConversation(repos);

      // Get-or-create returns the existing conversation instead of failing on the unique key.
      const again = await repos.conversations.getOrCreateByExternalId({
        id: createId(),
        userId,
        channel: "TELEGRAM",
        status: "ACTIVE",
        externalConversationId: `chat-${userId}`,
      });
      assert.equal(again.id, conversation.id);
      const fresh = await repos.conversations.getOrCreateByExternalId({
        id: createId(),
        userId,
        channel: "TELEGRAM",
        status: "ACTIVE",
        externalConversationId: `other-${userId}`,
      });
      assert.notEqual(fresh.id, conversation.id);
      await repos.conversations.lockForUpdate(conversation.id);

      // A reply is found by the message it answers.
      const inbound = await repos.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "USER",
        content: "hi",
        externalMessageId: "in-1",
      });
      assert.equal(await repos.messages.findReply(conversation.id, inbound.message.id), null);
      const reply = await repos.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "hello",
        metadata: { inReplyTo: inbound.message.id },
      });
      assert.equal(
        (await repos.messages.findReply(conversation.id, inbound.message.id))?.id,
        reply.message.id,
      );

      // save() overwrites, including clearing values that are no longer set.
      const recipient = await repos.recipients.create({
        id: createId(),
        ownerUserId: userId,
        type: "WALLET_ADDRESS",
        identifier: "0xabc",
        walletAddress: "0xabc",
        isSaved: false,
      });
      assert.equal(
        (await repos.recipients.findByIdentifier(userId, "WALLET_ADDRESS", "0xabc"))?.id,
        recipient.id,
      );
      assert.equal(await repos.recipients.findByIdentifier(userId, "USERNAME", "0xabc"), null);
      assert.deepEqual(
        await repos.recipients.listSavedByOwner(userId),
        [],
        "unsaved recipients are not listed",
      );

      const intent = await repos.intents.create({
        id: createId(),
        userId,
        conversationId: conversation.id,
        type: "SEND",
        status: "RESOLVED",
        amount: { money: createMoney("2000", usd.id), mode: "EXACT_INPUT" },
        sourceAssetId: usd.id,
        recipientId: recipient.id,
        constraints: { maxSlippageBps: 10 },
        parsed: { type: "SEND" },
        missingFields: [],
        revision: 1,
      });
      const cleared = await repos.intents.save({
        ...intent,
        status: "AWAITING_DETAILS",
        missingFields: ["RECIPIENT"],
      });
      assert.equal(cleared.status, "AWAITING_DETAILS");
      const { amount: _a, sourceAssetId: _s, recipientId: _r, constraints: _c, ...rest } = intent;
      const wiped = await repos.intents.save({ ...rest, status: "CANCELLED", missingFields: [] });
      assert.equal(wiped.amount, undefined);
      assert.equal(wiped.sourceAssetId, undefined);
      assert.equal(wiped.recipientId, undefined);
      assert.equal(wiped.constraints, undefined);
      assert.equal(wiped.status, "CANCELLED");
      assert.equal(await repos.intents.findOpenByConversation(conversation.id), null);

      // Users and identities by name.
      const created = await repos.users.create({
        id: createId(),
        username: `solo-${userId.slice(0, 8)}`,
      });
      assert.equal((await repos.users.findByUsername(created.username ?? ""))?.id, created.id);
      await repos.identities.add({
        id: createId(),
        userId: created.id,
        type: "TELEGRAM",
        externalId: `tg2-${userId}`,
        username: "MixedCase",
      });
      const found = await repos.identities.findByUsername("TELEGRAM", "mixedcase");
      assert.equal(found.length, 1, "channel usernames are matched case-insensitively");
      assert.equal(found[0]?.userId, created.id);
      assert.deepEqual(await repos.identities.findByUsername("EMAIL", "mixedcase"), []);
    });
  });

  it("stores clarification options, finds the latest question, and lets one caller use an option", async () => {
    await rolledBack(async (repos) => {
      const { usd, ngn } = await seeded(repos);
      const { userId, conversation } = await newConversation(repos);
      const intent = await repos.intents.create({
        id: createId(),
        userId,
        conversationId: conversation.id,
        type: "SEND",
        status: "AWAITING_DETAILS",
        missingFields: ["RECIPIENT"],
        preferredSourceAssetId: ngn.id,
        revision: 1,
      });
      assert.equal(intent.preferredSourceAssetId, ngn.id);
      assert.equal(intent.revision, 1);
      const saved = await repos.intents.save({ ...intent, revision: 2 });
      assert.equal(saved.revision, 2);

      const expiresAt = new Date(Date.now() + 60_000);
      const option = (groupId: string, label: string) => ({
        id: createId(),
        groupId,
        conversationId: conversation.id,
        intentId: intent.id,
        revision: 2,
        field: "SOURCE_ASSET" as const,
        label,
        value: { kind: "ASSET", target: "AMOUNT", assetId: usd.id },
        expiresAt,
      });
      const firstGroup = createId();
      const secondGroup = createId();
      const [a] = await repos.clarifications.issue([
        option(firstGroup, "first A"),
        option(firstGroup, "first B"),
      ]);
      assert.ok(a);
      assert.equal(await repos.clarifications.latestGroupId(intent.id), firstGroup);
      const [b] = await repos.clarifications.issue([option(secondGroup, "second A")]);
      assert.ok(b);
      assert.equal(await repos.clarifications.latestGroupId(intent.id), secondGroup);

      const found = await repos.clarifications.findById(a.id);
      assert.equal(found?.label, "first A");
      assert.equal(found?.usedAt, undefined);
      assert.deepEqual(found?.value, { kind: "ASSET", target: "AMOUNT", assetId: usd.id });

      assert.equal(await repos.clarifications.markUsed(a.id, new Date()), true);
      assert.equal(await repos.clarifications.markUsed(a.id, new Date()), false, "single use");
      assert.ok((await repos.clarifications.findById(a.id))?.usedAt);
      assert.equal(await repos.clarifications.findById(createId()), null);
    });
  });

  it("commits nothing: a rolled-back run leaves no rows behind", async () => {
    let userId = "";
    await rolledBack(async (repos) => {
      ({ userId } = await newConversation(repos));
    });
    const outside = createRepositoriesOutside();
    assert.equal(await outside.users.findById(userId), null);
  });

  function createRepositoriesOutside() {
    return {
      users: {
        findById: (id: string) => database.client.user.findUnique({ where: { id } }),
      },
    };
  }
});
