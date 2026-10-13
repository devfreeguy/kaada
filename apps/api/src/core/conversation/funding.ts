/**
 * What a person needs to put money into their Kaada wallet, worded by the application. Every value here (address, network,
 * tokens) comes from trusted application state; no model writes or paraphrases any of it.
 */
export interface FundingInfo {
  /** The wallet's public address. */
  address: string;
  /** The network name, e.g. "Celo". */
  network: string;
  /** Symbols of the tokens Kaada supports in this wallet. */
  assets: string[];
}

export function fundingInstructions(info: FundingInfo): string {
  const tokens = info.assets.length > 0 ? `\n\nSupported tokens: ${info.assets.join(", ")}` : "";
  return [
    `Send tokens to your Kaada wallet from any wallet or exchange that supports ${info.network}.`,
    `Your address (${info.network}):\n${info.address}${tokens}`,
    `Only send on the ${info.network} network. Tokens sent on another network may be lost.`,
  ].join("\n\n");
}

export function walletAddressMessage(info: FundingInfo): string {
  return `Your Kaada wallet address (${info.network}):\n${info.address}`;
}

export const FUNDING_NOT_READY =
  "Your wallet isn't ready yet. Send /start and I'll take you through the setup.";
export const FUNDING_UNAVAILABLE = "That way of funding your wallet isn't available.";
export const FUNDING_NONE = "Funding your wallet from here isn't available yet.";
