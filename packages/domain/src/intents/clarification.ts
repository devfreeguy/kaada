import type { JsonObject } from "../json.js";
import type { MissingField } from "./missing-fields.js";

/**
 * One selectable answer to a clarification question, as stored on the server. A channel only ever
 * sees `id`, `label` and `description`. `value` (what choosing the option means) never leaves the
 * server, and a selection is honoured only by looking this row up again.
 */
export interface ClarificationChoice {
  id: string;
  /** Options created for one question share a group; the newest group is the active question. */
  groupId: string;
  conversationId: string;
  intentId: string;
  /** The intent revision the question was asked at. Another revision makes the option stale. */
  revision: number;
  field: MissingField;
  label: string;
  description?: string;
  value: JsonObject;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

export type NewClarificationChoice = Omit<ClarificationChoice, "createdAt" | "usedAt">;

export interface ClarificationChoiceRepository {
  /** Stores all options of one question together. */
  issue(choices: NewClarificationChoice[]): Promise<ClarificationChoice[]>;
  findById(id: string): Promise<ClarificationChoice | null>;
  /** The group id of the most recently asked question for an intent, if any. */
  latestGroupId(intentId: string): Promise<string | null>;
  /**
   * Marks an option used. True only for the one caller that got there first, so a repeated or
   * concurrent selection cannot be applied twice.
   */
  markUsed(id: string, at: Date): Promise<boolean>;
}
