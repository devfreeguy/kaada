import type { ChatTopic } from "@kaada/domain";

import { describeCapabilities } from "./capabilities.js";
import type { CapabilityFlags } from "./capabilities.js";
import type { ResponseState } from "./states.js";

/**
 * The pieces of a spoken reply. `acknowledgement` reacts, `body` answers, `question` hands the turn back, `closing` ends
 * lightly. A model fills them (validated) or the deterministic wording below does: the user never loses a reply.
 */
export interface ReplyParts {
  acknowledgement?: string;
  body?: string;
  question?: string;
  closing?: string;
}

/** What deterministic wording may mention. Every value is trusted application state, never model output. */
export interface FallbackFacts {
  capabilities: CapabilityFlags;
  /** Why an onboarding message is being said: JUST_CREATED (it just happened), RESUMING (came back), CHECK_IN (asked). */
  context?: string | undefined;
  recipient?: string | undefined;
  amount?: string | undefined;
}

/** A stable 32-bit hash (FNV-1a): the same seed always picks the same variant, so tests and retries are repeatable. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function pick<T>(seed: string, variants: readonly T[]): T {
  const chosen = variants[hash(seed) % variants.length];
  if (chosen === undefined) throw new Error("no variants to pick from");
  return chosen;
}

/** Plain wording stored with a CHAT answer in the conversation history (the spoken reply may differ). */
const CHAT_TEXT: Record<ChatTopic, string> = {
  GREETING: "Hey 👋 What can I help you with today?",
  SMALL_TALK: "I'm good 😄 Ready when you are. What do you need?",
  FAREWELL: "Perfect 👌 Catch you later.",
  CAPABILITIES: "I can help you with money: sending it, rates and your wallet.",
  FINANCE_QUESTION: "Good question. I don't have an answer for that one yet.",
  FUNDING: "Let's get your wallet funded 💰",
  SUPPORTED_ASSETS: "Here's what your Kaada wallet works with.",
  OUT_OF_SCOPE: "That's outside my department 😄 I'm your money guy.",
  RATE_GENERAL: "Which rate would you like to check? Tell me the pair.",
};

export function chatFallbackText(topic: ChatTopic): string {
  return CHAT_TEXT[topic];
}

const HELP_EXAMPLE = "Try something like “Send Daniel $20”.";

/**
 * Deterministic wording for a state, or null when the Agent Core's own text should be used as is. `seed` makes the choice among
 * variants stable (use the message id), so variation never makes a test or a retry unpredictable.
 */
