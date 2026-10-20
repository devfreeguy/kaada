import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateRecoveryCode, deriveRecoveryKey } from "@kaada/contracts";
import { RECOVERY_AUDIT_EVENTS } from "@kaada/domain";
import type { Address } from "viem";

import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";
import type { RecoveryWorld, TestUser } from "./support/recovery-world.js";

/*
 * A wallet that was only funded (with a stablecoin) has no account on chain and no CELO. The platform may open the account and pay
 * the gas of its first Recovery Code setup, but only for a wallet that has received funds, and only up to a fixed lifetime budget.
 */

const CELO = 10n ** 18n;
const HALF = CELO / 2n;

async function undeployedWallet(options: { funded: boolean; budget?: bigint }) {
  const world = createRecoveryWorld();
  const user = await world.createUser({ armed: false, authenticator: true });
  world.chain.accounts.delete(user.account.toLowerCase());
  if (options.budget !== undefined) {
    world.context.sponsorship = {
      perWalletWei: options.budget,
      funded: () => Promise.resolve(options.funded),
    };
  }
  return { world, user };
}

const verifier = (world: RecoveryWorld, user: TestUser) =>
  deriveRecoveryKey(generateRecoveryCode(), {
    chainId: world.chain.chainId,
    account: user.account as Address,
  }).address;

const sponsored = async (world: RecoveryWorld, user: TestUser) =>
  (
    await world.repositories.audit.listByType(user.userId, RECOVERY_AUDIT_EVENTS.relayerSponsored)
  ).map((event) => event.data as { wei: string; purpose: string });

describe("sponsoring a wallet so it can secure itself", () => {
  it("does nothing unless sponsoring is configured: the wallet is still refused", async () => {
    const { world, user } = await undeployedWallet({ funded: true });
    await expectKaada(
      world.configuration.prepare({ userId: user.userId, recoveryAddress: verifier(world, user) }),
      "RECOVERY_REJECTED",
    );
    assert.equal(world.chain.openCalls, 0);
  });

  it("does nothing for a wallet that never received funds", async () => {
    const { world, user } = await undeployedWallet({ funded: false, budget: HALF });
    await expectKaada(
      world.configuration.prepare({ userId: user.userId, recoveryAddress: verifier(world, user) }),
      "RECOVERY_REJECTED",
    );
    assert.equal(world.chain.openCalls, 0, "an unfunded wallet costs the platform nothing");
    assert.deepEqual(await sponsored(world, user), []);
  });

  it("opens a funded wallet's account, offers the rest of the budget for gas, and records both spends", async () => {
    const { world, user } = await undeployedWallet({ funded: true, budget: HALF });
    world.chain.topUpWei = CELO / 4n;
    const arm = await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    assert.ok(arm.configurationId);
    assert.equal(world.chain.openCalls, 1);
    assert.equal(world.chain.lastSponsorUpTo, (HALF - world.chain.openCostWei).toString());
    const spends = await sponsored(world, user);
    assert.deepEqual(spends.map((s) => s.purpose).sort(), ["gas_topup", "open_account"]);
    assert.equal(
      spends.reduce((sum, s) => sum + BigInt(s.wei), 0n),
      world.chain.openCostWei + CELO / 4n,
    );
  });

  it("never opens the same account twice, and an already open wallet is not opened", async () => {
    const { world, user } = await undeployedWallet({ funded: true, budget: HALF });
    await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    assert.equal(world.chain.openCalls, 1);
    const open = await world.createUser({ armed: false, authenticator: true });
    world.context.sponsorship = { perWalletWei: HALF, funded: () => Promise.resolve(true) };
    await world.configuration.prepare({
      userId: open.userId,
      recoveryAddress: verifier(world, open),
    });
    assert.equal(world.chain.openCalls, 1, "a wallet that already exists costs nothing to open");
  });

  it("stops at the lifetime budget: once it is spent, no more is offered", async () => {
    const budget = 20_000_000_000_000_000n; // 0.02 CELO; opening costs 0.015
    const { world, user } = await undeployedWallet({ funded: true, budget });
    world.chain.topUpWei = 5_000_000_000_000_000n;
    await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    assert.equal(world.chain.lastSponsorUpTo, (budget - world.chain.openCostWei).toString());
    // Open 0.015 + top-up 0.005 = the whole budget. Preparing again offers nothing.
    await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    assert.equal(world.chain.lastSponsorUpTo, undefined);
    const total = (await sponsored(world, user)).reduce((sum, s) => sum + BigInt(s.wei), 0n);
    assert.equal(total, budget);
  });
});
