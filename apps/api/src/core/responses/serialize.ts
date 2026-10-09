import { MISSING_FIELDS } from "@kaada/domain";
import type { JsonValue } from "@kaada/domain";
import { jsonValueSchema } from "@kaada/schemas";
import { z } from "zod";

import type { AgentResponse } from "./agent-response.js";

/** Plain-JSON form of a response, for storing on the assistant message. */
export function responseToJson(response: AgentResponse): JsonValue {
  const reparsed: unknown = JSON.parse(JSON.stringify(response));
  return jsonValueSchema.parse(reparsed);
}

const option = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

/**
 * The responses the core produces that can be answered again from storage. Only the fields a
 * duplicate delivery needs are checked; the routing request is rebuilt from the intent, not trusted
 * from this copy. AUTHORIZATION_REQUIRED has no producer yet.
 */
const storedResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MESSAGE"), text: z.string() }),
  z.object({
    type: z.literal("CLARIFICATION_REQUIRED"),
    text: z.string(),
    intentId: z.string(),
    field: z.enum(MISSING_FIELDS),
    reason: z.enum(["MISSING", "AMBIGUOUS", "NOT_FOUND", "INVALID"]),
    options: z.array(option).optional(),
  }),
  z.looseObject({
    type: z.literal("ROUTING_REQUIRED"),
    text: z.string(),
    intentId: z.string(),
    purpose: z.enum(["PAYMENT", "QUOTE"]),
    revision: z.number().int(),
    summary: z.looseObject({}),
    request: z.looseObject({}),
  }),
  z.looseObject({
    type: z.literal("PAYMENT_READY"),
    text: z.string(),
    intentId: z.string(),
    revision: z.number().int(),
    routeId: z.string(),
  }),
  z.looseObject({
    type: z.literal("QUOTE_RESULT"),
    text: z.string(),
    intentId: z.string(),
    revision: z.number().int(),
    routeId: z.string(),
  }),
  z.object({ type: z.literal("CANCELLED"), text: z.string(), intentId: z.string().optional() }),
  z.object({
    type: z.literal("ERROR"),
    code: z.enum([
      "CHOICE_UNKNOWN",
      "CHOICE_EXPIRED",
      "CHOICE_ALREADY_USED",
      "CHOICE_STALE",
      "FEATURE_NOT_AVAILABLE",
      "ROUTING_UNSUPPORTED",
      "NO_ROUTE",
      "ROUTING_UNAVAILABLE",
      "ROUTING_STALE",
    ]),
    text: z.string(),
  }),
]);

/**
 * Rebuilds the response stored with an assistant message (used to answer duplicate deliveries).
 * Falls back to a plain MESSAGE of the stored text if the data is missing or from an older shape.
 */
export function responseFromStored(structuredData: unknown, fallbackText: string): AgentResponse {
  const parsed = storedResponseSchema.safeParse(structuredData);
  return parsed.success ? (parsed.data as AgentResponse) : { type: "MESSAGE", text: fallbackText };
}
