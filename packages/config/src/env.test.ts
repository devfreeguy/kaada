import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig, loadTextileCredentials } from "./env.js";

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
    assert.throws(() => loadConfig({ ...dev, FX_PROVIDER: "acme" }), ConfigError);
  });
});

describe("Textile configuration", () => {
  const live = {
    DATABASE_URL: databaseUrl,
    FX_PROVIDER: "textile",
    TEXTILE_ENV: "live",
    TEXTILE_LIVE_API_KEY: "tx_live_abcd1234.supersecretvalue",
  };

  it("needs an explicit environment and the matching key, with no default or fallback", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, FX_PROVIDER: "textile" }),
      /TEXTILE_ENV .* is required/,
    );
    assert.throws(
      () => loadConfig({ ...live, TEXTILE_LIVE_API_KEY: undefined }),
      /TEXTILE_LIVE_API_KEY is required/,
    );
    // A test key does not satisfy live, and a live key does not satisfy test.
    assert.throws(
      () =>
        loadConfig({
          ...live,
          TEXTILE_LIVE_API_KEY: undefined,
          TEXTILE_TEST_API_KEY: "tx_test_a.b",
        }),
      /TEXTILE_LIVE_API_KEY is required/,
    );
    assert.throws(() => loadConfig({ ...live, TEXTILE_LIVE_API_KEY: "   " }), ConfigError);
  });

  it("accepts live with the documented defaults", () => {
    const config = loadConfig(live);
    assert.deepEqual(config.fx.textile, {
      env: "live",
      apiKey: live.TEXTILE_LIVE_API_KEY,
      apiUrl: "https://api.textilecredit.com",
      timeoutMs: 8000,
    });
    assert.deepEqual(config.chain, { network: "mainnet", chainId: 42220 });
  });

  it("refuses the test environment for Kaada, which settles on Celo, in every NODE_ENV", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      assert.throws(
        () =>
          loadConfig({
            DATABASE_URL: databaseUrl,
            NODE_ENV,
            FX_PROVIDER: "textile",
            TEXTILE_ENV: "test",
            TEXTILE_TEST_API_KEY: "tx_test_abcd1234.secret",
          }),
        /cannot quote Celo mainnet/,
        NODE_ENV,
      );
    }
  });

  it("is allowed in production with a live key, and the mock still is not", () => {
    assert.equal(loadConfig({ ...live, NODE_ENV: "production" }).fx.provider, "textile");
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "production", FX_PROVIDER: "mock" }),
      ConfigError,
    );
  });

  it("requires the live key to look like a live key, without echoing it", () => {
    const secret = "tx_test_wrongenvironment.SECRETVALUE";
    try {
      loadConfig({ ...live, TEXTILE_LIVE_API_KEY: secret });
      assert.fail("expected a ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /tx_live_/);
      assert.equal(error.message.includes("SECRETVALUE"), false);
    }
  });

  it("only supports Celo mainnet and a host-only API URL", () => {
    assert.throws(() => loadConfig({ DATABASE_URL: databaseUrl, CELO_CHAIN_ID: "1" }), ConfigError);
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, CELO_NETWORK: "alfajores" }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...live, TEXTILE_API_URL: "https://api.textilecredit.com/v2" }),
      ConfigError,
    );
  });

  it("ignores Textile settings unless the provider is textile", () => {
    const { fx } = loadConfig({ DATABASE_URL: databaseUrl, TEXTILE_LIVE_API_KEY: "tx_live_a.b" });
    assert.equal(fx.textile, undefined);
  });
});

describe("loadTextileCredentials", () => {
  it("selects exactly the requested environment's key and never falls back", () => {
    const env = {
      TEXTILE_TEST_API_KEY: "tx_test_a.secret1",
      TEXTILE_LIVE_API_KEY: "tx_live_b.secret2",
    };
    assert.equal(loadTextileCredentials("test", env).apiKey, "tx_test_a.secret1");
    assert.equal(loadTextileCredentials("live", env).apiKey, "tx_live_b.secret2");
    assert.throws(
      () => loadTextileCredentials("live", { TEXTILE_TEST_API_KEY: "tx_test_a.secret1" }),
      /TEXTILE_LIVE_API_KEY is not set/,
    );
    assert.throws(
      () => loadTextileCredentials("test", { TEXTILE_TEST_API_KEY: "tx_live_oops.secret" }),
      /must be a tx_test_/,
    );
  });
});

