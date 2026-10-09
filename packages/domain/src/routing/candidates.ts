import type { AssetKind } from "../assets/index.js";
import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { CapabilityType } from "../providers/index.js";
import type { RoutingRequest } from "../intents/routing-request.js";

/**
 * Where a side's candidates came from, so a router knows how firm they are.
 * - EXPLICIT_ASSET:      the user named this exact token (for example "50 USDT").
 * - EXPLICIT_PREFERENCE: the user asked to pay with this token ("use USDT").
 * - SETTLEMENT:          the tokens that represent the side's currency, from Asset metadata.
 * - DEFAULT_FUNDING:     no preference: the supported USD settlement assets. Not a claim that the
 *                        user owns any of them; balance filtering comes later.
 */
export const CANDIDATE_ORIGINS = [
  "EXPLICIT_ASSET",
  "EXPLICIT_PREFERENCE",
  "SETTLEMENT",
  "DEFAULT_FUNDING",
] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];

export interface CandidateAsset {
  assetId: string;
  symbol: string;
  kind: AssetKind;
  /** Slugs of the providers that can convert this candidate in at least one retained pair. */
  providers: string[];
}

export interface CandidateSide {
  /** What this side is denominated in (a currency code or a token symbol). */
  denomination: string;
  origin: CandidateOrigin;
  candidates: CandidateAsset[];
}

/**
 * One source -> destination pair that can be handed to routing.
 * DIRECT means both sides are the same asset, so no conversion (and no provider) is needed.
 */
export interface CandidatePair {
  sourceAssetId: string;
  destinationAssetId: string;
  kind: "DIRECT" | "CONVERSION";
  /** Conversion steps needed: 0 for DIRECT, 1 for one provider step, 2 through an intermediate asset. */
  hops: 0 | 1 | 2;
  /** Intermediate assets of the two-step ways to make the conversion (hops = 2 only). */
  via?: string[];
  /** Providers that serve the pair. For a two-step pair, the providers of either step. */
  providers: { slug: string; capabilities: CapabilityType[] }[];
}

/**
 * Everything Build 8 needs, so it does not repeat asset or capability discovery. It states which
 * assets and providers are eligible; it chooses nothing, and holds no rate, source amount, fee,
 * quote, route or balance. It is valid only for `intentRevision`.
 */
export interface RoutingCandidateSet {
  intentId: string;
  intentRevision: number;
  userId: string;
  chainId: number;
  operation: RoutingRequest["operation"];
  purpose: RoutingRequest["purpose"];
  /** The fixed side. */
  amount: {
    /** Currency code or token symbol the amount is denominated in. */
    denomination: string;
    assetId: string;
    mode: AmountMode;
    /** For people: "500" for 500.00 BRL. Not used for arithmetic. */
    humanValue: string;
    money: Money;
  };
  /** The capabilities a provider must have for every conversion pair in this set. */
  requiredCapabilities: CapabilityType[];
  source: CandidateSide;
  destination: CandidateSide;
  /** Only the pairs a provider can serve (or that need none). Never empty in a READY set. */
  pairs: CandidatePair[];
  /** The user's explicit funding preference, carried through unchanged. */
  explicitSourceAssetId: string | null;
  recipient?: RoutingRequest["recipient"];
  destinationCountry?: string;
}

export const CANDIDATE_UNSUPPORTED_CODES = [
  "NO_SETTLEMENT_ASSET",
  "SOURCE_ASSET_UNSUPPORTED",
  "DESTINATION_ASSET_UNSUPPORTED",
  "AMBIGUOUS_SETTLEMENT_ASSET",
  "NO_PROVIDER_FOR_PAIR",
  "PROVIDER_CAPABILITY_UNAVAILABLE",
] as const;
export type CandidateUnsupportedCode = (typeof CANDIDATE_UNSUPPORTED_CODES)[number];

export interface CandidateUnsupported {
  status: "UNSUPPORTED";
  code: CandidateUnsupportedCode;
  /** Which side the problem is on, when it is one side. */
  side?: "SOURCE" | "DESTINATION";
  /** Plain, safe wording for the person. */
  text: string;
  /** Machine-readable specifics (denomination, missing capabilities, ambiguous assets). */
  details: {
    denomination?: string;
    reason?: string;
    missingCapabilities?: CapabilityType[];
    assetIds?: string[];
  };
}

export type CandidateResult = { status: "READY"; set: RoutingCandidateSet } | CandidateUnsupported;
