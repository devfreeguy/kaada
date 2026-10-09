import type { ClarificationChoiceRepository } from "@kaada/domain";

import { choiceCreateData, toClarificationChoice } from "../mappers/index.js";
import type { Db } from "./db.js";

export function createClarificationChoiceRepository(db: Db): ClarificationChoiceRepository {
  return {
    async issue(choices) {
      if (choices.length === 0) return [];
      const rows = await db.clarificationOption.createManyAndReturn({
        data: choices.map(choiceCreateData),
      });
      return rows.map(toClarificationChoice);
    },

    async findById(id) {
      const row = await db.clarificationOption.findUnique({ where: { id } });
      return row ? toClarificationChoice(row) : null;
    },

    async latestGroupId(intentId) {
      const row = await db.clarificationOption.findFirst({
        where: { intentId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { groupId: true },
      });
      return row?.groupId ?? null;
    },

    /** A conditional UPDATE: only the first caller sees a changed row, even under concurrency. */
    async markUsed(id, at) {
      const { count } = await db.clarificationOption.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: at },
      });
      return count === 1;
    },
  };
}
