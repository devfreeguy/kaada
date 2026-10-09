import type { Asset } from "@kaada/domain";

import type { Asset as AssetRow } from "../generated/prisma/client.js";
import { maybe } from "./support.js";

export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    kind: row.kind,
    decimals: row.decimals,
    ...maybe("chainId", row.chainId),
    ...maybe("contractAddress", row.contractAddress),
    ...maybe("fiatCode", row.fiatCode),
    ...maybe("countryCode", row.countryCode),
    isActive: row.isActive,
  };
}
