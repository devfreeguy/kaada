/*
 * The channel boundary. Telegram is the first adapter and WhatsApp the next; none of them appears in this file.
 *
 * An adapter's whole job is to translate: verify a provider webhook, turn the provider's payload into an InboundChannelMessage,
 * and turn an OutboundChannelMessage into the provider's own messages and buttons. It never interprets payment language,
 * resolves a recipient or asset, prices, authorizes, signs or executes: that is the Agent Core and the services behind it,
 * reached only through ChannelMessageService.
 */
import type { ChannelType } from "@kaada/domain";

/** Who is talking, in the channel's own terms. `externalUserId` is the stable id; names are display metadata only. */
export interface ChannelIdentity {
  channel: ChannelType;
  /** The provider's stable account id (Telegram: the numeric user id). Never a username: those change. */
  externalUserId: string;
  username?: string;
  displayName?: string;
  languageCode?: string;
}

/** Syntax-level commands a provider has (Telegram's /start). They are not payment language. */
export type ChannelCommand = "START" | "HELP" | "CANCEL" | "BALANCE" | "FUND" | "RATES" | "WALLET";

export type InboundContent =
  | { kind: "TEXT"; text: string }
  | { kind: "COMMAND"; command: ChannelCommand }
  /** A button press. `handle` is the opaque id the provider echoed back; `ackToken` lets the adapter acknowledge it. */
  | { kind: "ACTION"; handle: string; ackToken?: string };

export interface InboundChannelMessage {
  channel: ChannelType;
  /** One delivery from the provider (Telegram update_id): the unit of idempotency. */
  externalEventId: string;
  /** The message the text came from, or the one carrying the pressed button. */
  externalMessageId: string;
  /** The chat. */
  externalConversationId: string;
  sender: ChannelIdentity;
  /** Whether this is a one-to-one chat. Payments are only ever handled there. */
  isPrivate: boolean;
  content: InboundContent;
  timestamp: Date;
}

/** Things a person can do from a message, in channel-neutral form. Adapters decide how they look. */
export type OutboundAction =
  /** Opens a secure HTTPS page (authorization, setup, a root step). Never carries a PIN or a credential. */
  | {
      type: "OPEN_URL";
      semantic: "OPEN_AUTHORIZATION" | "OPEN_SETUP" | "OPEN_ROOT_ACTION";
      label: string;
      url: string;
    }
  /**
   * Copies `text` to the person's clipboard where the channel has a real copy button. Never used for anything secret (it is
   * visible in the message anyway): an address, a reference.
   */
  | { type: "COPY_TEXT"; label: string; text: string }
  /** A button the server will recognise by its opaque handle. */
  | {
      type: "ACTION";
      semantic:
        "SELECT_OPTION" | "CANCEL" | "RETRY" | "VIEW_STATUS" | "SUGGESTION" | "CONTINUE_PAYMENT";
      label: string;
      description?: string;
      handle: string;
    };

export interface OutboundChannelMessage {
  text: string;
  actions?: OutboundAction[];
  /**
   * Parts of `text` to show in a monospace, tap-to-copy style where the channel can (a wallet address). They must appear in the
   * text verbatim; an adapter that cannot format them just shows the text.
   */
  code?: string[];
}

/** Where a message goes: the chat. (In a one-to-one chat the provider needs nothing else.) */
export interface ChannelTarget {
  externalConversationId: string;
}

export interface SentMessage {
  externalMessageId: string;
}

/**
 * A reply being shown while it is still being written. Optional on an adapter: one that cannot (or need not) simply has no
 * drafts and the reply appears whole. `update` never blocks and is rate-limited by the adapter, so a fast generator cannot flood
 * the channel; `close` stops any pending update and waits for one in flight. The finished message is always sent separately.
 */
export interface ChannelDraft {
  update(text: string): void;
  close(): Promise<void>;
}

export interface ChannelAdapter {
  readonly channel: ChannelType;

  /** True only for a request that really comes from the provider (a shared secret compared in constant time). */
  verifyWebhook(request: { headers: Record<string, string | undefined> }): boolean;

  /**
   * The normalised message, or null for an update Kaada does not handle (edits, joins, stickers, group chats...). Never throws
   * on a malformed payload: unusable input is simply not a message.
   */
  parseWebhook(body: unknown): InboundChannelMessage | null;

  send(target: ChannelTarget, message: OutboundChannelMessage): Promise<SentMessage>;

  /** Edits an earlier message in place. Where the provider cannot edit, sends a new message instead. */
  update(
    target: ChannelTarget,
    externalMessageId: string,
    message: OutboundChannelMessage,
  ): Promise<SentMessage>;

  /** Tells the provider a button press was received (stops a spinner). Best effort. */
  acknowledge(message: InboundChannelMessage): Promise<void>;

  /** Publishes the slash-command menu where the channel has one. Best effort; called from setup tooling, not at run time. */
  registerCommands?(commands: { command: string; description: string }[]): Promise<void>;

  /** "typing..." while the agent thinks. Best effort. */
  indicateTyping?(target: ChannelTarget): Promise<void>;

  /** Begins showing a partly written reply, where the channel supports it. null when it cannot. */
  openDraft?(target: ChannelTarget): ChannelDraft | null;

  /** Removes a message from the chat (used for anything that looks like a secret that must not stay there). Best effort. */
  remove?(target: ChannelTarget, externalMessageId: string): Promise<void>;
}

/** What a notification is about. Channel-neutral: renderers turn these into words. */
export type NotificationType =
  | "PAYMENT_AUTHORIZATION_REQUIRED"
  | "PAYMENT_ROOT_ACTION_REQUIRED"
  | "PAYMENT_PROCESSING"
  | "PAYMENT_PENDING"
  | "PAYMENT_COMPLETED"
  | "PAYMENT_FAILED"
  | "PAYMENT_INSUFFICIENT_BALANCE"
  | "PAYMENT_NO_ROUTE"
  | "PAYMENT_QUOTE_EXPIRED"
  | "PAYMENT_REAUTHORIZATION_REQUIRED"
  | "PAYMENT_GAS_FUNDING_REQUIRED"
  | "RECOVERY_STARTED"
  | "RECOVERY_CANCELLED"
  | "RECOVERY_VETOED"
  | "RECOVERY_COMPLETED";
