import { isUuid } from "@kaada/domain";
import type {
  ClarificationChoice,
  ClarificationChoiceRepository,
  Intent,
  JsonObject,
  ResolvedRecipient,
  TransactionalIntent,
} from "@kaada/domain";
import { idSchema, jsonObjectSchema, resolvedRecipientSchema } from "@kaada/schemas";
import { z } from "zod";

/*
 * Structured choices. A clarification question can come with selectable answers. What a choice MEANS
 * is stored on the server when the question is asked; the channel only receives an opaque id and a
 * label. Selecting an option is therefore a lookup, never an instruction from the client: nothing a
 * button carries is trusted as data.
 */

/** Which asset label of the intent an asset choice replaces. */
export const ASSET_TARGETS = [
  "AMOUNT",
  "SOURCE_PREFERENCE",
  "FROM_ASSET",
  "TO_ASSET",
  "DESTINATION",
] as const;
export type AssetTarget = (typeof ASSET_TARGETS)[number];

export type ChoiceValue =
  | { kind: "RECIPIENT"; recipient: ResolvedRecipient }
  | { kind: "ASSET"; target: AssetTarget; assetId: string };

const choiceValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("RECIPIENT"), recipient: resolvedRecipientSchema }),
  z.strictObject({ kind: z.literal("ASSET"), target: z.enum(ASSET_TARGETS), assetId: idSchema }),
]);

/** An answer the assessment proposes, before it has been stored and given an id. */
export interface ChoiceDraft {
  label: string;
  description?: string;
  value: ChoiceValue;
}

/** The plain-JSON form stored with the option. */
export function toStoredValue(value: ChoiceValue): JsonObject {
  const reparsed: unknown = JSON.parse(JSON.stringify(value));
  return jsonObjectSchema.parse(reparsed);
}

/** Reads a stored value back, or undefined if it is not a value this code understands. */
export function fromStoredValue(stored: JsonObject): ChoiceValue | undefined {
  const parsed = choiceValueSchema.safeParse(stored);
  return parsed.success ? (parsed.data as ChoiceValue) : undefined;
}

/**
 * The intent with one asset label replaced by a specific asset id. The asset resolver understands
 * ids, so the chosen asset resolves exactly and the original ambiguous label is gone. Returns
 * undefined when the target does not apply to this kind of intent.
 */
export function applyAssetChoice(
  intent: TransactionalIntent,
  target: AssetTarget,
  assetId: string,
): TransactionalIntent | undefined {
  switch (target) {
    case "AMOUNT":
      return intent.amount
        ? { ...intent, amount: { ...intent.amount, currencyOrAsset: assetId } }
        : undefined;
    case "SOURCE_PREFERENCE":
      return intent.type === "SEND" ? { ...intent, sourceAsset: assetId } : undefined;
    case "FROM_ASSET":
      return intent.type === "SEND" ? undefined : { ...intent, fromAsset: assetId };
    case "TO_ASSET":
      return intent.type === "SEND" ? undefined : { ...intent, toAsset: assetId };
    case "DESTINATION": {
      if (intent.type === "CONVERT") return undefined;
      const { asset: _replaced, ...destination } = intent.destination ?? {};
      return { ...intent, destination: { ...destination, currency: assetId } };
    }
  }
}

export type ChoiceRejection = "UNKNOWN" | "EXPIRED" | "ALREADY_USED" | "STALE";

export type ChoiceVerdict =
  | { ok: true; value: ChoiceValue; choice: ClarificationChoice }
  | { ok: false; rejection: ChoiceRejection };

/**
 * Decides whether a selected option may be applied. Every check comes from server state:
 * - the option exists and belongs to THIS conversation (an unknown id and another conversation's id
 *   are indistinguishable to the caller);
 * - it has not been used and has not expired;
 * - the conversation's open intent is the one it was asked about, at the same revision, so any
 *   financial change since makes it stale;
 * - it belongs to the latest question asked for that intent.
 */
export async function verifyChoice(
  repositories: { clarifications: ClarificationChoiceRepository },
  request: {
    optionId: string;
    conversationId: string;
    active: Intent | null;
    now: Date;
  },
): Promise<ChoiceVerdict> {
  if (!isUuid(request.optionId)) return { ok: false, rejection: "UNKNOWN" };

  const choice = await repositories.clarifications.findById(request.optionId);
  if (!choice || choice.conversationId !== request.conversationId) {
    return { ok: false, rejection: "UNKNOWN" };
  }
  if (choice.usedAt) return { ok: false, rejection: "ALREADY_USED" };
  if (request.now.getTime() >= choice.expiresAt.getTime())
    return { ok: false, rejection: "EXPIRED" };

  const { active } = request;
  if (
    !active ||
    active.id !== choice.intentId ||
    active.revision !== choice.revision ||
    active.status !== "AWAITING_DETAILS" ||
    active.missingFields[0] !== choice.field
  ) {
    return { ok: false, rejection: "STALE" };
  }
  const latest = await repositories.clarifications.latestGroupId(choice.intentId);
  if (latest !== choice.groupId) return { ok: false, rejection: "STALE" };

  const value = fromStoredValue(choice.value);
  if (!value) return { ok: false, rejection: "STALE" };
  return { ok: true, value, choice };
}
