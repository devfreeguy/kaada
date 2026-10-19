import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PIN, firmWorld } from "./support/firm-world.js";
import { attachRunner } from "./support/run-world.js";

/*
 * Found live: after one payment was sent, the next "send 1000 naira to @jay" in the same chat merged into the intent that had
 * just been paid. Its link was then cancelled by the double-spend guard ("already authorized and being carried out"), so a person
 * could never pay twice in one chat. A paid intent is finished: the next payment is a new intent.
 */

describe("a second payment in the same chat", () => {
  it("starts a NEW payment that can be authorized, after the first one was sent", async () => {
    const w = await attachRunner(await firmWorld({ directNaira: { holds: 5000n } }));
    assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
    await w.confirmRootAction();
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    const firstIntent = w.authorization.intentId;

    // Same chat, same words: a second payment.
    const turn = await w.w.r.h.say("send 300 Naira to the address");
    assert.equal(turn.response.type, "AUTHORIZATION_REQUIRED", JSON.stringify(turn.response));
    if (turn.response.type !== "AUTHORIZATION_REQUIRED") return;

    const token = await w.w.token(turn.response.authorizationSessionId);
    const authorized = await w.w.auth.payments.authorize(token, PIN);
    assert.equal(authorized.status, "AUTHORIZED", "the new payment is not refused as already paid");
    if (authorized.status !== "AUTHORIZED") return;
    assert.notEqual(authorized.authorization.intentId, firstIntent, "it is a different payment");
  });

  it("the paid payment's own link still cannot be used again", async () => {
    const w = await attachRunner(await firmWorld({ directNaira: { holds: 5000n } }));
    await w.runner.run(w.executionId);
    await w.confirmRootAction();
    await w.runner.run(w.executionId);
    await assert.rejects(w.w.auth.payments.authorize(w.token, PIN));
  });
});
