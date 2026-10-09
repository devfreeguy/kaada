import { MISSING_FIELDS } from "@kaada/domain";
import type { ClarificationChoice, NewClarificationChoice } from "@kaada/domain";

import type {
  ClarificationOption as ClarificationOptionRow,
  Prisma,
} from "../generated/prisma/client.js";
import { DataIntegrityError, maybe, readJsonObjectOrEmpty, toStorableJson } from "./support.js";

function toField(value: string, id: string): ClarificationChoice["field"] {
  const field = MISSING_FIELDS.find((candidate) => candidate === value);
  if (!field) throw new DataIntegrityError(`ClarificationOption ${id}: unknown field ${value}`);
  return field;
}

export function toClarificationChoice(row: ClarificationOptionRow): ClarificationChoice {
  return {
    id: row.id,
    groupId: row.groupId,
    conversationId: row.conversationId,
    intentId: row.intentId,
    revision: row.revision,
    field: toField(row.field, row.id),
    label: row.label,
    ...maybe("description", row.description),
    value: readJsonObjectOrEmpty(row.value, "ClarificationOption.value"),
    expiresAt: row.expiresAt,
    ...maybe("usedAt", row.usedAt),
    createdAt: row.createdAt,
  };
}

export function choiceCreateData(
  choice: NewClarificationChoice,
): Prisma.ClarificationOptionUncheckedCreateInput {
  const value = toStorableJson(choice.value, "ClarificationOption.value");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataIntegrityError("ClarificationOption.value must be a JSON object");
  }
  return {
    id: choice.id,
    groupId: choice.groupId,
    conversationId: choice.conversationId,
    intentId: choice.intentId,
    revision: choice.revision,
    field: choice.field,
    label: choice.label,
    description: choice.description ?? null,
    value,
    expiresAt: choice.expiresAt,
  };
}
