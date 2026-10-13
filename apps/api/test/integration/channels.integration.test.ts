/*
 * Chat channels on the REAL database: single-use buttons under real concurrency, webhook claim idempotency, the status
 * compare-and-set, one Kaada user per Telegram account, and the CHECK constraints. Every row belongs to uniquely named test
 * users and is deleted afterwards. Skipped without DATABASE_URL. Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createDatabase, createRepositories } from "@kaada/database";
import type { Database } from "@kaada/database";
import { createId } from "@kaada/domain";

import { ChannelActionService } from "../../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../../src/core/channels/identity-service.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

describe("chat channels on the real database", { skip }, () => {
  let database: Database;
  const users: string[] = [];
  const externalIds: string[] = [];
  const eventIds: string[] = [];

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
  });

  after(async () => {
    const client = database.client;
    await client.channelAction.deleteMany({ where: { userId: { in: users } } });
    await client.channelPaymentStatus.deleteMany({ where: { userId: { in: users } } });
    await client.channelInboundEvent.deleteMany({ where: { externalEventId: { in: eventIds } } });
    await client.identity.deleteMany({ where: { externalId: { in: externalIds } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await database.close();
  });

  const repositories = () => createRepositories(database);
  async function newUser(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await repositories().users.create({ id });
    return id;
  }
  const uniqueId = (prefix: string) => {
    const id = `${prefix}-${randomBytes(6).toString("hex")}`;
    eventIds.push(id);
    return id;
  };

  describe("buttons", () => {
    it("are claimed by exactly one of many concurrent presses", async () => {
      const userId = await newUser();
      const service = new ChannelActionService(repositories().channelActions);
      const handle = await service.issue({
        userId,
        channel: "TELEGRAM",
        externalUserId: "tg-1",
        conversationId: randomUUID(),
        kind: "SELECT_OPTION",
        payload: { optionId: "opt" },
      });
      assert.match(handle, /^[A-Za-z0-9_-]{22}$/);
      const claims = await Promise.all(
        Array.from({ length: 12 }, () =>
          service.claim({ handle, channel: "TELEGRAM", externalUserId: "tg-1" }),
        ),
      );
      assert.equal(claims.filter((c) => c.ok).length, 1);
      assert.ok(claims.filter((c) => !c.ok).every((c) => !c.ok && c.reason === "USED"));
    });

    it("belong to the account they were shown to, and expire", async () => {
      const userId = await newUser();
      const service = new ChannelActionService(repositories().channelActions);
      const issue = (ttlMs?: number) =>
        service.issue({
          userId,
          channel: "TELEGRAM",
          externalUserId: "tg-2",
          conversationId: randomUUID(),
          kind: "CANCEL",
          ...(ttlMs && { ttlMs }),
        });
      const handle = await issue();
      const stranger = await service.claim({
        handle,
        channel: "TELEGRAM",
        externalUserId: "tg-OTHER",
      });
      assert.deepEqual(stranger, { ok: false, reason: "WRONG_USER" });
      assert.equal(
        (await service.claim({ handle, channel: "WHATSAPP", externalUserId: "tg-2" })).ok,
        false,
      );
      assert.equal(
        (await service.claim({ handle, channel: "TELEGRAM", externalUserId: "tg-2" })).ok,
        true,
        "the rightful account still can",
      );

      const short = await issue(60);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(
        await service.claim({ handle: short, channel: "TELEGRAM", externalUserId: "tg-2" }),
        {
          ok: false,
          reason: "EXPIRED",
        },
      );
    });

    it("a reusable button can be pressed again, and the database refuses a malformed handle", async () => {
      const userId = await newUser();
      const repo = repositories().channelActions;
      const handle = randomBytes(16).toString("base64url");
      await repo.create(
        {
          id: createId(),
          handle,
          userId,
          channel: "TELEGRAM",
          externalUserId: "tg-3",
          conversationId: randomUUID(),
          kind: "VIEW_STATUS",
          payload: { sessionId: "s" },
          reusable: true,
          expiresAt: new Date(Date.now() + 60_000),
        },
        new Date(),
      );
      for (let i = 0; i < 3; i += 1) {
        assert.equal(
          (
            await repo.consume({
              handle,
              channel: "TELEGRAM",
              externalUserId: "tg-3",
              now: new Date(),
            })
          ).ok,
          true,
        );
      }
      await assert.rejects(
        repo.create(
          {
            id: createId(),
            handle: "short",
            userId,
            channel: "TELEGRAM",
            externalUserId: "tg-3",
            conversationId: randomUUID(),
            kind: "CANCEL",
            payload: {},
            reusable: false,
            expiresAt: new Date(Date.now() + 60_000),
          },
          new Date(),
        ),
        Error,
      );
    });
  });

  describe("webhook events", () => {
    it("hand a delivery to exactly one of many concurrent workers, then report it as a duplicate", async () => {
      const repo = repositories().channelInboundEvents;
      const eventId = uniqueId("evt");
      const claim = () =>
        repo.claim({
          id: createId(),
          channel: "TELEGRAM",
          externalEventId: eventId,
          now: new Date(),
          staleMs: 60_000,
        });
      const results = await Promise.all(Array.from({ length: 10 }, claim));
      assert.equal(results.filter((r) => r === "NEW").length, 1);
      assert.ok(results.filter((r) => r !== "NEW").every((r) => r === "IN_PROGRESS"));
      await repo.markProcessed("TELEGRAM", eventId, new Date());
      assert.equal(await claim(), "DUPLICATE");
    });

    it("let a retry take over a worker that died, but only one retry", async () => {
      const repo = repositories().channelInboundEvents;
      const eventId = uniqueId("stale");
      const long = new Date(Date.now() - 10 * 60_000);
      assert.equal(
        await repo.claim({
          id: createId(),
          channel: "TELEGRAM",
          externalEventId: eventId,
          now: long,
          staleMs: 60_000,
        }),
        "NEW",
      );
      const retry = () =>
        repo.claim({
          id: createId(),
          channel: "TELEGRAM",
          externalEventId: eventId,
          now: new Date(),
          staleMs: 60_000,
        });
      const results = await Promise.all([retry(), retry(), retry()]);
      assert.equal(results.filter((r) => r === "RECLAIMED").length, 1);
    });

    it("forget a failed claim so the provider's retry is handled as new", async () => {
      const repo = repositories().channelInboundEvents;
      const eventId = uniqueId("fail");
      const claim = () =>
        repo.claim({
          id: createId(),
          channel: "TELEGRAM",
          externalEventId: eventId,
          now: new Date(),
          staleMs: 60_000,
        });
      assert.equal(await claim(), "NEW");
      await repo.release("TELEGRAM", eventId);
      assert.equal(await claim(), "NEW");
    });
  });

  describe("payment status messages", () => {
    it("announce a change once however many instances notice it, and can be reverted after a failed send", async () => {
      const userId = await newUser();
      const repo = repositories().channelPaymentStatuses;
      const status = await repo.create({
        id: createId(),
        userId,
        channel: "TELEGRAM",
        externalConversationId: "chat-1",
        authorizationSessionId: randomUUID(),
        externalSummaryMessageId: "10",
        lastState: "AWAITING_AUTHORIZATION",
        terminal: false,
      });
      const again = await repo.create({ ...status, id: createId() });
      assert.equal(again.id, status.id, "one record per authorization session");

      const moves = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.transition({ id: status.id, from: "AWAITING_AUTHORIZATION", to: "PROCESSING" }),
        ),
      );
      assert.equal(moves.filter(Boolean).length, 1);
      await repo.revert({ id: status.id, from: "AWAITING_AUTHORIZATION", to: "PROCESSING" });
      assert.equal(
        (await repo.findBySession(status.authorizationSessionId))?.lastState,
        "AWAITING_AUTHORIZATION",
      );

      await repo.attachStatusMessage(status.id, "11");
      const done = await repo.transition({
        id: status.id,
        from: "AWAITING_AUTHORIZATION",
        to: "COMPLETED",
        terminal: true,
      });
      assert.equal(done?.terminal, true);
      assert.equal(done?.externalStatusMessageId, "11");
      assert.equal(
        await repo.transition({ id: status.id, from: "COMPLETED", to: "PROCESSING" }),
        null,
        "a finished payment never moves again",
      );
      assert.ok(!(await repo.listActive(500)).some((row) => row.id === status.id));
    });
  });

  describe("identities", () => {
    it("two simultaneous first messages from one Telegram account make exactly one Kaada user", async () => {
      const repos = repositories();
      const service = new ChannelIdentityService({
        users: repos.users,
        identities: repos.identities,
      });
      const externalUserId = String(900_000_000 + Math.floor(Math.random() * 1_000_000));
      externalIds.push(externalUserId);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.resolve({
            channel: "TELEGRAM",
            externalUserId,
            username: "racer",
            displayName: "Racer",
          }),
        ),
      );
      for (const result of results) users.push(result.userId);
      assert.equal(new Set(results.map((r) => r.userId)).size, 1);
      assert.equal(results.filter((r) => r.created).length, 1);
    });

    it("a changed username updates metadata on the same identity and creates no one", async () => {
      const repos = repositories();
      const service = new ChannelIdentityService({
        users: repos.users,
        identities: repos.identities,
      });
      const externalUserId = String(910_000_000 + Math.floor(Math.random() * 1_000_000));
      externalIds.push(externalUserId);
      const first = await service.resolve({
        channel: "TELEGRAM",
        externalUserId,
        username: "before",
        displayName: "A",
      });
      users.push(first.userId);
      const second = await service.resolve({
        channel: "TELEGRAM",
        externalUserId,
        username: "after",
        displayName: "A B",
      });
      assert.equal(second.userId, first.userId);
      assert.equal(second.created, false);
      const identity = await repos.identities.findByExternalId("TELEGRAM", externalUserId);
      assert.equal(identity?.username, "after");
      assert.equal(identity?.metadata?.["displayName"], "A B");
    });
  });
});
