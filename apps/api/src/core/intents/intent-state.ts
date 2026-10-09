import { createId } from "@kaada/domain";
import type { NewIntent, ResolvedRecipient } from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";
import type { Assessment, TransactionalIntent } from "./assessment.js";

interface IntentStateInput {
  id: string;
  userId: string;
  conversationId: string;
  parsed: TransactionalIntent;
  assessment: Assessment;
  recipientId: string | undefined;
}

/**
 * The persisted shape of an intent after assessment: typed columns for what was resolved, the
 * human-level extraction in `parsed`, and the still-missing fields. Status is derived, never chosen
 * by the language model: RESOLVED means "ready to plan a route", nothing more. The revision is not
 * decided here; commitIntent sets it.
 */
export function buildIntentState(input: IntentStateInput): NewIntent {
  const { assessment, parsed } = input;
  const { facts } = assessment;
  const missing =
    assessment.status === "READY"
      ? []
      : [...new Set(assessment.clarifications.map((clarification) => clarification.field))];

  return {
    id: input.id,
    userId: input.userId,
    conversationId: input.conversationId,
    type: parsed.type,
    status: assessment.status === "READY" ? "RESOLVED" : "AWAITING_DETAILS",
    ...(facts.amount && { amount: facts.amount }),
    ...(facts.sourceAssetId && { sourceAssetId: facts.sourceAssetId }),
    ...(facts.destinationAssetId && { destinationAssetId: facts.destinationAssetId }),
    ...(facts.preferredSourceAssetId && { preferredSourceAssetId: facts.preferredSourceAssetId }),
    ...(facts.destinationCountry && { destinationCountry: facts.destinationCountry }),
    ...(input.recipientId && { recipientId: input.recipientId }),
    parsed,
    ...(parsed.constraints && { constraints: parsed.constraints }),
    missingFields: missing,
    revision: 1,
  };
}

/**
 * The stored Recipient row for a resolved recipient, created (unsaved) the first time it is used.
 * This gives the intent a stable reference that later steps read instead of re-resolving a name.
 */
export async function ensureRecipientRecord(
  repositories: Pick<AgentRepositories, "recipients">,
  ownerUserId: string,
  resolved: ResolvedRecipient,
): Promise<string> {
  if (resolved.recipientId) return resolved.recipientId;

  const type = resolved.reference.type;
  const identifier =
    resolved.linkedUserId ??
    resolved.walletAddress ??
    resolved.reference.value.trim().toLowerCase();
  const existing = await repositories.recipients.findByIdentifier(ownerUserId, type, identifier);
  if (existing) return existing.id;

  const created = await repositories.recipients.create({
    id: createId(),
    ownerUserId,
    type,
    identifier,
    isSaved: false,
    ...(resolved.linkedUserId && { linkedUserId: resolved.linkedUserId }),
    ...(resolved.displayName && { displayName: resolved.displayName }),
    ...(resolved.walletAddress && { walletAddress: resolved.walletAddress }),
  });
  return created.id;
}
