import { OPEN_INTENT_STATUSES } from "@kaada/domain";
import type { Intent, IntentRepository } from "@kaada/domain";

import { intentCreateData, intentUpdateData, toIntent } from "../mappers/index.js";
import type { Db } from "./db.js";

export function createIntentRepository(db: Db): IntentRepository {
  return {
    async create(intent) {
      return toIntent(await db.intent.create({ data: intentCreateData(intent) }));
    },

    async lockForUpdate(id) {
      await db.$queryRaw`SELECT id FROM "Intent" WHERE id = ${id}::uuid FOR UPDATE`;
    },

    async findById(id) {
      const row = await db.intent.findUnique({ where: { id } });
      return row ? toIntent(row) : null;
    },

    async findOpenByConversation(conversationId) {
      const row = await db.intent.findFirst({
        where: { conversationId, status: { in: [...OPEN_INTENT_STATUSES] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return row ? toIntent(row) : null;
    },

    async save(intent) {
      return toIntent(
        await db.intent.update({ where: { id: intent.id }, data: intentUpdateData(intent) }),
      );
    },

    /**
     * Read-merge-write so the amount/asset consistency rule is checked on the final state. Callers
     * that update the same intent concurrently should serialise per conversation.
     */
    async update(id, update) {
      const current = toIntent(await db.intent.findUniqueOrThrow({ where: { id } }));
      const merged: Intent = { ...current, ...update };
      return toIntent(await db.intent.update({ where: { id }, data: intentUpdateData(merged) }));
    },
  };
}
