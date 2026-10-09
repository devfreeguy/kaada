import type { ConversationRepository, MessageRepository } from "@kaada/domain";

import {
  conversationCreateData,
  messageCreateData,
  toConversation,
  toMessage,
} from "../mappers/index.js";
import { DataIntegrityError } from "../mappers/index.js";
import type { Message as MessageRow } from "../generated/prisma/client.js";
import type { Db } from "./db.js";

/** A JSON value (or nothing) as the text of a jsonb parameter. */
function jsonText(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

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
      // Almost every call is for an existing conversation: one cheap read, no write.
      const existing = await db.conversation.findUnique({
        where: {
          channel_externalConversationId: {
            channel: conversation.channel,
            externalConversationId: conversation.externalConversationId,
          },
        },
      });
      if (existing) return toConversation(existing);

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
      // One statement for the normal case: insert and return the row, or insert nothing when this
      // external message was already stored (then read the stored one).
      const inserted = await db.$queryRaw<MessageRow[]>`
        INSERT INTO "Message" ("id", "conversationId", "role", "content", "externalMessageId", "structuredData", "metadata")
        VALUES (${message.id}::uuid, ${message.conversationId}::uuid, ${message.role}::"MessageRole", ${message.content},
                ${message.externalMessageId}, ${jsonText(data.structuredData)}::jsonb, ${jsonText(data.metadata)}::jsonb)
        ON CONFLICT ("conversationId", "externalMessageId") DO NOTHING
        RETURNING *`;
      const [fresh] = inserted;
      if (fresh) return { message: toMessage(fresh), created: true };

      const row = await db.message.findUnique({
        where: {
          conversationId_externalMessageId: {
            conversationId: message.conversationId,
            externalMessageId: message.externalMessageId,
          },
        },
      });
      if (!row) throw new DataIntegrityError("message conflicted on id but has no external match");
      return { message: toMessage(row), created: false };
    },

    async findByExternalId(conversationId, externalMessageId) {
      const row = await db.message.findUnique({
        where: { conversationId_externalMessageId: { conversationId, externalMessageId } },
      });
      return row ? toMessage(row) : null;
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
