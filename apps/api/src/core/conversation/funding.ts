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
  const assets = info.assets.length > 0 ? `\nSupported assets: ${info.assets.join(", ")}` : "";
  return [
    "Sure 👍 You can fund your Kaada wallet from another wallet.",
    `Network: ${info.network}\nWallet: ${info.address}${assets}`,
    `Only send supported assets on the ${info.network} network to this address. Funds sent on another network, or unsupported assets, may not appear in Kaada and may be difficult or impossible to recover.`,
  ].join("\n\n");
}

export function walletAddressMessage(info: FundingInfo): string {
  return `Your Kaada wallet\nNetwork: ${info.network}\nAddress: ${info.address}`;
}

export const FUNDING_NOT_READY =
  "Your wallet isn't ready yet. Send /start and I'll take you through the setup.";
export const FUNDING_UNAVAILABLE = "That way of funding your wallet isn't available.";
export const FUNDING_NONE = "Funding your wallet from here isn't available yet.";
