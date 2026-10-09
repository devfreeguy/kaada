import { z } from "zod";

import { agentIntentSchema } from "../intents/index.js";

/**
 * The schema an LLM must satisfy when asked to extract an intent. It is the same strict
 * discriminated union used everywhere else, so there is one definition of "a valid intent".
 */
export const llmIntentOutputSchema = agentIntentSchema;

/** JSON Schema form of the above, for providers that accept a schema for structured output. */
export function llmIntentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(llmIntentOutputSchema, { io: "input" });
}
