import { availableCapabilities, availableFundingMethods } from "./capabilities.js";
import type { CapabilityFlags, SuggestionId } from "./capabilities.js";
import type { ResponseState } from "./states.js";

/** The most buttons ever offered with one reply. Buttons assist the conversation; they never crowd it. */
export const MAX_SUGGESTIONS = 4;

/**
 * Which actions are worth offering after a reply. Contextual, not a reflex: a question the person must answer carries no
 * extras, a goodbye carries none, and nothing is offered for a feature that is not switched on. There is no recommendation
 * engine and no memory of past recipients here.
 */
export function suggestionPolicy(state: ResponseState, flags: CapabilityFlags): SuggestionId[] {
  const available = availableCapabilities(flags).map((capability) => capability.id);
  const only = (...wanted: SuggestionId[]): SuggestionId[] =>
    wanted.filter((id) => available.includes(id)).slice(0, MAX_SUGGESTIONS);

  switch (state) {
    // Open conversation: show what is possible.
    case "CASUAL_GREETING":
    case "CASUAL_FINANCE_CHAT":
    case "CAPABILITY_DISCOVERY":
    case "FINANCIAL_QUESTION":
    case "OUT_OF_SCOPE":
    case "RETURNING_USER":
      // Everyday actions only. Funding is offered when someone has just set up (below), not as a reflex.
      return only("SEND_MONEY", "CHECK_RATE", "CHECK_BALANCE");
    // Just finished onboarding: help them take a first step, without the whole catalogue.
    case "ONBOARDING_COMPLETE":
      return only("FUND_WALLET", "SEND_MONEY", "CHECK_RATE", "CHECK_BALANCE");
    // The funding choices: exactly the methods that really exist.
    case "FUNDING_OPTIONS":
      return availableFundingMethods(flags)
        .filter((method) => method.choice)
        .map((method) => method.id);
    // Someone just looked at a rate or a balance: the natural next step is another look, or to send.
    case "RATE_QUERY":
      return only("CHECK_RATE", "SEND_MONEY");
    // Waiting for a pair: the next thing to do is type it.
    case "RATE_PAIR_NEEDED":
      return [];
    case "BALANCE_QUERY":
      return only("SEND_MONEY", "CHECK_RATE");
    // A payment waiting on funds: the way forward is funding the wallet.
    case "INSUFFICIENT_BALANCE":
      return only("FUND_WALLET");
    // Nothing in the wallet: the way forward is funding it.
    case "BALANCE_EMPTY":
      return only("FUND_WALLET");
    // A finished payment: light, relevant follow-ups (the wording stays "Anything else?").
    case "PAYMENT_COMPLETED":
      return only("SEND_MONEY", "CHECK_BALANCE");
    // Everything else is a question to answer, a decision to make, a status or an ending: no extras.
    default:
      return [];
  }
}
