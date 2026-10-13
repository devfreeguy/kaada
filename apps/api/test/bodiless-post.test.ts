import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";

import { configureApp } from "../src/app.setup.js";

@Controller({ path: "ping", version: "1" })
class PingController {
  @Post()
  @HttpCode(200)
  ping(@Body() body: unknown) {
    return { ok: true, body: body ?? null };
  }
}

async function boot(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureApp(app, { corsOrigins: [] } as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("a POST with no body, as a proxy or tunnel delivers it", () => {
  it("is handled, not refused with 415 (this broke the first passkey step behind a tunnel)", async () => {
    const app = await boot();
    try {
      const plain = await app.inject({ method: "POST", url: "/api/v1/ping" });
      assert.equal(plain.statusCode, 200);
      const chunked = await app.inject({
        method: "POST",
        url: "/api/v1/ping",
        headers: { "transfer-encoding": "chunked" },
      });
      assert.equal(chunked.statusCode, 200, "an empty chunked request with no content type");
      const zero = await app.inject({
        method: "POST",
        url: "/api/v1/ping",
        headers: { "content-length": "0" },
      });
      assert.equal(zero.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("still accepts JSON and still refuses a content type it does not support", async () => {
    const app = await boot();
    try {
      const json = await app.inject({
        method: "POST",
        url: "/api/v1/ping",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ a: 1 }),
      });
      assert.equal(json.statusCode, 200);
      assert.deepEqual(json.json(), { ok: true, body: { a: 1 } });
      const xml = await app.inject({
        method: "POST",
        url: "/api/v1/ping",
        headers: { "content-type": "application/xml" },
        payload: "<a/>",
      });
      assert.equal(xml.statusCode, 415, "strictness for declared-but-unsupported types is kept");
    } finally {
      await app.close();
    }
  });
});
