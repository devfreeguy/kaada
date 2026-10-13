import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CALLBACK_PREFIX,
  TelegramAdapter,
  TelegramApiError,
} from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import { NotificationService, adapterDelivery } from "../src/core/channels/notification-service.js";
import { FakeAdapter } from "./support/channels-memory.js";

const TOKEN = "123456:SECRET-BOT-TOKEN";
const SECRET = "webhook-secret_ABC-123";
const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function build(
  respond: (call: Call) => Response = () => json({ ok: true, result: { message_id: 77 } }),
) {
  const calls: Call[] = [];
  const adapter = new TelegramAdapter({
    botToken: TOKEN,
    webhookSecret: SECRET,
    fetch: ((url: string, init: { body: string }) => {
      const call = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      calls.push(call);
      return Promise.resolve(respond(call));
    }) as unknown as typeof fetch,
  });
  return { adapter, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const textUpdate = (over: Record<string, unknown> = {}, from: Record<string, unknown> = {}) => ({
  update_id: 9001,
  message: {
    message_id: 11,
    date: 1_790_000_000,
    from: {
      id: 424242,
      is_bot: false,
      first_name: "Ada",
      last_name: "L",
      username: "ada",
      language_code: "en",
      ...from,
    },
    chat: { id: 424242, type: "private" },
    text: "Send Daniel $20",
    ...over,
  },
});

describe("Telegram webhook verification", () => {
  it("accepts only the exact secret, compared safely", () => {
    const { adapter } = build();
    assert.equal(
      adapter.verifyWebhook({ headers: { "x-telegram-bot-api-secret-token": SECRET } }),
      true,
    );
    for (const bad of [
      undefined,
      "",
      "wrong",
      `${SECRET}x`,
      SECRET.slice(1),
      SECRET.toUpperCase(),
    ]) {
      assert.equal(
        adapter.verifyWebhook({ headers: { "x-telegram-bot-api-secret-token": bad } }),
        false,
        String(bad),
      );
    }
    assert.equal(adapter.verifyWebhook({ headers: {} }), false);
  });
});

describe("Telegram update normalisation", () => {
  const { adapter } = build();

  it("turns a text message into a normalised inbound message keyed by stable ids", () => {
    const message = adapter.parseWebhook(textUpdate());
    assert.deepEqual(
      { ...message, timestamp: undefined },
      {
        channel: "TELEGRAM",
        externalEventId: "9001",
        externalMessageId: "11",
        externalConversationId: "424242",
        sender: {
          channel: "TELEGRAM",
          externalUserId: "424242",
          username: "ada",
          displayName: "Ada L",
          languageCode: "en",
        },
        isPrivate: true,
        content: { kind: "TEXT", text: "Send Daniel $20" },
        timestamp: undefined,
      },
    );
    assert.equal(message?.timestamp.getTime(), 1_790_000_000_000);
  });

  it("identifies by the numeric id: a changed or missing username keeps the same identity", () => {
    const renamed = adapter.parseWebhook(textUpdate({}, { username: "ada_new" }));
    const nameless = adapter.parseWebhook(textUpdate({}, { username: undefined }));
    assert.equal(renamed?.sender.externalUserId, "424242");
    assert.equal(nameless?.sender.externalUserId, "424242");
    assert.equal(nameless?.sender.username, undefined);
  });

  it("recognises syntax-level commands, with a payload or a bot suffix, and leaves other slash text to the agent", () => {
    const command = (text: string) => adapter.parseWebhook(textUpdate({ text }))?.content;
    assert.deepEqual(command("/start"), { kind: "COMMAND", command: "START" });
    assert.deepEqual(command("/start abc123"), { kind: "COMMAND", command: "START" });
    assert.deepEqual(command("/START@kaada_bot"), { kind: "COMMAND", command: "START" });
    assert.deepEqual(command("/help"), { kind: "COMMAND", command: "HELP" });
    assert.deepEqual(command("/cancel"), { kind: "COMMAND", command: "CANCEL" });
    assert.deepEqual(command("/pay now"), { kind: "TEXT", text: "/pay now" });
    assert.deepEqual(command("/started"), { kind: "TEXT", text: "/started" });
  });

  it("normalises a button press to its opaque handle, and rejects anything that is not ours", () => {
    const press = (data: string | undefined) =>
      adapter.parseWebhook({
        update_id: 9002,
        callback_query: {
          id: "cbq-1",
          from: { id: 424242, is_bot: false, first_name: "Ada" },
          message: { message_id: 40, chat: { id: 424242, type: "private" } },
          ...(data !== undefined && { data }),
        },
      });
    const ok = press(`${CALLBACK_PREFIX}${HANDLE}`);
    assert.deepEqual(ok?.content, { kind: "ACTION", handle: HANDLE, ackToken: "cbq-1" });
    assert.equal(ok?.externalMessageId, "40");
    assert.equal(ok?.externalEventId, "9002");
    for (const bad of [
      undefined,
      "",
      "other:a:" + HANDLE,
      `${CALLBACK_PREFIX}short`,
      `${CALLBACK_PREFIX}${HANDLE}extra`,
      `${CALLBACK_PREFIX}${HANDLE.replace("A", "!")}`,
    ]) {
      assert.equal(press(bad), null, String(bad));
    }
  });

  it("ignores bots, edits, stickers, empty text and malformed payloads without throwing", () => {
    assert.equal(adapter.parseWebhook(textUpdate({}, { is_bot: true })), null);
    assert.equal(
      adapter.parseWebhook({ update_id: 1, edited_message: textUpdate().message }),
      null,
    );
    assert.equal(adapter.parseWebhook(textUpdate({ text: undefined })), null);
    assert.equal(adapter.parseWebhook(textUpdate({ text: "   " })), null);
    for (const junk of [
      null,
      undefined,
      42,
      "x",
      [],
      {},
      { update_id: "1" },
      { update_id: 1, message: { text: "hi" } },
    ]) {
      assert.equal(adapter.parseWebhook(junk), null);
    }
  });

  it("marks group chats as not private", () => {
    const group = adapter.parseWebhook(textUpdate({ chat: { id: -100123, type: "supergroup" } }));
    assert.equal(group?.isPrivate, false);
  });
});

describe("Telegram rendering", () => {
  it("sends plain text with inline buttons: URL buttons open pages, others carry only the opaque handle", async () => {
    const { adapter, calls } = build();
    const sent = await adapter.send(
      { externalConversationId: "424242" },
      {
        text: "Payment to Daniel",
        actions: [
          {
            type: "ACTION",
            semantic: "SELECT_OPTION",
            label: "Daniel Okafor",
            description: "@daniel_o",
            handle: HANDLE,
          },
          {
            type: "OPEN_URL",
            semantic: "OPEN_AUTHORIZATION",
            label: "Authorize payment",
            url: "https://app.kaada.test/authorize/TOK",
          },
          { type: "ACTION", semantic: "CANCEL", label: "Cancel", handle: "ZyXwVuTsRqPoNmLkJiHgFe" },
        ],
      },
    );
    assert.deepEqual(sent, { externalMessageId: "77" });
    const [call] = calls;
    assert.match(call?.url ?? "", /\/sendMessage$/);
    assert.equal(call?.body["chat_id"], "424242");
    assert.equal(
      call?.body["parse_mode"],
      undefined,
      "plain text: nothing the person typed is interpreted as markup",
    );
    assert.deepEqual(call?.body["link_preview_options"], { is_disabled: true });
    const keyboard = (call?.body["reply_markup"] as { inline_keyboard: Record<string, string>[][] })
      .inline_keyboard;
    assert.deepEqual(keyboard, [
      [{ text: "Daniel Okafor (@daniel_o)", callback_data: `${CALLBACK_PREFIX}${HANDLE}` }],
      [{ text: "Authorize payment", url: "https://app.kaada.test/authorize/TOK" }],
      [{ text: "Cancel", callback_data: `${CALLBACK_PREFIX}ZyXwVuTsRqPoNmLkJiHgFe` }],
    ]);
    for (const row of keyboard) {
      const data = (row[0] as Record<string, string> | undefined)?.["callback_data"];
      if (data) assert.ok(Buffer.byteLength(data) <= 64, "within Telegram's callback_data limit");
    }
  });

  it("clips overlong text and button labels", async () => {
    const { adapter, calls } = build();
    await adapter.send(
      { externalConversationId: "1" },
      {
        text: "x".repeat(5000),
        actions: [
          { type: "ACTION", semantic: "SELECT_OPTION", label: "L".repeat(200), handle: HANDLE },
        ],
      },
    );
    assert.equal((calls[0]?.body["text"] as string).length, 4096);
    const keyboard = (calls[0]?.body["reply_markup"] as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    assert.ok((keyboard[0]?.[0]?.text.length ?? 0) <= 60);
  });

  it("edits a message in place, and removes its buttons when none are given", async () => {
    const { adapter, calls } = build();
    await adapter.update({ externalConversationId: "424242" }, "55", { text: "Payment sent ✅" });
    assert.match(calls[0]?.url ?? "", /\/editMessageText$/);
    assert.equal(calls[0]?.body["message_id"], 55);
    assert.deepEqual(calls[0]?.body["reply_markup"], { inline_keyboard: [] });
  });

  it("treats 'message is not modified' as success and falls back to a new message when it cannot edit", async () => {
    const notModified = build(() =>
      json({ ok: false, description: "Bad Request: message is not modified" }, 400),
    );
    assert.deepEqual(
      await notModified.adapter.update({ externalConversationId: "1" }, "9", { text: "same" }),
      { externalMessageId: "9" },
    );

    let n = 0;
    const tooOld = build(() =>
      ++n === 1
        ? json({ ok: false, description: "Bad Request: message can't be edited" }, 400)
        : json({ ok: true, result: { message_id: 88 } }),
    );
    const result = await tooOld.adapter.update({ externalConversationId: "1" }, "9", {
      text: "new",
    });
    assert.deepEqual(result, { externalMessageId: "88" });
    assert.match(tooOld.calls[1]?.url ?? "", /\/sendMessage$/);
  });

  it("acknowledges a button press, shows typing and can delete a message", async () => {
    const { adapter, calls } = build();
    const press = adapter.parseWebhook({
      update_id: 5,
      callback_query: {
        id: "cbq-9",
        from: { id: 1 },
        message: { message_id: 3, chat: { id: 1, type: "private" } },
        data: `${CALLBACK_PREFIX}${HANDLE}`,
      },
    });
    if (!press) throw new Error("expected a press");
    await adapter.acknowledge(press);
    await adapter.indicateTyping({ externalConversationId: "1" });
    await adapter.remove({ externalConversationId: "1" }, "3");
    assert.deepEqual(
      calls.map((c) => c.url.split("/").pop()),
      ["answerCallbackQuery", "sendChatAction", "deleteMessage"],
    );
    assert.equal(calls[0]?.body["callback_query_id"], "cbq-9");
  });

  it("registers the webhook with the secret and only the updates it handles", async () => {
    const { adapter, calls } = build();
    await adapter.setWebhook("https://example.test/api/v1/channels/telegram/webhook");
    assert.equal(calls[0]?.body["secret_token"], SECRET);
    assert.deepEqual(calls[0]?.body["allowed_updates"], ["message", "callback_query"]);
  });

  it("never puts the bot token in an error", async () => {
    const { adapter } = build(() =>
      json({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403),
    );
    await assert.rejects(
      adapter.send({ externalConversationId: "1" }, { text: "hi" }),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.status, 403);
        assert.equal(error.method, "sendMessage");
        assert.equal(
          JSON.stringify([error.message, error.description, error.stack]).includes(
            "SECRET-BOT-TOKEN",
          ),
          false,
        );
        return true;
      },
    );
  });
});

describe("NotificationService", () => {
  const identities = (types: string[]) => ({
    listForUser: () =>
      Promise.resolve(
        types.map((type, index) => ({
          id: String(index),
          userId: "u",
          type: type as "TELEGRAM",
          externalId: type === "TELEGRAM" ? "424242" : "a@b.c",
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
  });

  it("reaches every linked chat through its adapter without the caller knowing which exist", async () => {
    const adapter = new FakeAdapter();
    const service = new NotificationService({
      identities: identities(["TELEGRAM"]),
      channels: [adapterDelivery(adapter)],
    });
    const result = await service.send("u", { type: "PAYMENT_COMPLETED" });
    assert.deepEqual(result, { delivered: 1, failed: 0, unsupported: 0 });
    assert.equal(adapter.last?.text, "Payment sent ✅");
    assert.equal(adapter.log[0]?.target?.externalConversationId, "424242");
  });

  it("renders every payment and recovery notification type, and counts unsupported and failing channels", async () => {
    const adapter = new FakeAdapter();
    const service = new NotificationService({
      identities: identities(["TELEGRAM", "EMAIL"]),
      channels: [adapterDelivery(adapter)],
    });
    const types = [
      "PAYMENT_AUTHORIZATION_REQUIRED",
      "PAYMENT_ROOT_ACTION_REQUIRED",
      "PAYMENT_PROCESSING",
      "PAYMENT_PENDING",
      "PAYMENT_COMPLETED",
      "PAYMENT_INSUFFICIENT_BALANCE",
      "PAYMENT_NO_ROUTE",
      "PAYMENT_QUOTE_EXPIRED",
      "PAYMENT_REAUTHORIZATION_REQUIRED",
      "PAYMENT_GAS_FUNDING_REQUIRED",
    ] as const;
    for (const type of types) {
      const result = await service.send("u", { type });
      assert.deepEqual(result, { delivered: 1, failed: 0, unsupported: 1 }, type);
    }
    await service.send("u", { type: "PAYMENT_FAILED", code: "X1" });
    await service.send("u", { type: "RECOVERY_CANCELLED" });
    await service.send("u", { type: "RECOVERY_VETOED" });
    await service.send("u", { type: "RECOVERY_COMPLETED", now: new Date() });
    await service.send("u", {
      type: "RECOVERY_STARTED",
      now: new Date(),
      executeAfter: new Date(Date.now() + 3 * 86_400_000),
      reportLink: "https://app.kaada.test/recovery/report#tok",
    });
    assert.equal(
      new Set(adapter.sent.map((m) => m.text)).size,
      adapter.sent.length,
      "every message is distinct",
    );
    adapter.failNextSend = true;
    assert.deepEqual(await service.send("u", { type: "PAYMENT_COMPLETED" }), {
      delivered: 0,
      failed: 1,
      unsupported: 1,
    });
  });
});
