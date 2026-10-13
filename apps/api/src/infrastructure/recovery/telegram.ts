import type { ChannelMessage, ChannelMessenger, IdentityType } from "@kaada/domain";

import type { ChannelAdapter } from "../../core/channels/types.js";

/**
 * Delivers recovery alerts to a LINKED Telegram identity. It is the same Telegram client as the conversational channel (the
 * TelegramAdapter), seen through the recovery notifier's ChannelMessenger port: there is one place that talks to Telegram.
 * In a private chat the numeric Telegram user id is also the chat id, so a linked identity is enough to reach the person. A
 * failure is reported to the notifier and never blocks the other channels or the recovery.
 */
export class TelegramChannelMessenger implements ChannelMessenger {
  constructor(private readonly adapter: Pick<ChannelAdapter, "send">) {}

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
    await this.adapter.send(
      { externalConversationId: identity.externalId },
      { text: `${message.subject}\n\n${message.text}` },
    );
  }
}
