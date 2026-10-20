import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { HttpException, Logger } from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { loadConfig } from "@kaada/config";
import type { DeploymentCheckResult } from "@kaada/blockchain";

import { configureApp } from "../src/app.setup.js";
import { RecoveryEmailService } from "../src/core/recovery/recovery-email.js";
import { DeploymentGuard } from "../src/recovery/deployment-guard.js";
import { RecoveryController } from "../src/recovery/recovery.controller.js";
import type { RecoveryRuntime } from "../src/recovery/recovery.runtime.js";
import { RECOVERY_RUNTIME } from "../src/recovery/recovery.tokens.js";
import {
  RELAYER_SPEND_LIMITER,
  RelayerSpendLimiter,
} from "../src/security/relayer-spend-limiter.js";
import { RECOVERY_SWITCH, RecoverySwitch } from "../src/recovery/recovery-switch.js";
import { startedFields } from "../src/started-log.js";
import { WALLET_SETUP_SERVICE } from "../src/wallet/wallet.tokens.js";
import { createRecoveryWorld, newPasskeyRoot } from "./support/recovery-world.js";

const status = async (work: Promise<unknown>) => {
  try {
    await work;
    return 200;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("RelayerSpendLimiter", () => {
  it("counts each kind on its own, per person and per address", async () => {
    const limiter = new RelayerSpendLimiter({ perUserPerHour: 2, perIpPerHour: 3 });
    assert.equal(await status(limiter.checkUser("arming", "u1")), 200);
    assert.equal(await status(limiter.checkUser("arming", "u1")), 200);
    assert.equal(await status(limiter.checkUser("arming", "u1")), 429);
    // Another person, and another kind for the same person, are untouched.
    assert.equal(await status(limiter.checkUser("arming", "u2")), 200);
    assert.equal(await status(limiter.checkUser("cancel", "u1")), 200);
    assert.equal(await status(limiter.checkUser("device-key", "u1")), 200);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await status(limiter.checkIp("cancel", "1.2.3.4")), 200);
    }
    assert.equal(await status(limiter.checkIp("cancel", "1.2.3.4")), 429);
    assert.equal(await status(limiter.checkIp("cancel", "5.6.7.8")), 200);
    assert.equal(await status(limiter.checkIp("arming", "1.2.3.4")), 200);
  });
});

describe("relayer-spend limits over HTTP", () => {
  async function boot(limits: { perUserPerHour: number; perIpPerHour: number }) {
    const world = createRecoveryWorld();
    const runtime: RecoveryRuntime = {
      context: world.context,
      flow: world.flow,
      cleanup: world.cleanup,
      finalizer: world.finalizer(),
      configuration: world.configuration,
      email: new RecoveryEmailService(world.context),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [RecoveryController],
      providers: [
        { provide: RECOVERY_RUNTIME, useValue: runtime },
        { provide: WALLET_SETUP_SERVICE, useValue: null },
        { provide: RELAYER_SPEND_LIMITER, useValue: new RelayerSpendLimiter(limits) },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app, { corsOrigins: [] } as never);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { app, world };
  }
  const post = async (app: NestFastifyApplication, url: string, token: string, body?: unknown) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/recovery${url}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(body ?? {}),
    });
    return response.statusCode;
  };

  it("cancel preparation is limited per cancel link (one link is one attempt, one person)", async () => {
    const { app, world } = await boot({ perUserPerHour: 2, perIpPerHour: 100 });
    const user = await world.createUser();
    await world.startRecovery(user, newPasskeyRoot());
    const cancelToken = world.cancelTokenFrom(user);
    assert.equal(await post(app, "/cancel/prepare", cancelToken), 200);
    assert.equal(await post(app, "/cancel/prepare", cancelToken), 200);
    assert.equal(await post(app, "/cancel/prepare", cancelToken), 429);
    await app.close();
  });

  it("arming is limited per address before anything is looked up, so a flood of bad tokens is stopped too", async () => {
    const { app } = await boot({ perUserPerHour: 100, perIpPerHour: 2 });
    const body = { recoveryAddress: "0x00000000000000000000000000000000000000f9" };
    assert.notEqual(await post(app, "/configuration/prepare", "nope", body), 429);
    assert.notEqual(await post(app, "/configuration/prepare", "nope", body), 429);
    assert.equal(await post(app, "/configuration/prepare", "nope", body), 429);
    await app.close();
  });
});

