/**
 * What Kaada can actually do in conversation, in ONE place. Suggestions, the capability answer and the model's allowed
 * suggestions all come from here, and only for features that are really switched on, so an unfinished feature can never be
 * advertised. To add a feature later: add it here and implement its button; no prompt changes.
 */
export const SUGGESTION_IDS = ["SEND_MONEY", "CHECK_RATE", "CHECK_BALANCE"] as const;
export type SuggestionId = (typeof SUGGESTION_IDS)[number];

export function isSuggestionId(value: string): value is SuggestionId {
  return (SUGGESTION_IDS as readonly string[]).includes(value);
}

/** Which features this deployment has, decided by configuration at start-up. Never by the model. */
export interface CapabilityFlags {
  /** Payments can be priced and authorized (a pricing provider AND wallets are configured). */
  send: boolean;
  /** Rates and quotes can be priced (a pricing provider is configured). */
  rates: boolean;
  /** Wallet balances can be read. */
  balance: boolean;
}

export const NO_CAPABILITIES: CapabilityFlags = { send: false, rates: false, balance: false };

export interface Capability {
  id: SuggestionId;
  /** The button label. */
  label: string;
  /** A phrase for "you can ..." sentences, and the only description of the feature the model is given. */
  blurb: string;
  requires: keyof CapabilityFlags;
}

const REGISTRY: readonly Capability[] = [
  { id: "SEND_MONEY", label: "Send money", blurb: "send money to someone", requires: "send" },
  { id: "CHECK_RATE", label: "Today's rates", blurb: "check today's rates", requires: "rates" },
  { id: "CHECK_BALANCE", label: "My balance", blurb: "see your balance", requires: "balance" },
];

export function availableCapabilities(flags: CapabilityFlags): Capability[] {
  return REGISTRY.filter((capability) => flags[capability.requires]);
}

export function capabilityById(id: SuggestionId): Capability {
  const found = REGISTRY.find((capability) => capability.id === id);
  if (!found) throw new Error(`unknown capability ${id}`);
  return found;
}

/** "send money to someone, check today's rates or see your balance" (nothing unavailable is ever listed). */
export function describeCapabilities(flags: CapabilityFlags): string {
  const blurbs = availableCapabilities(flags).map((capability) => capability.blurb);
  if (blurbs.length === 0) return "chat about money";
  if (blurbs.length === 1) return blurbs[0] ?? "";
  return `${blurbs.slice(0, -1).join(", ")} or ${blurbs[blurbs.length - 1] ?? ""}`;
}
