import type { Recipient } from "./recipient.js";

export type NewRecipient = Omit<Recipient, "createdAt" | "updatedAt">;

export interface RecipientRepository {
  findById(id: string): Promise<Recipient | null>;
  /** A stored recipient of this owner with the same type and identifier, if any. */
  findByIdentifier(
    ownerUserId: string,
    type: Recipient["type"],
    identifier: string,
  ): Promise<Recipient | null>;
  /** The owner's saved beneficiaries, newest first. */
  listSavedByOwner(ownerUserId: string): Promise<Recipient[]>;
  create(recipient: NewRecipient): Promise<Recipient>;
}
