import { KaadaError, amountAssetIdFor, createMoney } from "@kaada/domain";
import type { Intent, IntentAmountResolved, NewIntent } from "@kaada/domain";
import { agentIntentSchema, missingFieldsSchema, paymentConstraintsSchema } from "@kaada/schemas";

import { Prisma } from "../generated/prisma/client.js";
import type { Intent as IntentRow } from "../generated/prisma/client.js";
import { DataIntegrityError, jsonInput, maybe, parseColumn } from "./support.js";

function isEmptyObject(value: Prisma.JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export function toIntent(row: IntentRow): Intent {
  // normalizedData is {} until the language stage has extracted something.
  const parsed = isEmptyObject(row.normalizedData)
    ? undefined
    : parseColumn(agentIntentSchema, row.normalizedData, "Intent.normalizedData");
  if (parsed && parsed.type !== row.type) {
    throw new DataIntegrityError(
      `Intent ${row.id}: normalizedData type ${parsed.type} != ${row.type}`,
    );
  }

  let amount: IntentAmountResolved | undefined;
  if (row.amount !== null) {
    if (row.amountMode === null) {
      throw new DataIntegrityError(`Intent ${row.id}: amount without amountMode`);
    }
    const assetId = amountAssetIdFor(row.amountMode, {
      ...maybe("sourceAssetId", row.sourceAssetId),
      ...maybe("destinationAssetId", row.destinationAssetId),
    });
    if (assetId === undefined) {
      throw new DataIntegrityError(
        `Intent ${row.id}: amount has no asset for mode ${row.amountMode}`,
      );
    }
    amount = { money: createMoney(row.amount, assetId), mode: row.amountMode };
  }

  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    type: row.type,
    status: row.status,
    ...maybe("amount", amount),
    ...maybe("sourceAssetId", row.sourceAssetId),
    ...maybe("destinationAssetId", row.destinationAssetId),
    ...maybe("recipientId", row.recipientId),
    ...maybe("destinationCountry", row.destinationCountry),
    ...maybe("parsed", parsed),
    ...maybe(
      "constraints",
      row.constraints === null
        ? undefined
        : parseColumn(paymentConstraintsSchema, row.constraints, "Intent.constraints"),
    ),
    missingFields:
      row.missingFields === null
        ? []
        : parseColumn(missingFieldsSchema, row.missingFields, "Intent.missingFields"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type MutableIntent = Pick<
  Intent,
  | "status"
  | "amount"
  | "sourceAssetId"
  | "destinationAssetId"
  | "recipientId"
  | "destinationCountry"
  | "parsed"
  | "constraints"
  | "missingFields"
>;

function intentColumns(intent: MutableIntent, absentJson: typeof Prisma.DbNull | undefined) {
  if (intent.amount) {
    const expected = amountAssetIdFor(intent.amount.mode, intent);
    if (expected !== intent.amount.money.assetId) {
      throw new KaadaError("ASSET_MISMATCH", "intent amount asset does not match its amount mode", {
        details: { mode: intent.amount.mode },
      });
    }
  }
  return {
    status: intent.status,
    amount: intent.amount?.money.amount ?? null,
    amountMode: intent.amount?.mode ?? null,
    sourceAssetId: intent.sourceAssetId ?? null,
    destinationAssetId: intent.destinationAssetId ?? null,
    recipientId: intent.recipientId ?? null,
    destinationCountry: intent.destinationCountry ?? null,
    normalizedData: jsonInput(intent.parsed, "Intent.parsed") ?? {},
    ...maybe("constraints", jsonInput(intent.constraints, "Intent.constraints") ?? absentJson),
    ...maybe(
      "missingFields",
      jsonInput(intent.missingFields, "Intent.missingFields") ?? absentJson,
    ),
  };
}

export function intentCreateData(intent: NewIntent): Prisma.IntentUncheckedCreateInput {
  return {
    id: intent.id,
    userId: intent.userId,
    conversationId: intent.conversationId,
    type: intent.type,
    ...intentColumns(intent, undefined),
  };
}

/** Writes every mutable column from the merged intent; absent optional values become NULL. */
export function intentUpdateData(intent: MutableIntent): Prisma.IntentUncheckedUpdateInput {
  return intentColumns(intent, Prisma.DbNull);
}
