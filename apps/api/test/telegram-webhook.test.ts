import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createId } from "@kaada/domain";

import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { TelegramAdapter } from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import { TelegramWebhookController } from "../src/channels/telegram-webhook.controller.js";
import { createMemoryChannelStores } from "./support/channels-memory.js";
import { SENDER, createHarness, intent } from "./support/harness.js";

const SECRET = "a-long-enough-webhook-secret_123";
const headers = { "x-telegram-bot-api-secret-token": SECRET };

/** The whole path with a real Telegram adapter over a fake Bot API: webhook JSON in, Bot API calls out. */
function build() {
  const h = createHarness();
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  h.world.addRecipient({
    id: randomUUID(),
    ownerUserId: SENDER,
    type: "SAVED_BENEFICIARY",
    displayName: "Daniel",
    identifier: "daniel",
    destinationCountry: "BR",
  });
  const api: { method: string; body: Record<string, unknown> }[] = [];
  let messageId = 1000;
  const adapter = new TelegramAdapter({
    botToken: "1:TOKEN",
    webhookSecret: SECRET,
    fetch: ((url: string, init: { body: string }) => {
      api.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } })),
      );
    }) as unknown as typeof fetch,
  });
  const stores = createMemoryChannelStores();
  const service = new ChannelMessageService({
    adapters: new Map([["TELEGRAM", adapter]]),
    identities: new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: h.world.repositories.identities,
    }),
    actions: new ChannelActionService(stores.channelActions),
    inboundEvents: stores.inboundEvents,
    statuses: stores.channelPaymentStatuses,
    agent: h.agent,
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/TOKEN"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/TOKEN"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
  });
  return { h, api, controller: new TelegramWebhookController(adapter, service), stores };
}

let updateId = 5000;
const text = (value: string, id = ++updateId) => ({
  update_id: id,
  message: {
    message_id: id + 1,
    date: 1_790_000_000,
    from: { id: 424242, is_bot: false, first_name: "Ada", username: "ada" },
    chat: { id: 424242, type: "private" },
    text: value,
  },
});

describe("the Telegram webhook", () => {
  it("rejects a request without the right secret, before looking at the body", async () => {
    const { controller, api, h } = build();
    for (const bad of [
      {},
      { "x-telegram-bot-api-secret-token": "nope" },
      { "x-telegram-bot-api-secret-token": "" },
    ]) {
      await assert.rejects(controller.webhook(text("send $20"), bad), UnauthorizedException);
    }
    assert.equal(api.length, 0);
    assert.equal(h.interpreterCalls, 0);
  });

  it("is not enabled until the bot is configured", async () => {
    const controller = new TelegramWebhookController(null, null);
    await assert.rejects(controller.webhook(text("hi"), headers), NotFoundException);
  });

  it("acknowledges and ignores malformed or unsupported updates without doing anything", async () => {
    const { controller, api } = build();
    for (const junk of [
      null,
      "x",
      12,
      [],
      {},
      { update_id: "x" },
      { update_id: 1 },
      { update_id: 2, edited_message: {} },
    ]) {
      assert.deepEqual(await controller.webhook(junk, headers), { ok: true });
    }
    assert.equal(api.length, 0);
  });

  it("/start then a request: the answer comes back as Telegram API calls", async () => {
    const { controller, api, h } = build();
    h.script.set(
      "send daniel $20",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "Daniel" },
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    await controller.webhook(text("/start"), headers);
    assert.match(String(api.find((c) => c.method === "sendMessage")?.body["text"]), /Welcome back/);
    await controller.webhook(text("send daniel $20"), headers);
    const sends = api.filter((c) => c.method === "sendMessage");
    assert.equal(sends.length, 2);
    assert.equal(sends[1]?.body["chat_id"], "424242");
  });

  it("the same update delivered again is acknowledged and not processed again", async () => {
    const { controller, api, h } = build();
    h.script.set(
      "send daniel $20",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "Daniel" },
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    const update = text("send daniel $20", 777);
    const outcomes = await Promise.allSettled([
      controller.webhook(update, headers),
      controller.webhook(update, headers),
    ]);
    assert.ok(outcomes.some((o) => o.status === "fulfilled"));
    await controller.webhook(update, headers);
    assert.equal(h.interpreterCalls, 1);
    assert.equal(api.filter((c) => c.method === "sendMessage").length, 1);
  });

  it("answers 503 (so Telegram retries) when handling fails, and the retry then succeeds", async () => {
    const { controller, api, h } = build();
    const original = h.agent.handle.bind(h.agent);
    let fail = true;
    h.agent.handle = (input: Parameters<typeof original>[0]) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("boom"));
      }
      return original(input);
    };
    h.script.set(
      "send daniel",
      intent({ type: "SEND", recipient: { type: "SAVED_BENEFICIARY", value: "Daniel" } }),
    );
    const update = text("send daniel", 888);
    await assert.rejects(controller.webhook(update, headers), ServiceUnavailableException);
    assert.deepEqual(await controller.webhook(update, headers), { ok: true });
    assert.equal(api.filter((c) => c.method === "sendMessage").length, 1);
  });

  it("an inline-button press arrives as callback_data, is acknowledged, and resolves without the interpreter", async () => {
    const { controller, api, h } = build();
    for (const [name, handle] of [
      ["Okafor", "daniel_o"],
      ["Silva", "daniel_s"],
    ] as const) {
      h.world.addRecipient({
        id: randomUUID(),
        ownerUserId: SENDER,
        type: "SAVED_BENEFICIARY",
        displayName: `Daniel ${name}`,
        identifier: handle,
        destinationCountry: "BR",
      });
    }
    h.script.set(
      "send $20 to daniel",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "Daniel" },
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    // Three Daniels now (the seeded one and two more) so the question is asked.
    await controller.webhook(text("send $20 to daniel"), headers);
    const keyboard = (
      api.filter((c) => c.method === "sendMessage").at(-1)?.body["reply_markup"] as {
        inline_keyboard: { text: string; callback_data?: string }[][];
      }
    ).inline_keyboard;
    const choice = keyboard.flat().find((b) => b.callback_data && /Okafor/.test(b.text));
    assert.ok(choice?.callback_data?.startsWith("kaada:a:"));
    assert.ok(Buffer.byteLength(choice?.callback_data ?? "") <= 64);

    const calls = h.interpreterCalls;
    const press = {
      update_id: ++updateId,
      callback_query: {
        id: "cbq-1",
        from: { id: 424242, is_bot: false, first_name: "Ada" },
        message: { message_id: 3, chat: { id: 424242, type: "private" } },
        data: choice?.callback_data,
      },
    };
    await controller.webhook(press, headers);
    assert.equal(h.interpreterCalls, calls);
    assert.ok(
      api.some(
        (c) => c.method === "answerCallbackQuery" && c.body["callback_query_id"] === "cbq-1",
      ),
    );

    // A button carrying someone else's data (or garbage) is dropped as "not ours".
    await controller.webhook(
      {
        ...press,
        update_id: ++updateId,
        callback_query: { ...press.callback_query, data: "other:thing" },
      },
      headers,
    );
  });
});
