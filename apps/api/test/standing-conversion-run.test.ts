import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { permissionScopeKey } from "@kaada/domain";
import type { PermissionScope } from "@kaada/domain";

import type { PlanPolicy } from "../src/core/execution/fresh-plan.js";
import { firmWorld, quotedReply } from "./support/firm-world.js";
import type { FirmWorld } from "./support/firm-world.js";
import { EXACT_OUT, WALLET_ADDRESS, attachRunner } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";

/*
 * The standing permission for converting your own money, end to end on fakes: preparation, the runner and the signer must
 * all rebuild the SAME permission. If one of them were given no policy it would describe a different (exact, short-lived)
 * permission from the one that was installed, and the signer would refuse the payment for want of an installed permission.
 */

const POLICY: PlanPolicy = {
  standingConversion: { wholeTokens: 1_000_000n, windowMs: 30 * 24 * 3600_000 },
};
const WINDOW_MS = 30 * 24 * 3600_000;

/** A world whose stored payment is a CONVERSION: the person's own money, no recipient. */
async function conversion(policy: PlanPolicy | undefined): Promise<RunWorld> {
  const world: FirmWorld = await firmWorld({
    text: "pay 500 brl with usdt",
    ...(policy && { planPolicy: policy }),
  });
  const stored = world.w.r.world.authorization.payments.find(
    (p) => p.id === world.authorization.id,
  );
  assert.ok(stored);
  const intent = world.w.r.world.intents.get(stored.intentId);
  assert.ok(intent);
  world.w.r.world.intents.set(intent.id, {
    ...intent,
    type: "CONVERT",
    recipientId: undefined,
  } as never);
  Object.assign(stored, { operation: "CONVERT", recipient: {} });
  world.transport.enqueue(
    quotedReply({
      now: world.now(),
      sellAmount: "92200000",
      takerPays: "92200000",
      buyAmount: EXACT_OUT,
    }),
  );
  return attachRunner(world, undefined, undefined, undefined, policy);
}

const scopeOf = async (w: RunWorld): Promise<PermissionScope> => {
  const record = await w.uow.read.executionPlans.findById(w.executionId);
  const plan = record?.plan as unknown as {
    permissionRequirement: { scope: Record<string, unknown> };
  };
  const scope = plan.permissionRequirement.scope;
  return {
    ...scope,
    validFrom: new Date(String(scope["validFrom"])),
    expiresAt: new Date(String(scope["expiresAt"])),
  } as unknown as PermissionScope;
};

describe("a conversion with the standing permission, run end to end", () => {
  it("installs ONE standing permission, then the signer accepts it on the very same payment", async () => {
    const w = await conversion(POLICY);
    const scope = await scopeOf(w);
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), WINDOW_MS);
    assert.equal(
      scope.payout?.recipient,
      WALLET_ADDRESS.toLowerCase(),
      "paid back to the wallet itself",
    );

    assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
    // The setup page tells the truth about a conversion: no PIN was used, and this is what lets later ones run unasked.
    const pending = await w.uow.read.rootActions.findPendingByExecution(w.executionId);
    assert.ok(pending);
    const link = await w.rootActions.issueLink({ sessionId: pending.id, userId: pending.userId });
    const page = await w.rootActions.view(link.token);
    assert.match(page.message, /convert between your own currencies/);
    assert.doesNotMatch(page.message, /your PIN already did that/);
    await w.confirmRootAction();
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_SENT", JSON.stringify(outcome));

    // What was installed is the standing scope, and the signer's read-back asked about exactly that one.
    const installed = w.kernel.prepared[0];
    assert.ok(installed);
    assert.equal(permissionScopeKey(installed), permissionScopeKey(scope));
    assert.ok(w.kernel.readBacks.length > 0);
    for (const readBack of w.kernel.readBacks) {
      assert.equal(permissionScopeKey(readBack), permissionScopeKey(scope));
    }
    assert.equal(
      installed.expiresAt.getTime() - installed.validFrom.getTime(),
      WINDOW_MS,
      "a standing permission, not a 15-minute one",
    );
  });

  it("the stored permission remembers the scope key a later conversion will match", async () => {
    const w = await conversion(POLICY);
    await w.runner.run(w.executionId);
    await w.confirmRootAction();
    const [permission] = await w.uow.read.delegatedPermissions.listForWallet(
      w.authorization.walletId,
    );
    assert.equal(permission?.scopeKey, permissionScopeKey(await scopeOf(w)));
  });

  it("without the policy it stays exact and short-lived (nothing changes for anyone who does not opt in)", async () => {
    const w = await conversion(undefined);
    const scope = await scopeOf(w);
    assert.equal(scope.expiresAt.getTime() - scope.validFrom.getTime(), 15 * 60 * 1000);
  });
});
