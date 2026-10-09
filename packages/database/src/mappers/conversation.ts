import type { Conversation, Message, NewConversation, NewMessage } from "@kaada/domain";

import type {
  Conversation as ConversationRow,
  Message as MessageRow,
  Prisma,
} from "../generated/prisma/client.js";
import { jsonInput, maybe, readJsonObject, readJsonValue } from "./support.js";

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    status: row.status,
    ...maybe("externalConversationId", row.externalConversationId),
    ...maybe("metadata", readJsonObject(row.metadata, "Conversation.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function conversationCreateData(
  conversation: NewConversation,
): Prisma.ConversationUncheckedCreateInput {
  return {
    id: conversation.id,
    userId: conversation.userId,
    channel: conversation.channel,
    status: conversation.status,
    externalConversationId: conversation.externalConversationId ?? null,
    ...maybe("metadata", jsonInput(conversation.metadata, "Conversation.metadata")),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    ...maybe("externalMessageId", row.externalMessageId),
    ...maybe("structuredData", readJsonValue(row.structuredData, "Message.structuredData")),
    ...maybe("metadata", readJsonObject(row.metadata, "Message.metadata")),
    createdAt: row.createdAt,
  };
}

export function messageCreateData(message: NewMessage): Prisma.MessageUncheckedCreateInput {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    externalMessageId: message.externalMessageId ?? null,
    ...maybe("structuredData", jsonInput(message.structuredData, "Message.structuredData")),
    ...maybe("metadata", jsonInput(message.metadata, "Message.metadata")),
  };
}
