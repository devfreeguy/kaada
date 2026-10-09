/*
 * Agent core against the real database, using real committed transactions so that the conversation
 * row lock is genuinely exercised. Skipped without DATABASE_URL; requires the migrations and seed.
 *
 * Every row these tests create belongs to uniquely named test users and is deleted afterwards.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import "reflect-metadata";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import { createId, createMoney } from "@kaada/domain";
import type { Interpretation } from "@kaada/domain";

import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/app.setup.js";
import { AgentService } from "../../src/core/agent/agent-service.js";
import { MockIntentInterpreter } from "../../src/core/agent/mock-interpreter.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

const intent = (value: Extract<Interpretation, { kind: "INTENT" }>["intent"]): Interpretation => ({
  kind: "INTENT",
  intent: value,
});

describe("agent core on the real database", { skip }, () => {
  let database: Database;
  let repositories: Repositories;
  const createdUsers: string[] = [];
  const run = createId().slice(0, 8);

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 20_000 });
    repositories = createRepositories(database);
  });

  after(async () => {
    const where = { in: createdUsers };
    await database.client.intent.deleteMany({ where: { userId: where } });
    await database.client.recipient.deleteMany({ where: { ownerUserId: where } });
    await database.client.conversation.deleteMany({ where: { userId: where } });
    await database.client.user.deleteMany({ where: { id: where } });
    await database.close();
  });

  async function newUser(label: string) {
    const user = await repositories.users.create({
      id: createId(),
      username: `${label}-${run}-${createId().slice(0, 4)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  function newAgent(script: Record<string, Interpretation>, delays: Record<string, number> = {}) {
    const interpreter = new MockIntentInterpreter(async (input) => {
      const wait = delays[input.message] ?? 0;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return script[input.message] ?? intent({ type: "UNKNOWN" });
    });
    const agent = new AgentService({
      interpreter,
      unitOfWork: {
        read: repositories,
        transaction: (work) => withTransaction(database, work, { timeoutMs: 30_000 }),
      },
    });
    return { agent, interpreter };
  }

  const say = (agent: AgentService, userId: string, chat: string, content: string, ext?: string) =>
    agent.handleMessage({
      userId,
      channel: "TELEGRAM",
      externalConversationId: chat,
      content,
      ...(ext && { externalMessageId: ext }),
    });

  async function usdAssetId(): Promise<string> {
    const [usd] = await repositories.assets.findByFiatCode("USD");
    assert.ok(usd, "run `pnpm db:seed` first");
    return usd.id;
  }

  it("carries a multi-turn SEND through Postgres and back as domain state", async () => {
    const sender = await newUser("sender");
    const daniel = await newUser("daniel");
    const usd = await usdAssetId();
    const { agent, interpreter } = newAgent({
      "send $20": intent({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
      "to daniel": intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: daniel.username ?? "" },
      }),
      "make it $40": intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    });
    const chat = `chat-${run}-a`;

    const first = await say(agent, sender.id, chat, "send $20");
    assert.equal(first.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(first.response.text, "Who would you like to send it to?");

    const second = await say(agent, sender.id, chat, "to daniel");
    assert.equal(second.intentId, first.intentId);
    assert.equal(second.response.type, "ROUTING_REQUIRED");

    const third = await say(agent, sender.id, chat, "make it $40");
    assert.equal(third.intentId, first.intentId);

    const stored = await repositories.intents.findById(first.intentId ?? "");
    assert.equal(stored?.status, "RESOLVED");
    assert.deepEqual(stored?.amount, { money: createMoney("4000", usd), mode: "EXACT_INPUT" });
    assert.equal(stored?.sourceAssetId, usd);
    assert.deepEqual(stored?.missingFields, []);
    assert.deepEqual(stored?.parsed?.type === "SEND" && stored.parsed.amount, {
      value: "40",
      currencyOrAsset: "USD",
      mode: "EXACT_INPUT",
    });
    const recipient = await repositories.recipients.findById(stored?.recipientId ?? "");
    assert.equal(recipient?.linkedUserId, daniel.id);
    assert.equal(recipient?.isSaved, false);

    const conversation = await repositories.conversations.findById(first.conversationId);
    const history = await repositories.messages.listRecent(first.conversationId, 20);
    assert.equal(conversation?.userId, sender.id);
    assert.deepEqual(
      history.map((m) => m.role),
      ["USER", "ASSISTANT", "USER", "ASSISTANT", "USER", "ASSISTANT"],
    );
    assert.ok(history.every((m) => m.role === "USER" || m.metadata?.["inReplyTo"]));
    assert.equal(interpreter.calls.length, 3);
    assert.deepEqual(
      interpreter.calls[1]?.activeIntent?.type,
      "SEND",
      "the interpreter sees the open intent",
    );
  });

  it("keeps the active intent coherent when two messages arrive at once", async () => {
    for (const slowOne of ["send $20", "to daniel"]) {
      const sender = await newUser("sender");
      const daniel = await newUser("daniel");
      const { agent } = newAgent(
        {
          "send $20": intent({
            type: "SEND",
            amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
          }),
          "to daniel": intent({
            type: "SEND",
            recipient: { type: "USERNAME", value: daniel.username ?? "" },
          }),
        },
        { [slowOne]: 150 },
      );
      const chat = `chat-${run}-race-${slowOne}`;

      await Promise.all([
        say(agent, sender.id, chat, "send $20"),
        say(agent, sender.id, chat, "to daniel"),
      ]);

      const conversation = await repositories.conversations.findByExternalId("TELEGRAM", chat);
      const open = await repositories.intents.findOpenByConversation(conversation?.id ?? "");
      assert.equal(open?.status, "RESOLVED", `both details merged (slow: ${slowOne})`);
      assert.equal(open?.amount?.money.amount, "2000");
      assert.ok(open?.recipientId);
      const count = await database.client.intent.count({
        where: { conversationId: conversation?.id ?? "" },
      });
      assert.equal(count, 1, "no duplicate or orphan intents");
    }
  });

  it("creates one conversation even when the first messages of a chat race", async () => {
    const sender = await newUser("sender");
    const { agent } = newAgent({}, { a: 50, b: 50 });
    const chat = `chat-${run}-first`;
    const turns = await Promise.all([
      say(agent, sender.id, chat, "a"),
      say(agent, sender.id, chat, "b"),
    ]);
    assert.equal(turns[0].conversationId, turns[1].conversationId);
    const count = await database.client.conversation.count({ where: { userId: sender.id } });
    assert.equal(count, 1);
  });

  it("does not duplicate state when the same message is delivered twice at once or later", async () => {
    const sender = await newUser("sender");
    const { agent, interpreter } = newAgent(
      { "send $20": intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }) },
      { "send $20": 100 },
    );
    const chat = `chat-${run}-dup`;

    const [a, b] = await Promise.all([
      say(agent, sender.id, chat, "send $20", "tg-1"),
      say(agent, sender.id, chat, "send $20", "tg-1"),
    ]);
    const later = await say(agent, sender.id, chat, "send $20", "tg-1");

    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
    assert.equal(later.duplicate, true);
    assert.deepEqual(later.response, a.response);
    const conversationId = a.conversationId;
    const messages = await database.client.message.findMany({ where: { conversationId } });
    assert.equal(messages.filter((m) => m.role === "USER").length, 1);
    assert.equal(messages.filter((m) => m.role === "ASSISTANT").length, 1);
    assert.equal(await database.client.intent.count({ where: { conversationId } }), 1);
    assert.ok(interpreter.calls.length <= 2, "at most one wasted interpretation from the race");
  });

  it("retires the open operation when the user switches and keeps cancelled history", async () => {
    const sender = await newUser("sender");
    const { agent } = newAgent({
      "send $20": intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
      convert: intent({
        type: "CONVERT",
        amount: { value: "10", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        fromAsset: "USD",
        toAsset: "NGN",
      }),
      cancel: { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" },
    });
    const chat = `chat-${run}-switch`;
    const first = await say(agent, sender.id, chat, "send $20");
    const second = await say(agent, sender.id, chat, "convert");
    assert.equal(second.supersededIntentId, first.intentId);
    assert.equal(second.response.type, "ROUTING_REQUIRED");
    const cancelled = await say(agent, sender.id, chat, "cancel");
    assert.equal(cancelled.response.type, "CANCELLED");

    const statuses = await database.client.intent.findMany({
      where: { conversationId: first.conversationId },
      orderBy: { createdAt: "asc" },
      select: { type: true, status: true },
    });
    assert.deepEqual(statuses, [
      { type: "SEND", status: "CANCELLED" },
      { type: "CONVERT", status: "CANCELLED" },
    ]);
    assert.equal(await repositories.intents.findOpenByConversation(first.conversationId), null);
  });

  describe("development HTTP endpoint", () => {
    let app: NestFastifyApplication;

    before(async () => {
      process.env["AGENT_INTERPRETER"] = "mock";
      app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
        logger: false,
      });
      const { loadConfig } = await import("@kaada/config");
      configureApp(app, loadConfig());
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    after(async () => {
      await app.close();
    });

    const post = async (payload: object) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/agent/messages", payload });
      return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
    };

    it("runs the dev fixtures end to end and persists the conversation", async () => {
      const first = await post({ content: "Send $20" });
      assert.equal(first.status, 200);
      const userId = String(first.body["userId"]);
      createdUsers.push(userId);
      assert.deepEqual(
        (first.body["response"] as { type: string; field: string }).field,
        "RECIPIENT",
      );

      const second = await post({
        content: "send $20",
        userId,
        conversationId: first.body["conversationId"],
      });
      assert.equal(second.status, 200);
      assert.equal(second.body["conversationId"], first.body["conversationId"]);

      const cancel = await post({
        content: "cancel that",
        userId,
        conversationId: first.body["conversationId"],
      });
      assert.equal((cancel.body["response"] as { type: string }).type, "CANCELLED");

      const stored = await repositories.conversations.findById(
        String(first.body["conversationId"]),
      );
      assert.equal(stored?.userId, userId);
    });

    it("rejects a body that tries to smuggle in an interpretation", async () => {
      const result = await post({ content: "Send $20", intent: { type: "SEND" } });
      assert.equal(result.status, 400);
    });

    it("keeps the liveness and readiness endpoints working", async () => {
      const live = await app.inject({ method: "GET", url: "/api/health" });
      const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
      assert.equal(live.statusCode, 200);
      assert.equal(ready.statusCode, 200);
    });
  });
});
