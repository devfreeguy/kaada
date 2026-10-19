import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMoney } from "@kaada/domain";
import type { DelegatedPermission, PermissionScope } from "@kaada/domain";

import { buildTransferPlan, isDirectTransferRoute } from "../src/core/execution/transfer.js";
import { CNGN_ADDRESS, RECIPIENT_ADDRESS, firmWorld } from "./support/firm-world.js";
import { attachRunner } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";

/*
 * A DIRECT transfer: the payment is already in the right currency (Naira to a wallet address), so there is no swap, no provider
 * and no firm quote. These run on the same offline fakes as the swap runner: nothing here reaches a chain or a bundler; the fakes
 * record exactly what would have been sent.
 */

const NAIRA_300 = "300000000";

async function transferWorld(holds = 1000n): Promise<RunWorld> {
  const world = await firmWorld({ directNaira: { holds } });
  return attachRunner(world);
}

const record = (w: RunWorld) => w.uow.read.executionPlans.findById(w.executionId);
const authorization = (w: RunWorld) =>
  w.uow.read.paymentAuthorizations.findById(w.authorization.id);

/** Wallet setup first (a deployed account and the permission), as for any payment. */
async function ready(w: RunWorld): Promise<void> {
  assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
  await w.confirmRootAction();
}

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

describe("preparing a direct transfer", () => {
  it("is ready at once: no price to confirm and no provider is asked for anything", async () => {
    const w = await transferWorld();
    const stored = await record(w);
    assert.equal(stored?.status, "READY");
    assert.equal((stored?.plan as { kind?: string } | undefined)?.kind, "TRANSFER");
    assert.equal(w.calls().length, 0, "the pricing provider was never called");
    assert.equal(w.firm.attempts.length, 0, "no firm quote attempt exists");
    assert.equal(stored?.firmQuoteAttemptId, undefined);
  });

  it("is a single transfer step in the right currency and amount", async () => {
    const w = await transferWorld();
    const route = [...w.w.r.world.routes.values()][0];
    assert.ok(route && isDirectTransferRoute(route));
    assert.equal(route.input.amount, NAIRA_300);
    assert.equal(route.output.amount, NAIRA_300);
    assert.equal(route.input.assetId, route.output.assetId);
  });
});

describe("a direct transfer permission", () => {
  it("lets the session key do ONE thing: transfer this token to this recipient, up to this amount", async () => {
    const w = await transferWorld();
    await w.runner.run(w.executionId);
    const scope = w.kernel.prepared[0];
    assert.ok(scope);
    assert.deepEqual(scope.allowedOperations, ["TRANSFER_TOKEN"]);
    assert.deepEqual(scope.allowedContracts, [CNGN_ADDRESS]);
    assert.equal(scope.swapTarget, undefined, "no swap contract");
    assert.equal(scope.swapSelector, undefined);
    assert.equal(scope.approval, undefined, "no approve");
    assert.equal(scope.payout?.recipient, RECIPIENT_ADDRESS);
    assert.equal(scope.payout?.tokenAddress, CNGN_ADDRESS);
    assert.equal(scope.payout?.limit.amount, NAIRA_300);
    assert.equal(scope.perTransactionLimit.amount, NAIRA_300);
  });
});

