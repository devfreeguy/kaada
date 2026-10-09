import type { NewRecipient, Recipient } from "@kaada/domain";

import type { Prisma, Recipient as RecipientRow } from "../generated/prisma/client.js";
import { jsonInput, maybe, readJsonObject } from "./support.js";

export function toRecipient(row: RecipientRow): Recipient {
  return {
    id: row.id,
    ...maybe("ownerUserId", row.ownerUserId),
    ...maybe("linkedUserId", row.linkedUserId),
    type: row.type,
    ...maybe("displayName", row.displayName),
    ...maybe("identifier", row.identifier),
    ...maybe("walletAddress", row.walletAddress),
    ...maybe("destinationCountry", row.destinationCountry),
    ...maybe("preferredAssetId", row.preferredAssetId),
    isSaved: row.isSaved,
    ...maybe("metadata", readJsonObject(row.metadata, "Recipient.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function recipientCreateData(recipient: NewRecipient): Prisma.RecipientUncheckedCreateInput {
  return {
    id: recipient.id,
    ownerUserId: recipient.ownerUserId ?? null,
    linkedUserId: recipient.linkedUserId ?? null,
    type: recipient.type,
    displayName: recipient.displayName ?? null,
    identifier: recipient.identifier ?? null,
    walletAddress: recipient.walletAddress ?? null,
    destinationCountry: recipient.destinationCountry ?? null,
    preferredAssetId: recipient.preferredAssetId ?? null,
    isSaved: recipient.isSaved,
    ...maybe("metadata", jsonInput(recipient.metadata, "Recipient.metadata")),
  };
}
