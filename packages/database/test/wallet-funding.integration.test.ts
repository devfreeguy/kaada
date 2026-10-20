/*
 * WalletFundingStore.hasBeenFunded against the real database. Every test runs in a transaction that is ALWAYS rolled back, so nothing
 * is left behind. Requires the migrations. Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";
import { createWalletFundingStore } from "../src/repositories/wallet-funding.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

class Rollback extends Error {}

const CELO = 42220;
const OTHER_CHAIN = 11142220;
const NOW = new Date("2026-10-10T12:00:00.000Z");

describe("hasBeenFunded (rolled back)", { skip }, () => {
  let database: Database;
  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 3, poolTimeoutMs: 20_000 });
  });
  after(async () => {
    await database.close();
  });

  type Tx = Parameters<Parameters<Database["client"]["$transaction"]>[0]>[0];
  async function rolledBack(work: (tx: Tx) => Promise<void>): Promise<void> {
    await assert.rejects(
      database.client.$transaction(
        async (tx) => {
          await work(tx);
          throw new Rollback();
        },
        { timeout: 60_000, maxWait: 30_000 },
      ),
      (error) => error instanceof Rollback,
    );
  }

  /** The store only uses `database.client`, so a transaction client makes it work inside the rolled-back transaction. */
  const storeOn = (tx: Tx) => createWalletFundingStore({ client: tx } as unknown as Database);

  async function newUser(tx: Tx): Promise<string> {
    const id = randomUUID();
    await tx.user.create({ data: { id, username: `f${id.slice(0, 8)}` } });
    return id;
  }

  const address = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;

  async function checkpoint(
    tx: Tx,
    userId: string,
    observed: Record<string, string>,
    chainId = CELO,
  ): Promise<{ id: string; address: string }> {
    const row = { id: randomUUID(), address: address() };
    await tx.walletDepositCheckpoint.create({
      data: {
        id: row.id,
        userId,
        chainId,
        address: row.address,
        observed,
        version: 0,
        observedAt: NOW,
      },
    });
    return row;
  }

  async function event(tx: Tx, userId: string, checkpointId: string, addr: string, chainId = CELO) {
    await tx.walletFundingEvent.create({
      data: {
        id: randomUUID(),
        userId,
        checkpointId,
        version: 1,
        chainId,
        address: addr,
        items: [
          {
            assetId: "a",
            symbol: "USDT",
            decimals: 6,
            previous: "0",
            current: "5000000",
            delta: "5000000",
          },
        ],
        createdAt: NOW,
      },
    });
  }

  it("is false for a wallet that was never funded (no rows, or only zero balances)", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      assert.equal(await storeOn(tx).hasBeenFunded(userId, CELO), false, "no rows at all");
      await checkpoint(tx, userId, { usdt: "0", celo: "0" });
      assert.equal(await storeOn(tx).hasBeenFunded(userId, CELO), false, "a checkpoint of zeros");
    });
  });

  it("is true after one recorded deposit", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const cp = await checkpoint(tx, userId, { usdt: "0" });
      await event(tx, userId, cp.id, cp.address);
      assert.equal(await storeOn(tx).hasBeenFunded(userId, CELO), true);
    });
  });

  it("is true when the last check shows a positive balance, even with no recorded event", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      await checkpoint(tx, userId, { usdt: "0", celo: "2500000000000000" });
      assert.equal(await storeOn(tx).hasBeenFunded(userId, CELO), true);
    });
  });

  it("stays true after the money was funded and then spent down to zero", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const cp = await checkpoint(tx, userId, { usdt: "5000000" });
      await event(tx, userId, cp.id, cp.address);
      assert.equal(await storeOn(tx).hasBeenFunded(userId, CELO), true, "funded");
      await tx.walletDepositCheckpoint.update({
        where: { id: cp.id },
        data: { observed: { usdt: "0" }, version: 1 },
      });
      assert.equal(
        await storeOn(tx).hasBeenFunded(userId, CELO),
        true,
        "spent to zero, still counts",
      );
    });
  });

  it("counts only this person and this chain", async () => {
    await rolledBack(async (tx) => {
      const funded = await newUser(tx);
      const other = await newUser(tx);
      const cp = await checkpoint(tx, funded, { usdt: "9000000" });
      await event(tx, funded, cp.id, cp.address);
      assert.equal(await storeOn(tx).hasBeenFunded(other, CELO), false, "someone else's funds");
      assert.equal(await storeOn(tx).hasBeenFunded(funded, OTHER_CHAIN), false, "another network");
    });
  });
});
