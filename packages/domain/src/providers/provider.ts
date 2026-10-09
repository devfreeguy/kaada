import type { JsonObject } from "../json.js";

export const PROVIDER_TYPES = ["FX", "RAMP", "WALLET", "RPC", "MULTI_SERVICE"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const CAPABILITY_TYPES = [
  "QUOTE",
  "SWAP",
  "EXACT_INPUT",
  "EXACT_OUTPUT",
  "ON_RAMP",
  "OFF_RAMP",
  "BANK_PAYOUT",
  "CONDITIONAL_EXECUTION",
] as const;
export type CapabilityType = (typeof CAPABILITY_TYPES)[number];

/** A registered external service. Credentials are never stored here. */
export interface Provider {
  id: string;
  /** Stable machine name, e.g. "textile". Matches FxProvider.id / RampProvider.id. */
  slug: string;
  name: string;
  type: ProviderType;
  isActive: boolean;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One thing a provider can do, optionally narrowed to a chain, asset pair or country. Corridor
 * support is data: if no matching capability row exists, the corridor is not supported.
 */
export interface ProviderCapability {
  id: string;
  providerId: string;
  capability: CapabilityType;
  chainId?: number;
  inputAssetId?: string;
  outputAssetId?: string;
  countryCode?: string;
  isActive: boolean;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface CapabilityQuery {
  providerId?: string;
  capability?: CapabilityType;
  inputAssetId?: string;
  outputAssetId?: string;
  countryCode?: string;
  chainId?: number;
}

export interface ProviderRepository {
  findBySlug(slug: string): Promise<Provider | null>;
  listActive(): Promise<Provider[]>;
  /** Active capabilities of active providers matching every given filter. */
  listCapabilities(query?: CapabilityQuery): Promise<ProviderCapability[]>;
}
