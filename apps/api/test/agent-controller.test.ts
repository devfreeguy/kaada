import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import type { Repositories } from "@kaada/database";

import { AgentController } from "../src/agent/agent.controller.js";
import { MockIntentInterpreter } from "../src/core/agent/mock-interpreter.js";
import { AgentService } from "../src/core/agent/agent-service.js";
import { createHarness, intent } from "./support/harness.js";

function setup(nodeEnv: AppConfig["nodeEnv"] = "development", withAgent = true) {
  const h = createHarness();
  h.script.set(
    "send $20",
    intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
  );
  const agent = withAgent
    ? new AgentService({ unitOfWork: h.world.unitOfWork, interpreter: h.interpreter })
    : null;
  const controller = new AgentController(
    agent,
    h.world.repositories as unknown as Repositories,
    { nodeEnv } as AppConfig,
  );
  return { h, controller };
}

describe("AgentController (development endpoint)", () => {
  it("does not exist in production", async () => {
    const { controller } = setup("production");
    await assert.rejects(controller.sendMessage({ content: "send $20" }), NotFoundException);
  });

  it("is unavailable until an interpreter is configured", async () => {
    const { controller } = setup("development", false);
    await assert.rejects(
      controller.sendMessage({ content: "send $20" }),
      ServiceUnavailableException,
    );
  });

  it("accepts only what a person typed: callers cannot supply an interpreted intent", async () => {
    const { controller } = setup();
    const injected = {
      content: "send $20",
      intent: { type: "SEND", amount: { value: "1000000", currencyOrAsset: "USD" } },
    };
    await assert.rejects(controller.sendMessage(injected), BadRequestException);
    await assert.rejects(
      controller.sendMessage({ content: "send $20", interpretation: {} }),
      BadRequestException,
    );
    await assert.rejects(controller.sendMessage({ content: "" }), BadRequestException);
    await assert.rejects(
      controller.sendMessage({ content: "x", userId: "not-a-uuid" }),
      BadRequestException,
    );
    await assert.rejects(controller.sendMessage(null), BadRequestException);
  });

  it("creates a throwaway dev user when none is given and continues the same conversation", async () => {
    const { h, controller } = setup();
    const first = await controller.sendMessage({ content: "send $20" });
    assert.ok(h.world.users.has(first.userId));
    assert.equal(first.response.type, "CLARIFICATION_REQUIRED");

    const second = await controller.sendMessage({
      content: "send $20",
      userId: first.userId,
      conversationId: first.conversationId,
    });
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(h.world.conversations.size, 1);
  });

  it("rejects unknown users and conversations that belong to someone else", async () => {
    const { h, controller } = setup();
    await assert.rejects(
      controller.sendMessage({ content: "send $20", userId: randomUUID() }),
      NotFoundException,
    );

    const first = await controller.sendMessage({ content: "send $20" });
    const other = h.world.addUser({ id: randomUUID() });
    await assert.rejects(
      controller.sendMessage({
        content: "send $20",
        userId: other.id,
        conversationId: first.conversationId,
      }),
      NotFoundException,
    );
  });
});

describe("MockIntentInterpreter", () => {
  it("returns scripted results in order and fails loudly when exhausted", async () => {
    const mock = MockIntentInterpreter.sequence(
      intent({ type: "HELP" }),
      intent({ type: "UNKNOWN" }),
    );
    const input = { message: "x", history: [], now: new Date() };
    assert.deepEqual(await mock.interpret(input), intent({ type: "HELP" }));
    assert.deepEqual(await mock.interpret(input), intent({ type: "UNKNOWN" }));
    await assert.rejects(mock.interpret(input), /exhausted/);
    assert.equal(mock.calls.length, 3);
  });

  it("matches messages exactly (case and spacing aside) and otherwise says UNKNOWN", async () => {
    const mock = MockIntentInterpreter.byMessage({ "Send  $20": intent({ type: "SEND" }) });
    const ask = (message: string) => mock.interpret({ message, history: [], now: new Date() });
    assert.deepEqual(await ask(" send $20 "), intent({ type: "SEND" }));
    assert.deepEqual(await ask("send $21"), intent({ type: "UNKNOWN" }));
  });
});
