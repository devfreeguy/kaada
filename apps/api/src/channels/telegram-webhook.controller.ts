import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import { errorDetails, isPermanentProviderError } from "../core/channels/error-details.js";
import type { ChannelMessageService } from "../core/channels/message-service.js";
import type { TelegramAdapter } from "../infrastructure/channels/telegram/telegram-adapter.js";
import { CHANNEL_MESSAGE_SERVICE, TELEGRAM_ADAPTER } from "./channels.tokens.js";

/**
 * Telegram's webhook. Nothing about the request is trusted until Telegram's secret header matches (constant-time), and the
 * answer never explains why a request was refused. Handling is idempotent per update id, so a redelivery is acknowledged
 * without doing anything twice. A failure answers 5xx so Telegram retries; the claim is released first so the retry is handled.
 */
@Controller({ path: "channels/telegram", version: "1" })
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    @Inject(TELEGRAM_ADAPTER) private readonly adapter: TelegramAdapter | null,
    @Inject(CHANNEL_MESSAGE_SERVICE) private readonly service: ChannelMessageService | null,
  ) {}

  @Post("webhook")
  @HttpCode(200)
  async webhook(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ ok: true }> {
    if (!this.adapter || !this.service) throw new NotFoundException();
    if (!this.adapter.verifyWebhook({ headers })) throw new UnauthorizedException();

    const message = this.adapter.parseWebhook(body);
    // Not something Kaada handles (an edit, a sticker, a group event): acknowledge so Telegram does not resend it.
    if (!message) return { ok: true };

    try {
      const result = await this.service.handleInbound(message);
      // Another worker is on this update right now: ask Telegram to come back rather than say it was handled.
      if (result === "IN_PROGRESS") throw new ServiceUnavailableException();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const permanent = isPermanentProviderError(error);
      this.logger.error({ event: "telegram.webhook.failed", permanent, ...errorDetails(error) });
      // Telegram refusing a reply (bad button URL, blocked bot, chat gone) fails the same way every time: answering 5xx would
      // only make it redeliver the update for ever. The claim is already released and the agent turn is idempotent.
      if (permanent) return { ok: true };
      throw new ServiceUnavailableException();
    }
    return { ok: true };
  }
}
