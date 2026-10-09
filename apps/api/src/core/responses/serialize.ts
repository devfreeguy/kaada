import type { JsonValue } from "@kaada/domain";
import { jsonValueSchema } from "@kaada/schemas";
import { z } from "zod";

import type { AgentResponse } from "./agent-response.js";

/** Plain-JSON form of a response, for storing on the assistant message. */
export function responseToJson(response: AgentResponse): JsonValue {
  const reparsed: unknown = JSON.parse(JSON.stringify(response));
  return jsonValueSchema.parse(reparsed);
}

const option = z.object({ id: z.string(), label: z.string() });

/** The responses the core can currently produce. AUTHORIZATION_REQUIRED has no producer yet. */
const storedResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MESSAGE"), text: z.string() }),
  z.object({
    type: z.literal("CLARIFICATION_REQUIRED"),
    text: z.string(),
    intentId: z.string(),
    field: z.enum([
      "RECIPIENT",
      "AMOUNT",
      "CURRENCY",
      "SOURCE_ASSET",
      "DESTINATION_ASSET",
      "DESTINATION",
      "WALLET",
    ]),
    reason: z.enum(["MISSING", "AMBIGUOUS", "NOT_FOUND", "INVALID"]),
    options: z.array(option).optional(),
  }),
  z.object({
    type: z.literal("ROUTING_REQUIRED"),
    text: z.string(),
    intentId: z.string(),
    purpose: z.enum(["PAYMENT", "QUOTE"]),
  }),
  z.object({ type: z.literal("CANCELLED"), text: z.string(), intentId: z.string().optional() }),
]);

/**
 * Rebuilds the response stored with an assistant message (used to answer duplicate deliveries).
 * Falls back to a plain MESSAGE of the stored text if the data is missing or from an older shape.
 */
export function responseFromStored(structuredData: unknown, fallbackText: string): AgentResponse {
  const parsed = storedResponseSchema.safeParse(structuredData);
  return parsed.success ? (parsed.data as AgentResponse) : { type: "MESSAGE", text: fallbackText };
}
