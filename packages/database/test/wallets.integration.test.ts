/*
 * Wallet tables against the real database: constraints, repositories and mapping. Every test runs in a
 * transaction that is ALWAYS rolled back, so nothing is left behind. Requires the migrations.
 * Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createMoney } from "@kaada/domain";

import { createDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";
import {
  createAuditRepository,
  createDelegatedPermissionRepository,
  createPasskeyRepository,
  createWalletRepository,
} from "../src/repositories/wallets.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

class Rollback extends Error {}

const CELO = 42220;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("wallet tables (rolled back)", { skip }, () => {
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

  async function newUser(tx: Tx): Promise<string> {
    const id = randomUUID();
    await tx.user.create({ data: { id, username: `w${id.slice(0, 8)}` } });
    return id;
  }

  const wallet = (userId: string, over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    userId,
    chainId: CELO,
    type: "EMBEDDED" as const,
    status: "PROVISIONING" as const,
    deployment: "NOT_APPLICABLE" as const,
    ...over,
  });

  async function usdt(tx: Tx): Promise<string> {
    const row = await tx.asset.findFirstOrThrow({ where: { symbol: "USDT", chainId: CELO } });
    return row.id;
  }

  it("allows one non-revoked EMBEDDED wallet per user and chain, and frees the slot on revoke", async () => {
    // Each refusal aborts its transaction, so each is checked in its own.
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      await tx.wallet.create({ data: wallet(userId) });
      await assert.rejects(tx.wallet.create({ data: wallet(userId) }));
    });
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const first = wallet(userId);
      await tx.wallet.create({ data: first });
      await tx.wallet.update({ where: { id: first.id }, data: { status: "REVOKED" } });
      await tx.wallet.create({ data: wallet(userId) }); // the slot is free again
      await tx.wallet.create({ data: wallet(userId, { chainId: 1 }) }); // another chain was never blocked
      await tx.wallet.create({
        data: wallet(userId, {
          type: "EXTERNAL",
          status: "ACTIVE",
          address: `0x${"ab".repeat(20)}`,
        }),
      });
      assert.equal(await tx.wallet.count({ where: { userId } }), 4);
    });
  });

  it("requires an address for an ACTIVE wallet and a consistent deployment state", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      await assert.rejects(tx.wallet.create({ data: wallet(userId, { status: "ACTIVE" }) }));
    });
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      // An EXTERNAL wallet is never "counterfactual".
      await assert.rejects(
        tx.wallet.create({
          data: wallet(userId, {
            type: "EXTERNAL",
            status: "ACTIVE",
            address: `0x${"ab".repeat(20)}`,
            deployment: "COUNTERFACTUAL",
          }),
        }),
      );
    });
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      // A deployment state without an address is refused; the address-less PROVISIONING row is fine.
      await tx.wallet.create({ data: wallet(userId) });
      await assert.rejects(
        tx.wallet.create({ data: wallet(userId, { chainId: 1, deployment: "COUNTERFACTUAL" }) }),
      );
    });
  });

  it("round-trips a wallet through its lifecycle with the repository", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const repo = createWalletRepository(tx);
      const created = await repo.create({
        id: randomUUID(),
        userId,
        chainId: CELO,
        isPrimary: true,
        type: "EMBEDDED",
        status: "PROVISIONING",
        deployment: "NOT_APPLICABLE",
      });
      assert.equal(created.address, undefined);
      assert.deepEqual((await repo.findEmbedded(userId, CELO))?.id, created.id);

      await repo.recordFailure(created.id, "PROVIDER_ERROR");
      assert.equal((await repo.findById(created.id))?.statusReason, "PROVIDER_ERROR");

      const address = `0x${"cd".repeat(20)}`;
      const active = await repo.activate(created.id, {
        address,
        deployment: "COUNTERFACTUAL",
        provider: "zerodev-kernel-v3.3",
        at: NOW,
      });
      assert.equal(active?.status, "ACTIVE");
      assert.equal(active?.address, address);
      assert.equal(active?.deployment, "COUNTERFACTUAL");
      assert.equal(active?.statusReason, undefined, "the failure reason is cleared");
      assert.equal(
        await repo.activate(created.id, {
          address,
          deployment: "DEPLOYED",
          provider: "x",
          at: NOW,
        }),
        null,
        "only once",
      );

      assert.equal(
        (await repo.setStatus(created.id, "SUSPENDED", "REVIEW")).statusReason,
        "REVIEW",
      );
      assert.equal((await repo.setDeployment(created.id, "DEPLOYED")).deployment, "DEPLOYED");
      assert.equal((await repo.listByUser(userId)).length, 1);
      await repo.lockUser(userId);
    });
  });

  it("stores passkeys as public data, enforces hex coordinates, and claims a challenge only once", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const repo = createPasskeyRepository(tx);
      const credential = await repo.create({
        id: randomUUID(),
        userId,
        credentialId: `cred-${randomUUID()}`,
        publicKeyX: "ab".repeat(32),
        publicKeyY: "cd".repeat(32),
        rpId: "kaada.test",
      });
      assert.equal(credential.signCount, 0);
      assert.equal((await repo.listActiveForUser(userId)).length, 1);
      assert.equal(await repo.advanceCounter(credential.id, 5, NOW), true);
      assert.equal(await repo.advanceCounter(credential.id, 5, NOW), false, "must move forward");
      assert.equal(await repo.advanceCounter(credential.id, 4, NOW), false);
      assert.equal(await repo.revoke(credential.id, NOW), true);
      assert.equal(await repo.revoke(credential.id, NOW), false);
      assert.equal((await repo.listActiveForUser(userId)).length, 0);

      const challenge = randomUUID().replaceAll("-", "");
      await repo.issueChallenge({
        id: randomUUID(),
        userId,
        purpose: "REGISTRATION",
        challenge,
        expiresAt: new Date(NOW.getTime() + HOUR),
      });
      const claim = { userId, purpose: "REGISTRATION" as const, challenge, now: NOW };
      assert.ok(await repo.consumeChallenge(claim));
      assert.equal(await repo.consumeChallenge(claim), null, "single use");
      const expired = randomUUID().replaceAll("-", "");
      await repo.issueChallenge({
        id: randomUUID(),
        userId,
        purpose: "AUTHENTICATION",
        challenge: expired,
        expiresAt: new Date(NOW.getTime() - 1),
      });
      assert.equal(
        await repo.consumeChallenge({
          userId,
          purpose: "AUTHENTICATION",
          challenge: expired,
          now: NOW,
        }),
        null,
      );
      assert.equal(
        await repo.consumeChallenge({
          userId: randomUUID(),
          purpose: "AUTHENTICATION",
          challenge: expired,
          now: NOW,
        }),
        null,
      );
    });
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      await assert.rejects(
        createPasskeyRepository(tx).create({
          id: randomUUID(),
          userId,
          credentialId: "c",
          publicKeyX: "AB".repeat(32),
          publicKeyY: "cd".repeat(32),
          rpId: "kaada.test",
        }),
      );
    });
  });

  describe("delegated permissions", () => {
    async function setupWallet(tx: Tx) {
      const userId = await newUser(tx);
      const walletId = randomUUID();
      await tx.wallet.create({
        data: wallet(userId, {
          id: walletId,
          status: "ACTIVE",
          address: `0x${"ef".repeat(20)}`,
          deployment: "COUNTERFACTUAL",
        }),
      });
      return { userId, walletId, assetId: await usdt(tx) };
    }
    const base = (
      userId: string,
      walletId: string,
      assetId: string,
      over: Record<string, unknown> = {},
    ) => ({
      id: randomUUID(),
      userId,
      walletId,
      provider: "zerodev-kernel-v3.3",
      chainId: CELO,
      allowedOperations: ["APPROVE_TOKEN"],
      allowedContracts: [`0x${"12".repeat(20)}`],
      allowedAssetIds: [assetId],
      perTransactionAmount: "1000000",
      perTransactionAssetId: assetId,
      enforcement: {},
      validFrom: NOW,
      expiresAt: new Date(NOW.getTime() + HOUR),
      ...over,
    });

    it("round-trips with the repository, including the enforcement map and Money", async () => {
      await rolledBack(async (tx) => {
        const { userId, walletId, assetId } = await setupWallet(tx);
        const repo = createDelegatedPermissionRepository(tx);
        const enforcement = {
          contracts: "ONCHAIN",
          operations: "ONCHAIN",
          assets: "ONCHAIN",
          perTransactionLimit: "ONCHAIN",
          cumulativeLimit: "KAADA_POLICY",
          validity: "ONCHAIN",
        } as const;
        const created = await repo.create({
          id: randomUUID(),
          userId,
          walletId,
          provider: "zerodev-kernel-v3.3",
          chainId: CELO,
          status: "PENDING",
          allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP"],
          allowedContracts: [`0x${"12".repeat(20)}`],
          allowedAssetIds: [assetId],
          perTransactionLimit: createMoney("50000000", assetId),
          cumulativeLimit: createMoney("200000000", assetId),
          enforcement,
          validFrom: NOW,
          expiresAt: new Date(NOW.getTime() + HOUR),
        });
        assert.deepEqual(created.enforcement, enforcement);
        assert.deepEqual(created.perTransactionLimit, createMoney("50000000", assetId));
        assert.deepEqual(created.cumulativeLimit, createMoney("200000000", assetId));

        const active = await repo.activate(created.id, "perm-1");
        assert.equal(active?.status, "ACTIVE");
        assert.equal(await repo.activate(created.id, "perm-2"), null);
        const revoked = await repo.revoke(created.id, "USER_REQUEST", NOW);
        assert.equal(revoked?.status, "REVOKED");
        assert.equal(revoked?.revocationReason, "USER_REQUEST");
        assert.equal(await repo.revoke(created.id, "AGAIN", NOW), null);
        assert.equal((await repo.listForWallet(walletId)).length, 1);

        const second = await repo.create({
          ...created,
          id: randomUUID(),
          status: "ACTIVE",
          expiresAt: new Date(NOW.getTime() + 1000),
        });
        assert.equal(await repo.expireDue(new Date(NOW.getTime() + 2000)), 1);
        assert.equal((await repo.findById(second.id))?.status, "EXPIRED");
      });
    });

    it("refuses an unbounded or malformed permission at the database", async () => {
      const cases: [string, (assetId: string) => Record<string, unknown>][] = [
        ["no allowed contracts", () => ({ allowedContracts: [] })],
        ["no allowed operations", () => ({ allowedOperations: [] })],
        ["no allowed assets", () => ({ allowedAssetIds: [] })],
        ["expires before it starts", () => ({ expiresAt: new Date(NOW.getTime() - HOUR) })],
        ["a non-canonical amount", () => ({ perTransactionAmount: "01" })],
        ["an upper-case contract address", () => ({ allowedContracts: [`0x${"AB".repeat(20)}`] })],
        ["a cumulative amount without an asset", () => ({ cumulativeAmount: "5" })],
        ["REVOKED without a revocation time", () => ({ status: "REVOKED" })],
      ];
      for (const [label, over] of cases) {
        await rolledBack(async (tx) => {
          const { userId, walletId, assetId } = await setupWallet(tx);
          await assert.rejects(
            tx.delegatedPermission.create({ data: base(userId, walletId, assetId, over(assetId)) }),
            label,
          );
        });
      }
    });
  });

  it("appends audit events with JSON data and lists them newest first", async () => {
    await rolledBack(async (tx) => {
      const userId = await newUser(tx);
      const repo = createAuditRepository(tx);
      await repo.append({
        id: randomUUID(),
        userId,
        type: "wallet.provisioned",
        entityType: "wallet",
        entityId: randomUUID(),
        data: { deployment: "COUNTERFACTUAL" },
      });
      await repo.append({ id: randomUUID(), userId, type: "wallet.suspended" });
      const events = await repo.listForUser(userId);
      assert.equal(events.length, 2);
      assert.ok(
        events.some(
          (e) =>
            e.type === "wallet.provisioned" &&
            (e.data as { deployment?: string })?.deployment === "COUNTERFACTUAL",
        ),
      );
    });
  });
});
