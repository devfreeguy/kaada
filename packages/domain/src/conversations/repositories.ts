import type { ChannelType, Conversation, ConversationStatus, Message } from "./conversation.js";

export type NewConversation = Omit<Conversation, "createdAt" | "updatedAt">;
export type NewMessage = Omit<Message, "createdAt">;

export interface ConversationRepository {
  findById(id: string): Promise<Conversation | null>;
  /** The conversation bound to a channel chat id, if any. */
  findByExternalId(
    channel: ChannelType,
    externalConversationId: string,
  ): Promise<Conversation | null>;
  create(conversation: NewConversation): Promise<Conversation>;
  /**
   * Returns the conversation bound to the channel chat, creating it when none exists. Safe under
   * concurrent first messages: exactly one row is created and every caller receives it.
   */
  getOrCreateByExternalId(
    conversation: NewConversation & { externalConversationId: string },
  ): Promise<Conversation>;
  /**
   * Takes a row lock on the conversation until the surrounding transaction ends, serialising
   * everything that changes the conversation state. Only meaningful inside a transaction.
   */
  lockForUpdate(id: string): Promise<void>;
  updateStatus(id: string, status: ConversationStatus): Promise<Conversation>;
}

export interface AppendMessageResult {
  message: Message;
  /** False when the same external message was already stored (duplicate webhook delivery). */
  created: boolean;
}

export interface MessageRepository {
  /** Stores a message, or returns the existing one if its externalMessageId was already seen. */
  append(message: NewMessage): Promise<AppendMessageResult>;
  /** A stored message by the channel's own id, if any. */
  findByExternalId(conversationId: string, externalMessageId: string): Promise<Message | null>;
  /** The assistant message that answered `inboundMessageId`, if one was stored. */
  findReply(conversationId: string, inboundMessageId: string): Promise<Message | null>;
  /** The latest `limit` messages, in chronological order (oldest first). */
  listRecent(conversationId: string, limit: number): Promise<Message[]>;
}