describe("DeploymentGuard", () => {
  const ok: DeploymentCheckResult = { status: "OK" };
  const down: DeploymentCheckResult = { status: "UNAVAILABLE", reason: "fetch failed" };
  const wrong: DeploymentCheckResult = {
    status: "MISMATCH",
    problems: ["recovery validator RELAYER(): on chain 0xaaa, expected 0xbbb"],
  };
  const sequence = (results: DeploymentCheckResult[]) => {
    let calls = 0;
    return {
      check: () =>
        Promise.resolve(results[Math.min(calls++, results.length - 1)] as DeploymentCheckResult),
      calls: () => calls,
    };
  };

  it("does nothing when there is nothing to check", async () => {
    await new DeploymentGuard({ check: null }).onApplicationBootstrap();
  });

  it("starts when the chain matches", async () => {
    const run = sequence([ok]);
    await new DeploymentGuard({ check: run.check, sleep: tick }).onApplicationBootstrap();
    assert.equal(run.calls(), 1);
  });

  it("a definitive mismatch stops startup and names both values", async () => {
    const run = sequence([wrong]);
    await assert.rejects(
      new DeploymentGuard({ check: run.check, sleep: tick }).onApplicationBootstrap(),
      /on chain 0xaaa, expected 0xbbb/,
    );
    assert.equal(run.calls(), 1, "a definitive answer is not retried");
  });

  it("an outage does not stop startup: it retries quickly, then keeps trying in the background without crashing", async () => {
    const run = sequence([down, down, down, down, ok]);
    const late: string[] = [];
    const guard = new DeploymentGuard({
      check: run.check,
      sleep: tick,
      onLateMismatch: (m) => late.push(m),
    });
    await guard.onApplicationBootstrap(); // resolves although the three boot attempts all failed
    assert.equal(run.calls(), 3);
    for (let i = 0; i < 50 && run.calls() < 5; i += 1) await tick();
    assert.equal(run.calls(), 5, "the background retry kept going until the chain answered");
    assert.deepEqual(late, []);
    guard.onModuleDestroy();
  });

  it("a mismatch found by a later retry is logged at error level and handed over, without stopping the process", async () => {
    const run = sequence([down, down, down, wrong]);
    const late: string[] = [];
    const guard = new DeploymentGuard({
      check: run.check,
      sleep: tick,
      onLateMismatch: (m) => late.push(m),
    });
    const errors = mock.method(Logger.prototype, "error", () => undefined);
    const exit = mock.method(process, "exit", () => undefined as never);
    await guard.onApplicationBootstrap();
    for (let i = 0; i < 50 && late.length === 0; i += 1) await tick();
    const logged = errors.mock.calls.map((c) => String(c.arguments[0]));
    errors.mock.restore();
    const exited = exit.mock.callCount();
    exit.mock.restore();
    assert.equal(exited, 0, "the process is never stopped");
    assert.ok(
      logged.some(
        (m) =>
          m.startsWith("recovery.chain_mismatch") && m.includes("on chain 0xaaa, expected 0xbbb"),
      ),
    );
    assert.equal(late.length, 1);
    assert.match(late[0] as string, /on chain 0xaaa, expected 0xbbb/);
  });

  it("a check that throws counts as an outage", async () => {
    const guard = new DeploymentGuard({
      check: () => Promise.reject(new Error("boom")),
      sleep: tick,
      bootAttempts: 1,
      retryDelayMs: 1,
    });
    await guard.onApplicationBootstrap();
    guard.onModuleDestroy();
  });
});

describe("app.started", () => {
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    WALLET_PROVIDER: "none",
  } as Record<string, string>;
  it("reports whether recovery and device keys are on and for which network", () => {
    const off = startedFields(loadConfig(base));
    assert.equal(off.event, "app.started");
    assert.equal(off.recoveryEnabled, false);
    assert.equal(off.deviceKeyRootsEnabled, false);
    assert.equal(off.recoveryNetwork, "celo-mainnet");
    assert.equal(
      startedFields(loadConfig({ ...base, RECOVERY_NETWORK: "celo-sepolia" })).recoveryNetwork,
      "celo-sepolia",
    );
  });
});

describe("the runtime switch", () => {
  it("turns the recovery endpoints into 503 once it is off, and leaves them alone before", async () => {
    const world = createRecoveryWorld();
    const off = new RecoverySwitch();
    const runtime: RecoveryRuntime = {
      context: world.context,
      flow: world.flow,
      cleanup: world.cleanup,
      finalizer: world.finalizer(),
      configuration: world.configuration,
      email: new RecoveryEmailService(world.context),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [RecoveryController],
      providers: [
        { provide: RECOVERY_RUNTIME, useValue: runtime },
        { provide: WALLET_SETUP_SERVICE, useValue: null },
        { provide: RECOVERY_SWITCH, useValue: off },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app, { corsOrigins: [] } as never);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const get = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/recovery/status",
          headers: { authorization: "Bearer nope" },
        })
      ).statusCode;
    assert.equal(await get(), 401);
    off.disable("mismatch");
    assert.equal(await get(), 503);
    assert.equal(off.disabledReason, "mismatch");
    await app.close();
  });
});
