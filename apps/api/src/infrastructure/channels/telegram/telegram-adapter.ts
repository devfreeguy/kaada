import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type {
  ChannelAdapter,
  ChannelCommand,
  ChannelTarget,
  InboundChannelMessage,
  OutboundAction,
  OutboundChannelMessage,
  SentMessage,
} from "../../../core/channels/types.js";

/** callback_data is "kaada:a:<22-char opaque handle>": 30 bytes of Telegram's 64-byte limit, and nothing but the handle. */
export const CALLBACK_PREFIX = "kaada:a:";
const HANDLE = /^[A-Za-z0-9_-]{22}$/;

const MAX_TEXT = 4096;
const MAX_BUTTON = 60;

/** A failed Bot API call. Carries the method and Telegram's status, never the URL (which contains the bot token). */
export class TelegramApiError extends Error {
  override name = "TelegramApiError";
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method} failed (${String(status)})`);
  }
}

// ── the slice of Telegram's Update we read. Lenient on purpose: anything else is ignored, never trusted ──

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
const chatSchema = z.object({ id: z.number().int(), type: z.string() });
const messageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().optional(),
  from: userSchema.optional(),
  chat: chatSchema,
  text: z.string().optional(),
});
const updateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: userSchema,
      message: messageSchema.optional(),
      data: z.string().optional(),
    })
    .optional(),
});

type TelegramUser = z.infer<typeof userSchema>;

const displayName = (user: TelegramUser): string | undefined => {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || undefined;
};

/** Syntax-level commands only: "/start", "/start payload", "/start@kaadabot". Everything else is plain text. */
function commandOf(text: string): ChannelCommand | null {
  const match = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s|$)/.exec(text);
  switch (match?.[1]?.toLowerCase()) {
    case "start":
      return "START";
    case "help":
      return "HELP";
    case "cancel":
      return "CANCEL";
    default:
      return null;
  }
}

export interface TelegramAdapterOptions {
  botToken: string;
  /** Absent for a send-only bot (recovery alerts): then no webhook is ever accepted. */
  webhookSecret?: string;
  fetch?: typeof fetch;
  /** Override for tests or a local Bot API server. */
  apiBase?: string;
}

/**
 * Telegram as a ChannelAdapter. It verifies and normalises webhooks, and renders neutral messages as Telegram messages with
 * inline keyboards. It interprets nothing: payment language, recipients, routes and authorization all live behind
 * ChannelMessageService.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "TELEGRAM" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.base = (options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
  }

  // ───────────────────────────────── inbound ─────────────────────────────────

  verifyWebhook(request: { headers: Record<string, string | undefined> }): boolean {
    const provided = request.headers["x-telegram-bot-api-secret-token"];
    if (!provided || !this.options.webhookSecret) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.options.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown): InboundChannelMessage | null {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return null;
    const update = parsed.data;
    const eventId = String(update.update_id);

    if (update.callback_query) {
      const query = update.callback_query;
      const message = query.message;
      if (query.from.is_bot || !message || !query.data?.startsWith(CALLBACK_PREFIX)) return null;
      const handle = query.data.slice(CALLBACK_PREFIX.length);
      if (!HANDLE.test(handle)) return null;
      return {
        channel: "TELEGRAM",
        externalEventId: eventId,
        externalMessageId: String(message.message_id),
        externalConversationId: String(message.chat.id),
        sender: this.sender(query.from),
        isPrivate: message.chat.type === "private",
        content: { kind: "ACTION", handle, ackToken: query.id },
        timestamp: new Date(),
      };
    }

    const message = update.message;
    if (!message?.from || message.from.is_bot || typeof message.text !== "string") return null;
    const text = message.text.trim();
    if (text.length === 0) return null;
    const command = commandOf(text);
    return {
      channel: "TELEGRAM",
      externalEventId: eventId,
      externalMessageId: String(message.message_id),
      externalConversationId: String(message.chat.id),
      sender: this.sender(message.from),
      isPrivate: message.chat.type === "private",
      content: command ? { kind: "COMMAND", command } : { kind: "TEXT", text: text.slice(0, 2000) },
      timestamp: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
    };
  }

  private sender(user: TelegramUser): InboundChannelMessage["sender"] {
    return {
      channel: "TELEGRAM",
      // The stable numeric id: usernames are display metadata and can change or disappear.
      externalUserId: String(user.id),
      ...(user.username && { username: user.username }),
      ...(displayName(user) && { displayName: displayName(user) as string }),
      ...(user.language_code && { languageCode: user.language_code }),
    };
  }

  // ───────────────────────────────── outbound ─────────────────────────────────

  async send(target: ChannelTarget, message: OutboundChannelMessage): Promise<SentMessage> {
    const { text, actions } = renderable(message);
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: target.externalConversationId,
      text: clip(text, MAX_TEXT),
      link_preview_options: { is_disabled: true },
      ...keyboardOf(actions),
    });
    return { externalMessageId: String(result.message_id) };
  }

  async update(
    target: ChannelTarget,
    externalMessageId: string,
    message: OutboundChannelMessage,
  ): Promise<SentMessage> {
    const { text, actions } = renderable(message);
    try {
      await this.call("editMessageText", {
        chat_id: target.externalConversationId,
        message_id: Number(externalMessageId),
        text: clip(text, MAX_TEXT),
        link_preview_options: { is_disabled: true },
        // An empty keyboard removes the buttons: a closed payment must not keep offering "Authorize".
        reply_markup: keyboardOf(actions).reply_markup ?? { inline_keyboard: [] },
      });
      return { externalMessageId };
    } catch (error) {
      if (error instanceof TelegramApiError && /not modified/i.test(error.description)) {
        return { externalMessageId };
      }
      // Too old or already deleted: tell the person in a new message instead.
      if (error instanceof TelegramApiError && error.status === 400)
        return this.send(target, message);
      throw error;
    }
  }

  async acknowledge(message: InboundChannelMessage): Promise<void> {
    if (message.content.kind !== "ACTION" || !message.content.ackToken) return;
    await this.call("answerCallbackQuery", { callback_query_id: message.content.ackToken });
  }

  async indicateTyping(target: ChannelTarget): Promise<void> {
    await this.call("sendChatAction", { chat_id: target.externalConversationId, action: "typing" });
  }

  async remove(target: ChannelTarget, externalMessageId: string): Promise<void> {
    await this.call("deleteMessage", {
      chat_id: target.externalConversationId,
      message_id: Number(externalMessageId),
    });
  }

  // ───────────────────────────────── setup ─────────────────────────────────

  /** Points Telegram at the webhook and tells it to send the secret header. Used by the setup script, not at run time. */
  async setWebhook(url: string): Promise<void> {
    if (!this.options.webhookSecret) throw new Error("a webhook needs a secret");
    await this.call("setWebhook", {
      url,
      secret_token: this.options.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }

  async getWebhookInfo(): Promise<{ url: string; pendingUpdateCount: number; lastError?: string }> {
    const info = await this.call<{
      url?: string;
      pending_update_count?: number;
      last_error_message?: string;
    }>("getWebhookInfo", {});
    return {
      url: info.url ?? "",
      pendingUpdateCount: info.pending_update_count ?? 0,
      ...(info.last_error_message && { lastError: info.last_error_message }),
    };
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>("getMe", {});
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.base}/bot${this.options.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let payload: {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // A non-JSON answer is a failure all the same.
    }
    if (!response.ok || payload.ok !== true) {
      throw new TelegramApiError(
        method,
        response.status,
        String(payload.description ?? "").slice(0, 200),
        payload.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }
}

// ───────────────────────────────── rendering ─────────────────────────────────

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function buttonOf(
  action: OutboundAction,
): { text: string; url: string } | { text: string; callback_data: string } {
  if (action.type === "OPEN_URL") return { text: clip(action.label, MAX_BUTTON), url: action.url };
  const label = action.description ? `${action.label} (${action.description})` : action.label;
  return { text: clip(label, MAX_BUTTON), callback_data: `${CALLBACK_PREFIX}${action.handle}` };
}

/**
 * Telegram refuses a whole message whose button URL is not https (a local http://localhost link, for one). Those links go into
 * the text instead, so the message still arrives and the link can be copied.
 */
function renderable(message: OutboundChannelMessage): { text: string; actions: OutboundAction[] } {
  const actions: OutboundAction[] = [];
  const links: string[] = [];
  for (const action of message.actions ?? []) {
    if (action.type === "OPEN_URL" && !/^https:\/\/\S+$/i.test(action.url)) {
      links.push(`${action.label}: ${action.url}`);
    } else actions.push(action);
  }
  return { text: links.length ? `${message.text}\n\n${links.join("\n")}` : message.text, actions };
}

/** One button per row: choices stay readable on a phone, and the primary action is never beside a destructive one. */
function keyboardOf(actions: OutboundAction[] | undefined): {
  reply_markup?: { inline_keyboard: unknown[][] };
} {
  if (!actions || actions.length === 0) return {};
  return { reply_markup: { inline_keyboard: actions.map((action) => [buttonOf(action)]) } };
}
