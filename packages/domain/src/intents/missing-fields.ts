import type { AgentIntent } from "./agent-intent.js";

export const MISSING_FIELDS = [
  "RECIPIENT",
  "AMOUNT",
  "SOURCE_ASSET",
  "DESTINATION_ASSET",
  "DESTINATION",
  "WALLET",
] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

/**
 * Which required fields an extracted intent has not provided yet. This is a presence check only:
 * it never guesses and never validates values. WALLET is not derivable from the message (it depends
 * on the user's account), so callers add it themselves when a payment needs a wallet the user lacks.
 */
export function findMissingFields(intent: AgentIntent): MissingField[] {
  const missing: MissingField[] = [];
  switch (intent.type) {
    case "SEND":
      if (!intent.recipient) missing.push("RECIPIENT");
      if (!intent.amount) missing.push("AMOUNT");
      break;
    case "CONVERT":
      if (!intent.amount) missing.push("AMOUNT");
      if (!intent.fromAsset) missing.push("SOURCE_ASSET");
      if (!intent.toAsset) missing.push("DESTINATION_ASSET");
      break;
    case "QUOTE":
      if (!intent.amount) missing.push("AMOUNT");
      if (!intent.fromAsset) missing.push("SOURCE_ASSET");
      if (!intent.toAsset && !intent.destination) missing.push("DESTINATION");
      break;
    case "BALANCE":
    case "TRANSACTION_STATUS":
    case "HELP":
    case "UNKNOWN":
      break;
  }
  return missing;
}
