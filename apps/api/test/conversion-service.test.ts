import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KaadaError } from "@kaada/domain";
import type { AuthorizationSession } from "@kaada/domain";

import { ConversionService } from "../src/core/execution/conversion-service.js";
import type { PreparationOutcome } from "../src/core/execution/preparation-service.js";
import { RunTracker } from "../src/core/execution/run-tracker.js";
import { PreparationTracker } from "../src/core/execution/tracker.js";

const NOW = new Date("2026-11-06T12:00:00Z");
const USER = "user-1";

const session = (over: Partial<AuthorizationSession> = {}): AuthorizationSession => ({
  id: "session-1",
  userId: USER,
  walletId: "wallet-1",
  intentId: "intent-1",
  intentRevision: 1,
  routeId: "route-1",
  status: "PENDING",
  expiresAt: new Date(NOW.getTime() + 60_000),
  createdAt: NOW,
  ...over,
});

function build(options: {
  stored?: AuthorizationSession | null;
  authorize?: () => Promise<{ id: string }>;
  outcome?: PreparationOutcome;
}) {
  const calls = { authorize: 0, prepare: [] as string[], run: [] as string[] };
  const preparations = new PreparationTracker();
  const runs = new RunTracker();
  const service = new ConversionService({
    sessions: {
      findById: () => Promise.resolve(options.stored === undefined ? session() : options.stored),
    },
    payments: {
      authorizeConversion: () => {
        calls.authorize += 1;
        return (options.authorize ?? (() => Promise.resolve({ id: "auth-1" })))() as never;
      },
    },
    preparation: {
      prepare: (id: string) => {
        calls.prepare.push(id);
        return Promise.resolve(
          options.outcome ?? {
            status: "EXECUTION_READY",
            executionId: "exec-1",
            expiresAt: NOW,
            reused: false,
          },
        );
      },
    },
    runner: {
      run: (id: string) => {
        calls.run.push(id);
        return Promise.resolve({ status: "PAYMENT_SENT" } as never);
      },
    },
    preparations,
    runs,
    now: () => NOW,
  });
  const settle = async () => {
    await preparations.idle();
    await runs.idle();
  };
  return { service, calls, settle };
}

describe("confirming a conversion with one tap", () => {
  it("authorizes, prices the final quote, then runs it, in that order, for the right ids", async () => {
    const { service, calls, settle } = build({});
    assert.deepEqual(await service.confirm({ userId: USER, sessionId: "session-1" }), {
      status: "STARTED",
    });
    await settle();
    assert.equal(calls.authorize, 1);
    assert.deepEqual(calls.prepare, ["auth-1"]);
    assert.deepEqual(calls.run, ["exec-1"]);
  });

  it("does not run a conversion whose final price could not be confirmed", async () => {
    const { service, calls, settle } = build({
      outcome: { status: "EXECUTION_BLOCKED", executionId: "exec-1", blockers: [] },
    });
    await service.confirm({ userId: USER, sessionId: "session-1" });
    await settle();
    assert.deepEqual(calls.prepare, ["auth-1"]);
    assert.deepEqual(calls.run, []);
  });

  it("treats another person's session, a missing one and an expired one the same, and authorizes nothing", async () => {
    for (const stored of [
      null,
      session({ userId: "someone-else" }),
      session({ expiresAt: new Date(NOW.getTime() - 1) }),
      session({ status: "AUTHORIZED" }),
      session({ status: "CANCELLED" }),
    ]) {
      const { service, calls } = build({ stored });
      assert.deepEqual(await service.confirm({ userId: USER, sessionId: "session-1" }), {
        status: "NOT_AVAILABLE",
      });
      assert.equal(calls.authorize, 0);
      assert.deepEqual(calls.prepare, []);
    }
  });

  it("reports a payment that cannot be authorized (a SEND, or one that changed) as not available", async () => {
    const { service, calls } = build({
      authorize: () =>
        Promise.reject(new KaadaError("AUTHORIZATION_SESSION_INVALID", "not a conversion")),
    });
    assert.deepEqual(await service.confirm({ userId: USER, sessionId: "session-1" }), {
      status: "NOT_AVAILABLE",
    });
    assert.deepEqual(calls.prepare, [], "nothing was priced or run");
  });

  it("does not hide an unexpected failure as 'not available'", async () => {
    const { service } = build({ authorize: () => Promise.reject(new Error("database down")) });
    await assert.rejects(
      service.confirm({ userId: USER, sessionId: "session-1" }),
      /database down/,
    );
  });
});
