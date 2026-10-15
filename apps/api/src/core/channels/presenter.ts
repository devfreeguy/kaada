import type { SuggestionId } from "../conversation/capabilities.js";
import type { AgentResponse, AuthorizationSummary } from "../responses/agent-response.js";

/**
 * An agent answer in channel-neutral, presentable form: words plus what a person may DO next. No provider markup, no buttons
 * objects: the message service turns `choices` into stored actions and links, and an adapter turns those into its own buttons.
 */
export interface PresentedMessage {
  text: string;
  /** Selectable answers to a question. Each `optionId` is the agent's own opaque, server-bound id. */
  choices?: { optionId: string; label: string; description?: string }[];
  /** A priced payment waiting for the person's PIN, on a secure page. */
  authorization?: { sessionId: string; expiresAt: Date };
  /** The person needs a Kaada wallet first: offer the secure setup page. */
  setup?: boolean;
  /** Offer a Cancel button (something is in progress that can be dropped). */
  cancellable?: boolean;
  /** A secure page to open (the setup page, or the PIN step), issued by the channel service when it composes the message. */
  link?: { kind: "WALLET_SETUP" | "PIN_SETUP"; label: string };
  /** Address-like text to show monospace, and a copy button for it (see OutboundChannelMessage.code and COPY_TEXT). */
  code?: string[];
  copy?: { label: string; text: string };
  /** A payment is still open behind this answer: offer to carry on with it (or cancel it). The ids are trusted state. */
  resume?: { intentId: string; revision: number };
  /** Things worth offering next, from the server's allowlist (see conversation/suggestions). Rendered as buttons by the channel. */
  suggestions?: SuggestionId[];
}

/** The payment summary: only figures the authorization will bind, labelled for people. */
export function describePayment(
  summary: AuthorizationSummary,
  options: { mock?: boolean | undefined },
): string {
  const lines: string[] = [];
  lines.push(summary.recipient ? `Payment to ${summary.recipient}` : "Payment");
  if (summary.amountMode === "EXACT_OUTPUT") {
    lines.push(`They receive exactly: ${summary.recipientReceives.display}`);
    lines.push(
      `You spend: about ${summary.senderSpends.display}, never more than ${summary.maximumSpend.display}`,
    );
  } else {
    lines.push(`You spend exactly: ${summary.senderSpends.display}`);
    lines.push(
      `They receive: about ${summary.recipientReceives.display}, at least ${summary.minimumReceive.display}`,
    );
  }
  return `${lines.join("\n")}${options.mock ? "\n(Test prices: no real money moves.)" : ""}`;
}

const feeLine = (fees: { display: string }[]): string | null =>
  fees.length === 0 ? null : `Fees: ${fees.map((fee) => fee.display).join(" + ")}`;

/** Maps an agent response to what a person is shown. Never parses `text` to decide anything: only the typed fields. */
export function presentAgentResponse(response: AgentResponse, _now: Date): PresentedMessage {
  switch (response.type) {
    case "MESSAGE":
      return { text: response.text };

    case "CLARIFICATION_REQUIRED":
      return {
        text: response.text,
        cancellable: true,
        ...(response.options &&
          response.options.length > 0 && {
            choices: response.options.map((option) => ({
              optionId: option.id,
              label: option.label,
              ...(option.description && { description: option.description }),
            })),
          }),
      };

    case "ROUTING_REQUIRED":
      return { text: response.text, cancellable: true };

    case "AUTHORIZATION_REQUIRED": {
      const expiresAt = new Date(response.expiresAt);
      const fees = feeLine(response.fees);
      const body = [
        describePayment(response.summary, { mock: response.mock }),
        fees,
        "You confirm with your 6-digit PIN on a secure Kaada page. Never type it in this chat.",
      ].filter((line): line is string => line !== null);
      return {
        text: body.join("\n\n"),
        authorization: { sessionId: response.authorizationSessionId, expiresAt },
        cancellable: true,
      };
    }

    case "PAYMENT_READY":
      return { text: response.text, cancellable: true };

    case "QUOTE_RESULT":
      return { text: response.text };

    case "CANCELLED":
      return { text: response.text };

    // Plain wording only; the conversation layer replaces it with a friendlier reply when it can.
    case "CHAT":
    case "SIDE_QUOTE_REQUIRED":
    case "BALANCE_REQUIRED":
    case "BALANCE_RESULT":
      return { text: response.text };

    case "ERROR":
      return presentError(response);
  }
}

function presentError(response: Extract<AgentResponse, { type: "ERROR" }>): PresentedMessage {
  switch (response.code) {
    case "WALLET_SETUP_REQUIRED":
      return {
        text: "To send money you first need to set up your Kaada wallet. It takes a minute and happens on a secure page.",
        setup: true,
      };
    case "NO_ROUTE":
      return {
        text: "I can't find an available route for that payment right now. Try a different amount or currency.",
      };
    case "ROUTING_UNAVAILABLE":
    case "ROUTING_STALE":
      return { text: "Pricing is temporarily unavailable. Please try again in a moment." };
    case "ROUTING_UNSUPPORTED":
      return { text: response.text };
    case "CHOICE_EXPIRED":
    case "CHOICE_STALE":
    case "CHOICE_UNKNOWN":
    case "CHOICE_ALREADY_USED":
      return {
        text: "That option is no longer available. Tell me what you'd like to do and I'll start from where we are.",
      };
    // A payment that cannot go ahead for want of funds points at the way forward. The payment itself stays open.
    case "WALLET_NEEDS_FUNDING":
      return {
        text: "You don't have a supported balance for this payment yet.\n\nWant to fund your wallet?",
        suggestions: ["FUND_WALLET"],
        cancellable: true,
      };
    // Only the network fee is missing: say that and nothing else (the money itself is fine).
    case "GAS_FUNDING_REQUIRED":
      return { text: response.text, suggestions: ["FUND_CELO"], cancellable: true };
    case "INSUFFICIENT_BALANCE":
      return {
        text: `${response.text}\n\nWant to fund your wallet and come back to it?`,
        suggestions: ["FUND_WALLET"],
        cancellable: true,
      };
    case "FEATURE_NOT_AVAILABLE":
    case "BALANCE_UNAVAILABLE":
      return { text: response.text };
  }
}
