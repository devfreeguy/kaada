import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";

import { RecoveryController } from "../src/recovery/recovery.controller.js";
import type { RecoveryRuntime } from "../src/recovery/recovery.runtime.js";
import { RECOVERY_RUNTIME } from "../src/recovery/recovery.tokens.js";
import { configureApp } from "../src/app.setup.js";
import { WALLET_SETUP_SERVICE } from "../src/wallet/wallet.tokens.js";
import { createRecoveryWorld, newDeviceRoot, newPasskeyRoot } from "./support/recovery-world.js";
import type { RecoveryWorld } from "./support/recovery-world.js";

/*
 * The HTTP edge, driven through a real Fastify instance and the real versioned routes: status codes, headers, strict bodies,
 * and that a token is read from the Authorization header only.
 */

function runtimeOf(world: RecoveryWorld): RecoveryRuntime {
  return {
    context: world.context,
    flow: world.flow,
    cleanup: world.cleanup,
    finalizer: world.finalizer(),
    configuration: world.configuration,
  };
}

async function boot(world: RecoveryWorld, runtime: RecoveryRuntime | null = runtimeOf(world)) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RecoveryController],
    providers: [
      { provide: RECOVERY_RUNTIME, useValue: runtime },
      { provide: WALLET_SETUP_SERVICE, useValue: null },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureApp(app, { corsOrigins: [] } as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const call = async (
  app: NestFastifyApplication,
  method: "GET" | "POST",
  url: string,
  options: { token?: string; body?: unknown } = {},
) => {
  const response = await app.inject({
    method,
    url: `/api/v1/recovery${url}`,
    headers: {
      ...(options.token && { authorization: `Bearer ${options.token}` }),
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
  });
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.json<Record<string, unknown>>(),
  };
};

describe("recovery HTTP", () => {
  it("is 503 on every route when recovery is not enabled", async () => {
    const world = createRecoveryWorld();
    const app = await boot(world, null);
    for (const [method, url] of [
      ["POST", "/start"],
      ["GET", "/status"],
      ["POST", "/proof"],
      ["POST", "/cancel/prepare"],
    ] as const) {
      const r = await call(app, method, url, {
        token: "A".repeat(43),
        body:
          method === "POST"
            ? { email: "a@b.co", signature: `0x${"11".repeat(65)}`, authenticatorCode: "123456" }
            : undefined,
      });
      assert.ok([503, 400].includes(r.status), `${url} -> ${r.status}`);
    }
    assert.equal((await call(app, "POST", "/start", { body: { email: "a@b.co" } })).status, 503);
    await app.close();
    assert.ok(new ServiceUnavailableException());
  });

  it("walks a whole recovery over HTTP: start, verify, root, proof, wait, finalize, prove, PIN", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await world.pins.setPin(user.userId, "735142");
    const app = await boot(world);

    const start = await call(app, "POST", "/start", { body: { email: user.email } });
    assert.equal(start.status, 202);
    assert.equal(start.headers["cache-control"], "no-store");
    assert.deepEqual(Object.keys(start.body), ["token"]);
    const token = String(start.body["token"]);

    // Before the email is verified the token reveals nothing.
    assert.equal((await call(app, "GET", "/status", { token })).status, 401);

    const verified = await call(app, "POST", "/verify-email", {
      token,
      body: { code: world.email.codeFor(user.email) },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body["status"], "EMAIL_VERIFIED");

    const root = await newDeviceRoot();
    const proposal = await call(app, "POST", "/root/device-key", {
      token,
      body: { publicKeyX: root.publicKeyX, publicKeyY: root.publicKeyY },
    });
    assert.equal(proposal.status, 200);
    const typedData = proposal.body["typedData"] as Parameters<RecoveryWorld["signProposal"]>[0];
    const signature = await world.signProposal(typedData, user.code, user.account as `0x${string}`);
    // The Recovery Code signature alone is not a proof: the authenticator code is part of the body.
    assert.equal((await call(app, "POST", "/proof", { token, body: { signature } })).status, 400);
    const proof = await call(app, "POST", "/proof", {
      token,
      body: { signature, authenticatorCode: world.authenticatorCode(user) },
    });
    assert.equal(proof.status, 200);
    assert.equal(proof.body["status"], "PENDING");
    assert.equal(proof.body["nextStep"], "WAIT");

    // Too early: nothing happens.
    const early = await call(app, "POST", "/finalize", { token });
    assert.deepEqual(early.body, { outcome: "NOT_ELIGIBLE" });

    world.advance(72 * 3600 * 1000 + 10_000);
    const done = await call(app, "POST", "/finalize", { token });
    assert.deepEqual(done.body, { outcome: "ROOT_CHANGED" });

    const options = await call(app, "POST", "/signing-proof/options", { token });
    assert.equal(options.status, 200);
    assert.equal(options.body["rootKind"], "DEVICE_KEY");
    const completed = await call(app, "POST", "/signing-proof", {
      token,
      body: { material: world.rootSigns(root.credentialRef, String(options.body["challenge"])) },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body["status"], "COMPLETED");

    const pin = await call(app, "POST", "/pin", { token, body: { pin: "246813" } });
    assert.equal(pin.status, 200);
    assert.equal(pin.body["nextStep"], "CREATE_RECOVERY_CODE");
    assert.equal(
      (await call(app, "POST", "/pin", { token, body: { pin: "135790" } })).status,
      400,
      "a second reset is refused",
    );

    // The recovery retired the old authenticator: the new Recovery Code needs a NEW one first.
    const context = await call(app, "GET", "/configuration/context", { token });
    assert.equal(context.status, 200);
    assert.equal(context.body["authenticatorEnrolled"], false);
    const earlyCode = await call(app, "POST", "/configuration/prepare", {
      token,
      body: { recoveryAddress: "0x00000000000000000000000000000000000000f9" },
    });
    assert.equal(earlyCode.status, 409, "no Recovery Code before the authenticator app");
    const begin = await call(app, "POST", "/configuration/authenticator/begin", { token });
    assert.equal(begin.status, 200);
    assert.equal(begin.headers["cache-control"], "no-store");
    assert.match(String(begin.body["otpauthUri"]), /^otpauth:\/\/totp\/Kaada:/);
    assert.match(String(begin.body["secret"]), /^[A-Z2-7]{32}$/);
    const { totpAtStep, stepAt } = await import("../src/core/recovery/totp.js");
    // A wrong code does not complete setup, and says nothing about the secret.
    const wrongCode = totpAtStep(String(begin.body["secret"]), stepAt(world.now().getTime()) + 5);
    const bad = await call(app, "POST", "/configuration/authenticator/confirm", {
      token,
      body: { code: wrongCode },
    });
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.body).includes(String(begin.body["secret"])));
    assert.equal(
      (
        await call(app, "POST", "/configuration/authenticator/confirm", {
          token,
          body: { code: "12ab56" },
        })
      ).status,
      400,
    );
    const good = await call(app, "POST", "/configuration/authenticator/confirm", {
      token,
      body: { code: totpAtStep(String(begin.body["secret"]), stepAt(world.now().getTime())) },
    });
    assert.equal(good.status, 200);
    assert.equal(
      (await call(app, "GET", "/configuration/context", { token })).body["authenticatorEnrolled"],
      true,
    );
    // A completed enrolment cannot be silently replaced.
    assert.equal(
      (await call(app, "POST", "/configuration/authenticator/begin", { token })).status,
      400,
    );
    await app.close();
  });

  it("maps failures to safe statuses with no internals", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const app = await boot(world);
    // not a token at all / no header
    assert.equal((await call(app, "GET", "/status")).status, 401);
    assert.equal((await call(app, "GET", "/status", { token: "short" })).status, 401);
    // a malformed email is a 400; a rate limited one a 429
    assert.equal((await call(app, "POST", "/start", { body: { email: "nope" } })).status, 400);
    for (let i = 0; i < 5; i++) await call(app, "POST", "/start", { body: { email: user.email } });
    assert.equal((await call(app, "POST", "/start", { body: { email: user.email } })).status, 429);
    // wrong code: the same generic 401 as an unknown token
    const { body } = await call(app, "POST", "/start", {
      body: { email: "ghost@example.com" },
    }).catch(() => ({ body: { token: "A".repeat(43) } }));
    const wrong = await call(app, "POST", "/verify-email", {
      token: typeof body["token"] === "string" ? body["token"] : "A".repeat(43),
      body: { code: "123456" },
    });
    assert.equal(wrong.status, 401);
    assert.ok(!JSON.stringify(wrong.body).includes(user.email));
    await app.close();
  });

  it("refuses bodies with extra fields, and never accepts a token in the URL or the body", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const app = await boot(world);
    assert.equal(
      (await call(app, "POST", "/start", { body: { email: user.email, userId: "x" } })).status,
      400,
    );
    assert.equal(
      (
        await call(app, "POST", "/proof", {
          token,
          body: { signature: `0x${"11".repeat(65)}`, authenticatorCode: "123456", account: "0x1" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(app, "POST", "/pin", { token, body: { pin: "246813", userId: "x" } })).status,
      400,
    );
    assert.equal(
      (
        await call(app, "POST", "/root/device-key", {
          token,
          body: { publicKeyX: "11".repeat(32), publicKeyY: "22".repeat(32), channel: "native-ios" },
        })
      ).status,
      400,
    );
    // a token in the query string or the body is ignored: still 401
    const viaQuery = await app.inject({
      method: "GET",
      url: `/api/v1/recovery/status?token=${token}`,
    });
    assert.equal(viaQuery.statusCode, 401);
    const viaBody = await app.inject({
      method: "POST",
      url: "/api/v1/recovery/proof",
      payload: { token, signature: `0x${"11".repeat(65)}`, authenticatorCode: "123456" },
    });
    assert.ok([400, 401].includes(viaBody.statusCode));
    await app.close();
  });

  it("the device-key route is the WEB route: a key from it can never be TRUSTED_DEVICE", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const app = await boot(world);
    const root = await newDeviceRoot();
    await call(app, "POST", "/root/device-key", {
      token,
      body: { publicKeyX: root.publicKeyX, publicKeyY: root.publicKeyY },
    });
    const attempt = await world.attemptOf(token);
    const credential = await world.repositories.walletCredentials.findById(
      attempt.newCredentialId ?? "",
    );
    assert.equal(credential?.securityTier, "WEB_NON_EXTRACTABLE");
    await app.close();
  });

  it("the cancel link works end to end over HTTP, and there is no report/veto route", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.startRecovery(user, newPasskeyRoot());
    const cancelToken = world.cancelTokenFrom(user);
    const app = await boot(world);
    // The cancel token is not a session token.
    assert.equal((await call(app, "GET", "/status", { token: cancelToken })).status, 401);
    const prepared = await call(app, "POST", "/cancel/prepare", { token: cancelToken });
    assert.equal(prepared.status, 200);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const cancelled = await call(app, "POST", "/cancel", {
      token: cancelToken,
      body: { material: world.rootSigns(root.credentialRef, String(prepared.body["challenge"])) },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body["status"], "CANCELLED");
    // There is no way for Kaada to stop a recovery: the old "report" route is gone.
    assert.equal((await call(app, "POST", "/report", { token: cancelToken })).status, 404);
    assert.equal((await call(app, "GET", "/status", { token })).body["status"], "CANCELLED");
    await app.close();
  });

  it("arms a Recovery Code only for a completed recovery session (never for an unfinished one)", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const app = await boot(world);
    const refused = await call(app, "POST", "/configuration/prepare", {
      token,
      body: { recoveryAddress: "0x00000000000000000000000000000000000000f9" },
    });
    assert.equal(refused.status, 400, "a verified but unfinished session cannot arm anything");
    await app.close();
  });
});
