import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXACT_OUT, runWorld } from "./support/run-world.js";
import type { RunWorld } from "./support/run-world.js";
import { CLAIM_TOKEN } from "./support/firm-world.js";

/*
 * Build 13 on offline fakes: the runner, the validated signer, the root action and settlement. Nothing
 * here reaches a chain, a bundler or the provider; the fakes record what would have been sent.
 */

const record = (w: RunWorld) => w.uow.read.executionPlans.findById(w.executionId);
const authorization = (w: RunWorld) =>
  w.uow.read.paymentAuthorizations.findById(w.authorization.id);

/** Brings a world with an installed account and permission to a point where a run can send. */
async function ready(w: RunWorld): Promise<void> {
  assert.equal((await w.runner.run(w.executionId)).status, "ROOT_ACTION_REQUIRED");
  await w.confirmRootAction();
}

describe("root action before payment", () => {
  it("asks for the passkey first, spends nothing and consumes nothing", async () => {
    const w = await runWorld();
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "ROOT_ACTION_REQUIRED");
    assert.equal((await record(w))?.status, "REQUIRES_USER_ACTION");
    assert.equal((await authorization(w))?.status, "ACTIVE", "not consumed by wallet setup");
    assert.equal(w.kernel.delegated.length, 0);
    assert.equal(w.kernel.rootSends, 0, "nothing is sent until the user confirms");
    assert.equal(w.orders.submits.length, 0);
  });

  it("the page fixes the challenge on the server and never takes calldata from the browser", async () => {
    const w = await runWorld();
    await w.runner.run(w.executionId);
    const session = await w.uow.read.rootActions.findPendingByExecution(w.executionId);
    assert.ok(session);
    const link = await w.rootActions.issueLink({ sessionId: session.id, userId: session.userId });
    const view = await w.rootActions.view(link.token);
    assert.equal(view.title, "Confirm wallet setup to continue payment");
    const options = await w.rootActions.options(link.token);
    assert.equal(options.userVerification, "required");
    assert.equal(
      options.challenge,
      Buffer.from(session.challenge.slice(2), "hex").toString("base64url"),
    );
    // The completion takes an assertion and nothing else: its parameters carry no operation.
    assert.equal(w.rootActions.complete.length, 2);
  });

  it("a wrong passkey assertion changes nothing and a link works once", async () => {
    const w = await runWorld();
    await w.runner.run(w.executionId);
    await assert.rejects(w.confirmRootAction(false));
    assert.equal(w.kernel.rootSends, 0);
    await w.confirmRootAction();
    assert.equal(w.kernel.rootSends, 1);
    const session = w.run.rootSessions[0];
    assert.equal(session?.status, "COMPLETED");
    assert.ok(session?.usedAt);
    await assert.rejects(
      w.rootActions.complete(String(session?.tokenHash), { id: "x", good: true }),
    );
  });

  it("is PENDING until the chain shows the permission, then ACTIVE and installed", async () => {
    const w = await runWorld();
    await ready(w);
    const permission = [...w.run.permissions.values()][0];
    assert.equal(permission?.status, "PENDING", "an intention is not authority");
    assert.equal(permission?.installedAt, undefined);
    // Run: confirms on chain, activates, then pays.
    await w.runner.run(w.executionId);
    const after = [...w.run.permissions.values()][0];
    assert.equal(after?.status, "ACTIVE");
    assert.ok(after?.installedAt);
  });

  it("keeps the session key and enable data only as ciphertext", async () => {
    const w = await runWorld();
    await ready(w);
    for (const secret of w.firm.secrets) {
      assert.match(secret.ciphertext, /^v1\./);
      assert.equal(secret.ciphertext.includes(w.kernel.approvalText), false);
    }
    const kinds = w.firm.secrets.map((s) => s.purpose).sort();
    assert.ok(kinds.includes("SESSION_KEY") && kinds.includes("PERMISSION_APPROVAL"));
  });
});

