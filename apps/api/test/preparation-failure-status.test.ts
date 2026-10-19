import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveProgress, describeProgress } from "../src/core/channels/payment-status.js";
import { outcomeFromRecord } from "../src/core/execution/tracker.js";
import { firmWorld } from "./support/firm-world.js";

/*
 * A payment the executor refuses before anything runs (for example a two-hop route) used to leave the chat on "Authorized,
 * confirming the final price" for ever, because the refusal lived only in one process's memory. It is now written on the
 * execution record, so the chat (and every instance) says what really happened.
 */

describe("a payment that preparation refuses is reported, not left 'confirming'", () => {
  it("a route the executor cannot run is recorded as FAILED with its reason, and nothing was sent", async () => {
    // USDC only: the cheapest route is two swaps, which execution refuses before any provider call.
    const w = await firmWorld({ text: "pay 500 brl", usdcOnly: true });
    const outcome = await w.service.prepare(w.authorization.id);
    assert.equal(outcome.status, "EXECUTION_ROUTE_UNSUPPORTED");

    const record = await w.uow.read.executionPlans.findByAuthorization(w.authorization.id);
    assert.equal(record?.status, "FAILED");
    assert.equal(record?.failureCode, "EXECUTION_ROUTE_UNSUPPORTED");
    assert.equal(w.calls().length, 0, "no provider was asked for anything");
  });

  it("the chat says so plainly instead of 'confirming the final price'", async () => {
    const w = await firmWorld({ text: "pay 500 brl", usdcOnly: true });
    await w.service.prepare(w.authorization.id);
    const plan = await w.uow.read.executionPlans.findByAuthorization(w.authorization.id);
    const progress = deriveProgress(
      {
        session: null,
        authorized: true,
        plan,
      },
      w.now(),
    );
    assert.deepEqual(progress, { state: "NO_ROUTE" });
    const text = describeProgress(progress);
    assert.match(text, /can't send this kind of payment yet/);
    assert.match(text, /nothing was sent/);
    assert.doesNotMatch(text, /Confirming the final price/);
  });

  it("the web page, reading the record after a restart, gets the same answer", async () => {
    const w = await firmWorld({ text: "pay 500 brl", usdcOnly: true });
    await w.service.prepare(w.authorization.id);
    const plan = await w.uow.read.executionPlans.findByAuthorization(w.authorization.id);
    assert.deepEqual(outcomeFromRecord(plan), { status: "EXECUTION_ROUTE_UNSUPPORTED" });
  });

  it("asking again does not turn a refused payment into a started one", async () => {
    const w = await firmWorld({ text: "pay 500 brl", usdcOnly: true });
    await w.service.prepare(w.authorization.id);
    assert.equal(
      (await w.service.prepare(w.authorization.id)).status,
      "EXECUTION_ROUTE_UNSUPPORTED",
    );
    const record = await w.uow.read.executionPlans.findByAuthorization(w.authorization.id);
    assert.equal(record?.status, "FAILED");
  });
});
