import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNativeCelo } from "@kaada/domain";

import { CELO_ADDRESS, RECIPIENT_ADDRESS, firmWorld } from "./support/firm-world.js";
import { attachRunner } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";

/*
 * CELO is Celo's own coin, sent like any token (it is also an ERC-20 at one address). It is not a currency: no fiat code, never
 * converted. The fee comes out of the same balance, so a payment in CELO must leave the fee behind.
 */

const THREE_TENTHS = 3n * 10n ** 17n;
const MIN_FEE = 10n ** 15n;
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

async function celoWorld(): Promise<RunWorld> {
  return attachRunner(await firmWorld({ directCelo: { holds: 5n } }));
}

async function ready(w: RunWorld): Promise<void> {
  assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
  await w.confirmRootAction();
}

describe("sending CELO", () => {
  it("is recognised by its address, and only on Celo", () => {
    assert.equal(
      isNativeCelo({ chainId: 42220, contractAddress: CELO_ADDRESS.toUpperCase() }),
      true,
    );
    assert.equal(isNativeCelo({ chainId: 1, contractAddress: CELO_ADDRESS }), false);
    assert.equal(isNativeCelo({ chainId: 42220, contractAddress: `0x${"55".repeat(20)}` }), false);
  });

  it("is a direct transfer of the CELO token to the recipient, with no value and no swap", async () => {
    const w = await celoWorld();
    await ready(w);
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_SENT");
    const [sent] = w.kernel.delegated;
    assert.equal(sent?.calls.length, 1);
    const call = sent?.calls[0];
    assert.equal(call?.to.toLowerCase(), CELO_ADDRESS);
    assert.equal(call?.value, "0");
    assert.equal(
      call?.data.toLowerCase(),
      `0xa9059cbb${word(RECIPIENT_ADDRESS)}${word(THREE_TENTHS.toString(16))}`,
    );
    assert.equal(w.calls().length, 0, "no pricing provider was involved");
  });

  it("refuses when sending it would leave too little CELO for the network fee, and consumes nothing", async () => {
    const w = await celoWorld();
    await ready(w);
    w.kernel.native = THREE_TENTHS + MIN_FEE - 1n;
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "INSUFFICIENT_BALANCE");
    assert.equal(w.kernel.delegated.length, 0);
    const stored = await w.uow.read.paymentAuthorizations.findById(w.authorization.id);
    assert.equal(stored?.status, "ACTIVE");
  });

  it("goes through when the fee is still covered after the amount leaves", async () => {
    const w = await celoWorld();
    await ready(w);
    w.kernel.native = THREE_TENTHS + MIN_FEE;
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
  });
});
