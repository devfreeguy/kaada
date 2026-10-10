import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UnauthorizedException } from "@nestjs/common";
import type { Repositories } from "@kaada/database";
import { createMoney, SecretValue } from "@kaada/domain";
import type { DelegatedPermission } from "@kaada/domain";

import { RunTracker } from "../src/core/execution/run-tracker.js";
import { ExecutionController } from "../src/execution/execution.controller.js";
import { approveCalldata, firmWorld, noQuoteReply, quotedReply } from "./support/firm-world.js";
import type { FirmWorld } from "./support/firm-world.js";
import {
  CLAIM_TOKEN,
  REACTOR,
  SECRET_KEY,
  SWAP_TARGET,
  USDT_ADDRESS,
  RECIPIENT_ADDRESS,
  WBRL_ADDRESS,
} from "./support/firm-world.js";
import { WALLET_ADDRESS, WALLET_ID } from "./support/payment-world.js";
import { AesGcmSecretCipher } from "../src/infrastructure/security/aes-gcm-cipher.js";
import { SENDER } from "./support/harness.js";

/*
 * Firm quotes and the pre-signing execution plan against TEST fixtures. 500 wBRL costs about
 * 92.26015 USDT and the authorized maximum is 92.306281; spending 20 USDT must return at least
 * 108.334965420 wBRL. The Textile transport is scripted: no network, no chain, no signer.
 */

const EXACT_OUT = "500000000000000000000";
const MAX_IN = 92_306_281n;

const outReply = (f: FirmWorld, over: Partial<Parameters<typeof quotedReply>[0]> = {}) =>
  quotedReply({
    now: f.now(),
    sellAmount: "92200000",
    buyAmount: EXACT_OUT,
    takerPays: "92200000",
    ...over,
  });

const inReply = (f: FirmWorld, over: Partial<Parameters<typeof quotedReply>[0]> = {}) =>
  quotedReply({
    now: f.now(),
    sellAmount: "20000000",
    buyAmount: "108400000000000000000",
    takerPays: "20000000",
    ...over,
  });

/** A world whose single reply is built from the world's own clock. */
async function exactOutput(over: Partial<Parameters<typeof quotedReply>[0]> = {}, extra = {}) {
  const f = await firmWorld({ ...extra });
  f.transport.enqueue(outReply(f, over));
  return f;
}

async function exactInput(over: Partial<Parameters<typeof quotedReply>[0]> = {}) {
  const f = await firmWorld({ text: "spend 20 usdt" });
  f.transport.enqueue(inReply(f, over));
  return f;
}

describe("the firm request", () => {
  it("EXACT_OUTPUT asks for the exact buy amount only, never the maximum input", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const [call] = f.calls();
    assert.equal(call?.path, "/v2/rfq/request");
    assert.deepEqual(call?.body, {
      chainId: 42220,
      sellToken: USDT_ADDRESS,
      buyToken: WBRL_ADDRESS,
      buyAmount: EXACT_OUT,
      taker: WALLET_ADDRESS,
    });
    assert.equal("sellAmount" in (call?.body ?? {}), false);
    assert.equal(JSON.stringify(call?.body).includes(String(MAX_IN)), false);
    assert.equal(call?.timeoutMs, 75_000);
  });

  it("EXACT_INPUT asks for the authorized input as the sell amount, never more", async () => {
    const f = await exactInput();
    await f.service.prepare(f.authorization.id);
    const [call] = f.calls();
    assert.equal(call?.body["sellAmount"], "20000000");
    assert.equal("buyAmount" in (call?.body ?? {}), false);
  });

  it("the taker is the wallet service's address for the authorization's wallet, and nobody else can set it", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    assert.equal(f.calls()[0]?.body["taker"], WALLET_ADDRESS);
    assert.equal(f.authorization.walletId, WALLET_ID);
    // The only inputs of the entry points are an authorization id and a bearer token.
    assert.equal(f.service.prepare.length, 1);
    assert.equal(ExecutionController.prototype.prepare.length, 1);
    assert.equal(ExecutionController.prototype.outcome.length, 1);
  });

  it("is never retried by the client, whatever the failure", async () => {
    const f = await firmWorld({ replies: [{ status: 503 }, { status: 503 }] });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "FINAL_PRICE_UNAVAILABLE");
    assert.equal(f.calls().length, 1, "a 5xx is not retried for a firm quote");
  });
});

