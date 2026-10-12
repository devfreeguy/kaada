import type { ChannelMessage, ChannelMessenger, IdentityType } from "@kaada/domain";

/**
 * Delivers recovery alerts to a LINKED Telegram identity through the Bot API. The identity's external id is the Telegram user
 * id, which is also the id of that person's private chat with the bot. It only ever sends text, to identities the person
 * linked themselves; a Telegram failure is reported to the notifier and never blocks the other channels or the recovery.
 */
export class TelegramChannelMessenger implements ChannelMessenger {
  constructor(
    private readonly options: {
      botToken: string;
      fetch?: typeof fetch;
      baseUrl?: string;
    },
  ) {}

  supports(type: IdentityType): boolean {
    return type === "TELEGRAM";
  }

  async send(
    identity: { type: IdentityType; externalId: string },
    message: ChannelMessage,
  ): Promise<void> {
    if (!/^[0-9]{1,20}$/.test(identity.externalId)) {
      throw new Error("a Telegram identity must be a numeric user id");
    }
    const base = this.options.baseUrl ?? "https://api.telegram.org";
    const response = await (this.options.fetch ?? fetch)(
      `${base}/bot${this.options.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: identity.externalId,
          text: `${message.subject}\n\n${message.text}`,
          // Links stay plain text: no previews that could fetch or reveal a one-time link elsewhere.
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      // Never include the URL (it holds the bot token) or the body in the error.
      throw new Error(`telegram answered ${String(response.status)}`);
    }
  }
}
