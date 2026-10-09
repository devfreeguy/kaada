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

  it("requires a Groq key only when the Groq interpreter is selected", () => {
    const base = { DATABASE_URL: databaseUrl };
    assert.equal(loadConfig(base).agent.groq, undefined);
    assert.equal(loadConfig({ ...base, AGENT_INTERPRETER: "mock" }).agent.groq, undefined);
    assert.equal(loadConfig({ ...base, GROQ_API_KEY: "" }).agent.groq, undefined, "blank is unset");
    assert.throws(() => loadConfig({ ...base, AGENT_INTERPRETER: "groq" }), ConfigError);
    assert.throws(
      () => loadConfig({ ...base, AGENT_INTERPRETER: "groq", GROQ_API_KEY: "   " }),
      ConfigError,
    );

    const config = loadConfig({ ...base, AGENT_INTERPRETER: "groq", GROQ_API_KEY: "gsk_test" });
    assert.deepEqual(config.agent, {
      interpreter: "groq",
      groq: { apiKey: "gsk_test", model: "openai/gpt-oss-20b", timeoutMs: 8000 },
    });
  });

  it("allows Groq in production but never the mock, and bounds the Groq settings", () => {
    const prod = { DATABASE_URL: databaseUrl, NODE_ENV: "production", GROQ_API_KEY: "gsk_test" };
    assert.equal(loadConfig({ ...prod, AGENT_INTERPRETER: "groq" }).agent.interpreter, "groq");
    assert.throws(() => loadConfig({ ...prod, AGENT_INTERPRETER: "mock" }), ConfigError);

    const groq = { DATABASE_URL: databaseUrl, AGENT_INTERPRETER: "groq", GROQ_API_KEY: "gsk_test" };
    const custom = loadConfig({
      ...groq,
      GROQ_MODEL: "openai/gpt-oss-120b",
      GROQ_TIMEOUT_MS: "3000",
    });
    assert.equal(custom.agent.groq?.model, "openai/gpt-oss-120b");
    assert.equal(custom.agent.groq?.timeoutMs, 3000);
    assert.throws(() => loadConfig({ ...groq, GROQ_TIMEOUT_MS: "10" }), ConfigError);
    assert.throws(() => loadConfig({ ...groq, GROQ_MODEL: " " }), ConfigError);
  });

  it("never echoes the Groq key in an error", () => {
    try {
      loadConfig({
        DATABASE_URL: "mysql://nope",
        AGENT_INTERPRETER: "groq",
        GROQ_API_KEY: "gsk_super_secret_value",
        GROQ_TIMEOUT_MS: "1",
      });
      assert.fail("expected ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes("gsk_super_secret_value"));
    }
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

describe("FX provider configuration", () => {
  const dev = { DATABASE_URL: databaseUrl };

  it("defaults to no pricing, and accepts the mock in development", () => {
    assert.equal(loadConfig(dev).fx.provider, "none");
    assert.equal(loadConfig({ ...dev, FX_PROVIDER: "mock" }).fx.provider, "mock");
  });

  it("rejects the mock FX provider in production, and unknown providers", () => {
    assert.throws(
      () => loadConfig({ ...dev, NODE_ENV: "production", FX_PROVIDER: "mock" }),
      ConfigError,
    );
    assert.equal(loadConfig({ ...dev, NODE_ENV: "production" }).fx.provider, "none");
    assert.throws(() => loadConfig({ ...dev, FX_PROVIDER: "textile" }), ConfigError);
  });
});
