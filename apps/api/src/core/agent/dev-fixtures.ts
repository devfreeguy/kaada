import type { AgentIntent, Interpretation } from "@kaada/domain";

import { MockIntentInterpreter } from "./mock-interpreter.js";

const intent = (value: AgentIntent): Interpretation => ({ kind: "INTENT", intent: value });

/**
 * Exact phrases the development interpreter understands, each mapped to the structured result a
 * real LLM would be expected to return. This is a lookup table, not language understanding: any
 * other text is UNKNOWN. It exists so the agent core can be exercised by hand before a real model
 * is connected, and it is refused in production (see AGENT_INTERPRETER).
 */
export const DEV_FIXTURES: Record<string, Interpretation> = {
  // Multi-turn SEND: ask for a recipient, then provide one, then correct the amount.
  "send $20": intent({
    type: "SEND",
    amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
  }),
  "send $50": intent({
    type: "SEND",
    amount: { value: "50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
  }),
  "send $20 to daniel": intent({
    type: "SEND",
    recipient: { type: "USERNAME", value: "daniel" },
    amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
  }),
  daniel: intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } }),
  "actually make that $40": intent({
    type: "SEND",
    amount: { value: "40", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
  }),

  // Exact output, with a destination country.
  "send joao r$500 in brazil": intent({
    type: "SEND",
    recipient: { type: "USERNAME", value: "joao" },
    amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
    destination: { country: "BR" },
  }),

  // Needs assets that are not seeded yet, so these show the "not supported" path.
  "convert 100 usdc to cngn": intent({
    type: "CONVERT",
    amount: { value: "100", currencyOrAsset: "USDC", mode: "EXACT_INPUT" },
    fromAsset: "USDC",
    toAsset: "cNGN",
  }),
  "convert 100 usd to ngn": intent({
    type: "CONVERT",
    amount: { value: "100", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
    fromAsset: "USD",
    toAsset: "NGN",
  }),
  "how much would 50 usd give me in brazil": intent({
    type: "QUOTE",
    amount: { value: "50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
    fromAsset: "USD",
    destination: { country: "BR" },
  }),

  // Conversation controls and informational requests.
  "cancel that": { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" },
  "start over": { kind: "COMMAND", command: "START_OVER" },
  "don't use usdt": { kind: "COMMAND", command: "REMOVE_SOURCE_PREFERENCE" },
  help: intent({ type: "HELP" }),
  "what is my balance": intent({ type: "BALANCE" }),
  "where is my payment": intent({ type: "TRANSACTION_STATUS" }),
};

export function createDevInterpreter(): MockIntentInterpreter {
  return MockIntentInterpreter.byMessage(DEV_FIXTURES);
}
