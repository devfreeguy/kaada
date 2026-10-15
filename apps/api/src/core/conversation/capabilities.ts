/**
 * What Kaada can actually do in conversation, in ONE place. Suggestions, the capability answer and the model's allowed
 * suggestions all come from here, and only for features that are really switched on, so an unfinished feature can never be
 * advertised. To add a feature later: add it here and implement its button; no prompt changes.
 */
export const SUGGESTION_IDS = [
  "SEND_MONEY",
  "CHECK_RATE",
  "CHECK_BALANCE",
  "FUND_WALLET",
  // Funding methods (the options offered after "Fund wallet"). Each exists only while its flag is on.
  "FUND_FROM_WALLET",
  "VIEW_WALLET_ADDRESS",
  "FUND_LOCAL_CURRENCY",
  /** The little CELO that pays the network fee. Offered only where a transfer cannot go ahead for want of it. */
  "FUND_CELO",
] as const;
export type SuggestionId = (typeof SUGGESTION_IDS)[number];

export function isSuggestionId(value: string): value is SuggestionId {
  return (SUGGESTION_IDS as readonly string[]).includes(value);
}

/** Which ways of putting money into a wallet really work in this deployment. */
export interface FundingFlags {
  /** The person can send tokens to their own Kaada address from another wallet or an exchange. */
  walletTransfer: boolean;
  /** A real local-currency on-ramp provider and flow exists. Stays false until one does. */
  localCurrency: boolean;
}

/** Which features this deployment has, decided by configuration at start-up. Never by the model. */
export interface CapabilityFlags {
  /** Payments can be priced and authorized (a pricing provider AND wallets are configured). */
  send: boolean;
  /** Rates and quotes can be priced (a pricing provider is configured). */
  rates: boolean;
  /** Wallet balances can be read. */
  balance: boolean;
  /** Ways to fund a wallet. Absent means none. */
  funding?: FundingFlags;
}

export const NO_CAPABILITIES: CapabilityFlags = { send: false, rates: false, balance: false };

export interface Capability {
  id: SuggestionId;
  /** The button label. */
  label: string;
  /** A phrase for "you can ..." sentences, and the only description of the feature the model is given. */
  blurb: string;
  available: (flags: CapabilityFlags) => boolean;
}

export interface FundingMethod {
  id: SuggestionId;
  label: string;
  /** Offered as a choice after "Fund wallet". A method that is only a view of another (the address) is not. */
  choice: boolean;
  available: (flags: FundingFlags) => boolean;
}

/**
 * Funding methods, in the order they are offered. A method with no working provider behind it is simply not available: add
 * the provider and flip its flag, and the button appears everywhere. Never listed here "for later" with its flag on.
 */
const FUNDING_METHODS: readonly FundingMethod[] = [
  {
    id: "FUND_FROM_WALLET",
    label: "Send from another wallet",
    choice: true,
    available: (f) => f.walletTransfer,
  },
  {
    id: "VIEW_WALLET_ADDRESS",
    label: "View wallet address",
    choice: false,
    available: (f) => f.walletTransfer,
  },
  {
    id: "FUND_CELO",
    label: "⛽ Fund CELO",
    choice: false,
    available: (f) => f.walletTransfer,
  },
  {
    id: "FUND_LOCAL_CURRENCY",
    label: "Fund with local currency",
    choice: true,
    available: (f) => f.localCurrency,
  },
];

export function availableFundingMethods(flags: CapabilityFlags): FundingMethod[] {
  const funding = flags.funding;
  return funding ? FUNDING_METHODS.filter((method) => method.available(funding)) : [];
}

const REGISTRY: readonly Capability[] = [
  {
    id: "FUND_WALLET",
    label: "💰 Fund wallet",
    blurb: "help you fund your wallet",
    available: (flags) => availableFundingMethods(flags).length > 0,
  },
  {
    id: "SEND_MONEY",
    label: "💸 Send money",
    blurb: "send money to someone",
    available: (flags) => flags.send,
  },
  {
    id: "CHECK_RATE",
    label: "💱 Today's rates",
    blurb: "check today's rates",
    available: (flags) => flags.rates,
  },
  {
    id: "CHECK_BALANCE",
    label: "👛 Balance",
    blurb: "see your balance",
    available: (flags) => flags.balance,
  },
];

export function availableCapabilities(flags: CapabilityFlags): Capability[] {
  return REGISTRY.filter((capability) => capability.available(flags));
}

/** The label of any button: a capability or a funding method. */
export function labelOf(id: SuggestionId): string {
  const capability = REGISTRY.find((entry) => entry.id === id);
  if (capability) return capability.label;
  const method = FUNDING_METHODS.find((entry) => entry.id === id);
  if (method) return method.label;
  throw new Error(`unknown capability ${id}`);
}

/** "send money to someone, check today's rates or see your balance" (nothing unavailable is ever listed). */
export function describeCapabilities(flags: CapabilityFlags): string {
  const blurbs = availableCapabilities(flags)
    // Funding is something to do once, not part of the everyday pitch.
    .filter((capability) => capability.id !== "FUND_WALLET")
    .map((capability) => capability.blurb);
  if (blurbs.length === 0) return "chat about money";
  if (blurbs.length === 1) return blurbs[0] ?? "";
  return `${blurbs.slice(0, -1).join(", ")} or ${blurbs[blurbs.length - 1] ?? ""}`;
}