describe("a fresh balance comes first", () => {
  it("reads the chain balance before asking and asks nothing when it is short (EXACT_INPUT)", async () => {
    const f = await exactInput();
    f.w.port.held.set(f.w.r.h.assets.USDT.id, 19_999_999n);
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "INSUFFICIENT_BALANCE");
    assert.equal(f.calls().length, 0);
    assert.equal(f.firm.attempts.length, 0);
    assert.ok(f.w.port.reads >= 1);
  });

  it("EXACT_OUTPUT needs the whole authorized ceiling, not just the estimate", async () => {
    const f = await exactOutput();
    f.w.port.held.set(f.w.r.h.assets.USDT.id, 92_300_000n); // above the estimate, below the 92.306281 ceiling
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "INSUFFICIENT_BALANCE");
    assert.equal(f.calls().length, 0);
  });

  it("reads fresh every time, never a stored balance", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const reads = f.w.port.reads;
    f.w.r.clock.advance(61_000); // the quote expires, so a new request will be considered
    f.transport.enqueue(outReply(f));
    await f.service.prepare(f.authorization.id);
    assert.ok(f.w.port.reads > reads);
  });
});

describe("one firm quote per authorization", () => {
  it("a repeat reuses the valid quote and takes no second provider slot", async () => {
    const f = await exactOutput();
    const first = await f.service.prepare(f.authorization.id);
    const second = await f.service.prepare(f.authorization.id);
    assert.equal(first.status, "EXECUTION_READY");
    assert.equal(second.status, "EXECUTION_READY");
    assert.equal(f.calls().length, 1);
    assert.equal(f.firm.attempts.length, 1);
  });

  it("concurrent deliveries make exactly one provider call", async () => {
    const f = await exactOutput();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.service.prepare(f.authorization.id)),
    );
    assert.equal(f.calls().length, 1);
    assert.equal(f.firm.attempts.length, 1);
    assert.ok(
      results.every((r) => ["EXECUTION_READY", "PREPARATION_IN_PROGRESS"].includes(r.status)),
      results.map((r) => r.status).join(),
    );
    assert.ok(results.some((r) => r.status === "EXECUTION_READY"));
  });

  it("an expired quote is never reused; one more request is allowed, then no more", async () => {
    const f = await firmWorld();
    f.transport.enqueue(outReply(f, { expiresInMs: 60_000 }));
    assert.equal((await f.service.prepare(f.authorization.id)).status, "EXECUTION_READY");

    f.w.r.clock.advance(61_000);
    f.transport.enqueue(outReply(f, { rfqId: "rfq_test_2" }));
    assert.equal((await f.service.prepare(f.authorization.id)).status, "EXECUTION_READY");
    assert.equal(f.calls().length, 2);
    assert.equal(
      f.firm.attempts.find((a) => a.providerQuoteId === "rfq_test_1")?.status,
      "EXPIRED",
    );

    f.w.r.clock.advance(61_000);
    const third = await f.service.prepare(f.authorization.id);
    assert.deepEqual(third, { status: "FINAL_PRICE_UNAVAILABLE", code: "ATTEMPTS_EXHAUSTED" });
    assert.equal(f.calls().length, 2, "history is kept and nothing loops");
    assert.equal(f.firm.attempts.length, 2);
  });

  it("an abandoned REQUESTING attempt is closed and still counted as holding a slot", async () => {
    const f = await exactOutput();
    f.firm.attempts.push({
      id: "00000000-0000-4000-8000-0000000000ff",
      paymentAuthorizationId: f.authorization.id,
      userId: SENDER,
      walletId: WALLET_ID,
      providerId: (await f.w.r.world.repositories.providers.findBySlug("textile"))?.id ?? "",
      status: "REQUESTING",
      idempotencyKey: "k-abandoned",
      amountMode: "EXACT_OUTPUT",
      exactAmount: createMoney(EXACT_OUT, f.w.r.tokens.wBRL.id),
      takerAddress: WALLET_ADDRESS,
      createdAt: new Date(f.now().getTime() - 5 * 60_000),
      updatedAt: new Date(f.now().getTime() - 5 * 60_000),
    });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "EXECUTION_READY");
    assert.equal(f.firm.attempts[0]?.status, "TIMED_OUT");
  });
});

