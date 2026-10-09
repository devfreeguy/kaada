import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "./env.js";

const databaseUrl = "postgresql://user:pass@localhost:5432/kaada";

describe("loadConfig", () => {
  it("applies defaults and nests database settings", () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl });
    assert.equal(config.port, 4000);
    assert.deepEqual(config.corsOrigins, [config.webUrl]);
    assert.deepEqual(config.database, { url: databaseUrl, poolMax: 10, poolTimeoutMs: 10_000 });
  });

  it("accepts a direct URL and pool overrides", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_DIRECT_URL: "postgres://user:pass@localhost:5432/direct",
      DATABASE_POOL_MAX: "5",
      DATABASE_POOL_TIMEOUT_MS: "2000",
    });
    assert.equal(config.database.directUrl, "postgres://user:pass@localhost:5432/direct");
    assert.equal(config.database.poolMax, 5);
    assert.equal(config.database.poolTimeoutMs, 2000);
  });

  it("keeps the agent disabled by default and rejects the mock interpreter in production", () => {
    assert.equal(loadConfig({ DATABASE_URL: databaseUrl }).agent.interpreter, "none");
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, AGENT_INTERPRETER: "mock" }).agent.interpreter,
      "mock",
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          AGENT_INTERPRETER: "mock",
          NODE_ENV: "production",
        }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, AGENT_INTERPRETER: "gpt" }),
      ConfigError,
    );
  });

  it("requires DATABASE_URL", () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  it("rejects non-postgres and malformed database URLs", () => {
    assert.throws(() => loadConfig({ DATABASE_URL: "mysql://localhost/kaada" }), ConfigError);
    assert.throws(() => loadConfig({ DATABASE_URL: "not a url" }), ConfigError);
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, DATABASE_DIRECT_URL: "http://localhost" }),
      ConfigError,
    );
  });

  it("rejects out-of-range pool settings", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: "0" }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, DATABASE_POOL_TIMEOUT_MS: "5" }),
      ConfigError,
    );
  });

  it("does not leak the connection string in error messages", () => {
    try {
      loadConfig({ DATABASE_URL: "mysql://user:s3cret@localhost/kaada" });
      assert.fail("expected ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes("s3cret"));
    }
  });
});
