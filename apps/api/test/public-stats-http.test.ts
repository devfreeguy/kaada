import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { CompletedPaymentGroup } from "@kaada/domain";

import { configureApp } from "../src/app.setup.js";
import { PublicStatsService } from "../src/core/stats/public-stats-service.js";
import { StatsController } from "../src/stats/stats.controller.js";
import { PUBLIC_STATS_SERVICE } from "../src/stats/stats.tokens.js";

/*
 * The public totals over real HTTP: the route, the cache headers, what the body can contain, the per-address limit and the 503.
 */

async function boot(groups: () => Promise<CompletedPaymentGroup[]>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [StatsController],
    providers: [
      {
        provide: PUBLIC_STATS_SERVICE,
        useValue: new PublicStatsService({ stats: { completedByAsset: groups } }),
      },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureApp(app, { corsOrigins: [] } as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const GROUP = {
  assetId: "a",
  symbol: "cNGN",
  fiatCode: "NGN",
  decimals: 6,
  payments: 9,
  total: "4200000000",
};

describe("GET /api/v1/stats/public", () => {
  it("answers with the totals, no credentials, and cache headers a CDN can use", async () => {
    const app = await boot(() => Promise.resolve([GROUP]));
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/stats/public" });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["cache-control"]), /public, max-age=300/);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["completedPayments", "updatedAt", "volume"]);
      assert.equal(body["completedPayments"], 9);
      assert.deepEqual(body["volume"], [{ currency: "NGN", amount: "4200", payments: 9 }]);
    } finally {
      await app.close();
    }
  });

  it("takes no input: a query string or a header changes nothing and is never echoed", async () => {
    const app = await boot(() => Promise.resolve([GROUP]));
    try {
      const plain = await app.inject({ method: "GET", url: "/api/v1/stats/public" });
      const probed = await app.inject({
        method: "GET",
        url: "/api/v1/stats/public?userId=abc&currency=USD&amount=1",
        headers: { authorization: "Bearer SECRET-TOKEN", cookie: "session=SECRET" },
      });
      assert.equal(probed.statusCode, 200);
      assert.deepEqual(
        { ...JSON.parse(probed.body), updatedAt: "" },
        { ...JSON.parse(plain.body), updatedAt: "" },
      );
      assert.equal(probed.body.includes("SECRET"), false);
    } finally {
      await app.close();
    }
  });

  it("answers 503, with no detail, when the database cannot be read and nothing is cached", async () => {
    const app = await boot(() => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")));
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/stats/public" });
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.includes("ECONNREFUSED"), false);
      assert.equal(response.body.includes("10.0.0.5"), false);
    } finally {
      await app.close();
    }
  });

  it("limits one address, so it cannot be used to hammer the server", async () => {
    const app = await boot(() => Promise.resolve([GROUP]));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 65; i += 1) {
        const response = await app.inject({ method: "GET", url: "/api/v1/stats/public" });
        codes.push(response.statusCode);
      }
      assert.equal(codes[0], 200);
      assert.equal(codes.at(-1), 429);
    } finally {
      await app.close();
    }
  });

  it("is read only: nothing else is served on the path", async () => {
    const app = await boot(() => Promise.resolve([GROUP]));
    try {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
        const response = await app.inject({ method, url: "/api/v1/stats/public" });
        assert.equal(response.statusCode, 404, method);
      }
    } finally {
      await app.close();
    }
  });
});