describe("wallet configuration", () => {
  const base = { DATABASE_URL: databaseUrl };
  const kernel = {
    ...base,
    WALLET_PROVIDER: "kernel",
    PASSKEY_RP_ID: "kaada.app",
    PASSKEY_ORIGIN: "https://app.kaada.app",
  };

  it("defaults to no wallet stack and the public Celo RPC", () => {
    const config = loadConfig(base);
    assert.equal(config.wallet.provider, "none");
    assert.equal(config.wallet.rpcUrl, "https://forno.celo.org");
    assert.equal(config.wallet.passkey, undefined);
  });

  it("validates the selected stack: Kernel needs a relying party and origin", () => {
    assert.throws(
      () => loadConfig({ ...base, WALLET_PROVIDER: "kernel" }),
      /PASSKEY_RP_ID and PASSKEY_ORIGIN/,
    );
    assert.deepEqual(loadConfig(kernel).wallet.passkey, {
      rpId: "kaada.app",
      rpName: "Kaada",
      origin: "https://app.kaada.app",
    });
    assert.equal(
      loadConfig({ ...kernel, PASSKEY_RP_NAME: " Kaada Pay " }).wallet.passkey?.rpName,
      "Kaada Pay",
    );
    assert.throws(() => loadConfig({ ...kernel, PASSKEY_RP_NAME: "" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, WALLET_PROVIDER: "other" }), ConfigError);
  });

  it("rejects an origin that is not on the relying party domain", () => {
    assert.throws(
      () => loadConfig({ ...kernel, PASSKEY_ORIGIN: "https://evil.example" }),
      /must be on PASSKEY_RP_ID/,
    );
    assert.throws(
      () => loadConfig({ ...kernel, PASSKEY_ORIGIN: "https://notkaada.app" }),
      ConfigError,
    );
  });

  it("requires https in production and allows localhost in development", () => {
    const local = {
      ...base,
      WALLET_PROVIDER: "kernel",
      PASSKEY_RP_ID: "localhost",
      PASSKEY_ORIGIN: "http://localhost:3000",
    };
    assert.equal(loadConfig(local).wallet.provider, "kernel");
    assert.throws(() => loadConfig({ ...local, NODE_ENV: "production" }), /https/);
    const production = { ...kernel, NODE_ENV: "production", PIN_PEPPER: "p".repeat(32) };
    assert.equal(loadConfig(production).wallet.provider, "kernel");
    assert.throws(() => loadConfig({ ...production, CELO_RPC_URL: "http://rpc.example" }), /https/);
  });
});

describe("execution (moving funds) configuration", () => {
  const key = Buffer.alloc(32, 5).toString("base64");
  const ready = {
    DATABASE_URL: databaseUrl,
    WALLET_PROVIDER: "kernel",
    PASSKEY_RP_ID: "kaada.app",
    PASSKEY_ORIGIN: "https://app.kaada.app",
    FX_PROVIDER: "textile",
    TEXTILE_ENV: "live",
    TEXTILE_LIVE_API_KEY: "tx_live_abcd1234.supersecretvalue",
    EXECUTION_SECRET_KEY: key,
  };

  it("is off unless exactly true", () => {
    assert.equal(loadConfig({ ...ready }).execution.enabled, false);
    assert.throws(() => loadConfig({ ...ready, EXECUTION_ENABLED: "yes" }), ConfigError);
  });

  it("refuses to start enabled without a bundler", () => {
    assert.throws(() => loadConfig({ ...ready, EXECUTION_ENABLED: "true" }), /BUNDLER_URL/);
    const config = loadConfig({
      ...ready,
      EXECUTION_ENABLED: "true",
      BUNDLER_URL: "https://bundler.example/rpc",
    });
    assert.equal(config.execution.enabled, true);
    assert.equal(config.execution.bundlerUrl, "https://bundler.example/rpc");
  });

  it("refuses to start enabled without the secret key, wallets or pricing", () => {
    const enabled = { ...ready, EXECUTION_ENABLED: "true", BUNDLER_URL: "https://b.example/rpc" };
    const { EXECUTION_SECRET_KEY: _key, ...noKey } = enabled;
    assert.throws(() => loadConfig(noKey), ConfigError);
    assert.throws(() => loadConfig({ ...enabled, FX_PROVIDER: "mock" }), ConfigError);
  });

  it("validates the gas floor and the polling bounds", () => {
    assert.throws(() => loadConfig({ ...ready, EXECUTION_MIN_NATIVE_WEI: "0" }), ConfigError);
    assert.throws(() => loadConfig({ ...ready, EXECUTION_MIN_NATIVE_WEI: "1.5" }), ConfigError);
    assert.throws(() => loadConfig({ ...ready, EXECUTION_POLL_INTERVAL_MS: "5" }), ConfigError);
    assert.equal(
      loadConfig({ ...ready, EXECUTION_RECONCILE_INTERVAL_SECONDS: "0" }).execution
        .reconcileIntervalMs,
      0,
    );
  });
});

