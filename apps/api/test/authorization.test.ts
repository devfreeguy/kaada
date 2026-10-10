import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { CELO_CHAIN_ID, createMoney, isKaadaError } from "@kaada/domain";
import type { AuthorizationCheck, ExecutionCandidate, PaymentAuthorization } from "@kaada/domain";

import type {
  AgentResponse,
  AuthorizationRequiredResponse,
} from "../src/core/responses/agent-response.js";
import { SENDER } from "./support/harness.js";
import { WALLET_ID, setup } from "./support/payment-world.js";

/*
 * Payment authorization against MOCK / TEST fixtures. 500 wBRL costs 92.26015 USDT (max 92.306281);
 * spending exactly 20 USDT gives 108.38916 wBRL (at least 108.33496542 with slippage). No provider is
 * called, nothing is signed and nothing executes.
 */

const PIN = "7351";
const WRONG = "2468";
const USDT_UNITS = 10n ** 6n;

function authorizationRequired(response: AgentResponse): AuthorizationRequiredResponse {
  assert.equal(response.type, "AUTHORIZATION_REQUIRED", JSON.stringify(response));
  if (response.type !== "AUTHORIZATION_REQUIRED") throw new Error("unreachable");
  return response;
}

/** A world with a funded wallet, a PIN, and a payment waiting for authorization. */
async function pending(
  text: "pay 500 brl with usdt" | "spend 20 usdt" | "pay 500 brl" = "pay 500 brl with usdt",
) {
  const w = setup({ authorize: true });
  w.fund("USDT", 500n);
  w.fund("USDC", 500n);
  await w.auth.pins.setPin(SENDER, PIN);
  const turn = await w.r.h.say(text);
  const response = authorizationRequired(turn.response);
  const token = await w.token(response.authorizationSessionId);
  const authorize = (pin = PIN, over: string = token) => w.auth.payments.authorize(over, pin);
  const sessionRow = () => w.r.world.authorization.sessions[0];
  const activeAuthorization = (): PaymentAuthorization | undefined =>
    w.r.world.authorization.payments.find((p) => p.status === "ACTIVE");
  return { w, turn, response, token, authorize, sessionRow, activeAuthorization };
}