describe("provider capacity", () => {
  it("a 429 without Retry-After is capacity, is not retried, and is not asked again at once", async () => {
    const f = await firmWorld({
      replies: [
        { status: 429, body: { error: { code: "rate_limited", message: "x", request_id: "r1" } } },
        { status: 429 },
      ],
    });
    const first = await f.service.prepare(f.authorization.id);
    assert.equal(first.status, "PROVIDER_CAPACITY_REACHED");
    assert.equal(f.calls().length, 1);
    const second = await f.service.prepare(f.authorization.id);
    assert.equal(second.status, "PROVIDER_CAPACITY_REACHED");
    assert.equal(f.calls().length, 1, "no repeat inside the cooldown");
    assert.equal(f.firm.attempts[0]?.status, "FAILED");
  });

  it("Kaada's own count of held slots stops the request before it reaches the provider", async () => {
    const f = await firmWorld({ held: 4, maxOutstanding: 4 });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "PROVIDER_CAPACITY_REACHED");
    assert.equal(f.calls().length, 0);
  });

  it("a timeout may have reserved a quote, so it keeps counting as a held slot and is not retried", async () => {
    const f = await firmWorld({ replies: [{ throws: "TIMEOUT" }, { throws: "TIMEOUT" }] });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "PROVIDER_TIMEOUT" });
    assert.equal(f.calls().length, 1);
    assert.equal(f.firm.attempts[0]?.status, "TIMED_OUT");
    const providerId = f.firm.attempts[0]?.providerId ?? "";
    assert.equal(
      await f.firm.repositories.firmQuoteAttempts.countHeldSlots(providerId, f.now(), 3 * 60_000),
      1,
    );
  });

  it("no_quote releases the slot at once and is a price problem, not a balance problem", async () => {
    const f = await firmWorld({ replies: [noQuoteReply] });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "NO_QUOTE" });
    assert.equal(f.firm.attempts[0]?.status, "FAILED");
    const providerId = f.firm.attempts[0]?.providerId ?? "";
    assert.equal(
      await f.firm.repositories.firmQuoteAttempts.countHeldSlots(providerId, f.now(), 3 * 60_000),
      0,
    );
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "ACTIVE");
  });

  it("a malformed answer is rejected by the schema and still holds its slot", async () => {
    const f = await firmWorld({
      replies: [{ status: 200, body: { data: { status: "quoted", rfqId: "rfq_x" } } }],
    });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "MALFORMED_RESPONSE" });
    assert.equal(f.firm.attempts[0]?.status, "TIMED_OUT");
  });
});

describe("the claim token is a secret", () => {
  it("is encrypted at rest with AES-GCM and bound to its own record", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    assert.equal(f.firm.secrets.length, 1);
    const [secret] = f.firm.secrets;
    assert.ok(secret);
    assert.match(secret.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(secret.ciphertext.includes(CLAIM_TOKEN), false);
    assert.equal(secret.purpose, "TEXTILE_CLAIM_TOKEN");
    assert.equal(f.firm.attempts[0]?.claimSecretId, secret.id);

    const cipher = new AesGcmSecretCipher([{ version: 1, key: SECRET_KEY }]);
    assert.equal(
      cipher.decrypt(secret.ciphertext, `textile-claim-token:${secret.id}`),
      CLAIM_TOKEN,
    );
    assert.throws(() => cipher.decrypt(secret.ciphertext, "textile-claim-token:another-record"));
    const tampered = `${secret.ciphertext.slice(0, -2)}AA`;
    assert.throws(() => cipher.decrypt(tampered, `textile-claim-token:${secret.id}`));
    const otherKey = new AesGcmSecretCipher([
      { version: 1, key: Buffer.alloc(32, 7).toString("base64") },
    ]);
    assert.throws(() => otherKey.decrypt(secret.ciphertext, `textile-claim-token:${secret.id}`));
  });

  it("uses a fresh nonce each time, supports rotation, and refuses a short key", () => {
    const a = new AesGcmSecretCipher([{ version: 2, key: SECRET_KEY }]);
    const one = a.encrypt("same", "ctx");
    const two = a.encrypt("same", "ctx");
    assert.notEqual(one.ciphertext, two.ciphertext);
    assert.match(one.ciphertext, /^v2\./);
    const rotated = new AesGcmSecretCipher([
      { version: 3, key: Buffer.alloc(32, 9).toString("base64") },
      { version: 2, key: SECRET_KEY },
    ]);
    assert.equal(rotated.decrypt(one.ciphertext, "ctx"), "same");
    assert.match(rotated.encrypt("x", "ctx").ciphertext, /^v3\./);
    assert.throws(() => new AesGcmSecretCipher([{ version: 1, key: "c2hvcnQ=" }]));
  });

  it("never appears in logs, audit, stored rows, plans or any outcome", async () => {
    const f = await exactOutput();
    const outcome = await f.service.prepare(f.authorization.id);
    const everything = JSON.stringify([
      f.logs,
      f.w.r.world.authorization.audit,
      f.firm.attempts,
      f.firm.plans,
      outcome,
      f.w.r.world.authorization.payments,
    ]);
    assert.equal(everything.includes(CLAIM_TOKEN), false);
    assert.equal(everything.includes("rfqc_"), false);
    assert.equal(JSON.stringify({ t: new SecretValue(CLAIM_TOKEN) }), '{"t":"[REDACTED]"}');
    assert.equal(String(new SecretValue(CLAIM_TOKEN)), "[REDACTED]");
  });

  it("is never returned to a browser", async () => {
    const f = await exactOutput();
    const controller = new ExecutionController(
      f.w.auth.sessions,
      f.service,
      f.tracker,
      f.w.auth.uow.read as unknown as Repositories,
      null,
      null,
      new RunTracker(),
    );
    // The controller reads the stored session and plan through the same in-memory repositories.
    Object.assign(controller, {
      repositories: {
        paymentAuthorizations: f.w.auth.uow.read.paymentAuthorizations,
        executionPlans: f.firm.repositories.executionPlans,
      },
    });
    const started = await controller.prepare(`Bearer ${f.token}`);
    await f.tracker.idle();
    const outcome = await controller.outcome(`Bearer ${f.token}`);
    const text = JSON.stringify([started, outcome]);
    assert.equal(text.includes(CLAIM_TOKEN), false);
    assert.equal(outcome.state, "EXECUTION_READY");
    assert.equal(outcome.message, "Payment authorized and final pricing confirmed.");
    for (const word of ["sent", "paid", "completed", "received"]) {
      assert.equal(
        new RegExp(`\\b${word}\\b`, "i").test(outcome.message.replace("Nothing was sent", "")),
        false,
      );
    }
  });
});