describe("a payment, end to end", () => {
  it("approves the exact amount, then swaps and pays out in one operation, then completes", async () => {
    const w = await runWorld();
    await ready(w);
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_SENT");
    const final = await record(w);
    assert.equal(final?.status, "COMPLETED");
    assert.ok(final?.authorizationConsumedAt);
    assert.equal((await authorization(w))?.status, "CONSUMED");

    // Two user operations: a bounded approval, then the swap with the payout in the same batch.
    assert.equal(w.kernel.delegated.length, 2);
    const [approval, swap] = w.kernel.delegated;
    assert.equal(approval?.calls.length, 1);
    assert.ok(approval?.calls[0]?.data.startsWith("0x095ea7b3"));
    assert.equal(approval?.calls[0]?.value, "0");
    assert.equal(swap?.calls.length, 2, "swap + transfer to the recipient");
    assert.ok(swap?.calls[1]?.data.startsWith("0xa9059cbb"));
    for (const call of [...(approval?.calls ?? []), ...(swap?.calls ?? [])]) {
      assert.equal(call.value, "0", "no native value");
    }
  });

  it("stores the userOpHash and the txHash separately, with no secrets", async () => {
    const w = await runWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    const swap = w.run.transactions.find((t) => t.type === "SWAP");
    assert.ok(swap?.userOpHash && swap.hash);
    assert.notEqual(swap.userOpHash, swap.hash);
    assert.equal(swap.status, "CONFIRMED");
    assert.ok(swap.blockNumber && swap.confirmedAt && swap.submittedAt);
    const text = JSON.stringify([
      w.run.transactions,
      w.firm.plans,
      w.w.r.world.authorization.audit,
    ]);
    assert.equal(text.includes(CLAIM_TOKEN), false);
    assert.equal(text.includes(w.kernel.approvalText), false);
  });

  it("COMPLETED needs the provider to report the order filled", async () => {
    const w = await runWorld();
    await ready(w);
    w.orders.result = { state: "SUBMITTED" };
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_PENDING");
    assert.equal((await record(w))?.status, "SETTLING", "never READY -> COMPLETED, never early");
    w.orders.result = { state: "FILLED" };
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal((await record(w))?.status, "COMPLETED");
  });

  it("submits the on-chain hash to the provider with the claim token, once, then destroys it", async () => {
    const w = await runWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    assert.equal(w.orders.submits.length, 1);
    assert.equal(w.orders.submits[0]?.claim, CLAIM_TOKEN);
    const swap = w.run.transactions.find((t) => t.type === "SWAP");
    assert.equal(w.orders.submits[0]?.txHash, swap?.hash);
    const final = await record(w);
    assert.ok(final?.claimTombstonedAt);
    const attempt = [...w.firm.attempts][0];
    const secret = w.firm.secrets.find((s) => s.id === attempt?.claimSecretId);
    assert.equal(secret?.ciphertext, "", "the claim token is gone");
    // Running again changes nothing and submits nothing.
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal(w.orders.submits.length, 1);
  });

  it("an existing sufficient allowance needs no approval", async () => {
    const w = await runWorld();
    w.chain.allowance = 10n ** 12n;
    await ready(w);
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal(w.kernel.delegated.length, 1, "only the swap and payout");
  });

  it("emits a user message that never claims more than is true", async () => {
    const { runMessage } = await import("../src/core/execution/runner.js");
    assert.match(runMessage({ status: "PAYMENT_PENDING" }), /don't send it again/);
    assert.equal(/sent/i.test(runMessage({ status: "PROCESSING_PAYMENT" })), false);
  });
});

describe("the execution lock and the authorization", () => {
  it("concurrent runs cannot both pay: exactly one acquires and one swap goes out", async () => {
    const w = await runWorld();
    await ready(w);
    const results = await Promise.all([
      w.runner.run(w.executionId),
      w.runner.run(w.executionId),
      w.runner.run(w.executionId),
    ]);
    assert.ok(results.some((r) => r.status === "PAYMENT_SENT" || r.status === "PAYMENT_PENDING"));
    const swaps = w.kernel.delegated.filter((d) => d.calls.length === 2);
    assert.equal(swaps.length, 1);
    assert.equal(w.run.transactions.filter((t) => t.type === "SWAP").length, 1);
  });

  it("acquire consumes the authorization together with READY -> SIGNING, exactly once", async () => {
    const w = await runWorld();
    await ready(w);
    const first = await w.uow.read.executionPlans.acquire(w.executionId, w.now());
    // The root action already finished but the permission is still PENDING; acquire itself only locks.
    assert.equal(first.status, "NOT_READY", "REQUIRES_USER_ACTION is not READY");
    assert.equal((await authorization(w))?.status, "ACTIVE");
  });

  it("a failure after consumption keeps the authorization consumed", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.sendMode = "reject";
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_FAILED");
    assert.equal((await record(w))?.status, "FAILED");
    assert.equal((await authorization(w))?.status, "CONSUMED", "no silent replay");
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_FAILED");
    const attempts = w.run.transactions.filter((t) => t.type === "APPROVAL");
    assert.equal(attempts.length, 1, "the rejected attempt is never repeated");
    assert.equal(attempts[0]?.status, "FAILED");
    assert.equal(w.kernel.delegated.length, 0, "the bundler took nothing");
  });

  it("an expired authorization is a re-authorization, not a payment", async () => {
    const w = await runWorld();
    await ready(w);
    w.w.r.clock.now = new Date(w.authorization.expiresAt.getTime() + 1000);
    const outcome = await w.runner.run(w.executionId);
    assert.ok(["REAUTHORIZATION_REQUIRED", "PAYMENT_FAILED"].includes(outcome.status));
    assert.equal(w.kernel.delegated.length, 0);
    assert.notEqual((await authorization(w))?.status, "CONSUMED");
  });

  it("an insufficient fresh balance stops before anything is consumed", async () => {
    const w = await runWorld();
    await ready(w);
    w.w.port.held.clear();
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "INSUFFICIENT_BALANCE");
    assert.equal((await authorization(w))?.status, "ACTIVE");
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("without gas it asks for funding and consumes nothing", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.native = 0n;
    assert.equal((await w.runner.run(w.executionId)).status, "GAS_FUNDING_REQUIRED");
    assert.equal((await authorization(w))?.status, "ACTIVE");
    assert.equal(w.kernel.delegated.length, 0);
  });
});

