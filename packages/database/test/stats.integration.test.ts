/*
 * The public payment totals against the real database. Read only: it runs the aggregate and checks its shape, whatever the database
 * holds (an empty one answers with no groups). Requires the migrations. Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createDatabase, createPaymentStatsRepository } from "../src/index.js";
import type { Database } from "../src/index.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

describe("completed payment totals on the real database", { skip }, () => {
  let database: Database;

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 2, poolTimeoutMs: 5000 });
  });
  after(async () => {
    await database.close();
  });

  it("runs, and returns only sums and counts per asset: nothing that names a person, wallet or payment", async () => {
    const groups = await createPaymentStatsRepository(database).completedByAsset();
    assert.ok(Array.isArray(groups));
    for (const group of groups) {
      assert.deepEqual(
        Object.keys(group)
          .filter((key) => key !== "fiatCode")
          .sort(),
        ["assetId", "decimals", "payments", "symbol", "total"],
      );
      assert.match(group.total, /^[0-9]+$/, "a canonical integer in smallest units");
      assert.ok(Number.isInteger(group.payments) && group.payments > 0);
      assert.ok(Number.isInteger(group.decimals));
    }
  });
});