describe("a bad answer from the provider", () => {
  it("rejects a quote for another chain", async () => {
    const f = await exactOutput({ chainId: 1 });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "QUOTE_MISMATCH" });
  });

  it("rejects a quote bound to another taker", async () => {
    const f = await exactOutput({ taker: `0x${"99".repeat(20)}` });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FINAL_PRICE_UNAVAILABLE", code: "QUOTE_MISMATCH" });
  });

  it("rejects an exact side that is not what was asked for", async () => {
    const out = await exactOutput({ buyAmount: "499000000000000000000" });
    assert.equal(
      (await out.service.prepare(out.authorization.id)).status,
      "FINAL_PRICE_UNAVAILABLE",
    );
    const input = await exactInput({ sellAmount: "19999999" });
    assert.equal(
      (await input.service.prepare(input.authorization.id)).status,
      "FINAL_PRICE_UNAVAILABLE",
    );
  });
});

describe("the firm price against what was authorized", () => {
  it("EXACT_OUTPUT inside the maximum becomes READY and leaves the authorization untouched", async () => {
    const f = await exactOutput();
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "EXECUTION_READY");
    const stored = f.w.r.world.authorization.payments[0];
    assert.equal(stored?.status, "ACTIVE", "planning never consumes the approval");
    assert.equal(stored?.consumedAt, undefined);
    assert.deepEqual(stored?.bounds, f.authorization.bounds, "the bounds never change");
    assert.equal(f.firm.plans[0]?.status, "READY");
  });

  it("exactly the maximum is allowed; one atom above needs a new authorization", async () => {
    const edge = await exactOutput({ takerPays: String(MAX_IN), sellAmount: String(MAX_IN) });
    assert.equal((await edge.service.prepare(edge.authorization.id)).status, "EXECUTION_READY");

    const over = await exactOutput({
      takerPays: String(MAX_IN + 1n),
      sellAmount: String(MAX_IN + 1n),
    });
    const outcome = await over.service.prepare(over.authorization.id);
    assert.equal(outcome.status, "REAUTHORIZATION_REQUIRED");
    if (outcome.status !== "REAUTHORIZATION_REQUIRED") throw new Error("unreachable");
    assert.deepEqual(outcome.violations, ["INPUT_EXCEEDS_MAXIMUM"]);
    assert.equal(over.calls().length, 1, "no second quote is requested");
    assert.equal(
      over.w.r.world.authorization.payments[0]?.status,
      "ACTIVE",
      "not widened, not consumed",
    );
    assert.equal(over.firm.attempts[0]?.status, "UNUSABLE");
    assert.equal(over.firm.plans[0]?.status, "FAILED");
    assert.equal(over.firm.plans[0]?.failureCode, "OUTSIDE_AUTHORIZED_LIMITS");
  });

  it("a better price than the estimate is accepted without another PIN", async () => {
    const f = await exactOutput({ takerPays: "90000000", sellAmount: "90000000" });
    assert.equal((await f.service.prepare(f.authorization.id)).status, "EXECUTION_READY");
    assert.equal(f.w.r.world.authorization.sessions.length, 1, "no new session was needed");
  });

  it("EXACT_INPUT: more output is fine, less than the minimum is not, more input is not", async () => {
    const good = await exactInput({ buyAmount: "109000000000000000000" });
    assert.equal((await good.service.prepare(good.authorization.id)).status, "EXECUTION_READY");

    const low = await exactInput({ buyAmount: "108334965419999999999" });
    const lowOutcome = await low.service.prepare(low.authorization.id);
    assert.ok(lowOutcome.status === "REAUTHORIZATION_REQUIRED");
    assert.deepEqual(lowOutcome.violations, ["OUTPUT_BELOW_MINIMUM"]);

    const exactMin = await exactInput({ buyAmount: "108334965420000000000" });
    assert.equal(
      (await exactMin.service.prepare(exactMin.authorization.id)).status,
      "EXECUTION_READY",
    );

    const dear = await exactInput({ takerPays: "20000001" });
    const dearOutcome = await dear.service.prepare(dear.authorization.id);
    assert.ok(dearOutcome.status === "REAUTHORIZATION_REQUIRED");
    assert.deepEqual(dearOutcome.violations, ["INPUT_EXCEEDS_MAXIMUM"]);
  });

  it("a changed payment is refused BEFORE any provider slot is spent", async () => {
    const edited = await exactOutput();
    await edited.w.r.h.say("make it 40");
    const e = await edited.service.prepare(edited.authorization.id);
    assert.deepEqual(e, { status: "REAUTHORIZATION_REQUIRED", reason: "AUTHORIZATION_NOT_ACTIVE" });
    assert.equal(edited.calls().length, 0);

    const route = await exactOutput();
    await route.w.r.world.repositories.routes.updateStatus(route.authorization.routeId, "INVALID");
    assert.deepEqual(await route.service.prepare(route.authorization.id), {
      status: "REAUTHORIZATION_REQUIRED",
      reason: "PAYMENT_CHANGED",
    });
    assert.equal(route.calls().length, 0);

    const recipient = await exactOutput();
    const intent = await recipient.w.r.world.repositories.intents.findById(
      recipient.authorization.intentId,
    );
    const stored = await recipient.w.r.world.repositories.recipients.findById(
      intent?.recipientId ?? "",
    );
    assert.ok(stored);
    stored.walletAddress = `0x${"ab".repeat(20)}`; // the recipient now resolves to a different address
    const r = await recipient.service.prepare(recipient.authorization.id);
    assert.ok(
      r.status === "REAUTHORIZATION_REQUIRED" && r.violations?.includes("RECIPIENT_MISMATCH"),
    );
    assert.equal(recipient.calls().length, 0);
  });

  it("an expired authorization is refused before any provider call", async () => {
    const f = await exactOutput();
    f.w.r.clock.advance(3 * 60_000);
    assert.deepEqual(await f.service.prepare(f.authorization.id), {
      status: "REAUTHORIZATION_REQUIRED",
      reason: "AUTHORIZATION_EXPIRED",
    });
    assert.equal(f.calls().length, 0);
  });

  it("a quote too close to expiry is not ready, is not retried, and burns nothing", async () => {
    const f = await exactOutput({ expiresInMs: 5_000 });
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY" });
    assert.equal(f.calls().length, 1);
    assert.equal(f.firm.attempts[0]?.status, "UNUSABLE");
    assert.equal(f.firm.attempts[0]?.failureCode, "TOO_CLOSE_TO_EXPIRY");
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "ACTIVE");
  });

  it("validate never consumes; consume takes it exactly once", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const plan = f.firm.plans[0]?.plan as { candidate: Record<string, unknown> } | undefined;
    assert.ok(plan);
    const candidate = {
      userId: SENDER,
      walletId: WALLET_ID,
      chainId: 42220,
      intentRevision: f.authorization.intentRevision,
      operation: "SEND" as const,
      recipient: { ...f.authorization.recipient },
      input: createMoney("92200000", f.w.r.h.assets.USDT.id),
      output: createMoney(EXACT_OUT, f.w.r.tokens.wBRL.id),
      route: {
        assetPath: [...f.authorization.route.assetPath],
        providers: [...f.authorization.route.providers],
      },
    };
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await f.w.auth.policy.validate(f.authorization.id, candidate), { ok: true });
    }
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "ACTIVE");
    await f.w.auth.policy.validateAndConsume(f.authorization.id, candidate);
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "CONSUMED");
  });

  it("refuses a wrong input asset, a wrong output asset and a wrong chain in the candidate", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const base = {
      userId: SENDER,
      walletId: WALLET_ID,
      chainId: 42220,
      intentRevision: f.authorization.intentRevision,
      operation: "SEND" as const,
      recipient: { ...f.authorization.recipient },
      input: createMoney("92200000", f.w.r.h.assets.USDT.id),
      output: createMoney(EXACT_OUT, f.w.r.tokens.wBRL.id),
      route: {
        assetPath: [...f.authorization.route.assetPath],
        providers: [...f.authorization.route.providers],
      },
    };
    const violations = (over: object) => {
      const check = f.w.auth.policy.check(f.authorization, { ...base, ...over });
      return check.ok ? [] : check.violations;
    };
    assert.deepEqual(violations({ input: createMoney("92200000", f.w.r.h.assets.USDC_CELO.id) }), [
      "INPUT_ASSET_MISMATCH",
    ]);
    assert.deepEqual(violations({ output: createMoney(EXACT_OUT, f.w.r.tokens.wARS.id) }), [
      "OUTPUT_ASSET_MISMATCH",
    ]);
    assert.deepEqual(violations({ chainId: 1 }), ["WRONG_CHAIN"]);
  });
});

