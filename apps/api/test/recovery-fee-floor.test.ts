import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveRecoveryKey, generateRecoveryCode } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Address } from "viem";

import { configureApp } from "../src/app.setup.js";
import { isFeeTooLow } from "../src/core/recovery/bundler-reason.js";
import { RecoveryController } from "../src/recovery/recovery.controller.js";
import type { RecoveryRuntime } from "../src/recovery/recovery.runtime.js";
import { RECOVERY_RUNTIME } from "../src/recovery/recovery.tokens.js";
import { WALLET_SETUP_SERVICE } from "../src/wallet/wallet.tokens.js";
import { createRecoveryWorld, expectKaada, newPasskeyRoot } from "./support/recovery-world.js";
import type { RecoveryWorld, TestUser } from "./support/recovery-world.js";
import { MemorySponsorshipLedger } from "./support/sponsorship-memory.js";

/*
 * Every operation to the bundler is priced at its fee floor plus 20%. When the floor cannot be read there is no price and no operation:
 * the person is told to try again in a few minutes and the log says so at error level. When the floor rises after an operation was
 * priced, the bundler refuses it, and that too is a retryable answer, not a raw 500.
 */

const CELO = 10n ** 18n;
const REAL_REFUSAL =
  "maxFeePerGas must be at least 360001500000 (current maxFeePerGas: 240001000000) - use pimlico_getUserOperationGasPrice to get the current gas price";
const TRY_LATER =
  "We can't finish securing your account right now. Please try again in a few minutes.";

type Logged = { level: string; event: string; fields: Record<string, unknown> };

function capture(world: RecoveryWorld): Logged[] {
  const logs: Logged[] = [];
  world.context.log = (level, event, fields) => {
    logs.push({ level, event, fields: fields ?? {} });
  };
  return logs;
}

function sponsoring(world: RecoveryWorld, over: { perWalletWei?: bigint } = {}) {
  const ledger = new MemorySponsorshipLedger();
  world.context.sponsorship = {
    perWalletWei: over.perWalletWei ?? CELO,
    dailyBudgetWei: 10n * CELO,
    relayerReserveWei: CELO,
    minDepositUsdMicros: 5_000_000n,
    depositItems: () => Promise.resolve([{ fiatCode: "USD", decimals: 6, delta: "20000000" }]),
    ledger,
  };
  return ledger;
}

const verifier = (world: RecoveryWorld, user: TestUser) =>
  deriveRecoveryKey(generateRecoveryCode(), {
    chainId: world.chain.chainId,
    account: user.account as Address,
  }).address;

