import type { Intent, RoutingRequest } from "@kaada/domain";

import type { ResolvedFacts, TransactionalIntent } from "../intents/assessment.js";
import type { IntentSummary, RoutingRequiredResponse } from "./agent-response.js";

/** The resolved intent in display terms. Everything shown was stated or resolved; nothing is priced. */
export function summarizeIntent(
  intent: TransactionalIntent,
  facts: ResolvedFacts,
): IntentSummary | undefined {
  if (!facts.amount || !facts.display.amount) return undefined;
  return {
    operation: intent.type,
    ...(facts.display.recipient && { recipient: facts.display.recipient }),
    amount: { display: facts.display.amount, mode: facts.amount.mode },
    ...(facts.display.preferredSource && { preferredSourceAsset: facts.display.preferredSource }),
    ...(facts.destinationCountry &&
      facts.display.country && {
        destination: { code: facts.destinationCountry, label: facts.display.country },
      }),
  };
}

/**
 * The deterministic "here is what I understood" message for an intent that is ready for routing.
 * It states facts only; nothing has been priced, quoted or sent.
 */
export function routingRequiredResponse(
  summary: IntentSummary,
  saved: Intent,
  request: RoutingRequest,
): RoutingRequiredResponse {
  const recipient = summary.recipient ?? "the recipient";
  const amount = summary.amount.display;
  const exactOutput = summary.amount.mode === "EXACT_OUTPUT";
  const where = summary.destination ? ` in ${summary.destination.label}` : "";
  const funding = summary.preferredSourceAsset
    ? `, paying with ${summary.preferredSourceAsset}`
    : "";

  switch (summary.operation) {
    case "SEND": {
      const what = exactOutput
        ? `${recipient} receives ${amount}${where}`
        : `you send ${amount} to ${recipient}${where}`;
      return build(`Got it: ${what}${funding}. I'll find the best route next.`);
    }
    case "CONVERT":
      return build(
        `Got it: ${exactOutput ? `convert to get ${amount}` : `convert ${amount}`}. I'll find the best route next.`,
      );
    case "QUOTE":
      return build(
        `Got it: a quote for ${amount}${where}. I'll look up a price next. Nothing will be sent.`,
      );
  }

  function build(text: string): RoutingRequiredResponse {
    return {
      type: "ROUTING_REQUIRED",
      text,
      intentId: saved.id,
      purpose: request.purpose,
      revision: saved.revision,
      summary,
      request,
    };
  }
}