describe("account, permission and allowance requirements", () => {
  const permission = (
    f: FirmWorld,
    over: Partial<DelegatedPermission> = {},
  ): DelegatedPermission => ({
    id: "00000000-0000-4000-8000-0000000000e1",
    userId: SENDER,
    walletId: WALLET_ID,
    provider: "zerodev-kernel-v3.3",
    providerPermissionId: "perm-1",
    chainId: 42220,
    status: "ACTIVE",
    allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
    allowedContracts: [USDT_ADDRESS, SWAP_TARGET, WBRL_ADDRESS],
    allowedAssetIds: [f.w.r.h.assets.USDT.id, f.w.r.tokens.wBRL.id],
    perTransactionLimit: createMoney(String(MAX_IN), f.w.r.h.assets.USDT.id),
    enforcement: {
      contracts: "ONCHAIN",
      operations: "ONCHAIN",
      assets: "ONCHAIN",
      perTransactionLimit: "ONCHAIN",
      cumulativeLimit: "KAADA_POLICY",
      validity: "ONCHAIN",
    },
    validFrom: new Date(f.now().getTime() - 60_000),
    expiresAt: new Date(f.now().getTime() + 3_600_000),
    createdAt: f.now(),
    ...over,
  });

  interface PlanView {
    status: string;
    accountRequirements: {
      deploymentRequired: boolean;
      rootSignatureRequired: boolean;
      passkeyRootAvailable: boolean;
    };
    permissionRequirement: {
      state: string;
      installSigner: string;
      scope: {
        chainId: number;
        allowedContracts: string[];
        allowedOperations: string[];
        allowedAssetIds: string[];
        perTransactionLimit: { amount: string };
        payout?: { recipient: string };
        swapSelector: string;
        validFrom: string;
        expiresAt: string;
      };
    };
    approvalRequirements: {
      signer: string;
      required: boolean;
      currentAllowance: string;
      requiredAllowance: string;
      spender: string;
      owner: string;
      resetToZeroFirst: boolean;
    }[];
    swapRequirement: { signer: string; claimTokenStored: boolean };
    signingPrerequisites: string[];
    candidate: {
      providerQuoteId: string;
      provider: string;
      intentId: string;
      routeSteps: unknown[];
    };
  }
  const planOf = (f: FirmWorld): PlanView => {
    const plan = f.firm.plans[0]?.plan;
    if (!plan) throw new Error("no plan was stored");
    return plan as unknown as PlanView;
  };

  it("discovers that the account must be deployed and a permission installed, and writes nothing", async () => {
    const f = await exactOutput();
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "EXECUTION_READY");
    const plan = planOf(f);
    assert.equal(plan["accountRequirements"].deploymentRequired, true);
    assert.equal(plan["accountRequirements"].rootSignatureRequired, true);
    assert.equal(plan["accountRequirements"].passkeyRootAvailable, true);
    assert.equal(plan["permissionRequirement"].state, "INSTALLATION_REQUIRED");
    assert.equal(plan["permissionRequirement"].installSigner, "ROOT_PASSKEY");
    assert.equal(plan["swapRequirement"].signer, "DELEGATED_SIGNER");
    assert.equal(plan["approvalRequirements"][0]?.signer, "DELEGATED_SIGNER");
    assert.deepEqual(plan["signingPrerequisites"], ["BUNDLER_NOT_CONFIGURED"]);
    assert.equal(plan["swapRequirement"].claimTokenStored, true);
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "ACTIVE");
  });

  it("a deployed account needs no deployment", async () => {
    const f = await exactOutput();
    f.chain.deployed = true;
    await f.service.prepare(f.authorization.id);
    assert.equal(planOf(f)["accountRequirements"].deploymentRequired, false);
  });

  it("scopes the permission to this payment: chain, contracts, asset, maximum spend, short window", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const scope = planOf(f)["permissionRequirement"].scope;
    assert.equal(scope.chainId, 42220);
    assert.deepEqual(
      scope.allowedContracts.sort(),
      [USDT_ADDRESS, SWAP_TARGET, WBRL_ADDRESS].sort(),
    );
    assert.deepEqual(scope.allowedOperations, ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"]);
    assert.deepEqual(scope.allowedAssetIds, [f.w.r.h.assets.USDT.id, f.w.r.tokens.wBRL.id]);
    assert.equal(scope.payout?.recipient, RECIPIENT_ADDRESS);
    assert.equal(
      scope.perTransactionLimit.amount,
      String(MAX_IN),
      "never above the authorized maximum",
    );
    const window = Date.parse(scope.expiresAt) - Date.parse(scope.validFrom);
    assert.ok(window > 0 && window <= 15 * 60_000);
  });

  it("recognizes an installed ACTIVE permission, but never a PENDING one", async () => {
    const installed = await exactOutput();
    installed.chain.deployed = true;
    installed.permissions.push(permission(installed));
    await installed.service.prepare(installed.authorization.id);
    assert.equal(planOf(installed)["permissionRequirement"].state, "SATISFIED");
    assert.equal(planOf(installed)["accountRequirements"].rootSignatureRequired, false);

    const pending = await exactOutput();
    pending.chain.deployed = true;
    pending.permissions.push(
      permission(pending, { status: "PENDING", providerPermissionId: undefined as never }),
    );
    await pending.service.prepare(pending.authorization.id);
    assert.equal(planOf(pending)["permissionRequirement"].state, "INSTALLATION_REQUIRED");

    const small = await exactOutput();
    small.chain.deployed = true;
    small.permissions.push(
      permission(small, {
        perTransactionLimit: createMoney("1000000", small.w.r.h.assets.USDT.id),
      }),
    );
    await small.service.prepare(small.authorization.id);
    assert.equal(
      planOf(small)["permissionRequirement"].state,
      "INSTALLATION_REQUIRED",
      "too small",
    );

    const expired = await exactOutput();
    expired.chain.deployed = true;
    expired.permissions.push(
      permission(expired, { expiresAt: new Date(expired.now().getTime() + 1_000) }),
    );
    await expired.service.prepare(expired.authorization.id);
    assert.equal(planOf(expired)["permissionRequirement"].state, "INSTALLATION_REQUIRED");
  });

  it("reads the allowance and decides whether an approval is needed", async () => {
    const enough = await exactOutput();
    enough.chain.allowance = 100_000_000n;
    await enough.service.prepare(enough.authorization.id);
    assert.equal(planOf(enough)["approvalRequirements"][0]?.required, false);
    assert.equal(
      planOf(enough)["permissionRequirement"].scope.allowedOperations.includes("APPROVE_TOKEN"),
      false,
    );

    const none = await exactOutput();
    none.chain.allowance = 0n;
    await none.service.prepare(none.authorization.id);
    const a = planOf(none)["approvalRequirements"][0];
    assert.ok(a);
    assert.equal(a.required, true);
    assert.equal(a.currentAllowance, "0");
    assert.equal(a.requiredAllowance, "92200000");
    assert.equal(a.spender, REACTOR);
    assert.equal(a.owner, WALLET_ADDRESS);
    assert.equal(a.resetToZeroFirst, false);

    const partial = await exactOutput();
    partial.chain.allowance = 5n;
    await partial.service.prepare(partial.authorization.id);
    assert.equal(
      planOf(partial)["approvalRequirements"][0]?.resetToZeroFirst,
      true,
      "USDT needs a reset first",
    );
  });

  it("never silently accepts an unlimited, oversized, misdirected or malformed approval", async () => {
    const max = (1n << 256n) - 1n;
    const cases: [
      string,
      Parameters<typeof quotedReply>[0] extends infer _
        ? Partial<Parameters<typeof quotedReply>[0]>
        : never,
      string,
    ][] = [
      ["unlimited", { approvalAmount: max }, "APPROVAL_UNLIMITED"],
      ["huge", { approvalAmount: 1n << 200n }, "APPROVAL_EXCEEDS_REQUIRED"],
      ["bigger than needed", { approvalAmount: 92_200_001n }, "APPROVAL_EXCEEDS_REQUIRED"],
      ["smaller than needed", { approvalAmount: 92_199_999n }, "APPROVAL_BELOW_REQUIRED"],
      ["wrong token", { approvalTo: WBRL_ADDRESS }, "APPROVAL_TOKEN_MISMATCH"],
      ["native value", { approvalValue: "1" }, "APPROVAL_CARRIES_VALUE"],
      ["swap value", { swapValue: "1" }, "SWAP_CARRIES_UNEXPECTED_VALUE"],
    ];
    for (const [label, over, blocker] of cases) {
      const f = await exactOutput(over);
      const outcome = await f.service.prepare(f.authorization.id);
      assert.equal(outcome.status, "EXECUTION_BLOCKED", label);
      assert.ok(
        outcome.status === "EXECUTION_BLOCKED" && outcome.blockers.includes(blocker as never),
        label,
      );
      assert.equal(f.firm.plans[0]?.status, "BLOCKED", label);
    }
    // The calldata names a spender other than the reactor.
    const f = await firmWorld();
    const reply = outReply(f);
    if ("body" in reply) {
      const body = reply.body as { data: { transactions: { approval: { data: string } } } };
      body.data.transactions.approval.data = approveCalldata(`0x${"77".repeat(20)}`, 92_200_000n);
    }
    f.transport.enqueue(reply);
    const outcome = await f.service.prepare(f.authorization.id);
    assert.ok(
      outcome.status === "EXECUTION_BLOCKED" &&
        outcome.blockers.includes("APPROVAL_TARGET_MISMATCH"),
    );
  });

  it("an approval that is not needed is still inspected, but only blocks when it would be used", async () => {
    const f = await exactOutput({ approvalAmount: (1n << 256n) - 1n });
    f.chain.allowance = 100_000_000n; // already approved: the provider's calldata would not be sent
    const outcome = await f.service.prepare(f.authorization.id);
    assert.equal(outcome.status, "EXECUTION_READY");
  });

  it("without a passkey the root signature has nothing to come from", async () => {
    const f = await exactOutput();
    f.credentials.length = 0;
    const outcome = await f.service.prepare(f.authorization.id);
    assert.ok(
      outcome.status === "EXECUTION_BLOCKED" && outcome.blockers.includes("NO_PASSKEY_ROOT"),
    );
  });

  it("assembles the plan from the live intent, with no signature and no secret", async () => {
    const f = await exactOutput();
    await f.service.prepare(f.authorization.id);
    const plan = planOf(f);
    assert.equal(plan["status"], "READY");
    assert.equal(plan["candidate"].providerQuoteId, "rfq_test_1");
    assert.equal(plan["candidate"].provider, "textile");
    assert.equal(plan["candidate"].intentId, f.authorization.intentId);
    assert.equal(plan["candidate"].routeSteps.length, 1);
    const text = JSON.stringify(plan);
    for (const forbidden of ["signature", CLAIM_TOKEN, '"claimToken"', "privateKey", "calldata"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    // The swap's 4-byte selector is pinned in the permission scope; its arguments never are.
    assert.equal(plan["permissionRequirement"].scope.swapSelector, "0xdeadbeef");
    assert.equal(/"data"/.test(text), false);
    // The record is a pre-execution stage and nothing else.
    assert.ok(
      ["PREPARING", "READY", "BLOCKED", "EXPIRED", "FAILED"].includes(
        f.firm.plans[0]?.status ?? "",
      ),
    );
  });
});

