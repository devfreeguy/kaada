/*
 * Firm quotes and execution plans on the real database: the one-live-attempt index under real
 * concurrency, encrypted claim-token storage, the Execution plan record and its constraints. The
 * provider is a FAKE (no Textile call is ever made); the chain is a fake (no RPC). Every row belongs
 * to uniquely named test users and is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  SecretValue,
  createAssetRegistry,
  createId,
  createMoney,
} from "@kaada/domain";
import type { FirmQuoteProvider, FirmQuoteRequest, Wallet } from "@kaada/domain";

import { PaymentAuthorizationService } from "../../src/core/authorization/payment-authorization-service.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import { AuthorizationPolicyService } from "../../src/core/authorization/policy-service.js";
import { AuthorizationSessionService } from "../../src/core/authorization/session-service.js";
import { AccountReadinessService } from "../../src/core/execution/account-readiness.js";
import { FirmQuoteService } from "../../src/core/execution/firm-quote-service.js";
import { ExecutionPreparationService } from "../../src/core/execution/preparation-service.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";
import { approveCalldata } from "../support/firm-world.js";
import { TestPinHasher } from "../support/payment-world.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";
const PIN = "7351";
const KEY = randomBytes(32).toString("base64");
const REACTOR = `0x${"33".repeat(20)}`;
const SWAP_TARGET = `0x${"44".repeat(20)}`;
const CLAIM = "rfqc_INTEGRATION_TEST_TOKEN_must_not_be_stored_plain";

describe("firm quotes and execution plans on the real database", { skip }, () => {
  let database: Database;
  let repositories: Repositories;
  let uow: {
    read: Repositories;
    transaction<T>(work: (r: Repositories) => Promise<T>): Promise<T>;
  };
  const createdUsers: string[] = [];
  const run = createId().slice(0, 8);

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
    repositories = createRepositories(database);
    uow = {
      read: repositories,
      transaction: (work) =>
        withTransaction(database, work, { timeoutMs: 60_000, maxWaitMs: 30_000 }),
    };
  });

  // Each test starts with no held provider slots from earlier tests (Kaada's own slot count is shared
  // by every attempt on this database, which is exactly what it is for).
  afterEach(async () => {
    const userIds = { in: createdUsers };
    await database.client.execution.deleteMany({ where: { userId: userIds } });
    await database.client.firmQuoteAttempt.deleteMany({ where: { userId: userIds } });
  });

  after(async () => {
    const userIds = { in: createdUsers };
    const intents = (
      await database.client.intent.findMany({ where: { userId: userIds }, select: { id: true } })
    ).map((row) => row.id);
    const owned = { intentId: { in: intents } };
    await database.client.execution.deleteMany({ where: { userId: userIds } });
    await database.client.firmQuoteAttempt.deleteMany({ where: { userId: userIds } });
    await database.client.paymentAuthorization.deleteMany({ where: owned });
    await database.client.authorizationSession.deleteMany({ where: owned });
    await database.client.routeStep.deleteMany({ where: { route: owned } });
    await database.client.route.deleteMany({ where: owned });
    await database.client.quote.deleteMany({ where: owned });
    await database.client.intent.deleteMany({ where: { userId: userIds } });
    await database.client.conversation.deleteMany({ where: { userId: userIds } });
    await database.client.transactionPinSecurity.deleteMany({ where: { userId: userIds } });
    await database.client.passkeyCredential.deleteMany({ where: { userId: userIds } });
    await database.client.auditEvent.deleteMany({ where: { userId: userIds } });
    await database.client.wallet.deleteMany({ where: { userId: userIds } });
    await database.client.user.deleteMany({ where: { id: userIds } });
    // Secrets are not tied to a user; remove the ones these tests created.
    await database.client.executionSecret.deleteMany({
      where: {
        purpose: { in: ["TEXTILE_CLAIM_TOKEN", "TEST_PLAINTEXT"] },
        firmQuoteAttempts: { none: {} },
      },
    });
    await database.close();
  });

  /** Everything up to an ACTIVE PaymentAuthorization, through the real authorization services. */
  async function authorized(label: string) {
    const user = await repositories.users.create({
      id: createId(),
      username: `${label}-${run}-${createId().slice(0, 4)}`,
    });
    createdUsers.push(user.id);
    const [usdt] = await repositories.assets.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
    const [wbrl] = await repositories.assets.findBySymbol("wBRL", { chainId: CELO_CHAIN_ID });
    assert.ok(usdt?.contractAddress && wbrl?.contractAddress, "run `pnpm db:seed` first");
    const wallet = await repositories.wallets.create({
      id: createId(),
      userId: user.id,
      chainId: CELO_CHAIN_ID,
      isPrimary: true,
      type: "EMBEDDED",
      status: "ACTIVE",
      deployment: "COUNTERFACTUAL",
      address: `0x${randomBytes(20).toString("hex")}`,
    });
    await repositories.passkeys.create({
      id: createId(),
      userId: user.id,
      credentialId: `cred-${randomUUID()}`,
      publicKeyX: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      publicKeyY: randomUUID().replaceAll("-", "").padEnd(64, "b"),
      rpId: "kaada.test",
    });
    const conversation = await repositories.conversations.create({
      id: createId(),
      userId: user.id,
      channel: "TELEGRAM",
      status: "ACTIVE",
      externalConversationId: `firm-${run}-${createId()}`,
    });
    const intent = await repositories.intents.create({
      id: createId(),
      userId: user.id,
      conversationId: conversation.id,
      type: "SEND",
      status: "RESOLVED",
      missingFields: [],
      revision: 1,
      sourceAssetId: usdt.id,
      destinationAssetId: wbrl.id,
      amount: { money: createMoney("500000000000000000000", wbrl.id), mode: "EXACT_OUTPUT" },
    });
    const routeId = createId();
    const textile = await repositories.providers.findBySlug("textile");
    assert.ok(textile);
    const quote = await repositories.quotes.create({
      id: createId(),
      intentId: intent.id,
      intentRevision: 1,
      providerId: textile.id,
      input: createMoney("92260150", usdt.id),
      output: createMoney("500000000000000000000", wbrl.id),
      slippageBps: 5,
      rawProviderData: { adapter: "textile", indicative: true },
    });
    const route = await repositories.routes.createWithSteps({
      id: routeId,
      intentId: intent.id,
      intentRevision: 1,
      status: "VALID",
      input: createMoney("92260150", usdt.id),
      output: createMoney("500000000000000000000", wbrl.id),
      steps: [
        {
          id: createId(),
          routeId,
          position: 0,
          type: "SWAP",
          input: createMoney("92260150", usdt.id),
          output: createMoney("500000000000000000000", wbrl.id),
          providerId: textile.id,
          quoteId: quote.id,
        },
      ],
    });

    const hasher = new TestPinHasher();
    const pins = new TransactionPinService({ unitOfWork: uow, hasher });
    const sessions = new AuthorizationSessionService({
      unitOfWork: uow,
      assets: createAssetRegistry(repositories.assets),
      pins,
      origin: "https://app.kaada.test",
      sessionTtlMs: 5 * 60_000,
    });
    const payments = new PaymentAuthorizationService({
      unitOfWork: uow,
      sessions,
      pins,
      authorizationTtlMs: 3 * 60_000,
    });
    await pins.setPin(user.id, PIN);
    const { sessionId } = await sessions.begin(repositories, {
      userId: user.id,
      walletId: wallet.id,
      intentId: intent.id,
      intentRevision: 1,
      routeId: route.id,
    });
    const { token } = await sessions.issueLink({ sessionId, userId: user.id });
    const result = await payments.authorize(token, PIN);
    assert.equal(result.status, "AUTHORIZED");
    if (result.status !== "AUTHORIZED") throw new Error("unreachable");
    return {
      user,
      wallet,
      intent,
      route,
      usdt,
      wbrl,
      authorization: result.authorization,
      textile,
    };
  }

  /** A provider that returns a plausible firm quote and counts its calls. No network. */
  class FakeProvider implements FirmQuoteProvider {
    readonly id = "textile";
    calls = 0;
    constructor(private readonly takerPaysAtoms = "92200000") {}

    requestFirm(request: FirmQuoteRequest) {
      this.calls += 1;
      return Promise.resolve({
        status: "QUOTED" as const,
        quote: {
          provider: "textile",
          providerQuoteId: `rfq_${randomUUID()}`,
          chainId: request.chainId,
          input: createMoney(this.takerPaysAtoms, request.sellAssetId),
          output: createMoney(request.exactAmount, request.buyAssetId),
          fee: createMoney("9227", request.sellAssetId),
          expiresAt: new Date(Date.now() + 60_000),
          orderDeadline: new Date(Date.now() + 90_000),
          latestOrderDeadline: new Date(Date.now() + 180_000),
          reactor: REACTOR,
          taker: request.taker.toLowerCase(),
          executionReference: "rfq",
          indicative: false as const,
        },
        transactions: {
          approval: {
            to: request.sellToken.toLowerCase(),
            data: approveCalldata(REACTOR, BigInt(this.takerPaysAtoms)),
            value: "0",
            chainId: request.chainId,
          },
          swap: { to: SWAP_TARGET, data: "0xdeadbeef", value: "0", chainId: request.chainId },
        },
        claimToken: new SecretValue(CLAIM),
      });
    }
  }

  function services(provider: FirmQuoteProvider) {
    const wallets = {
      getWallet: async (userId: string): Promise<Wallet | null> =>
        repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID),
    };
    const chain = {
      allowances: { readAllowance: () => Promise.resolve(0n) },
      // The wallet is "funded" by the fake chain read.
      balances: {
        balancesOf: (_address: string, ids: string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, 10n ** 12n]))),
      },
      isDeployed: () => Promise.resolve(false),
    };
    const firmQuotes = new FirmQuoteService({
      unitOfWork: uow,
      provider,
      cipher: new AesGcmSecretCipher([{ version: 1, key: KEY }]),
      chain,
      maxOutstanding: 4,
      requestTimeoutMs: 75_000,
    });
    const service = new ExecutionPreparationService({
      unitOfWork: uow,
      firmQuotes,
      policy: new AuthorizationPolicyService({ unitOfWork: uow }),
      readiness: new AccountReadinessService({
        repositories,
        chain,
        infrastructure: { rpcConfigured: true, bundlerConfigured: false },
      }),
      chain,
      wallets,
      minWindowMs: 12_000,
    });
    return { service, firmQuotes };
  }

  it("allows exactly one live attempt per authorization under real concurrency", async () => {
    const ctx = await authorized("claim-race");
    const claim = () =>
      repositories.firmQuoteAttempts.claim(
        {
          id: createId(),
          paymentAuthorizationId: ctx.authorization.id,
          userId: ctx.user.id,
          walletId: ctx.wallet.id,
          providerId: ctx.textile.id,
          idempotencyKey: `race-${createId()}`,
          amountMode: "EXACT_OUTPUT",
          exactAmount: createMoney("500000000000000000000", ctx.wbrl.id),
          takerAddress: ctx.wallet.address ?? "",
        },
        new Date(),
      );
    const results = await Promise.all(Array.from({ length: 8 }, claim));
    assert.equal(results.filter((r) => r.claimed).length, 1);
    assert.equal(new Set(results.map((r) => r.attempt.id)).size, 1);
    assert.equal(
      await database.client.firmQuoteAttempt.count({
        where: { paymentAuthorizationId: ctx.authorization.id },
      }),
      1,
    );
    // And the index itself refuses a second live row even when written around the repository.
    await assert.rejects(
      database.client.firmQuoteAttempt.create({
        data: {
          id: createId(),
          paymentAuthorizationId: ctx.authorization.id,
          userId: ctx.user.id,
          walletId: ctx.wallet.id,
          providerId: ctx.textile.id,
          idempotencyKey: `direct-${createId()}`,
          amountMode: "EXACT_OUTPUT",
          exactAmount: "500000000000000000000",
          exactAssetId: ctx.wbrl.id,
          takerAddress: ctx.wallet.address ?? "",
        },
      }),
    );
  });

  it("prepares a READY plan once, however many deliveries, and never touches the authorization", async () => {
    const ctx = await authorized("prepare");
    const provider = new FakeProvider();
    const { service } = services(provider);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => service.prepare(ctx.authorization.id)),
    );
    assert.equal(provider.calls, 1, "one provider call for five deliveries");
    assert.ok(
      outcomes.some((o) => o.status === "EXECUTION_READY"),
      outcomes.map((o) => o.status).join(),
    );
    assert.equal((await service.prepare(ctx.authorization.id)).status, "EXECUTION_READY");
    assert.equal(provider.calls, 1);

    const plans = await database.client.execution.findMany({
      where: { paymentAuthorizationId: ctx.authorization.id },
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.status, "READY");
    assert.equal(plans[0]?.walletId, ctx.wallet.id);
    assert.ok(plans[0]?.firmQuoteAttemptId);
    assert.ok(plans[0]?.plan);
    assert.equal(JSON.stringify(plans[0]?.plan).includes(CLAIM), false);

    const stored = await database.client.paymentAuthorization.findUniqueOrThrow({
      where: { id: ctx.authorization.id },
    });
    assert.equal(stored.status, "ACTIVE", "planning does not consume the approval");
    assert.equal(stored.consumedAt, null);
  });

  it("stores the claim token only as AES-GCM ciphertext bound to its record", async () => {
    const ctx = await authorized("secret");
    const { service } = services(new FakeProvider());
    await service.prepare(ctx.authorization.id);
    const attempt = await database.client.firmQuoteAttempt.findFirstOrThrow({
      where: { paymentAuthorizationId: ctx.authorization.id },
      include: { claimSecret: true },
    });
    assert.equal(attempt.status, "QUOTED");
    assert.ok(attempt.claimSecret);
    assert.match(attempt.claimSecret.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(attempt.claimSecret.ciphertext.includes(CLAIM), false);
    const cipher = new AesGcmSecretCipher([{ version: 1, key: KEY }]);
    assert.equal(
      cipher.decrypt(
        attempt.claimSecret.ciphertext,
        `textile-claim-token:${attempt.claimSecret.id}`,
      ),
      CLAIM,
    );
    // The database refuses a bare token even if some code tried to store one.
    await assert.rejects(
      database.client.executionSecret.create({
        data: { id: createId(), purpose: "TEST_PLAINTEXT", keyVersion: 1, ciphertext: CLAIM },
      }),
    );
    const audit = JSON.stringify(
      await database.client.auditEvent.findMany({ where: { userId: ctx.user.id } }),
    );
    assert.equal(audit.includes(CLAIM), false);
  });

  it("a price above the authorization needs a new authorization and changes nothing", async () => {
    const ctx = await authorized("over");
    const provider = new FakeProvider("92306282"); // one atom above the 92306281 ceiling
    const { service } = services(provider);
    const outcome = await service.prepare(ctx.authorization.id);
    assert.equal(outcome.status, "REAUTHORIZATION_REQUIRED");
    assert.equal(provider.calls, 1);
    const attempt = await database.client.firmQuoteAttempt.findFirstOrThrow({
      where: { paymentAuthorizationId: ctx.authorization.id },
    });
    assert.equal(attempt.status, "UNUSABLE");
    const plan = await database.client.execution.findFirstOrThrow({
      where: { paymentAuthorizationId: ctx.authorization.id },
    });
    assert.equal(plan.status, "FAILED");
    const stored = await database.client.paymentAuthorization.findUniqueOrThrow({
      where: { id: ctx.authorization.id },
    });
    assert.equal(stored.status, "ACTIVE");
    assert.equal(stored.maxInputAmount, "92306281", "the bounds were not widened");
  });

  it("a plan stage can never claim execution, and READY needs a plan", async () => {
    const ctx = await authorized("stage");
    const { service } = services(new FakeProvider());
    const outcome = await service.prepare(ctx.authorization.id);
    assert.equal(outcome.status, "EXECUTION_READY");
    const plan = await database.client.execution.findFirstOrThrow({
      where: { paymentAuthorizationId: ctx.authorization.id },
    });
    assert.equal(plan.status, "READY");
    await assert.rejects(
      database.client.execution.update({ where: { id: plan.id }, data: { status: "EXECUTING" } }),
    );
    await assert.rejects(
      database.client.execution.update({ where: { id: plan.id }, data: { status: "COMPLETED" } }),
    );
    // READY without a plan is refused by the database itself.
    await assert.rejects(
      database.client
        .$executeRaw`UPDATE "Execution" SET "plan" = NULL WHERE "id" = ${plan.id}::uuid`,
    );
  });

  it("refuses a multi-hop route before any provider call", async () => {
    const ctx = await authorized("hops");
    const extraStep = await database.client.routeStep.findFirstOrThrow({
      where: { routeId: ctx.route.id },
    });
    await database.client.routeStep.create({
      data: {
        id: createId(),
        routeId: ctx.route.id,
        position: 1,
        type: "SWAP",
        inputAmount: extraStep.outputAmount,
        inputAssetId: extraStep.outputAssetId,
        outputAmount: extraStep.outputAmount,
        outputAssetId: extraStep.outputAssetId,
      },
    });
    const provider = new FakeProvider();
    const { service } = services(provider);
    assert.deepEqual(await service.prepare(ctx.authorization.id), {
      status: "EXECUTION_ROUTE_UNSUPPORTED",
    });
    assert.equal(provider.calls, 0);
  });
});
