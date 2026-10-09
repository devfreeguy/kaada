import type { AssetRepository } from "@kaada/domain";

import { toAsset } from "../mappers/index.js";
import type { Db } from "./db.js";

export function createAssetRepository(db: Db): AssetRepository {
  return {
    async findById(id) {
      const row = await db.asset.findUnique({ where: { id } });
      return row ? toAsset(row) : null;
    },

    async findBySymbol(symbol, options) {
      const rows = await db.asset.findMany({
        where: {
          symbol: { equals: symbol, mode: "insensitive" },
          ...(options?.chainId !== undefined && { chainId: options.chainId }),
        },
        orderBy: [{ chainId: "asc" }, { id: "asc" }],
      });
      return rows.map(toAsset);
    },

    async findByFiatCode(code) {
      const rows = await db.asset.findMany({
        where: { fiatCode: { equals: code.trim(), mode: "insensitive" } },
        orderBy: { id: "asc" },
      });
      return rows.map(toAsset);
    },

    async listActive() {
      const rows = await db.asset.findMany({
        where: { isActive: true },
        orderBy: [{ symbol: "asc" }, { chainId: "asc" }],
      });
      return rows.map(toAsset);
    },
  };
}