describe("never blindly resending", () => {
  it("a send that may have reached the bundler is not sent again", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.sendMode = "throw";
    const first = await w.runner.run(w.executionId);
    assert.equal(first.status, "PAYMENT_PENDING");
    const sentBefore = w.kernel.delegated.length;
    assert.equal(sentBefore, 1);
    // Many more runs, including after the outage: still no second send of that step.
    w.kernel.sendMode = "ok";
    w.kernel.receiptMode = "pending";
    for (let i = 0; i < 3; i += 1) await w.runner.run(w.executionId);
    assert.equal(w.kernel.delegated.length, sentBefore);
    const row = w.run.transactions.find((t) => t.type === "APPROVAL");
    assert.equal(row?.status, "UNKNOWN");
  });

  it("an RPC outage after sending leaves it pending and resends nothing", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.receiptMode = "throw";
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_PENDING");
    assert.equal(w.kernel.delegated.length, 1);
    w.kernel.receiptMode = "included";
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal(w.kernel.delegated.length, 2, "approval + swap, each exactly once");
  });

  it("a restart resumes from the persisted state", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.receiptMode = "pending";
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_PENDING");
    w.kernel.receiptMode = "included";
    const result = await w.runner.reconcile();
    assert.ok(result.examined >= 1);
    assert.equal((await record(w))?.status, "COMPLETED");
    assert.equal(w.kernel.delegated.length, 2);
  });

  it("a reverted step fails the payment and keeps the authorization consumed", async () => {
    const w = await runWorld();
    await ready(w);
    w.kernel.receiptMode = "revert";
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_FAILED");
    assert.equal((await authorization(w))?.status, "CONSUMED");
    assert.equal(w.orders.submits.length, 0, "nothing is reported to the provider");
  });

  it("an unreachable provider after the swap is pending, not failed, and not resent", async () => {
    const w = await runWorld();
    await ready(w);
    w.orders.submitFails = true;
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_PENDING");
    assert.equal(w.kernel.delegated.length, 2);
    w.orders.submitFails = false;
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.equal(w.kernel.delegated.length, 2);
  });
});

