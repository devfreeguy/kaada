import type { MissingField } from "@kaada/domain";

import type {
  ClarificationOption,
  ClarificationReason,
  ClarificationRequiredResponse,
} from "./agent-response.js";

export type Operation = "SEND" | "CONVERT" | "QUOTE";

/** A question the agent needs answered before an intent can move on. Wording is derived from it. */
export interface Clarification {
  operation: Operation;
  field: MissingField;
  reason: ClarificationReason;
  /** What the problem is about: a name the user typed, an asset label, a currency symbol. */
  subject?: string;
  /** Extra detail for the wording, e.g. how many decimals a currency allows. */
  decimals?: number;
  /** Why a recipient was not found, when that changes the wording. */
  detail?: "INVALID_FORMAT" | "UNSUPPORTED_TYPE";
  options?: ClarificationOption[];
}

const VERB: Record<Operation, string> = {
  SEND: "send",
  CONVERT: "convert",
  QUOTE: "get a quote for",
};

/** Deterministic, plain wording. A future response generator can make it friendlier. */
export function clarificationText(clarification: Clarification): string {
  const { operation, field, reason, subject, decimals, detail } = clarification;

  switch (field) {
    case "AMOUNT":
      if (reason === "INVALID") {
        return `${subject ?? "That currency"} supports up to ${decimals ?? 0} decimal places. How much would you like to ${VERB[operation]}?`;
      }
      return `How much would you like to ${VERB[operation]}?`;

    case "RECIPIENT":
      if (reason === "AMBIGUOUS") {
        return `I found more than one ${subject ?? "match"}. Which one do you mean?`;
      }
      if (reason === "NOT_FOUND") {
        if (detail === "INVALID_FORMAT") {
          return "That doesn't look like a valid wallet address. Who would you like to send it to?";
        }
        if (detail === "UNSUPPORTED_TYPE") {
          return "I can't look up that kind of contact yet. You can use a saved contact, a Kaada username, or a wallet address. Who would you like to send it to?";
        }
        return `I couldn't find ${subject ?? "that recipient"}. Who would you like to send it to? You can use a saved contact, a Kaada username, or a wallet address.`;
      }
      return "Who would you like to send it to?";

    case "SOURCE_ASSET":
      return assetQuestion(reason, subject, "Which currency or token do you want to convert from?");

    case "DESTINATION_ASSET":
      return assetQuestion(reason, subject, "Which currency or token do you want to receive?");

    case "DESTINATION":
      if (reason === "NOT_FOUND" || reason === "AMBIGUOUS") {
        return assetQuestion(reason, subject, "Which currency or country should they receive?");
      }
      return "Which currency or country should they receive?";

    case "WALLET":
      return "You need a wallet before you can do that.";
  }
}

function assetQuestion(
  reason: ClarificationReason,
  subject: string | undefined,
  missing: string,
): string {
  if (reason === "NOT_FOUND") {
    return `I don't support ${subject ?? "that"} yet. Which currency would you like to use instead?`;
  }
  if (reason === "AMBIGUOUS") {
    return `${subject ?? "That"} matches more than one asset. Which one do you mean?`;
  }
  return missing;
}

export function toClarificationResponse(
  clarification: Clarification,
  intentId: string,
  prefix = "",
): ClarificationRequiredResponse {
  return {
    type: "CLARIFICATION_REQUIRED",
    text: `${prefix}${clarificationText(clarification)}`,
    intentId,
    field: clarification.field,
    reason: clarification.reason,
    ...(clarification.options && { options: clarification.options }),
  };
}