describe("only single-hop payments execute", () => {
  it("a two-hop route is refused before any provider call", async () => {
    const f = await firmWorld({ text: "pay 500 brl", usdcOnly: true });
    const route = await f.w.r.world.repositories.routes.findById(f.authorization.routeId);
    assert.equal(
      route?.steps.filter((s) => s.type === "SWAP").length,
      2,
      "the indicative route is multi-hop",
    );
    const outcome = await f.service.prepare(f.authorization.id);
    assert.deepEqual(outcome, { status: "EXECUTION_ROUTE_UNSUPPORTED" });
    assert.equal(f.calls().length, 0);
    assert.equal(f.firm.attempts.length, 0);
    assert.equal(f.w.r.world.authorization.payments[0]?.status, "ACTIVE");
  });

  it("a QUOTE never reaches the firm path", async () => {
    const f = await firmWorld();
    const turn = await f.w.r.h.say("quote");
    assert.equal(turn.response.type, "QUOTE_RESULT");
    assert.equal(f.calls().length, 0);
    assert.equal(f.firm.attempts.length, 0);
  });
});

describe("the HTTP edge", () => {
  it("needs the link of a session that was just authorized, and nothing else", async () => {
    const f = await exactOutput();
    const controller = new ExecutionController(
      f.w.auth.sessions,
      f.service,
      f.tracker,
      {
        paymentAuthorizations: f.w.auth.uow.read.paymentAuthorizations,
        executionPlans: f.firm.repositories.executionPlans,
      } as unknown as Repositories,
      null,
      null,
      new RunTracker(),
    );
    await assert.rejects(controller.prepare(undefined), UnauthorizedException);
    await assert.rejects(controller.prepare(`Bearer ${"A".repeat(43)}`), UnauthorizedException);
    await assert.rejects(controller.outcome("Basic abc"), UnauthorizedException);
    assert.equal(f.calls().length, 0);
    const started = await controller.prepare(`Bearer ${f.token}`);
    assert.ok(["PREPARING", "EXECUTION_READY"].includes(started.state), started.state);
    await f.tracker.idle();
    // A duplicate request takes no second provider slot.
    await controller.prepare(`Bearer ${f.token}`);
    await f.tracker.idle();
    assert.equal(f.calls().length, 1);
  });
});