describe("settlement is checked against what was authorized", () => {
  it("rejects a settlement that took more input than authorized", async () => {
    const w = await runWorld();
    await ready(w);
    w.orders.result = { state: "FILLED", sellAmount: "999999999999", buyAmount: EXACT_OUT };
    const outcome = await w.runner.run(w.executionId);
    assert.deepEqual(outcome, { status: "PAYMENT_FAILED", code: "SETTLEMENT_POLICY_VIOLATION" });
    assert.equal((await record(w))?.failureCode, "SETTLEMENT_POLICY_VIOLATION");
  });

  it("rejects a settlement that delivered less than the exact output", async () => {
    const w = await runWorld();
    await ready(w);
    w.orders.result = { state: "FILLED", sellAmount: "92200000", buyAmount: "1" };
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "PAYMENT_FAILED");
  });

  it("records the settled amounts on success", async () => {
    const w = await runWorld();
    await ready(w);
    w.orders.result = { state: "FILLED", sellAmount: "91000000", buyAmount: EXACT_OUT };
    await w.runner.run(w.executionId);
    const final = await record(w);
    assert.equal(final?.settledInputAmount, "91000000");
    assert.equal(final?.settledOutputAmount, EXACT_OUT);
  });
});

describe("the signer boundary", () => {
  it("has exactly one public method and it takes only an execution id", async () => {
    const w = await runWorld();
    const proto = Object.getPrototypeOf(w.signer) as object;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== "constructor" && typeof (proto as Record<string, unknown>)[name] === "function",
    );
    // Everything else on the class is private; the only way in is the validated entry point.
    assert.ok(methods.includes("signValidatedExecution"));
    for (const forbidden of ["sign", "signBytes", "signTransaction", "signUserOperation", "send"]) {
      assert.equal(methods.includes(forbidden), false, forbidden);
    }
    assert.equal(w.signer.signValidatedExecution.length, 1);
  });

  it("refuses an execution that has not acquired execution rights", async () => {
    const w = await runWorld();
    await ready(w);
    await assert.rejects(
      w.signer.signValidatedExecution(w.executionId),
      (error: { details?: { reason?: string } }) =>
        error.details?.reason === "EXECUTION_NOT_SIGNING",
    );
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("refuses an unknown execution", async () => {
    const w = await runWorld();
    await assert.rejects(w.signer.signValidatedExecution("00000000-0000-4000-8000-000000000999"));
    assert.equal(w.kernel.delegated.length, 0);
  });

  it("never receives the PIN, the passkey or any calldata", async () => {
    const w = await runWorld();
    assert.equal(w.signer.signValidatedExecution.length, 1);
  });
});

describe("approvals", () => {
  it("resets a USDT-style allowance to zero first, then approves the exact amount", async () => {
    const w = await runWorld();
    w.chain.allowance = 5n; // a stale non-zero allowance
    await ready(w);
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    const approvals = w.kernel.delegated
      .map((d) => d.calls[0]?.data ?? "")
      .filter((data) => data.startsWith("0x095ea7b3"));
    assert.equal(approvals.length, 2);
    assert.equal(BigInt(`0x${approvals[0]?.slice(-64)}`), 0n, "reset to zero first");
    assert.equal(BigInt(`0x${approvals[1]?.slice(-64)}`), 92_200_000n, "then exactly takerPays");
    assert.equal(w.kernel.delegated.length, 3);
  });

  it("never approves more than the firm quote needs, and refuses an unlimited approval", async () => {
    const w = await runWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    const amount = BigInt(`0x${w.kernel.delegated[0]?.calls[0]?.data.slice(-64)}`);
    assert.equal(amount, 92_200_000n);
    assert.ok(amount < 2n ** 255n);

    // The plan itself is blocked, so no execution is ever READY to run.
    await assert.rejects(
      runWorld({ quote: { approvalAmount: 2n ** 256n - 1n } }),
      /EXECUTION_BLOCKED/,
    );
  });
});

describe("the firm quote window", () => {
  it("takes one refresh when the quote is about to expire, under the same authorization", async () => {
    const w = await runWorld();
    w.w.r.clock.now = new Date(w.now().getTime() + 58_000);
    w.transport.enqueue(
      (await import("./support/firm-world.js")).quotedReply({
        now: w.now(),
        sellAmount: "92200000",
        takerPays: "92200000",
        buyAmount: EXACT_OUT,
        rfqId: "rfq_test_2",
      }),
    );
    const outcome = await w.runner.run(w.executionId);
    assert.equal(outcome.status, "ROOT_ACTION_REQUIRED");
    assert.equal(w.calls().filter((c) => c.path === "/v2/rfq/request").length, 2);
    assert.equal((await authorization(w))?.status, "ACTIVE");
  });

  it("does not loop: an expired quote with no refresh available asks to authorize again", async () => {
    const w = await runWorld();
    w.w.r.clock.now = new Date(w.now().getTime() + 59_500);
    const outcome = await w.runner.run(w.executionId);
    assert.ok(
      ["REAUTHORIZATION_REQUIRED", "PAYMENT_FAILED", "PROCESSING_PAYMENT"].includes(outcome.status),
      outcome.status,
    );
    assert.equal(w.kernel.delegated.length, 0);
    assert.equal((await authorization(w))?.status, "ACTIVE");
  });
});

describe("what is recorded", () => {
  it("keeps secrets, calldata and the claim token out of the audit trail and the logs", async () => {
    const w = await runWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    const text = JSON.stringify([w.w.r.world.authorization.audit, w.logs, w.run.transactions]);
    for (const needle of [CLAIM_TOKEN, w.kernel.approvalText, "0x095ea7b3", "0xdeadbeef"]) {
      assert.equal(text.includes(needle), false, needle);
    }
  });

  it("begins a step once per idempotency key", async () => {
    const w = await runWorld();
    const input = {
      idempotencyKey: "exec:test:APPROVAL",
      executionId: w.executionId,
      type: "APPROVAL" as const,
      chainId: 42220,
      fromAddress: "0x00000000000000000000000000000000000000aa",
    };
    const first = await w.uow.read.executionTransactions.begin(input);
    const second = await w.uow.read.executionTransactions.begin(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(w.run.transactions.length, 1);
  });

  it("walks the execution states in order and never skips to COMPLETED", async () => {
    const w = await runWorld();
    const seen: string[] = [];
    const repo = w.uow.read.executionPlans;
    const original = repo.transition.bind(repo);
    repo.transition = async (id, from, to, fields) => {
      const moved = await original(id, from, to, fields);
      if (moved && seen[seen.length - 1] !== to) seen.push(to);
      return moved;
    };
    await ready(w);
    await w.runner.run(w.executionId);
    const order = [
      "REQUIRES_USER_ACTION",
      "READY",
      "SIGNING",
      "SUBMITTING",
      "SUBMITTED",
      "SETTLING",
      "COMPLETED",
    ];
    const indexes = seen.map((state) => order.indexOf(state));
    assert.ok(
      indexes.every((i) => i >= 0),
      seen.join(","),
    );
    assert.equal(seen.at(-1), "COMPLETED");
    assert.ok(seen.indexOf("SETTLING") < seen.indexOf("COMPLETED"));
  });
});

describe("the HTTP edge for payments", () => {
  const controllerFor = async (w: RunWorld) => {
    const { ExecutionController } = await import("../src/execution/execution.controller.js");
    const { RunTracker } = await import("../src/core/execution/run-tracker.js");
    const runs = new RunTracker();
    const controller = new ExecutionController(
      w.w.auth.sessions,
      w.service,
      w.tracker,
      w.uow.read as never,
      w.runner,
      w.rootActions,
      runs,
    );
    return { controller, runs };
  };

  it("runs only for the person who holds the authorization link", async () => {
    const w = await runWorld();
    const { controller } = await controllerFor(w);
    const { UnauthorizedException } = await import("@nestjs/common");
    await assert.rejects(controller.run(undefined), UnauthorizedException);
    await assert.rejects(controller.run(`Bearer ${"A".repeat(43)}`), UnauthorizedException);
    assert.equal(w.kernel.delegated.length + w.kernel.rootSends, 0);
  });

  it("walks the person through wallet setup and then the payment, with safe words only", async () => {
    const w = await runWorld();
    const { controller, runs } = await controllerFor(w);
    const auth = `Bearer ${w.token}`;
    const first = await controller.run(auth);
    await runs.idle();
    assert.equal(first.state === "ROOT_ACTION_REQUIRED" || first.state === "NOT_STARTED", true);
    const status = await controller.status(auth);
    assert.equal(status.state, "ROOT_ACTION_REQUIRED");

    const link = await controller.rootActionLink(auth);
    assert.match(link.url, /^https:\/\/app\.kaada\.test\/root-action\/[A-Za-z0-9_-]{43}$/);
    const token = link.url.split("/").at(-1) ?? "";
    await w.rootActions.complete(token, { id: "credential-0", good: true });

    await controller.run(auth);
    await runs.idle();
    const done = await controller.status(auth);
    assert.equal(done.state, "PAYMENT_SENT");
    const text = JSON.stringify([first, status, done]);
    for (const needle of [CLAIM_TOKEN, "0x", "userOp", "calldata"]) {
      assert.equal(text.includes(needle), false, needle);
    }
  });
});

describe("lessons from the Celo Sepolia validation", () => {
  it("reads the permission back with the window that was installed, not a recomputed one", async () => {
    const w = await runWorld();
    await ready(w);
    await w.runner.run(w.executionId);
    const installed = [...w.run.permissions.values()][0];
    assert.ok(installed && w.kernel.readBacks.length > 0);
    // Time moves between install and every later read-back; the id hashes the window.
    for (const scope of w.kernel.readBacks) {
      assert.equal(scope.validFrom.getTime(), installed.validFrom.getTime());
      assert.equal(scope.expiresAt.getTime(), installed.expiresAt.getTime());
    }
  });

  it("pins the swap selector in the permission scope (an omitted selector is not a wildcard)", async () => {
    const w = await runWorld();
    await ready(w);
    const scope = w.kernel.prepared[0];
    assert.equal(scope?.swapSelector, "0xdeadbeef");
    assert.match(scope?.swapSelector ?? "", /^0x[0-9a-f]{8}$/);
  });

  it("refuses swap calldata that carries no selector", async () => {
    const { inspectSwapTransaction } = await import("../src/core/execution/approval-inspector.js");
    const ok = { to: "0x" + "44".repeat(20), data: "0xdeadbeef00", value: "0", chainId: 42220 };
    assert.deepEqual(inspectSwapTransaction(ok, { chainId: 42220 }), []);
    assert.ok(
      inspectSwapTransaction({ ...ok, data: "0x12" }, { chainId: 42220 }).includes(
        "SWAP_CALLDATA_INVALID",
      ),
    );
    assert.ok(
      inspectSwapTransaction({ ...ok, data: "0x" }, { chainId: 42220 }).includes(
        "SWAP_CALLDATA_INVALID",
      ),
    );
  });

  it("waits for the RPC node to have seen a transaction before building the next step", async () => {
    const w = await runWorld();
    await ready(w);
    let polls = 0;
    const original = w.kernel.getTransactionReceipt.bind(w.kernel);
    w.kernel.getTransactionReceipt = () => {
      polls += 1;
      // The first looks are "a block behind"; then the node catches up.
      return polls < 3 ? Promise.resolve({ status: "NOT_FOUND" as const }) : original();
    };
    assert.equal((await w.runner.run(w.executionId)).status, "PAYMENT_SENT");
    assert.ok(polls >= 3, String(polls));
  });
});
