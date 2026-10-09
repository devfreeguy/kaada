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
 *
 * For CONVERT and QUOTE the amount's own currency already names the fixed side of the trade, so a
 * separate fromAsset (when the input is fixed) or toAsset (when the output is fixed) is not needed
 * once an amount exists. The other side must be stated. Amounts without a mode are read as
 * EXACT_INPUT here; the application derives the final mode with more context.
 */
export function findMissingFields(intent: AgentIntent): MissingField[] {
  const missing: MissingField[] = [];
  switch (intent.type) {
    case "SEND":
      if (!intent.amount) missing.push("AMOUNT");
      if (!intent.recipient) missing.push("RECIPIENT");
      break;
    case "CONVERT": {
      if (!intent.amount) missing.push("AMOUNT");
      const outputFixed = intent.amount?.mode === "EXACT_OUTPUT";
      if (!intent.fromAsset && (outputFixed || !intent.amount)) missing.push("SOURCE_ASSET");
      if (!intent.toAsset && (!outputFixed || !intent.amount)) missing.push("DESTINATION_ASSET");
      break;
    }
    case "QUOTE": {
      if (!intent.amount) missing.push("AMOUNT");
      const outputFixed = intent.amount?.mode === "EXACT_OUTPUT";
      if (!intent.fromAsset && (outputFixed || !intent.amount)) missing.push("SOURCE_ASSET");
      if (!intent.toAsset && !intent.destination && (!outputFixed || !intent.amount)) {
        missing.push("DESTINATION");
      }
      break;
    }
    case "BALANCE":
    case "TRANSACTION_STATUS":
    case "HELP":
    case "UNKNOWN":
      break;
  }
  return missing;
}
