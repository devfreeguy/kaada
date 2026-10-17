import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  recoveryCancelledMessage,
  recoveryCompletedMessage,
  recoveryStartedMessage,
} from "../src/core/recovery/messages.js";
import { SmtpEmailSender } from "../src/infrastructure/recovery/smtp-email.js";
import { TelegramAdapter } from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import { TelegramChannelMessenger } from "../src/infrastructure/recovery/telegram.js";

describe("SMTP email", () => {
  it("sends plain text from the configured sender", async () => {
    const sent: unknown[] = [];
    const sender = new SmtpEmailSender({
      from: "Kaada <no-reply@kaada.app>",
      transport: { sendMail: (m) => Promise.resolve(sent.push(m)) },
    });
    await sender.send({ to: "a@example.com", subject: "Hi", text: "body" });
    assert.deepEqual(sent, [
      { from: "Kaada <no-reply@kaada.app>", to: "a@example.com", subject: "Hi", text: "body" },
    ]);
  });

  it("refuses a recipient or subject that could inject headers", async () => {
    const sender = new SmtpEmailSender({
      from: "x@y.z",
      transport: { sendMail: () => Promise.reject(new Error("must not be called")) },
    });
    await assert.rejects(
      sender.send({ to: "a@example.com\r\nBcc: evil@example.com", subject: "s", text: "t" }),
      /line break/,
    );
    await assert.rejects(
      sender.send({ to: "a@example.com", subject: "s\nBcc: x", text: "t" }),
      /line break/,
    );
  });

  it("surfaces a transport failure to the caller (the notifier records it)", async () => {
    const sender = new SmtpEmailSender({
      from: "x@y.z",
      transport: { sendMail: () => Promise.reject(new Error("smtp down")) },
    });
    await assert.rejects(sender.send({ to: "a@b.c", subject: "s", text: "t" }), /smtp down/);
  });
});

describe("Telegram alerts", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const okFetch = ((url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
  }) as unknown as typeof fetch;

  it("only handles Telegram identities", () => {
    const messenger = new TelegramChannelMessenger(
      new TelegramAdapter({ botToken: "123:abc", fetch: okFetch }),
    );
    assert.equal(messenger.supports("TELEGRAM"), true);
    for (const other of ["EMAIL", "WHATSAPP", "PHONE", "DISCORD", "X"] as const) {
      assert.equal(messenger.supports(other), false);
    }
  });

  it("sends the alert text to the linked user's chat, with previews off", async () => {
    const messenger = new TelegramChannelMessenger(
      new TelegramAdapter({ botToken: "123:abc", fetch: okFetch }),
    );
    await messenger.send({ type: "TELEGRAM", externalId: "987654321" }, recoveryCancelledMessage());
    const [call] = calls;
    assert.equal(call?.url, "https://api.telegram.org/bot123:abc/sendMessage");
    assert.equal(call.body["chat_id"], "987654321");
    assert.deepEqual(call.body["link_preview_options"], { is_disabled: true });
    assert.match(String(call.body["text"]), /cancelled/);
  });

  it("refuses a non-numeric identity and never leaks the bot token in an error", async () => {
    const failing = new TelegramChannelMessenger(
      new TelegramAdapter({
        botToken: "123:SECRETTOKEN",
        fetch: () => Promise.resolve(new Response("{}", { status: 403 })),
      }),
    );
    await assert.rejects(
      failing.send({ type: "TELEGRAM", externalId: "@someone" }, recoveryCancelledMessage()),
      /numeric/,
    );
    try {
      await failing.send({ type: "TELEGRAM", externalId: "42" }, recoveryCancelledMessage());
      assert.fail("expected a failure");
    } catch (error) {
      assert.match((error as Error).message, /403/);
      assert.equal((error as Error).message.includes("SECRETTOKEN"), false);
    }
  });
});

describe("the three recovery alerts", () => {
  it("are distinct, say what happened, and only the start carries a link", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const started = recoveryStartedMessage({
      now,
      executeAfter: new Date(now.getTime() + 3 * 86_400_000),
      cancelLink: "https://app.example/recovery/cancel#abc",
    });
    const cancelled = recoveryCancelledMessage();
    const completed = recoveryCompletedMessage(now);
    const subjects = [started, cancelled, completed].map((m) => m.subject);
    assert.equal(new Set(subjects).size, 3);
    assert.match(started.text, /https:\/\/app\.example\/recovery\/cancel#abc/);
    assert.match(cancelled.text, /cancelled from your current device/);
    assert.match(completed.text, /recovered/);
    for (const m of [cancelled, completed]) assert.equal(/https?:\/\//.test(m.text), false);
  });
});
