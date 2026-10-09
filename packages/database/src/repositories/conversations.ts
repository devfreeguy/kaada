import type { ConversationRepository, MessageRepository } from "@kaada/domain";

import {
  conversationCreateData,
  messageCreateData,
  toConversation,
  toMessage,
} from "../mappers/index.js";
import { DataIntegrityError } from "../mappers/index.js";
import type { Db } from "./db.js";

export function createConversationRepository(db: Db): ConversationRepository {
  return {
    async findById(id) {
      const row = await db.conversation.findUnique({ where: { id } });
      return row ? toConversation(row) : null;
    },

    async findByExternalId(channel, externalConversationId) {
      const row = await db.conversation.findUnique({
        where: { channel_externalConversationId: { channel, externalConversationId } },
      });
      return row ? toConversation(row) : null;
    },

    async create(conversation) {
      return toConversation(
        await db.conversation.create({ data: conversationCreateData(conversation) }),
      );
    },

    /**
     * ON CONFLICT DO NOTHING keeps this safe under concurrent first messages and inside a larger
     * transaction (a failed INSERT would abort it).
     */
    async getOrCreateByExternalId(conversation) {
      await db.conversation.createMany({
        data: [conversationCreateData(conversation)],
        skipDuplicates: true,
      });
      const row = await db.conversation.findUnique({
        where: {
          channel_externalConversationId: {
            channel: conversation.channel,
            externalConversationId: conversation.externalConversationId,
          },
        },
      });
      if (!row)
        throw new DataIntegrityError("conversation conflicted on id but has no external match");
      return toConversation(row);
    },

    async lockForUpdate(id) {
      await db.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id}::uuid FOR UPDATE`;
    },

    async updateStatus(id, status) {
      return toConversation(await db.conversation.update({ where: { id }, data: { status } }));
    },
  };
}

export function createMessageRepository(db: Db): MessageRepository {
  return {
    /**
     * Duplicate webhook deliveries (same conversation + external message id) are absorbed with
     * ON CONFLICT DO NOTHING, which also keeps this safe inside a larger transaction.
     */
    async append(message) {
      const data = messageCreateData(message);
      if (message.externalMessageId === undefined) {
        return { message: toMessage(await db.message.create({ data })), created: true };
      }
      const { count } = await db.message.createMany({ data: [data], skipDuplicates: true });
      const row = await db.message.findUnique({
        where: {
          conversationId_externalMessageId: {
            conversationId: message.conversationId,
            externalMessageId: message.externalMessageId,
          },
        },
      });
      if (!row) throw new DataIntegrityError("message conflicted on id but has no external match");
      return { message: toMessage(row), created: count === 1 };
    },

    async findReply(conversationId, inboundMessageId) {
      const row = await db.message.findFirst({
        where: {
          conversationId,
          role: "ASSISTANT",
          metadata: { path: ["inReplyTo"], equals: inboundMessageId },
        },
        orderBy: { createdAt: "asc" },
      });
      return row ? toMessage(row) : null;
    },

    async listRecent(conversationId, limit) {
      const rows = await db.message.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      });
      return rows.reverse().map(toMessage);
    },
  };
}