async function post(configuration: unknown, userId: string, url: string, payload: unknown) {
  const runtime = {
    finalizer: {
      completedSessionUser: () => Promise.reject(new KaadaError("RECOVERY_SESSION_INVALID", "no")),
    },
    configuration,
  } as unknown as RecoveryRuntime;
  const moduleRef = await Test.createTestingModule({
    controllers: [RecoveryController],
    providers: [
      { provide: RECOVERY_RUNTIME, useValue: runtime },
      { provide: WALLET_SETUP_SERVICE, useValue: { userForView: () => Promise.resolve(userId) } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureApp(app, { corsOrigins: [] } as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/recovery${url}`,
    headers: { authorization: "Bearer abc", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  await app.close();
  return response;
}

const prepareBody = { recoveryAddress: "0x00000000000000000000000000000000000000f9" };

describe("no fee floor, no operation", () => {
  it("arming: a clean retryable answer, an error-level log naming the bundler's reason, and no fallback to the chain's price", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const logs = capture(world);
    world.chain.feeAvailable = false;
    const response = await post(
      world.configuration,
      user.userId,
      "/configuration/prepare",
      prepareBody,
    );
    const body = response.json<{ code: string; message: string; retryable: boolean }>();
    assert.equal(response.statusCode, 503);
    assert.equal(body.code, "GAS_ESTIMATE_UNAVAILABLE");
    assert.equal(body.message, TRY_LATER);
    assert.equal(body.retryable, true);
    const logged = logs.find((l) => l.event === "recovery.fee_unavailable");
    assert.equal(logged?.level, "error");
    assert.equal(logged?.fields["where"], "arming");
    assert.equal(logged?.fields["rpc"], "method not found");
    assert.equal(world.chain.topUps, 0, "nothing was priced or sent");
  });

  it("sponsoring: found BEFORE the wallet is opened, so nothing is spent on a wallet that cannot then be priced", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    world.chain.accounts.delete(user.account.toLowerCase());
    const logs = capture(world);
    const ledger = sponsoring(world);
    world.chain.feeAvailable = false;
    const response = await post(
      world.configuration,
      user.userId,
      "/configuration/prepare",
      prepareBody,
    );
    assert.equal(response.statusCode, 503);
    assert.equal(response.json<{ message: string }>().message, TRY_LATER);
    assert.equal(world.chain.openCalls, 0, "the account was not opened");
    assert.equal(ledger.rows.length, 0, "nothing was reserved");
    const seen = logs.filter(
      (l) => l.event === "recovery.fee_unavailable" || l.event === "recovery.sponsor_refused",
    );
    assert.deepEqual(
      seen.map((l) => l.level),
      ["error", "error"],
    );
  });

  it("cancel: logged at error level too, and the existing retryable answer stays", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await world.startRecovery(user, newPasskeyRoot());
    const cancelToken = world.cancelTokenFrom(user);
    const logs = capture(world);
    world.chain.feeAvailable = false;
    await expectKaada(world.flow.prepareCancel(cancelToken), "RECOVERY_BLOCKED");
    const logged = logs.find((l) => l.event === "recovery.fee_unavailable");
    assert.equal(logged?.level, "error");
    assert.equal(logged?.fields["where"], "cancel");
  });
});

describe("a fee floor that rose after the operation was priced", () => {
  async function submitting(message: string) {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const logs = capture(world);
    const arm = await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier(world, user),
    });
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const material = world.rootSigns(root.credentialRef, arm.signing.challenge);
    world.chain.submitOperation = () =>
      Promise.reject(
        new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
          details: { rpc: message, rpcCode: -32602 },
        }),
      );
    const error = await world.configuration
      .submit({ userId: user.userId, configurationId: arm.configurationId, material })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    return { error, logs };
  }

  it("the real refusal becomes a retryable RECOVERY_BLOCKED, and the bundler's words are still in the log", async () => {
    const { error, logs } = await submitting(REAL_REFUSAL);
    assert.ok(error instanceof KaadaError);
    assert.equal(error.code, "RECOVERY_BLOCKED");
    assert.deepEqual(error.details, { reason: "FEE_TOO_LOW" });
    const logged = logs.find((l) => l.event === "recovery.bundler_rejected");
    assert.match(String(logged?.fields["rpc"]), /maxFeePerGas must be at least 360001500000/);
  });

  it("over HTTP it is the same clean retryable 503, not a raw 500", async () => {
    const response = await post(
      {
        submit: () =>
          Promise.reject(
            new KaadaError("RECOVERY_BLOCKED", "x", { details: { reason: "FEE_TOO_LOW" } }),
          ),
      },
      "user-1",
      "/configuration",
      { configurationId: "5b0c2a52-1c7e-4f19-9a4e-0d6d3c0b8f11", material: {} },
    );
    assert.equal(response.statusCode, 503);
    assert.equal(response.json<{ code: string }>().code, "GAS_ESTIMATE_UNAVAILABLE");
    assert.equal(response.json<{ message: string }>().message, TRY_LATER);
  });

  it("any other refusal is left exactly as it was", async () => {
    const { error } = await submitting("AA24 signature error");
    assert.ok(error instanceof KaadaError);
    assert.equal(error.code, "BUNDLER_REJECTED");
  });

  it("the priority-fee form of the refusal is recognised too, and an ordinary message is not", () => {
    const refusal = (rpc: string) => new KaadaError("BUNDLER_REJECTED", "x", { details: { rpc } });
    assert.equal(isFeeTooLow(refusal(REAL_REFUSAL)), true);
    assert.equal(isFeeTooLow(refusal("maxPriorityFeePerGas must be at least 1500000")), true);
    assert.equal(isFeeTooLow(refusal("replacement underpriced")), true);
    assert.equal(isFeeTooLow(refusal("AA21 did not pay prefund")), false);
    assert.equal(
      isFeeTooLow(new Error("maxFeePerGas must be at least 1")),
      false,
      "only a bundler refusal counts",
    );
  });
});

describe("the sponsoring cost check uses the bundler's fee", () => {
  it("a cap that cannot cover the setup at today's fee is refused BEFORE the account is opened", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    world.chain.accounts.delete(user.account.toLowerCase());
    const logs = capture(world);
    sponsoring(world, { perWalletWei: CELO / 4n });
    world.chain.setupCostWei = (3n * CELO) / 10n; // 0.3 CELO at the floor: more than the 0.25 cap
    const error = await world.configuration
      .prepare({ userId: user.userId, recoveryAddress: verifier(world, user) })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(error instanceof KaadaError);
    assert.equal(error.code, "RECOVERY_SPONSORSHIP_REFUSED");
    assert.equal(world.chain.openCalls, 0);
    assert.equal(
      logs.find((l) => l.event === "recovery.sponsor_refused")?.fields["reason"],
      "WALLET_CAP",
    );
  });
});
