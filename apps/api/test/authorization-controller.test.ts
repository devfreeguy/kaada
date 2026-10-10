import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { AppConfig } from "@kaada/config";

import { AuthorizationController } from "../src/authorization/authorization.controller.js";
import type { AuthorizationRequiredResponse } from "../src/core/responses/agent-response.js";
import { SENDER } from "./support/harness.js";
import { setup } from "./support/payment-world.js";

const PIN = "7351";
const WRONG = "2468";

async function ready(nodeEnv: AppConfig["nodeEnv"] = "development") {
  const w = setup({ authorize: true });
  w.fund("USDT", 500n);
  await w.auth.pins.setPin(SENDER, PIN);
  const response = (await w.r.h.say("pay 500 brl with usdt"))
    .response as AuthorizationRequiredResponse;
  const token = await w.token(response.authorizationSessionId);
  const controller = new AuthorizationController(w.auth.sessions, w.auth.payments, {
    nodeEnv,
  } as AppConfig);
  return { w, response, token, controller, bearer: `Bearer ${token}` };
}

async function status(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
    return { status: 200, body: undefined };
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    throw error;
  }
}

describe("authorization HTTP edge", () => {
  it("needs a bearer token on every endpoint", async () => {
    const { controller } = await ready();
    await assert.rejects(controller.view(undefined), UnauthorizedException);
    await assert.rejects(controller.view("Basic abc"), UnauthorizedException);
    await assert.rejects(
      controller.authorize({ pin: PIN }, "1.1.1.1", undefined),
      UnauthorizedException,
    );
  });

  it("an unknown link is a generic 401", async () => {
    const { controller } = await ready();
    const unknown = `Bearer ${"A".repeat(43)}`;
    assert.equal((await status(controller.view(unknown))).status, 401);
    assert.equal(
      (await status(controller.authorize({ pin: PIN }, "1.1.1.1", unknown))).status,
      401,
    );
  });

  it("shows the summary without any internal id", async () => {
    const { controller, bearer, token } = await ready();
    const view = await controller.view(bearer);
    assert.equal(view.summary.maximumSpend.display, "92.306281 USDT");
    assert.equal(view.indicative, true);
    assert.equal(view.pin.isSet, true);
    const text = JSON.stringify(view);
    for (const secret of [SENDER, token, "tokenHash", "pinHash"]) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  it("takes only a PIN: an extra field (such as a user or route id) is refused", async () => {
    const { controller, bearer, w } = await ready();
    for (const body of [
      { pin: PIN, userId: randomUUID() },
      { pin: PIN, routeId: randomUUID() },
      { pin: PIN, intentId: randomUUID(), walletId: randomUUID() },
      {},
      { pin: 1234 },
      null,
    ]) {
      const result = await status(controller.authorize(body, "1.1.1.1", bearer));
      assert.equal(result.status, 400);
    }
    assert.equal(w.r.world.authorization.payments.length, 0);
  });

  it("a wrong PIN is a 401 with the attempts left, never the PIN", async () => {
    const { controller, bearer } = await ready();
    const result = await status(controller.authorize({ pin: WRONG }, "1.1.1.1", bearer));
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, {
      code: "INVALID_PIN",
      message: "That PIN is incorrect.",
      attemptsRemaining: 2,
    });
    assert.equal(JSON.stringify(result.body).includes(WRONG), false);
  });

  it("three wrong PINs answer 423 Locked, with the time it ends", async () => {
    const { controller, bearer } = await ready();
    await status(controller.authorize({ pin: WRONG }, "1.1.1.1", bearer));
    await status(controller.authorize({ pin: WRONG }, "1.1.1.1", bearer));
    const third = await status(controller.authorize({ pin: WRONG }, "1.1.1.1", bearer));
    assert.equal(third.status, 401);
    assert.ok((third.body as { lockedUntil?: string }).lockedUntil);
    const locked = await status(controller.authorize({ pin: PIN }, "1.1.1.1", bearer));
    assert.equal(locked.status, 423);
    assert.equal((locked.body as { code: string }).code, "PIN_LOCKED");
  });

  it("authorizes with the right PIN and says when the approval ends", async () => {
    const { controller, bearer, w } = await ready();
    const result = await controller.authorize({ pin: PIN }, "1.1.1.1", bearer);
    assert.equal(result.status, "AUTHORIZED");
    assert.ok(Date.parse((result as { expiresAt: string }).expiresAt) > w.r.clock.now.getTime());
    assert.equal(JSON.stringify(result).includes(PIN), false);
    // The link is spent.
    assert.equal((await status(controller.authorize({ pin: PIN }, "1.1.1.1", bearer))).status, 401);
  });

  it("a user with no PIN is told to create one (409)", async () => {
    const w = setup({ authorize: true });
    w.fund("USDT", 500n);
    const response = (await w.r.h.say("pay 500 brl with usdt"))
      .response as AuthorizationRequiredResponse;
    const bearer = `Bearer ${await w.token(response.authorizationSessionId)}`;
    const controller = new AuthorizationController(w.auth.sessions, w.auth.payments, {
      nodeEnv: "development",
    } as AppConfig);
    const result = await status(controller.authorize({ pin: PIN }, "1.1.1.1", bearer));
    assert.equal(result.status, 409);
    assert.equal((result.body as { code: string }).code, "PIN_NOT_SET");
    assert.equal((await controller.view(bearer)).pin.isSet, false);
  });

  it("throttles a flood of requests before they reach the PIN check", async () => {
    const { controller, bearer, w } = await ready();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      statuses.push((await status(controller.authorize({ pin: "12" }, "9.9.9.9", bearer))).status);
    }
    assert.ok(statuses.includes(429), statuses.join());
    // A malformed value is not a guess and the throttle spent no attempts: the PIN is not locked.
    assert.equal((await w.auth.pins.status(SENDER)).lockedUntil, undefined);
  });

  it("the development link helper does not exist in production and needs the session's own user", async () => {
    const production = await ready("production");
    await assert.rejects(
      production.controller.devLink({ sessionId: randomUUID(), userId: SENDER }),
      NotFoundException,
    );
    const dev = await ready();
    const link = await dev.controller.devLink({
      sessionId: dev.response.authorizationSessionId,
      userId: SENDER,
    });
    assert.match(link.url, /^https:\/\/app\.kaada\.test\/authorize\/[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (
        await status(
          dev.controller.devLink({
            sessionId: dev.response.authorizationSessionId,
            userId: randomUUID(),
          }),
        )
      ).status,
      401,
    );
    await assert.rejects(dev.controller.devLink({ sessionId: "nope" }), BadRequestException);
  });

  it("the services are optional: a missing one is reported, not crashed on", async () => {
    const controller = new AuthorizationController(null, null, {
      nodeEnv: "development",
    } as AppConfig);
    assert.equal((await status(controller.view(`Bearer ${"A".repeat(43)}`))).status, 503);
    assert.equal(
      (await status(controller.authorize({ pin: PIN }, "1.1.1.1", `Bearer ${"A".repeat(43)}`)))
        .status,
      503,
    );
    assert.ok(ConflictException);
  });
});
