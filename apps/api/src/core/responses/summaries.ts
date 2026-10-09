import type { ResolvedFacts, TransactionalIntent } from "../intents/assessment.js";
import type { RoutingRequiredResponse } from "./agent-response.js";

/**
 * The deterministic "here is what I understood" message for an intent that is ready for routing.
 * It states facts only; nothing has been priced, quoted or sent.
 */
export function routingRequiredResponse(
  intent: TransactionalIntent,
  facts: ResolvedFacts,
  intentId: string,
): RoutingRequiredResponse {
  const amount = facts.display.amount ?? "the amount";
  const recipient = facts.display.recipient ?? "the recipient";
  const exactOutput = facts.amount?.mode === "EXACT_OUTPUT";

  switch (intent.type) {
    case "SEND":
      return {
        type: "ROUTING_REQUIRED",
        intentId,
        purpose: "PAYMENT",
        text: `Got it: ${exactOutput ? `${recipient} receives ${amount}` : `you send ${amount} to ${recipient}`}. I'll find the best route next.`,
      };
    case "CONVERT":
      return {
        type: "ROUTING_REQUIRED",
        intentId,
        purpose: "PAYMENT",
        text: `Got it: ${exactOutput ? `convert to get ${amount}` : `convert ${amount}`}. I'll find the best route next.`,
      };
    case "QUOTE":
      return {
        type: "ROUTING_REQUIRED",
        intentId,
        purpose: "QUOTE",
        text: `Got it: a quote for ${amount}. I'll look up a price next. Nothing will be sent.`,
      };
  }
}