describe("running a direct transfer", () => {
  it("asks for the passkey first, spends nothing and consumes nothing", async () => {
    const w = await transferWorld();
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "ROOT_ACTION_REQUIRED");
    assert.equal((await record(w))?.status, "REQUIRES_USER_ACTION");
    assert.equal((await authorization(w))?.status, "ACTIVE", "not consumed by wallet setup");
    assert.equal(w.kernel.delegated.length, 0);
    assert.equal(w.kernel.rootSends, 0);
  });

  it("sends exactly one transfer(recipient, amount) call with no native value, then completes", async () => {
    const w = await transferWorld();
    await ready(w);
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_SENT");

    assert.equal(w.kernel.delegated.length, 1, "one user operation");
    const [sent] = w.kernel.delegated;
    assert.equal(sent?.calls.length, 1, "one call");
    const call = sent?.calls[0];
    assert.equal(call?.to.toLowerCase(), CNGN_ADDRESS);
    assert.equal(call?.value, "0");
    assert.equal(
      call?.data.toLowerCase(),
      `0xa9059cbb${word(RECIPIENT_ADDRESS)}${word(BigInt(NAIRA_300).toString(16))}`,
    );

    const final = await record(w);
    assert.equal(final?.status, "COMPLETED");
    assert.equal(final?.settledInputAmount, NAIRA_300);
    assert.equal(final?.settledOutputAmount, NAIRA_300);
    assert.ok(final?.authorizationConsumedAt);
    assert.equal((await authorization(w))?.status, "CONSUMED");
    // No provider was involved at any point.
    assert.equal(w.orders.submits.length, 0);
    assert.equal(w.orders.statuses, 0);
    assert.equal(w.calls().length, 0);
  });

  it("records the transfer once, with its user operation and transaction hashes", async () => {
    const w = await transferWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    const transfers = w.run.transactions.filter((t) => t.type === "TRANSFER");
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]?.status, "CONFIRMED");
    assert.ok(transfers[0]?.userOpHash && transfers[0].hash);
  });

  it("never sends twice: running a finished payment again moves nothing", async () => {
    const w = await transferWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    }
    assert.equal(w.kernel.delegated.length, 1);
  });

  it("several runs at once send once", async () => {
    const w = await transferWorld();
    await ready(w);
    const results = await Promise.all([
      w.runner.run(w.executionId),
      w.runner.run(w.executionId),
      w.runner.run(w.executionId),
    ]);
    assert.ok(results.every((r) => r.status === "PAYMENT_SENT" || r.status === "PAYMENT_PENDING"));
    assert.equal(w.kernel.delegated.length, 1);
  });
});

