import type { Intent } from "./intent.js";

export type NewIntent = Omit<Intent, "createdAt" | "updatedAt">;

/** Fields an intent may change after creation. */
export type IntentUpdate = Partial<
  Omit<Intent, "id" | "userId" | "conversationId" | "type" | "createdAt" | "updatedAt">
>;

export interface IntentRepository {
  create(intent: NewIntent): Promise<Intent>;
  findById(id: string): Promise<Intent | null>;
  /** The most recent intent in the conversation that can still be completed, if any. */
  findOpenByConversation(conversationId: string): Promise<Intent | null>;
  /** Applies only the fields present in `update`. */
  update(id: string, update: IntentUpdate): Promise<Intent>;
}