export function fallbackParts(
  state: ResponseState,
  facts: FallbackFacts,
  seed: string,
): ReplyParts | null {
  const can = describeCapabilities(facts.capabilities);
  switch (state) {
    case "CASUAL_GREETING":
      return pick(seed, [
        { acknowledgement: "Hey 👋", question: `What can I help you with today? I can ${can}.` },
        {
          acknowledgement: "Hi there 👋",
          question: `What are we sorting out today? I can ${can}.`,
        },
        { acknowledgement: "Hey, good to see you 😄", question: `What do you need? I can ${can}.` },
      ]);
    case "CASUAL_FINANCE_CHAT":
      return pick(seed, [
        { acknowledgement: "I'm good 😄 Ready when you are.", question: `Want to ${can}?` },
        {
          acknowledgement: "Doing well, thanks 👋",
          question: `Anything I can help with? I can ${can}.`,
        },
      ]);
    case "CAPABILITY_DISCOVERY":
      return {
        body: `I can ${can}.${facts.capabilities.send ? ` ${HELP_EXAMPLE}` : ""}`,
        question: "What would you like to do?",
      };
    case "FINANCIAL_QUESTION":
      return {
        acknowledgement: "Good question.",
        body: "I don't have a reliable answer for that one yet.",
        question: `I can ${can}. Want to try one?`,
      };
    case "OUT_OF_SCOPE":
      return pick(seed, [
        {
          acknowledgement: "Haha, I'm probably not the bot for that 😄",
          body: "I'm your money guy.",
          question: `Want to ${can}?`,
        },
        {
          acknowledgement: "That one's outside my department 😅",
          body: "Money is my thing.",
          question: `I can ${can}.`,
        },
        {
          acknowledgement: "Ha, can't help with that one.",
          body: "I'm better with money than with trivia.",
          question: `Shall we ${can.split(",")[0] ?? "chat about money"}?`,
        },
      ]);
    case "RATE_PAIR_NEEDED":
      return facts.capabilities.rates
        ? { question: "Which rate would you like to check? Tell me the pair, like USDT to cNGN." }
        : { body: "I can't check rates right now." };
    case "MISSING_RECIPIENT":
      return pick(seed, [
        { acknowledgement: "Sure.", question: "Who should I send it to?" },
        { acknowledgement: "Got you.", question: "Who's it going to?" },
      ]);
    case "MISSING_AMOUNT":
      return facts.recipient
        ? {
            acknowledgement: `Sure, ${facts.recipient} it is 👍`,
            question: "How much are we sending?",
          }
        : { acknowledgement: "Sure.", question: "How much would you like to send?" };
    case "MISSING_CURRENCY":
      return facts.amount
        ? { acknowledgement: "Got you.", question: `What currency is the ${facts.amount} in?` }
        : { acknowledgement: "Got you.", question: "Which currency is that in?" };
    case "AMBIGUOUS_RECIPIENT":
    case "AMBIGUOUS_ASSET":
      return pick(seed, [
        { acknowledgement: "Got it 👍" },
        { acknowledgement: "Okay, one quick check." },
      ]);
    case "PAYMENT_CORRECTION":
      return pick(seed, [
        { acknowledgement: "Updated 👍" },
        { acknowledgement: "Done, I've changed that." },
      ]);
    case "PAYMENT_READY":
    case "AUTHORIZATION_REQUIRED":
      return pick(seed, [
        { acknowledgement: "Alright, here's what I've got 👇", closing: "Everything look good?" },
        { acknowledgement: "Here's the payment 👇", closing: "Happy with this?" },
        { acknowledgement: "Okay, this is what it looks like 👇", closing: "Look right to you?" },
      ]);
    case "ONBOARDING_WALLET_NEEDED":
      return {
        acknowledgement: "Welcome to Kaada 👋",
        body: "I can help you send money, check rates and manage payments right here.",
        question:
          "First, let's get your wallet ready. It takes a minute on a secure Kaada page: your keys and PIN never go through this chat.",
      };
    case "ONBOARDING_PIN_NEEDED":
      if (facts.context === "RESUMING") {
        return {
          acknowledgement: "Looks like your wallet is ready, but your PIN still needs setting up.",
          question: "Want to finish that?",
        };
      }
      if (facts.context === "CHECK_IN") {
        return {
          acknowledgement: "Yep, your wallet is ready 🎉",
          body: "One more step: set up your 6-digit PIN so you can approve payments securely.",
        };
      }
      return {
        acknowledgement: "Wallet ready 🎉",
        body: "Now set up your 6-digit PIN. You'll use it to approve payments without having to confirm with your root credential every time.",
      };
    case "ONBOARDING_RECOVERY_NEEDED":
      return {
        acknowledgement: "Your PIN is set 👍",
        body: "One last step: set up recovery, so you can get back into your wallet if you ever lose your device.",
      };
    case "ONBOARDING_COMPLETE":
      return {
        acknowledgement: "You're all set ✅ Your Kaada wallet is ready to use.",
        question: "What do you want to do first?",
      };
    case "RETURNING_USER":
      return pick(seed, [
        { acknowledgement: "Hey 👋 Good to see you again.", question: "What are we doing today?" },
        { acknowledgement: "Welcome back 👋", question: "What can I help you with today?" },
      ]);
    case "FUNDING_OPTIONS":
      return { question: "How would you like to fund your wallet?" };
    case "CONVERSATION_END":
      return pick(seed, [
        { acknowledgement: "Perfect 👌 Catch you later." },
        { acknowledgement: "Anytime 👋 Come back whenever you need me." },
        { acknowledgement: "You got it 😊 Talk soon." },
      ]);
    case "PAYMENT_COMPLETED":
      return pick(seed, [
        { acknowledgement: "Done ✅ Your payment has been sent.", closing: "Anything else?" },
        {
          acknowledgement: "All done ✅ Your payment is on its way.",
          closing: "Anything else I can help with?",
        },
        { acknowledgement: "Sent ✅ Your payment is on its way.", closing: "Anything else?" },
      ]);
    default:
      return null;
  }
}

/** The lead/closing around a rate or balance result when the model is unavailable. */
export function resultFallback(
  state: "RATE_QUERY" | "BALANCE_QUERY",
  facts: FallbackFacts,
  seed: string,
): ReplyParts {
  if (state === "BALANCE_QUERY") {
    return {
      acknowledgement: pick(seed, ["Here's your balance 👇", "This is what you're holding 👇"]),
    };
  }
  return {
    acknowledgement: pick(seed, ["Here's the latest I've got 💱", "Here's where that stands 💱"]),
    ...(facts.capabilities.send && { closing: "Want to send some?" }),
  };
}

/** Joins the spoken pieces into one short text. */
export function joinParts(parts: ReplyParts, order: (keyof ReplyParts)[]): string {
  return order
    .map((key) => parts[key])
    .filter((piece): piece is string => typeof piece === "string" && piece.trim().length > 0)
    .map((piece) => piece.trim())
    .join(" ");
}
