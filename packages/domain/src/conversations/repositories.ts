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
  /** The latest `limit` messages, in chronological order (oldest first). */
  listRecent(conversationId: string, limit: number): Promise<Message[]>;
}
