/*
 * PIN and payment authorization on the real database: the atomic attempt counter, one-time session
 * and authorization consumption under real concurrency, and the constraints. Every row belongs to
 * uniquely named test users and is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createId,
  createMoney,
  isKaadaError,
} from "@kaada/domain";
import type { ExecutionCandidate } from "@kaada/domain";

import { PaymentAuthorizationService } from "../../src/core/authorization/payment-authorization-service.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import { AuthorizationPolicyService } from "../../src/core/authorization/policy-service.js";
import type { AuthorizationUnitOfWork } from "../../src/core/authorization/ports.js";
import { retireAuthorization } from "../../src/core/authorization/retire.js";
import { AuthorizationSessionService } from "../../src/core/authorization/session-service.js";
import { TestPinHasher } from "../support/payment-world.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";
const PIN = "7351";
const WRONG = "2468";

describe("PIN and authorization on the real database", { skip }, () => {
  let database: Database;
  let repositories: Repositories;
  let uow: AuthorizationUnitOfWork;
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

  after(async () => {
    const userIds = { in: createdUsers };
    const intents = (
      await database.client.intent.findMany({
        where: { userId: userIds },
        select: { id: true },
      })
    ).map((row) => row.id);
    const owned = { intentId: { in: intents } };
    await database.client.paymentAuthorization.deleteMany({ where: owned });
    await database.client.authorizationSession.deleteMany({ where: owned });
    await database.client.routeStep.deleteMany({ where: { route: owned } });
    await database.client.route.deleteMany({ where: owned });
    await database.client.intent.deleteMany({ where: { userId: userIds } });
    await database.client.conversation.deleteMany({ where: { userId: userIds } });
    await database.client.transactionPinSecurity.deleteMany({ where: { userId: userIds } });
    await database.client.auditEvent.deleteMany({ where: { userId: userIds } });
    await database.client.wallet.deleteMany({ where: { userId: userIds } });
    await database.client.user.deleteMany({ where: { id: userIds } });
    await database.close();
  });

  function services() {
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
    const policy = new AuthorizationPolicyService({ unitOfWork: uow });
    return { hasher, pins, sessions, payments, policy };
  }

  async function newUser(label: string) {
    const user = await repositories.users.create({
      id: createId(),
      username: `${label}-${run}-${createId().slice(0, 4)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  /** A user with an active wallet, a resolved EXACT_OUTPUT intent, a valid route and a pending session. */
  async function payment(label: string) {
    const user = await newUser(label);
    const [usdt] = await repositories.assets.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
    const [wbrl] = await repositories.assets.findBySymbol("wBRL", { chainId: CELO_CHAIN_ID });
    assert.ok(usdt && wbrl, "run `pnpm db:seed` first");
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
    const conversation = await repositories.conversations.create({
      id: createId(),
      userId: user.id,
      channel: "TELEGRAM",
      status: "ACTIVE",
      externalConversationId: `auth-${run}-${createId()}`,
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
        },
      ],
    });
    return { user, wallet, intent, route, usdt, wbrl };
  }

  async function pending(label: string) {
    const ctx = await payment(label);
    const svc = services();
    await svc.pins.setPin(ctx.user.id, PIN);
    const { sessionId } = await svc.sessions.begin(repositories, {
      userId: ctx.user.id,
      walletId: ctx.wallet.id,
      intentId: ctx.intent.id,
      intentRevision: 1,
      routeId: ctx.route.id,
    });
    const { token } = await svc.sessions.issueLink({ sessionId, userId: ctx.user.id });
    return { ...ctx, ...svc, sessionId, token };
  }

  it("counts parallel wrong guesses atomically: three checks, then locked", async () => {
    const user = await newUser("pin-race");
    const { pins, hasher } = services();
    await pins.setPin(user.id, PIN);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pins.verify(user.id, WRONG)),
    );
    assert.equal(hasher.verifyCalls, 3, "no more than the budget was ever checked");
    assert.equal(results.filter((r) => r.status === "INVALID").length, 3);
    assert.equal(results.filter((r) => r.status === "LOCKED").length, 7);
    const row = await database.client.transactionPinSecurity.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(row.lockLevel, 1);
    assert.ok(row.lockedUntil && row.lockedUntil.getTime() > Date.now());
    assert.match(row.pinHash, /^\$argon2id\$/);
    assert.equal((await pins.verify(user.id, PIN)).status, "LOCKED");
    const audit = JSON.stringify(
      await database.client.auditEvent.findMany({ where: { userId: user.id } }),
    );
    assert.equal(
      audit.includes(PIN) || audit.includes(WRONG) || audit.includes(row.pinHash),
      false,
    );
  });

  it("decides a correct PIN racing wrong ones without ever exceeding the budget", async () => {
    const user = await newUser("pin-mixed");
    const { pins, hasher } = services();
    await pins.setPin(user.id, PIN);
    const results = await Promise.all([
      pins.verify(user.id, WRONG),
      pins.verify(user.id, PIN),
      pins.verify(user.id, WRONG),
      pins.verify(user.id, WRONG),
      pins.verify(user.id, PIN),
    ]);
    // A correct PIN legitimately clears the counter mid-race, so the number of checks is not capped
    // here (a guess only ever gets past the budget by being correct). What must hold is that every
    // outcome is a defined one and the stored state is consistent.
    assert.ok(hasher.verifyCalls >= 1);
    assert.ok(results.every((r) => ["VERIFIED", "INVALID", "LOCKED"].includes(r.status)));
    const row = await database.client.transactionPinSecurity.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.ok(row.failedAttempts >= 0 && row.failedAttempts < 3);
  });

  it("a password change clears the lock and a database constraint refuses a non-Argon2 hash", async () => {
    const user = await newUser("pin-constraint");
    const { pins } = services();
    await pins.setPin(user.id, PIN);
    for (let i = 0; i < 3; i += 1) await pins.verify(user.id, WRONG);
    await pins.setPin(user.id, WRONG);
    assert.equal((await pins.verify(user.id, WRONG)).status, "VERIFIED");
    await assert.rejects(
      database.client.transactionPinSecurity.update({
        where: { userId: user.id },
        data: { pinHash: PIN },
      }),
    );
  });

  it("authorizes a pending payment once, even when two browsers submit together", async () => {
    const p = await pending("authorize-race");
    const results = await Promise.allSettled([
      p.payments.authorize(p.token, PIN),
      p.payments.authorize(p.token, PIN),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const approvals = await database.client.paymentAuthorization.findMany({
      where: { intentId: p.intent.id },
    });
    assert.equal(approvals.length, 1);
    const [approval] = approvals;
    assert.equal(approval?.status, "ACTIVE");
    assert.equal(approval?.amountMode, "EXACT_OUTPUT");
    assert.equal(approval?.maxInputAmount, "92260150");
    assert.equal(approval?.minOutputAmount, "500000000000000000000");
    assert.deepEqual(approval?.routeAssetPath, [p.usdt.id, p.wbrl.id]);
    const session = await database.client.authorizationSession.findUniqueOrThrow({
      where: { id: p.sessionId },
    });
    assert.equal(session.status, "AUTHORIZED");
    assert.ok(session.usedAt);
    assert.equal(session.tokenHash?.includes(p.token), false);
    await assert.rejects(p.payments.authorize(p.token, PIN), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
  });

  it("consumes an authorization exactly once under real concurrency", async () => {
    const p = await pending("consume-race");
    await p.payments.authorize(p.token, PIN);
    const approval = await repositories.paymentAuthorizations.findActiveByIntent(p.intent.id);
    assert.ok(approval);
    const candidate: ExecutionCandidate = {
      userId: approval.userId,
      walletId: approval.walletId,
      chainId: approval.chainId,
      intentRevision: approval.intentRevision,
      operation: "SEND",
      recipient: { ...approval.recipient },
      input: createMoney("92000000", p.usdt.id),
      output: createMoney("500000000000000000000", p.wbrl.id),
      route: { assetPath: [...approval.route.assetPath] },
    };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => p.policy.validateAndConsume(approval.id, candidate)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const row = await database.client.paymentAuthorization.findUniqueOrThrow({
      where: { id: approval.id },
    });
    assert.equal(row.status, "CONSUMED");
    assert.ok(row.consumedAt);
  });

  it("allows one active approval per payment and refuses malformed amounts", async () => {
    const p = await pending("constraints");
    await p.payments.authorize(p.token, PIN);
    const existing = await database.client.paymentAuthorization.findFirstOrThrow({
      where: { intentId: p.intent.id },
    });
    const { id: _id, ...copy } = existing;
    await assert.rejects(
      database.client.paymentAuthorization.create({ data: { ...copy, id: createId() } }),
      "a second ACTIVE approval for the same intent",
    );
    await assert.rejects(
      database.client.paymentAuthorization.update({
        where: { id: existing.id },
        data: { maxInputAmount: "0092" },
      }),
      "non-canonical amount",
    );
  });

  it("a payment edit retires the session and the approval in the database", async () => {
    const p = await pending("revise");
    await p.payments.authorize(p.token, PIN);
    await repositories.intents.update(p.intent.id, { revision: 2 });
    await retireAuthorization(repositories, p.intent.id, null, "INTENT_REVISED", new Date());
    const approval = await database.client.paymentAuthorization.findFirstOrThrow({
      where: { intentId: p.intent.id },
    });
    assert.equal(approval.status, "REVOKED");
    assert.equal(approval.revocationReason, "INTENT_REVISED");
    assert.ok(approval.revokedAt, "history is kept");
  });

  it("an edit that lands before the PIN decision cancels the session instead of authorizing", async () => {
    const p = await pending("stale");
    await repositories.intents.update(p.intent.id, { revision: 2 });
    await assert.rejects(p.payments.authorize(p.token, PIN), (e) =>
      isKaadaError(e, "AUTHORIZATION_SESSION_INVALID"),
    );
    assert.equal(
      await database.client.paymentAuthorization.count({ where: { intentId: p.intent.id } }),
      0,
    );
    const session = await database.client.authorizationSession.findUniqueOrThrow({
      where: { id: p.sessionId },
    });
    assert.equal(session.status, "CANCELLED");
  });

  it("creates one session per payment however often it is asked", async () => {
    const p = await pending("idempotent");
    const again = await Promise.all(
      Array.from({ length: 4 }, () =>
        p.sessions.begin(repositories, {
          userId: p.user.id,
          walletId: p.wallet.id,
          intentId: p.intent.id,
          intentRevision: 1,
          routeId: p.route.id,
        }),
      ),
    );
    assert.equal(new Set(again.map((a) => a.sessionId)).size, 1);
    assert.equal(
      await database.client.authorizationSession.count({ where: { intentId: p.intent.id } }),
      1,
    );
  });
});
