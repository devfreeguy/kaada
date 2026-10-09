import { AGENT_COMMANDS } from "@kaada/domain";
import type { Interpretation } from "@kaada/domain";
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

export const agentCommandSchema = z.enum(AGENT_COMMANDS);

/** What an interpreter returns for one message: an intent, or a conversation command. */
export const interpretationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("INTENT"), intent: agentIntentSchema }),
  z.strictObject({ kind: z.literal("COMMAND"), command: agentCommandSchema }),
]) satisfies z.ZodType<Interpretation>;