describe("payment authorization configuration", () => {
  const base = { DATABASE_URL: databaseUrl };
  const kernel = {
    ...base,
    WALLET_PROVIDER: "kernel",
    PASSKEY_RP_ID: "kaada.app",
    PASSKEY_ORIGIN: "https://app.kaada.app",
  };

  it("defaults to short lifetimes and no pepper in development", () => {
    const { authorization } = loadConfig(base);
    assert.equal(authorization.sessionTtlMs, 300_000);
    assert.equal(authorization.paymentTtlMs, 180_000);
    assert.equal("pinPepper" in authorization, false);
  });

  it("keeps the lifetimes short: a half-hour authorization is refused", () => {
    assert.equal(
      loadConfig({ ...base, PAYMENT_AUTHORIZATION_TTL_SECONDS: "120" }).authorization.paymentTtlMs,
      120_000,
    );
    assert.throws(
      () => loadConfig({ ...base, PAYMENT_AUTHORIZATION_TTL_SECONDS: "1800" }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...base, PAYMENT_AUTHORIZATION_TTL_SECONDS: "5" }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...base, AUTHORIZATION_SESSION_TTL_SECONDS: "3600" }),
      ConfigError,
    );
  });

  it("requires a PIN pepper of at least 32 characters in production wallets", () => {
    const production = { ...kernel, NODE_ENV: "production" };
    assert.throws(() => loadConfig(production), /PIN_PEPPER/);
    assert.throws(() => loadConfig({ ...production, PIN_PEPPER: "short" }), /PIN_PEPPER/);
    assert.equal(
      loadConfig({ ...production, PIN_PEPPER: "p".repeat(32) }).authorization.pinPepper,
      "p".repeat(32),
    );
  });
});

describe("firm quote configuration", () => {
  const base = { DATABASE_URL: databaseUrl };
  const key = Buffer.alloc(32, 5).toString("base64");

  it("defaults to a 12 s minimum window, a 75 s timeout, 4 slots and no key", () => {
    const { execution } = loadConfig(base);
    assert.equal(execution.minFirmWindowMs, 12_000);
    assert.equal(execution.firmTimeoutMs, 75_000);
    assert.equal(execution.maxOutstandingRfqs, 4);
    assert.deepEqual(execution.cipherKeys, []);
    assert.equal(execution.bundlerConfigured, false);
    assert.equal(execution.enabled, false, "moving funds is off by default");
    assert.equal(execution.minNativeWei, 1_000_000_000_000_000n);
  });

  it("accepts only a 32-byte key, and keeps the previous one for rotation", () => {
    assert.deepEqual(loadConfig({ ...base, EXECUTION_SECRET_KEY: key }).execution.cipherKeys, [
      { version: 1, key },
    ]);
    assert.throws(() => loadConfig({ ...base, EXECUTION_SECRET_KEY: "c2hvcnQ=" }), ConfigError);
    assert.throws(
      () => loadConfig({ ...base, EXECUTION_SECRET_KEY: key, EXECUTION_SECRET_KEY_PREVIOUS: "x" }),
      ConfigError,
    );
    const rotated = loadConfig({
      ...base,
      EXECUTION_SECRET_KEY: key,
      EXECUTION_SECRET_KEY_VERSION: "2",
      EXECUTION_SECRET_KEY_PREVIOUS: Buffer.alloc(32, 6).toString("base64"),
    });
    assert.deepEqual(
      rotated.execution.cipherKeys.map((k) => k.version),
      [2, 1],
    );
  });

  it("bounds the safety window and the slot count", () => {
    assert.throws(() => loadConfig({ ...base, FIRM_QUOTE_MIN_WINDOW_SECONDS: "1" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, FIRM_QUOTE_MIN_WINDOW_SECONDS: "120" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, TEXTILE_MAX_OUTSTANDING_RFQS: "9" }), ConfigError);
    assert.equal(
      loadConfig({ ...base, FIRM_QUOTE_MIN_WINDOW_SECONDS: "15" }).execution.minFirmWindowMs,
      15_000,
    );
  });

  it("production with Textile pricing and wallets needs the key", () => {
    const production = {
      ...base,
      NODE_ENV: "production",
      WALLET_PROVIDER: "kernel",
      PASSKEY_RP_ID: "kaada.app",
      PASSKEY_ORIGIN: "https://app.kaada.app",
      PIN_PEPPER: "p".repeat(32),
      FX_PROVIDER: "textile",
      TEXTILE_ENV: "live",
      TEXTILE_LIVE_API_KEY: "tx_live_abcd1234.supersecretvalue",
    };
    assert.throws(() => loadConfig(production), /EXECUTION_SECRET_KEY/);
    assert.equal(
      loadConfig({ ...production, EXECUTION_SECRET_KEY: key }).execution.cipherKeys.length,
      1,
    );
  });
});