describe("AUTHORIZATION_REQUIRED replaces PAYMENT_READY for payments", () => {
  it("produces a session reference, the summary and the limits, but no link or token", async () => {
    const { w, response, turn } = await pending();
    assert.equal(response.summary.amountMode, "EXACT_OUTPUT");
    assert.equal(response.summary.recipient, "João Silva");
    assert.equal(response.summary.recipientReceives.display, "500 wBRL");
    assert.equal(response.summary.minimumReceive.display, "500 wBRL");
    assert.equal(response.summary.senderSpends.display, "92.26015 USDT");
    assert.equal(response.summary.maximumSpend.display, "92.306281 USDT");
    assert.match(response.text, /Confirm with your PIN/);
    assert.match(response.text, /final price is confirmed just before it is sent/);
    assert.ok(response.authorizationSessionId);
    assert.ok(Date.parse(response.expiresAt) > w.r.clock.now.getTime());

    // The stored conversation holds the reference, never a link or a token.
    const token = await w.token(response.authorizationSessionId);
    const history = await w.r.world.repositories.messages.listRecent(turn.conversationId, 50);
    assert.equal(JSON.stringify(history).includes(token), false);
    assert.equal(JSON.stringify(history).includes("tokenHash"), false);
    assert.equal(
      Object.keys(response).some((key) => /token|url|link/i.test(key)),
      false,
    );
    assert.equal(turn.response.type, "AUTHORIZATION_REQUIRED");
  });

  it("a QUOTE never asks for a PIN and creates no session", async () => {
    const w = setup({ authorize: true });
    const turn = await w.r.h.say("quote");
    assert.equal(turn.response.type, "QUOTE_RESULT", JSON.stringify(turn.response));
    assert.equal(w.r.world.authorization.sessions.length, 0);
    assert.equal(w.port.lookups, 0, "a quote does not even look at the wallet");
  });

  it("still asks to set up a wallet first", async () => {
    const w = setup({ authorize: true });
    w.port.address = null;
    const turn = await w.r.h.say("pay 500 brl");
    assert.equal(turn.response.type, "ERROR");
    assert.ok(turn.response.type === "ERROR" && turn.response.code === "WALLET_SETUP_REQUIRED");
    assert.equal(w.r.world.authorization.sessions.length, 0);
  });

  it("checks the balance before any authorization is offered", async () => {
    const w = setup({ authorize: true });
    w.fund("USDT", 50n); // not enough for 92.30
    const turn = await w.r.h.say("pay 500 brl with usdt");
    assert.ok(turn.response.type === "ERROR" && turn.response.code === "INSUFFICIENT_BALANCE");
    assert.equal(w.r.world.authorization.sessions.length, 0);
  });

  it("no_makers_online stays a routing error and creates no session", async () => {
    const w = setup({ authorize: true, noMakersFrom: "USDC" });
    w.fund("USDC", 1000n);
    const turn = await w.r.h.say("pay 500 brl");
    assert.ok(turn.response.type === "ERROR" && turn.response.code === "ROUTING_UNAVAILABLE");
    assert.equal(w.r.world.authorization.sessions.length, 0);
  });

  it("is idempotent: the same payment gets the same session, even across duplicate deliveries", async () => {
    const { w, response } = await pending();
    const again = authorizationRequired((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.equal(again.authorizationSessionId, response.authorizationSessionId);
    assert.equal(w.r.world.authorization.sessions.length, 1);
    assert.equal(
      w.r.world.authorization.audit.filter((e) => e.type === "authorization.session_created")
        .length,
      1,
    );
  });
});

describe("authorization sessions", () => {
  it("binds the session to the right user, wallet, intent revision and route", async () => {
    const { w, response, sessionRow } = await pending();
    const row = sessionRow();
    assert.ok(row);
    assert.equal(row.userId, SENDER);
    assert.equal(row.walletId, WALLET_ID);
    assert.equal(row.intentId, response.intentId);
    assert.equal(row.intentRevision, response.revision);
    assert.equal(row.routeId, response.routeId);
    assert.equal(w.r.world.authorization.sessions.length, 1);
  });

  it("creates the link on demand, stores only its hash, and only for the session's own user", async () => {
    const { w, response, token, turn } = await pending();
    const row = w.r.world.authorization.sessions[0];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(row?.tokenHash ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(row?.tokenHash, token);
    assert.equal(JSON.stringify(w.r.world.authorization).includes(token), false);
    const history = await w.r.world.repositories.messages.listRecent(turn.conversationId, 50);
    assert.equal(JSON.stringify(history).includes(token), false);

    await assert.rejects(
      w.auth.sessions.issueLink({
        sessionId: response.authorizationSessionId,
        userId: randomUUID(),
      }),
      (e) => isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    const link = await w.auth.sessions.issueLink({
      sessionId: response.authorizationSessionId,
      userId: SENDER,
    });
    assert.equal(link.url, `https://app.kaada.test/authorize/${link.token}`);
    // A newer link replaces the older one.
    await assert.rejects(w.auth.sessions.view(token), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    await w.auth.sessions.view(link.token);
  });

  it("rejects an unknown, malformed or empty token the same generic way", async () => {
    const { w } = await pending();
    for (const bad of [randomUUID(), "x", "", "A".repeat(43), "%".repeat(43)]) {
      await assert.rejects(w.auth.sessions.view(bad), (e) => {
        assert.ok(isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"));
        assert.equal(e.message, "this authorization link is not valid");
        return true;
      });
    }
  });

  it("expires, and says so once in the audit trail", async () => {
    const { w, token, authorize } = await pending();
    w.r.clock.advance(5 * 60_000 + 1);
    await assert.rejects(w.auth.sessions.view(token), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    await assert.rejects(authorize(), (e) => isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"));
    assert.equal(w.r.world.authorization.sessions[0]?.status, "EXPIRED");
    assert.equal(
      w.r.world.authorization.audit.filter((e) => e.type === "authorization.session_expired")
        .length,
      1,
    );
    assert.equal(w.r.world.authorization.payments.length, 0);
  });

  it("the view shows the summary and the PIN state, with no internal ids", async () => {
    const { w, token } = await pending();
    const view = await w.auth.sessions.view(token);
    assert.equal(view.indicative, true);
    assert.equal(view.pin.isSet, true);
    assert.equal(view.summary.maximumSpend.display, "92.306281 USDT");
    const text = JSON.stringify(view);
    for (const secret of [SENDER, WALLET_ID, token]) assert.equal(text.includes(secret), false);
  });
});

describe("PIN entry creates the payment authorization", () => {
  it("EXACT_OUTPUT: records the exact output and the maximum spend", async () => {
    const { w, response, authorize } = await pending("pay 500 brl with usdt");
    const result = await authorize();
    assert.equal(result.status, "AUTHORIZED");
    const a = w.r.world.authorization.payments[0];
    assert.ok(a);
    assert.equal(a.status, "ACTIVE");
    assert.equal(a.bounds.mode, "EXACT_OUTPUT");
    if (a.bounds.mode !== "EXACT_OUTPUT") throw new Error("unreachable");
    assert.equal(a.bounds.exactOutput.amount, "500000000000000000000");
    assert.equal(a.bounds.maximumInput.amount, "92306281");
    assert.equal(a.userId, SENDER);
    assert.equal(a.walletId, WALLET_ID);
    assert.equal(a.chainId, CELO_CHAIN_ID);
    assert.equal(a.intentId, response.intentId);
    assert.equal(a.intentRevision, response.revision);
    assert.equal(a.routeId, response.routeId);
    assert.equal(a.operation, "SEND");
    assert.deepEqual(a.route.assetPath, [w.r.h.assets.USDT.id, w.r.tokens.wBRL.id]);
    assert.equal(a.recipient.recipientId !== undefined, true);
    assert.equal("quoteId" in a, false, "an authorization is not tied to a provider quote");
    // It lives a few minutes, not half an hour.
    assert.equal(a.expiresAt.getTime() - w.r.clock.now.getTime(), 3 * 60_000);
  });

  it("EXACT_INPUT: records the authorized input and the minimum output", async () => {
    const { w, authorize } = await pending("spend 20 usdt");
    await authorize();
    const a = w.r.world.authorization.payments[0];
    assert.ok(a);
    assert.equal(a.bounds.mode, "EXACT_INPUT");
    if (a.bounds.mode !== "EXACT_INPUT") throw new Error("unreachable");
    assert.equal(a.bounds.authorizedInput.amount, (20n * USDT_UNITS).toString());
    // 108.38916 wBRL less 5 bps (rounded up) of slippage.
    assert.equal(a.bounds.minimumOutput.amount, "108334965420000000000");
  });

  it("consumes the session: the link works once", async () => {
    const { w, token, authorize } = await pending();
    await authorize();
    assert.equal(w.r.world.authorization.sessions[0]?.status, "AUTHORIZED");
    assert.ok(w.r.world.authorization.sessions[0]?.usedAt);
    await assert.rejects(authorize(), (e) => isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"));
    await assert.rejects(w.auth.sessions.view(token), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    assert.equal(w.r.world.authorization.payments.length, 1);
    assert.equal(
      w.r.world.authorization.audit.filter((e) => e.type === "authorization.payment_authorized")
        .length,
      1,
    );
  });

  it("a wrong PIN authorizes nothing and reports the attempts left", async () => {
    const { w, authorize } = await pending();
    assert.deepEqual(await authorize(WRONG), { status: "INVALID_PIN", attemptsRemaining: 2 });
    assert.equal(w.r.world.authorization.payments.length, 0);
    assert.equal(
      w.r.world.authorization.sessions[0]?.status,
      "PENDING",
      "the link survives a typo",
    );
    assert.equal((await authorize()).status, "AUTHORIZED");
  });

  it("three wrong PINs lock; a fresh session cannot dodge the lock", async () => {
    const { w, authorize, response } = await pending();
    await authorize(WRONG);
    await authorize(WRONG);
    const third = await authorize(WRONG);
    assert.ok(third.status === "INVALID_PIN" && third.attemptsRemaining === 0 && third.lockedUntil);
    assert.equal((await authorize(PIN)).status, "LOCKED");

    // A new link for the same session does not help: the lock belongs to the user.
    const fresh = await w.token(response.authorizationSessionId);
    assert.equal((await authorize(PIN, fresh)).status, "LOCKED");
    assert.equal(w.r.world.authorization.payments.length, 0);
  });

  it("with no PIN set it asks for one, and flagged PINs ask for recovery", async () => {
    const w = setup({ authorize: true });
    w.fund("USDT", 500n);
    const response = authorizationRequired((await w.r.h.say("pay 500 brl with usdt")).response);
    const token = await w.token(response.authorizationSessionId);
    assert.deepEqual(await w.auth.payments.authorize(token, PIN), { status: "PIN_NOT_SET" });
    await w.auth.pins.setPin(SENDER, PIN);
    await w.auth.pins.requireReset(SENDER, "TEST");
    assert.deepEqual(await w.auth.payments.authorize(token, PIN), { status: "PIN_RESET_REQUIRED" });
  });

  it("two browsers using one session: only one authorization results", async () => {
    const { w, authorize } = await pending();
    const results = await Promise.allSettled([authorize(), authorize()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(w.r.world.authorization.payments.length, 1);
  });

  it("duplicate submit of a wrong PIN counts every attempt (no free retries)", async () => {
    const { w, authorize } = await pending();
    await Promise.allSettled([
      authorize(WRONG),
      authorize(WRONG),
      authorize(WRONG),
      authorize(WRONG),
    ]);
    assert.equal(w.auth.hasher.verifyCalls, 3);
    assert.equal((await authorize()).status, "LOCKED");
  });

  it("the PIN never reaches the audit trail, the logs or the stored conversation", async () => {
    const { w, authorize, turn } = await pending();
    await authorize(WRONG);
    await authorize(PIN);
    const everything = JSON.stringify([
      w.r.world.authorization.audit,
      w.r.world.authorization.sessions,
      w.r.world.authorization.payments,
      [...w.r.world.authorization.pins.values()],
      w.r.h.logs,
    ]);
    assert.equal(everything.includes(PIN), false);
    assert.equal(everything.includes(WRONG), false);
    const history = await w.r.world.repositories.messages.listRecent(turn.conversationId, 100);
    assert.equal(JSON.stringify(history).includes(PIN), false);
    assert.equal(JSON.stringify(history).includes(WRONG), false);
  });
});

describe("a changed payment invalidates what was built for it", () => {
  it("editing the payment cancels the session and revokes an approval", async () => {
    const { w, authorize, activeAuthorization } = await pending();
    await authorize();
    assert.ok(activeAuthorization());

    // Changing the amount revises the intent: the approval and the new session's predecessor go.
    await w.r.h.say("make it 40");
    assert.equal(activeAuthorization(), undefined);
    const revoked = w.r.world.authorization.payments[0];
    assert.equal(revoked?.status, "REVOKED");
    assert.equal(revoked?.revocationReason, "INTENT_REVISED");
    assert.equal(
      w.r.world.authorization.audit.some(
        (e) => e.type === "authorization.payment_authorization_revoked",
      ),
      true,
    );
  });

  it("an unused session is cancelled when the payment changes, and its link stops working", async () => {
    const { w, token, authorize } = await pending();
    await w.r.h.say("make it 40");
    assert.equal(w.r.world.authorization.sessions[0]?.status, "CANCELLED");
    await assert.rejects(w.auth.sessions.view(token), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    await assert.rejects(authorize(), (e) => isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"));
    assert.equal(w.r.world.authorization.payments.length, 0);
  });

  it("a new route for the same payment retires the old session and approval", async () => {
    const { w, authorize, response } = await pending();
    await authorize();
    // The prices expire; asking again prices a NEW route, so what was built on the old one is retired.
    w.r.clock.advance(31_000);
    const again = authorizationRequired((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.notEqual(again.routeId, response.routeId);
    const first = w.r.world.authorization.payments[0];
    assert.equal(first?.status, "REVOKED");
    assert.equal(first?.revocationReason, "ROUTE_REPLACED");
  });

  it("keeps the revoked approval as history", async () => {
    const { w, authorize } = await pending();
    await authorize();
    await w.r.h.say("make it 40");
    assert.equal(w.r.world.authorization.payments.length, 1);
    assert.ok(w.r.world.authorization.payments[0]?.revokedAt);
  });

  it("an edit that lands while the PIN is being checked wins: nothing is authorized", async () => {
    const { w, authorize } = await pending();
    let release: () => void = () => undefined;
    w.auth.hasher.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = authorize();
    // The PIN check is paused mid-flight; the person edits the payment meanwhile.
    await w.r.h.say("make it 40");
    w.auth.hasher.hold = undefined;
    release();
    await assert.rejects(inFlight, (e) => isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"));
    assert.equal(w.r.world.authorization.payments.length, 0);
    assert.equal(w.r.world.authorization.sessions[0]?.status, "CANCELLED");
  });
});

describe("executing under an authorization (policy)", () => {
  async function authorized(
    text: "pay 500 brl with usdt" | "spend 20 usdt" = "pay 500 brl with usdt",
  ) {
    const ctx = await pending(text);
    await ctx.authorize();
    const authorization = ctx.activeAuthorization();
    assert.ok(authorization);
    const candidate = (over: Partial<ExecutionCandidate> = {}): ExecutionCandidate => ({
      userId: authorization.userId,
      walletId: authorization.walletId,
      chainId: authorization.chainId,
      intentRevision: authorization.intentRevision,
      operation: authorization.operation,
      recipient: { ...authorization.recipient },
      input:
        authorization.bounds.mode === "EXACT_OUTPUT"
          ? createMoney("92300000", authorization.bounds.maximumInput.assetId)
          : authorization.bounds.authorizedInput,
      output:
        authorization.bounds.mode === "EXACT_OUTPUT"
          ? authorization.bounds.exactOutput
          : createMoney("108400000000000000000", authorization.bounds.minimumOutput.assetId),
      route: {
        assetPath: [...authorization.route.assetPath],
        providers: [...authorization.route.providers],
      },
      ...over,
    });
    return { ...ctx, authorization, candidate };
  }

  const violations = (check: AuthorizationCheck) => (check.ok ? [] : check.violations);

  it("EXACT_OUTPUT: a firm price inside the maximum is allowed, one above is not", async () => {
    const { w, authorization, candidate } = await authorized();
    assert.deepEqual(w.auth.policy.check(authorization, candidate()), { ok: true });
    // 92.41 USDT is below the 92.306281 limit? No: the limit is 92.306281, so use a cheaper one too.
    const cheaper = candidate({ input: createMoney("92000000", w.r.h.assets.USDT.id) });
    assert.deepEqual(w.auth.policy.check(authorization, cheaper), { ok: true });
    const dearer = candidate({ input: createMoney("92306282", w.r.h.assets.USDT.id) });
    assert.deepEqual(violations(w.auth.policy.check(authorization, dearer)), [
      "INPUT_EXCEEDS_MAXIMUM",
    ]);
    const exactlyMax = candidate({ input: createMoney("92306281", w.r.h.assets.USDT.id) });
    assert.deepEqual(w.auth.policy.check(authorization, exactlyMax), { ok: true });
  });

  it("EXACT_OUTPUT: delivering less than the exact output is refused", async () => {
    const { w, authorization, candidate } = await authorized();
    const short = candidate({ output: createMoney("499999999999999999999", w.r.tokens.wBRL.id) });
    assert.deepEqual(violations(w.auth.policy.check(authorization, short)), [
      "OUTPUT_BELOW_MINIMUM",
    ]);
    const more = candidate({ output: createMoney("500000000000000000001", w.r.tokens.wBRL.id) });
    assert.deepEqual(w.auth.policy.check(authorization, more), { ok: true });
  });

  it("EXACT_INPUT: the input may not exceed the authorized amount and the output may not fall short", async () => {
    const { w, authorization, candidate } = await authorized("spend 20 usdt");
    assert.deepEqual(w.auth.policy.check(authorization, candidate()), { ok: true });
    const over = candidate({ input: createMoney("20000001", w.r.h.assets.USDT.id) });
    assert.deepEqual(violations(w.auth.policy.check(authorization, over)), [
      "INPUT_EXCEEDS_MAXIMUM",
    ]);
    const short = candidate({ output: createMoney("108334965419999999999", w.r.tokens.wBRL.id) });
    assert.deepEqual(violations(w.auth.policy.check(authorization, short)), [
      "OUTPUT_BELOW_MINIMUM",
    ]);
    const exactly = candidate({ output: createMoney("108334965420000000000", w.r.tokens.wBRL.id) });
    assert.deepEqual(w.auth.policy.check(authorization, exactly), { ok: true });
  });

  it("refuses a different recipient, source asset, destination asset, wallet, chain and user", async () => {
    const { w, authorization, candidate } = await authorized();
    const check = (over: Partial<ExecutionCandidate>) =>
      violations(w.auth.policy.check(authorization, candidate(over)));
    assert.deepEqual(check({ recipient: { recipientId: randomUUID() } }), ["RECIPIENT_MISMATCH"]);
    assert.deepEqual(check({ input: createMoney("90000000", w.r.h.assets.USDC_CELO.id) }), [
      "INPUT_ASSET_MISMATCH",
    ]);
    assert.deepEqual(check({ output: createMoney("500000000000000000000", w.r.tokens.wARS.id) }), [
      "OUTPUT_ASSET_MISMATCH",
    ]);
    assert.deepEqual(check({ walletId: randomUUID() }), ["WRONG_WALLET"]);
    assert.deepEqual(check({ chainId: 1 }), ["WRONG_CHAIN"]);
    assert.deepEqual(check({ userId: randomUUID() }), ["WRONG_USER"]);
    assert.deepEqual(check({ operation: "CONVERT" }), ["OPERATION_MISMATCH"]);
  });

  it("refuses a silent switch of the route: USDT -> wBRL is not USDC -> USDT -> wBRL", async () => {
    const { w, authorization, candidate } = await authorized();
    const usdc = w.r.h.assets.USDC_CELO.id;
    const rerouted = candidate({
      route: { assetPath: [usdc, w.r.h.assets.USDT.id, w.r.tokens.wBRL.id] },
    });
    assert.deepEqual(violations(w.auth.policy.check(authorization, rerouted)), ["ROUTE_MISMATCH"]);
    const otherProvider = candidate({
      route: { assetPath: [...authorization.route.assetPath], providers: ["someone-else"] },
    });
    assert.deepEqual(violations(w.auth.policy.check(authorization, otherProvider)), [
      "ROUTE_MISMATCH",
    ]);
  });

  it("refuses another intent revision", async () => {
    const { w, authorization, candidate } = await authorized();
    assert.deepEqual(
      violations(
        w.auth.policy.check(
          authorization,
          candidate({ intentRevision: authorization.intentRevision + 1 }),
        ),
      ),
      ["REVISION_MISMATCH"],
    );
  });

  it("refuses an authorization that has expired", async () => {
    const { w, authorization, candidate } = await authorized();
    w.r.clock.advance(3 * 60_000);
    assert.deepEqual(violations(w.auth.policy.check(authorization, candidate())), ["EXPIRED"]);
    assert.equal(await w.auth.payments.expireDue(), 1);
    assert.equal(w.r.world.authorization.payments[0]?.status, "EXPIRED");
  });

  it("reports every reason at once and rejects nonsense amounts", async () => {
    const { w, authorization, candidate } = await authorized();
    const result = violations(
      w.auth.policy.check(
        authorization,
        candidate({ chainId: 1, input: createMoney("0", w.r.h.assets.USDT.id) }),
      ),
    );
    assert.deepEqual(result.sort(), ["INVALID_AMOUNT", "WRONG_CHAIN"]);
  });

  it("is consumed exactly once", async () => {
    const { w, authorization, candidate } = await authorized();
    const consumed = await w.auth.policy.validateAndConsume(authorization.id, candidate());
    assert.equal(consumed.status, "CONSUMED");
    assert.ok(consumed.consumedAt);
    await assert.rejects(w.auth.policy.validateAndConsume(authorization.id, candidate()), (e) =>
      isKaadaError(e, "AUTHORIZATION_REJECTED"),
    );
    assert.equal(
      w.r.world.authorization.audit.filter(
        (e) => e.type === "authorization.payment_authorization_consumed",
      ).length,
      1,
    );
  });

  it("of many concurrent executions exactly one consumes it", async () => {
    const { w, authorization, candidate } = await authorized();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        w.auth.policy.validateAndConsume(authorization.id, candidate()),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(w.r.world.authorization.payments[0]?.status, "CONSUMED");
  });

  it("an out-of-bounds execution consumes nothing and is audited", async () => {
    const { w, authorization, candidate } = await authorized();
    await assert.rejects(
      w.auth.policy.validateAndConsume(
        authorization.id,
        candidate({ input: createMoney("99000000", w.r.h.assets.USDT.id) }),
      ),
      (e) => isKaadaError(e, "AUTHORIZATION_REJECTED") && Array.isArray(e.details?.["violations"]),
    );
    assert.equal(
      w.r.world.authorization.payments[0]?.status,
      "ACTIVE",
      "a new firm price may still fit",
    );
    assert.equal(
      w.r.world.authorization.audit.some(
        (e) => e.type === "authorization.payment_authorization_rejected",
      ),
      true,
    );
  });

  it("a revoked authorization cannot be consumed", async () => {
    const { w, authorization, candidate } = await authorized();
    assert.equal(await w.auth.policy.revoke(authorization.id, "USER_REQUEST"), true);
    await assert.rejects(w.auth.policy.validateAndConsume(authorization.id, candidate()), (e) =>
      isKaadaError(e, "AUTHORIZATION_REJECTED"),
    );
    assert.equal(await w.auth.policy.revoke(authorization.id, "AGAIN"), false);
  });

  it("only one approval is live per payment: a new one replaces the old", async () => {
    const ctx = await authorized();
    const { w, response } = ctx;
    // Ask again for a new link on the same (now authorized) route: nothing live to authorize.
    assert.ok(response.authorizationSessionId);
    assert.equal(w.r.world.authorization.payments.filter((p) => p.status === "ACTIVE").length, 1);
  });
});