describe("a direct transfer that cannot go through", () => {
  it("without CELO for the network fee it says so and consumes nothing", async () => {
    const w = await transferWorld();
    await ready(w);
    w.kernel.native = 0n;
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "GAS_FUNDING_REQUIRED");
    assert.equal((await authorization(w))?.status, "ACTIVE");
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("without enough Naira it says so and consumes nothing", async () => {
    const w = await transferWorld();
    await ready(w);
    // The Naira leaves the wallet some other way between authorization and sending.
    w.w.port.held.set(w.w.r.tokens.cNGN.id, 100n * 10n ** 6n);
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "INSUFFICIENT_BALANCE");
    assert.equal((await authorization(w))?.status, "ACTIVE");
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("a bundler that refuses before anything was sent gives the approval back and sends nothing", async () => {
    const w = await transferWorld();
    await ready(w);
    w.kernel.sendMode = "reject";
    const outcome = await w.runner.run(w.executionId);
    assert.deepEqual(outcome, { status: "PAYMENT_FAILED", code: "BUNDLER_REJECTED" });
    assert.equal(w.kernel.delegated.length, 0);
    assert.notEqual((await authorization(w))?.status, "CONSUMED", "released, not spent");
  });

  it("a transfer that reverts on chain fails the payment and the approval stays spent", async () => {
    const w = await transferWorld();
    await ready(w);
    w.kernel.receiptMode = "revert";
    const outcome = await w.runner.run(w.executionId);
    assert.deepEqual(outcome, { status: "PAYMENT_FAILED", code: "TRANSFER_REVERTED" });
    assert.equal((await record(w))?.status, "FAILED");
    assert.equal((await authorization(w))?.status, "CONSUMED", "no silent replay");
    assert.equal(w.kernel.delegated.length, 1);
  });

  it("a transfer the chain has not confirmed yet is pending, and is never sent again", async () => {
    const w = await transferWorld();
    await ready(w);
    w.kernel.receiptMode = "pending";
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_PENDING");
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_PENDING");
    assert.equal(w.kernel.delegated.length, 1, "still the one transfer");
    // The chain eventually shows it.
    w.kernel.receiptMode = "included";
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal(w.kernel.delegated.length, 1);
  });

  it("a send whose outcome is unknown (the process lost the answer) is reconciled, never resent", async () => {
    const w = await transferWorld();
    await ready(w);
    w.kernel.sendMode = "throw";
    const first = await w.runner.run(w.executionId);
    assert.equal(first.status, "PAYMENT_PENDING");
    w.kernel.sendMode = "ok";
    await w.runner.run(w.executionId);
    assert.equal(w.kernel.delegated.length, 1, "only the one transfer that may have gone out");
  });

  it("a recipient changed after authorization is refused, and nothing is sent", async () => {
    const w = await transferWorld();
    await ready(w);
    for (const recipient of w.w.r.world.recipients.values()) {
      recipient.walletAddress = `0x${"99".repeat(20)}`;
    }
    const outcome = await w.runner.run(w.executionId);
    assert.notEqual(outcome.status, "PAYMENT_SENT");
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("the signer refuses to sign before execution rights were taken", async () => {
    const w = await transferWorld();
    await assert.rejects(w.signer.signValidatedExecution(w.executionId), /EXECUTION_NOT_SIGNING/);
    assert.equal(w.kernel.delegated.length, 0);
  });
});

describe("the transfer plan (pure)", () => {
  const asset = { id: "asset-ngn", contractAddress: CNGN_ADDRESS } as never;
  const wallet = { id: "w1", address: `0x${"aa".repeat(20)}`, chainId: 42220 } as never;
  const now = new Date("2026-10-19T10:00:00Z");
  const authorizationRow = { expiresAt: new Date("2026-10-19T10:30:00Z") } as never;
  const candidate = (recipient?: string) => ({
    userId: "u",
    walletId: "w1",
    chainId: 42220,
    intentRevision: 1,
    operation: "SEND" as const,
    recipient: recipient ? { address: recipient } : {},
    input: createMoney("300", "asset-ngn"),
    output: createMoney("300", "asset-ngn"),
    route: { assetPath: ["asset-ngn"], providers: [] },
  });
  const base = {
    authorization: authorizationRow,
    wallet,
    asset,
    deployed: true,
    rootAvailable: true,
    infrastructure: { rpcConfigured: true, bundlerConfigured: true },
    now,
  };
  const permission = (over: Partial<DelegatedPermission> = {}): DelegatedPermission =>
    ({
      id: "p1",
      status: "ACTIVE",
      providerPermissionId: "0xabc",
      chainId: 42220,
      allowedOperations: ["TRANSFER_TOKEN"],
      allowedContracts: [CNGN_ADDRESS],
      allowedAssetIds: ["asset-ngn"],
      perTransactionLimit: createMoney("300", "asset-ngn"),
      validFrom: new Date("2026-10-19T09:55:00Z"),
      expiresAt: new Date("2026-10-19T10:10:00Z"),
      installedAt: new Date("2026-10-19T09:56:00Z"),
      ...over,
    }) as unknown as DelegatedPermission;

  it("without a recipient address it is blocked", () => {
    const plan = buildTransferPlan({ ...base, candidate: candidate(), permissions: [] });
    assert.equal(plan.status, "BLOCKED");
    assert.deepEqual(plan.blockers, ["RECIPIENT_ADDRESS_REQUIRED"]);
  });

  it("a usable permission for the same token and amount is satisfied; a smaller one is not", () => {
    const covering = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [permission()],
    });
    assert.equal(covering.permissionRequirement.state, "SATISFIED");
    const smaller = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [permission({ perTransactionLimit: createMoney("100", "asset-ngn") })],
    });
    assert.equal(smaller.permissionRequirement.state, "INSTALLATION_REQUIRED");
  });

  it("a swap permission (other operations or contracts) never covers a transfer", () => {
    const plan = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [
        permission({ allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"] }),
        permission({ allowedContracts: [CNGN_ADDRESS, `0x${"44".repeat(20)}`] }),
      ],
    });
    assert.equal(plan.permissionRequirement.state, "INSTALLATION_REQUIRED");
  });

  it("a permission about to expire is not used", () => {
    const plan = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [permission({ expiresAt: new Date("2026-10-19T10:00:30Z") })],
    });
    assert.equal(plan.permissionRequirement.state, "INSTALLATION_REQUIRED");
  });

  it("an account that does not exist yet needs the root signature, and no root is a blocker", () => {
    const needs = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      deployed: false,
      permissions: [],
    });
    assert.equal(needs.accountRequirements.rootSignatureRequired, true);
    const noRoot = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      deployed: false,
      rootAvailable: false,
      permissions: [],
    });
    assert.deepEqual(noRoot.blockers, ["NO_ROOT"]);
  });

  it("a plan whose authorization has expired is EXPIRED", () => {
    const plan = buildTransferPlan({
      ...base,
      authorization: { expiresAt: new Date("2026-10-19T09:00:00Z") } as never,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [],
    });
    assert.equal(plan.status, "EXPIRED");
  });

  it("its scope never carries a swap target or selector", () => {
    const plan = buildTransferPlan({
      ...base,
      candidate: candidate(RECIPIENT_ADDRESS),
      permissions: [],
    });
    const scope: PermissionScope = plan.permissionRequirement.scope;
    assert.equal("swapTarget" in scope, false);
    assert.equal("swapSelector" in scope, false);
    assert.deepEqual(scope.allowedOperations, ["TRANSFER_TOKEN"]);
  });
});
