import type { Provider, ProviderCapability } from "@kaada/domain";

import type {
  Provider as ProviderRow,
  ProviderCapability as ProviderCapabilityRow,
} from "../generated/prisma/client.js";
import { maybe, readJsonObjectOrEmpty } from "./support.js";

export function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    isActive: row.isActive,
    metadata: readJsonObjectOrEmpty(row.metadata, "Provider.metadata"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProviderCapability(row: ProviderCapabilityRow): ProviderCapability {
  return {
    id: row.id,
    providerId: row.providerId,
    capability: row.capability,
    ...maybe("chainId", row.chainId),
    ...maybe("inputAssetId", row.inputAssetId),
    ...maybe("outputAssetId", row.outputAssetId),
    ...maybe("countryCode", row.countryCode),
    isActive: row.isActive,
    metadata: readJsonObjectOrEmpty(row.metadata, "ProviderCapability.metadata"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
