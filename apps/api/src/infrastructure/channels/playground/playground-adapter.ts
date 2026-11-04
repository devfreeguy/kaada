import { createId } from "@kaada/domain";
import type { ChannelType } from "@kaada/domain";

import type {
  ChannelAdapter,
  ChannelTarget,
  InboundChannelMessage,
  OutboundChannelMessage,
  SentMessage,
} from "../../../core/channels/types.js";

/*
 * The development playground's channel adapter.
 *
 * An adapter's whole job is to translate between a provider and Kaada's channel-neutral shapes. This one's "provider" is an
 * HTTP response to a browser: instead of calling Telegram it collects what Kaada said, so the playground controller can hand
 * the same OutboundChannelMessage objects (text, buttons, copyable parts) to the page.
 *
 * It is NOT a second pipeline. Everything above it - the agent, the interpreter, the coordinator, the currency registry, the
 * conversation memory, the presenter and the opaque button handles - is the same code Telegram runs, reached through the same
 * ChannelMessageService.handleInbound entry point.
 *
 * It has no webhook: it is never reachable from the internet, and verifyWebhook always refuses.
 */
export class PlaygroundAdapter implements ChannelAdapter {
  readonly channel: ChannelType = "WEB";

  /** What Kaada said during the turn being handled, in order, per chat. */
  private readonly outbox = new Map<string, OutboundChannelMessage[]>();

  /** Nothing may ever arrive here as a webhook: the playground speaks to the controller directly. */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): InboundChannelMessage | null {
    return null;
  }

  send(target: ChannelTarget, message: OutboundChannelMessage): Promise<SentMessage> {
    const sent = this.outbox.get(target.externalConversationId) ?? [];
    sent.push(message);
    this.outbox.set(target.externalConversationId, sent);
    return Promise.resolve({ externalMessageId: createId() });
  }

  /**
   * The browser re-renders the whole turn, so an edit is just another message. Kaada uses this to replace a temporary status
   * with the answer; showing both is the honest rendering of what happened.
   */
  update(
    target: ChannelTarget,
    _externalMessageId: string,
    message: OutboundChannelMessage,
  ): Promise<SentMessage> {
    return this.send(target, message);
  }

  /** Telegram stops a button's spinner here. A browser has nothing to acknowledge. */
  acknowledge(): Promise<void> {
    return Promise.resolve();
  }

  /** Typing indicators are a provider affordance; the page shows its own pending state. */
  indicateTyping(): Promise<void> {
    return Promise.resolve();
  }

  /** Takes everything said in a chat since the last call, leaving the chat's outbox empty. */
  drain(externalConversationId: string): OutboundChannelMessage[] {
    const sent = this.outbox.get(externalConversationId) ?? [];
    this.outbox.delete(externalConversationId);
    return sent;
  }
}
