/**
 * What a person needs to put money into their Kaada wallet, worded by the application. Every value here (address, network,
 * tokens) comes from trusted application state; no model writes or paraphrases any of it.
 */
export interface FundingInfo {
  /** The wallet's public address. */
  address: string;
  /** The network name, e.g. "Celo". */
  network: string;
  /** What the wallet supports, as people name it: one line per currency ("🇳🇬 Nigerian Naira"), never a token ticker. */
  assets: string[];
}

export function fundingInstructions(info: FundingInfo): string {
  const supported =
    info.assets.length > 0
      ? `Your Kaada wallet currently supports:\n${info.assets.join("\n")}`
      : "";
  return [
    "Sure 👍 You can fund your Kaada wallet from another wallet.",
    `Network: ${info.network}\nWallet: ${info.address}`,
    supported,
    `Only send supported currencies on the ${info.network} network to this address. Funds sent on another network, or unsupported assets, may not appear in Kaada and may be difficult or impossible to recover.`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function walletAddressMessage(info: FundingInfo): string {
  return `Your Kaada wallet\nNetwork: ${info.network}\nAddress: ${info.address}`;
}

export const FUNDING_NOT_READY =
  "Your wallet isn't ready yet. Send /start and I'll take you through the setup.";
export const FUNDING_UNAVAILABLE = "That way of funding your wallet isn't available.";
export const FUNDING_NONE = "Funding your wallet from here isn't available yet.";

/** Putting a little CELO in the wallet so a transfer can pay its network fee. Said only when that is the thing missing. */
export function networkFeeFundingMessage(info: FundingInfo): string {
  return `To cover the network fee, send a small amount of CELO to your Kaada wallet.\n\nNetwork: ${info.network}\nWallet: ${info.address}`;
}
