import type { CompletedPaymentGroup, PaymentStatsRepository } from "@kaada/domain";

import type { Database } from "../client/index.js";

interface Row {
  assetId: string;
  symbol: string;
  fiatCode: string | null;
  decimals: number;
  payments: number;
  total: string;
}

/**
 * Aggregates for the public marketing numbers. One read-only statement: it only ever returns sums and counts, never a row of
 * anyone's. A payment counts when it COMPLETED and recorded what it settled (a canonical integer), by the asset it delivered.
 */
export function createPaymentStatsRepository(database: Database): PaymentStatsRepository {
  return {
    async completedByAsset(): Promise<CompletedPaymentGroup[]> {
      const rows = await database.client.$queryRaw<Row[]>`
        SELECT a."id"::text                       AS "assetId",
               a."symbol"                         AS "symbol",
               a."fiatCode"                       AS "fiatCode",
               a."decimals"::int                  AS "decimals",
               COUNT(*)::int                      AS "payments",
               SUM(e."settledOutputAmount"::numeric)::text AS "total"
          FROM "Execution" e
          JOIN "Route" r ON r."id" = e."routeId"
          JOIN "Asset" a ON a."id" = r."outputAssetId"
         WHERE e."status" = 'COMPLETED'
           AND e."settledOutputAmount" ~ '^[0-9]+$'
         GROUP BY a."id", a."symbol", a."fiatCode", a."decimals"`;
      return rows.map((row) => ({
        assetId: row.assetId,
        symbol: row.symbol,
        ...(row.fiatCode && { fiatCode: row.fiatCode }),
        decimals: Number(row.decimals),
        payments: Number(row.payments),
        total: row.total,
      }));
    },
  };
}
