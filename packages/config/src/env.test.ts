import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RECOVERY_DELAYS, RECOVERY_DEPLOYMENTS } from "./deployments.js";
import type { RecoveryContracts, RecoveryNetwork } from "./deployments.js";
import { ConfigError, loadConfig, loadTextileCredentials } from "./env.js";
import { SETTINGS } from "./settings.js";

const databaseUrl = "postgresql://user:secret-password@db.example.com/kaada";
const base = { DATABASE_URL: databaseUrl };
const key = Buffer.alloc(32, 7).toString("base64");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const contracts: RecoveryContracts = {
  validator: address(1),
  passkeyFactory: address(2),
  passkeyImplementation: address(3),
  deviceFactory: address(4),
  deviceImplementation: address(5),
};
/** A deployments table where Celo Sepolia has contracts (the committed table has none yet). */
const deployed: Readonly<Record<RecoveryNetwork, RecoveryContracts | null>> = {
  "celo-mainnet": null,
  "celo-sepolia": contracts,
};

const kernel = {
  ...base,
  WALLET_PROVIDER: "kernel",
  PASSKEY_RP_ID: "kaada.app",
  PASSKEY_ORIGIN: "https://app.kaada.app",
};

/** A production wallet setup that satisfies every production rule. */
const production = {
  ...kernel,
  NODE_ENV: "production",
  PIN_PEPPER: "p".repeat(32),
  REDIS_URL: "rediss://redis.example:6380",
};

describe("loadConfig", () => {
  it("applies defaults and nests database settings", () => {
    const config = loadConfig(base);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.port, 4000);
    assert.equal(config.logLevel, "info");
    assert.deepEqual(config.corsOrigins, ["http://localhost:3000"]);
    assert.equal(config.database.url, databaseUrl);
    assert.equal("directUrl" in config.database, false);
    assert.equal(config.database.poolMax, SETTINGS.database.poolMax);
    assert.equal(config.database.transactionTimeoutMs, 5000);
  });

  it("accepts a direct URL, ports and explicit CORS origins", () => {
    const config = loadConfig({
      ...base,
      DATABASE_DIRECT_URL: "postgresql://u:p@direct.example.com/kaada",
      PORT: "8080",
      CORS_ORIGINS: " https://a.example , https://b.example ",
    });
    assert.equal(config.database.directUrl, "postgresql://u:p@direct.example.com/kaada");
    assert.equal(config.port, 8080);
    assert.deepEqual(config.corsOrigins, ["https://a.example", "https://b.example"]);
  });

  it("requires DATABASE_URL and refuses non-postgres or malformed URLs, without leaking them", () => {
    assert.throws(() => loadConfig({}), ConfigError);
    for (const bad of ["mysql://u:p@h/db", "not a url"]) {
      assert.throws(() => loadConfig({ DATABASE_URL: bad }), ConfigError);
    }
    try {
      loadConfig({ DATABASE_URL: "mysql://user:secret-password@h/db" });
      assert.fail("expected a failure");
    } catch (error) {
      assert.equal(String((error as Error).message).includes("secret-password"), false);
    }
  });

  it("keeps the agent disabled by default, requires the Groq key only for Groq, and refuses the mock in production", () => {
    assert.equal(loadConfig(base).agent.interpreter, "none");
    assert.throws(() => loadConfig({ ...base, AGENT_INTERPRETER: "groq" }), /GROQ_API_KEY/);
    const groq = loadConfig({ ...base, AGENT_INTERPRETER: "groq", GROQ_API_KEY: " gsk_test " });
    assert.deepEqual(groq.agent.groq, {
      apiKey: "gsk_test",
      model: SETTINGS.agent.groq.model,
      timeoutMs: SETTINGS.agent.groq.timeoutMs,
    });
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: "production", AGENT_INTERPRETER: "mock" }),
      /mock interpreter/,
    );
    assert.doesNotThrow(() =>
      loadConfig({ ...base, NODE_ENV: "production", AGENT_INTERPRETER: "groq", GROQ_API_KEY: "k" }),
    );
  });

  it("never echoes the Groq key in an error", () => {
    try {
      loadConfig({ ...base, AGENT_INTERPRETER: "bogus", GROQ_API_KEY: "gsk_super_secret" });
      assert.fail("expected a failure");
    } catch (error) {
      assert.equal(String((error as Error).message).includes("gsk_super_secret"), false);
    }
  });
});

describe("hardcoded settings are not configurable from the environment", () => {
  it("ignores every variable that used to tune them", () => {
    const ignored = {
      DATABASE_POOL_MAX: "99",
      DATABASE_POOL_TIMEOUT_MS: "1000",
      DATABASE_TRANSACTION_TIMEOUT_MS: "120000",
      AUTHORIZATION_SESSION_TTL_SECONDS: "900",
      PAYMENT_AUTHORIZATION_TTL_SECONDS: "600",
      EXECUTION_POLL_INTERVAL_MS: "250",
      EXECUTION_POLL_MAX_WAIT_MS: "120000",
      EXECUTION_RECONCILE_INTERVAL_SECONDS: "0",
      FIRM_QUOTE_MIN_WINDOW_SECONDS: "5",
      FIRM_QUOTE_TIMEOUT_MS: "10000",
      TEXTILE_MAX_OUTSTANDING_RFQS: "1",
      TEXTILE_API_URL: "https://evil.example",
      TEXTILE_TIMEOUT_MS: "80000",
      GROQ_MODEL: "something/else",
      GROQ_TIMEOUT_MS: "60000",
      PASSKEY_RP_NAME: "Phish",
      REDIS_KEY_PREFIX: "x:",
      CELO_CHAIN_ID: "1",
      CELO_NETWORK: "testnet",
      RECOVERY_MIN_DELAY_SECONDS: "1",
      RECOVERY_DELAY_SECONDS: "1",
      RECOVERY_SWEEP_INTERVAL_SECONDS: "0",
      RECOVERY_ATTESTOR_SIGNER: "file",
      RECOVERY_EMAIL_PROVIDER: "outbox",
      ATTESTATION_ANDROID_MIN_LEVEL: "TEE",
      ATTESTATION_IOS_ALLOW_DEVELOPMENT: "true",
      ATTESTATION_CHALLENGE_TTL_SECONDS: "900",
      ATTESTATION_REVOCATION_URL: "https://evil.example",
      ATTESTATION_REVOCATION_CACHE_SECONDS: "86400",
      TEXTILE_ENV: "test",
    };
    const withNoise = loadConfig({ ...base, ...ignored, NODE_ENV: "production" });
    const without = loadConfig({ ...base, NODE_ENV: "production" });
    assert.deepEqual(withNoise, without);
  });

  it("keeps the security floors where the code says they are", () => {
    const config = loadConfig(base);
    assert.equal(config.authorization.sessionTtlMs, 300_000);
    assert.equal(config.authorization.paymentTtlMs, 600_000);
    assert.equal(config.recovery.minDelaySeconds, 86_400);
    assert.equal(config.recovery.delaySeconds, 259_200);
    assert.equal(config.chain.chainId, 42220);
    assert.equal(config.chain.network, "mainnet");
    assert.equal(config.execution.minFirmWindowMs, 12_000);
    assert.equal(config.execution.firmTimeoutMs, 75_000);
    assert.equal(config.execution.maxOutstandingRfqs, 4);
    for (const network of ["celo-mainnet", "celo-sepolia"] as const) {
      assert.ok(RECOVERY_DELAYS[network].minDelaySeconds >= 86_400, network);
      assert.ok(RECOVERY_DELAYS[network].delaySeconds >= RECOVERY_DELAYS[network].minDelaySeconds);
    }
  });
});

describe("pricing and Textile", () => {
  it("defaults to no pricing and accepts the mock in development, never in production", () => {
    assert.equal(loadConfig(base).fx.provider, "none");
    assert.equal(loadConfig({ ...base, FX_PROVIDER: "mock" }).fx.provider, "mock");
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: "production", FX_PROVIDER: "mock" }),
      /mock FX provider/,
    );
    assert.throws(() => loadConfig({ ...base, FX_PROVIDER: "bogus" }), ConfigError);
  });

  it("textile pricing needs a live key, with the documented host and timeout", () => {
    assert.throws(() => loadConfig({ ...base, FX_PROVIDER: "textile" }), /TEXTILE_LIVE_API_KEY/);
    const config = loadConfig({
      ...base,
      FX_PROVIDER: "textile",
      TEXTILE_LIVE_API_KEY: "tx_live_abcd1234.supersecretvalue",
    });
    assert.deepEqual(config.fx.textile, {
      env: "live",
      apiKey: "tx_live_abcd1234.supersecretvalue",
      apiUrl: SETTINGS.textile.apiUrl,
      timeoutMs: SETTINGS.textile.timeoutMs,
    });
  });

  it("rejects a key that is not a live key, without echoing it", () => {
    try {
      loadConfig({
        ...base,
        FX_PROVIDER: "textile",
        TEXTILE_LIVE_API_KEY: "tx_test_abcd.secretvalue",
      });
      assert.fail("expected a failure");
    } catch (error) {
      assert.match((error as Error).message, /tx_live_/);
      assert.equal((error as Error).message.includes("secretvalue"), false);
    }
  });

  it("ignores Textile keys unless the provider is textile", () => {
    const config = loadConfig({ ...base, TEXTILE_LIVE_API_KEY: "tx_live_x.y" });
    assert.equal("textile" in config.fx, false);
  });
});

describe("loadTextileCredentials", () => {
  it("selects exactly the requested environment's key and never falls back", () => {
    const env = { TEXTILE_TEST_API_KEY: "tx_test_a.b", TEXTILE_LIVE_API_KEY: "tx_live_c.d" };
    assert.equal(loadTextileCredentials("test", env).apiKey, "tx_test_a.b");
    assert.equal(loadTextileCredentials("live", env).apiKey, "tx_live_c.d");
    assert.equal(loadTextileCredentials("live", env).apiUrl, SETTINGS.textile.apiUrl);
    assert.throws(
      () => loadTextileCredentials("test", { TEXTILE_LIVE_API_KEY: "tx_live_c.d" }),
      /not set/,
    );
    assert.throws(
      () => loadTextileCredentials("live", { TEXTILE_LIVE_API_KEY: "tx_test_x.y" }),
      /tx_live_/,
    );
  });
});

describe("wallet configuration", () => {
  it("defaults to no wallet stack, the public Celo RPC and Celo mainnet validators", () => {
    const config = loadConfig(base);
    assert.equal(config.wallet.provider, "none");
    assert.equal(config.wallet.rpcUrl, "https://forno.celo.org");
    assert.equal(config.wallet.onChainId, 42220);
    assert.equal("passkey" in config.wallet, false);
  });

  it("Kernel needs a relying party and an origin on that domain", () => {
    assert.throws(() => loadConfig({ ...base, WALLET_PROVIDER: "kernel" }), /PASSKEY_RP_ID/);
    const config = loadConfig(kernel);
    assert.deepEqual(config.wallet.passkey, {
      rpId: "kaada.app",
      rpName: "Kaada",
      origin: "https://app.kaada.app",
    });
    assert.throws(
      () => loadConfig({ ...kernel, PASSKEY_ORIGIN: "https://evil.example" }),
      /must be on/,
    );
    assert.doesNotThrow(() => loadConfig({ ...kernel, PASSKEY_ORIGIN: "https://x.kaada.app" }));
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
    assert.equal(loadConfig(production).wallet.provider, "kernel");
    assert.throws(() => loadConfig({ ...production, CELO_RPC_URL: "http://rpc.example" }), /https/);
  });
});

describe("payment authorization secrets", () => {
  it("needs no pepper in development, and a 32+ character one in production wallets", () => {
    assert.equal("pinPepper" in loadConfig(kernel).authorization, false);
    const { PIN_PEPPER: _p, ...noPepper } = production;
    assert.throws(() => loadConfig(noPepper), /PIN_PEPPER/);
    assert.throws(() => loadConfig({ ...production, PIN_PEPPER: "short" }), /PIN_PEPPER/);
    assert.equal(loadConfig(production).authorization.pinPepper, "p".repeat(32));
  });
});

describe("execution (moving funds)", () => {
  const ready = {
    ...kernel,
    FX_PROVIDER: "textile",
    TEXTILE_LIVE_API_KEY: "tx_live_abcd1234.supersecretvalue",
    EXECUTION_SECRET_KEY: key,
  };

  it("is off unless exactly true", () => {
    assert.equal(loadConfig(ready).execution.enabled, false);
    assert.throws(() => loadConfig({ ...ready, EXECUTION_ENABLED: "yes" }), ConfigError);
  });

  it("refuses to start enabled without a bundler, the key, wallets, pricing or passkeys", () => {
    assert.throws(() => loadConfig({ ...ready, EXECUTION_ENABLED: "true" }), /BUNDLER_URL/);
    const on = { ...ready, EXECUTION_ENABLED: "true", BUNDLER_URL: "https://bundler.example/rpc" };
    const config = loadConfig(on);
    assert.equal(config.execution.enabled, true);
    assert.equal(config.execution.bundlerUrl, "https://bundler.example/rpc");
    for (const drop of [
      "EXECUTION_SECRET_KEY",
      "FX_PROVIDER",
      "WALLET_PROVIDER",
      "PASSKEY_ORIGIN",
    ]) {
      const { [drop]: _gone, ...without } = on as Record<string, string>;
      assert.throws(() => loadConfig(without), ConfigError, drop);
    }
  });

  it("validates the gas floor, and keeps a 32-byte key and its previous one for rotation", () => {
    assert.equal(loadConfig(base).execution.minNativeWei, 50_000_000_000_000_000n);
    assert.equal(
      loadConfig({ ...base, EXECUTION_MIN_NATIVE_WEI: "1000000000000000" }).execution.minNativeWei,
      1_000_000_000_000_000n,
    );
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      assert.throws(() => loadConfig({ ...base, EXECUTION_MIN_NATIVE_WEI: bad }), ConfigError, bad);
    }
    assert.throws(
      () => loadConfig({ ...base, EXECUTION_SECRET_KEY: "tooshort" }),
      /32 random bytes/,
    );
    assert.deepEqual(loadConfig(base).execution.cipherKeys, []);
    const previous = Buffer.alloc(32, 9).toString("base64");
    const rotated = loadConfig({
      ...base,
      EXECUTION_SECRET_KEY: key,
      EXECUTION_SECRET_KEY_VERSION: "2",
      EXECUTION_SECRET_KEY_PREVIOUS: previous,
    });
    assert.deepEqual(rotated.execution.cipherKeys, [
      { version: 2, key },
      { version: 1, key: previous },
    ]);
  });

  it("production firm quotes need the key", () => {
    const quoting = { ...production, FX_PROVIDER: "textile", TEXTILE_LIVE_API_KEY: "tx_live_a.b" };
    assert.throws(() => loadConfig(quoting), /EXECUTION_SECRET_KEY/);
    assert.doesNotThrow(() => loadConfig({ ...quoting, EXECUTION_SECRET_KEY: key }));
  });
});

describe("account recovery", () => {
  const dev = {
    ...kernel,
    PASSKEY_RP_ID: "localhost",
    PASSKEY_ORIGIN: "http://localhost:3000",
    BUNDLER_URL: "https://bundler.example/rpc",
    RECOVERY_ENABLED: "true",
    RECOVERY_NETWORK: "celo-sepolia",
    RECOVERY_RELAYER_KEY_FILE: "/secrets/relayer.key",
    RECOVERY_ATTESTOR_KEY_FILE: "/secrets/attestor.key",
    RECOVERY_CHALLENGE_SECRET: key,
    RECOVERY_EMAIL_OUTBOX_FILE: "/tmp/outbox.jsonl",
  };

  it("is off by default and carries the 72 hour delay and the 24 hour floor", () => {
    const config = loadConfig(base);
    assert.equal(config.recovery.enabled, false);
    assert.equal(config.recovery.delaySeconds, 259_200);
    assert.equal(config.recovery.minDelaySeconds, 86_400);
    assert.equal(config.recovery.emailProvider, "none");
    assert.equal(config.recovery.gasTopUpMaxWei, 0n);
    assert.equal("setup" in config.recovery, false);
  });

  it("is on only when exactly true, then needs every piece and the contracts of its network", () => {
    assert.throws(
      () => loadConfig({ ...dev, RECOVERY_ENABLED: "yes" }, { deployments: deployed }),
      ConfigError,
    );
    const config = loadConfig(dev, { deployments: deployed });
    assert.equal(config.recovery.setup?.contracts.validator, address(1));
    assert.equal(config.recovery.setup?.attestor.signer, "file");
    assert.equal(config.recovery.chainId, 11142220);
    assert.equal(config.wallet.onChainId, 11142220);
    assert.equal(config.recovery.emailProvider, "outbox");
    for (const drop of [
      "WALLET_PROVIDER",
      "BUNDLER_URL",
      "RECOVERY_RELAYER_KEY_FILE",
      "RECOVERY_ATTESTOR_KEY_FILE",
      "RECOVERY_CHALLENGE_SECRET",
      "RECOVERY_EMAIL_OUTBOX_FILE",
    ]) {
      const { [drop]: _gone, ...without } = dev as Record<string, string>;
      assert.throws(() => loadConfig(without, { deployments: deployed }), ConfigError, drop);
    }
  });

  it("refuses a network whose contracts are not deployed (the committed table has none yet)", () => {
    assert.deepEqual(RECOVERY_DEPLOYMENTS, { "celo-mainnet": null, "celo-sepolia": null });
    assert.throws(() => loadConfig(dev), /not deployed on celo-sepolia/);
    assert.throws(
      () => loadConfig({ ...dev, RECOVERY_NETWORK: "celo-mainnet" }, { deployments: deployed }),
      /not deployed on celo-mainnet/,
    );
    assert.throws(
      () => loadConfig({ ...dev, RECOVERY_NETWORK: "nowhere" }, { deployments: deployed }),
      ConfigError,
    );
  });

  it("rejects a challenge secret that is not 32 bytes", () => {
    assert.throws(
      () => loadConfig({ ...dev, RECOVERY_CHALLENGE_SECRET: "short" }, { deployments: deployed }),
      /32 random bytes/,
    );
  });

  it("production: Redis, a KMS attestor, SMTP, never the file outbox or a key file", () => {
    const prod = {
      ...dev,
      ...production,
      RECOVERY_NETWORK: "celo-sepolia",
      BUNDLER_URL: "https://bundler.example/rpc",
      RECOVERY_ENABLED: "true",
      RECOVERY_RELAYER_KEY_FILE: "/secrets/relayer.key",
      RECOVERY_CHALLENGE_SECRET: key,
      RECOVERY_ATTESTOR_KMS_KEY_ID: "attestor-key-1",
      RECOVERY_SMTP_URL: "smtps://user:pass@mail.example:465",
      RECOVERY_EMAIL_FROM: "Kaada <no-reply@kaada.app>",
    };
    const { RECOVERY_EMAIL_OUTBOX_FILE: _o, RECOVERY_ATTESTOR_KEY_FILE: _k, ...clean } = prod;
    const config = loadConfig(clean, { deployments: deployed });
    assert.deepEqual(config.recovery.setup?.attestor, {
      signer: "kms",
      kmsKeyId: "attestor-key-1",
    });
    assert.equal(config.recovery.emailProvider, "smtp");
    assert.equal(config.recovery.smtp?.from, "Kaada <no-reply@kaada.app>");
    assert.equal(config.redis?.url, "rediss://redis.example:6380");

    const { RECOVERY_ATTESTOR_KMS_KEY_ID: _id, ...noKms } = clean;
    assert.throws(() => loadConfig(noKms, { deployments: deployed }), /KMS/);
    const { REDIS_URL: _r, ...noRedis } = clean;
    assert.throws(() => loadConfig(noRedis, { deployments: deployed }), /REDIS_URL/);
    const { RECOVERY_SMTP_URL: _s, RECOVERY_EMAIL_FROM: _f, ...noSmtp } = clean;
    assert.throws(
      () =>
        loadConfig({ ...noSmtp, RECOVERY_EMAIL_OUTBOX_FILE: "/tmp/o" }, { deployments: deployed }),
      /development/,
    );
  });

  it("validates SMTP and Redis URLs", () => {
    assert.throws(
      () => loadConfig({ ...base, RECOVERY_SMTP_URL: "http://x", RECOVERY_EMAIL_FROM: "a@b.c" }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...base, RECOVERY_SMTP_URL: "smtps://u:p@h:465" }),
      /RECOVERY_EMAIL_FROM/,
    );
    assert.throws(() => loadConfig({ ...base, REDIS_URL: "http://x" }), ConfigError);
    assert.equal(
      loadConfig({ ...base, REDIS_URL: "redis://localhost:6379" }).redis?.prefix,
      SETTINGS.redis.keyPrefix,
    );
    assert.equal("redis" in loadConfig(base), false);
  });

  it("the Telegram token is optional", () => {
    assert.equal(
      loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc" }).recovery.telegramBotToken,
      "123:abc",
    );
    assert.equal("telegramBotToken" in loadConfig(base).recovery, false);
  });
});

describe("device keys and attestation", () => {
  const roots = {
    ...kernel,
    PASSKEY_RP_ID: "localhost",
    PASSKEY_ORIGIN: "http://localhost:3000",
    RECOVERY_NETWORK: "celo-sepolia",
    DEVICE_KEY_ROOTS_ENABLED: "true",
    RECOVERY_RELAYER_KEY_FILE: "/secrets/relayer.key",
  };
  const digest = "ab".repeat(32);

  it("device-key roots are off by default and on only when exactly true, needing the contracts and the relayer", () => {
    assert.equal("deviceKeyRoots" in loadConfig(base).wallet, false);
    assert.throws(
      () => loadConfig({ ...roots, DEVICE_KEY_ROOTS_ENABLED: "yes" }, { deployments: deployed }),
      ConfigError,
    );
    const config = loadConfig(roots, { deployments: deployed });
    assert.equal(config.wallet.deviceKeyRoots?.contracts.deviceFactory, address(4));
    assert.equal(config.wallet.deviceKeyRoots?.relayerKeyFile, "/secrets/relayer.key");
    assert.throws(() => loadConfig(roots), /not deployed/);
    const { RECOVERY_RELAYER_KEY_FILE: _r, ...noRelayer } = roots;
    assert.throws(() => loadConfig(noRelayer, { deployments: deployed }), ConfigError);
  });

  it("attestation is enabled by naming trusted apps, needs device-key roots, and has fixed policy", () => {
    const on = {
      ...roots,
      ATTESTATION_ANDROID_APPS: `app.kaada.wallet=${digest}|${"cd".repeat(32)}`,
      ATTESTATION_IOS_APP_IDS: "ABCDE12345.app.kaada.wallet",
    };
    const config = loadConfig(on, { deployments: deployed });
    assert.deepEqual(config.wallet.deviceAttestation?.androidApps, [
      { packageName: "app.kaada.wallet", signatureDigests: [digest, "cd".repeat(32)] },
    ]);
    assert.deepEqual(config.wallet.deviceAttestation?.iosAppIds, ["ABCDE12345.app.kaada.wallet"]);
    assert.equal(config.wallet.deviceAttestation?.androidMinimumLevel, "TEE");
    assert.equal(config.wallet.deviceAttestation?.challengeTtlMs, 300_000);
    assert.equal(
      config.wallet.deviceAttestation?.iosAllowDevelopment,
      true,
      "sandbox attestation outside production",
    );
    assert.equal("deviceAttestation" in loadConfig(roots, { deployments: deployed }).wallet, false);
    const { DEVICE_KEY_ROOTS_ENABLED: _d, ...noRoots } = on;
    assert.throws(() => loadConfig(noRoots, { deployments: deployed }), /DEVICE_KEY_ROOTS_ENABLED/);
  });

  it("never accepts Apple's sandbox attestation in production, whatever the environment says", () => {
    const prod = {
      ...roots,
      ...production,
      DEVICE_KEY_ROOTS_ENABLED: "true",
      ATTESTATION_IOS_APP_IDS: "ABCDE12345.app.kaada.wallet",
      ATTESTATION_IOS_ALLOW_DEVELOPMENT: "true",
    };
    const config = loadConfig(prod, { deployments: deployed });
    assert.equal(config.wallet.deviceAttestation?.iosAllowDevelopment, false);
  });

  it("rejects malformed app identities", () => {
    for (const bad of [
      "app.kaada.wallet",
      `nodots=${digest}`,
      `app.kaada.wallet=${digest.slice(1)}`,
    ]) {
      assert.throws(
        () => loadConfig({ ...roots, ATTESTATION_ANDROID_APPS: bad }, { deployments: deployed }),
        ConfigError,
        bad,
      );
    }
    assert.throws(
      () =>
        loadConfig({ ...roots, ATTESTATION_IOS_APP_IDS: "short.app" }, { deployments: deployed }),
      ConfigError,
    );
  });
});

describe("chat channels", () => {
  const secret = "s".repeat(24);

  it("has no channel unless the Telegram token and the webhook secret are both set", () => {
    assert.deepEqual(loadConfig(base).channels, {});
    assert.deepEqual(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc" }).channels, {});
    assert.equal(
      loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc" }).recovery.telegramBotToken,
      "123:abc",
    );
  });

  it("enables Telegram conversations with a token, a secret and wallets", () => {
    const config = loadConfig({
      ...kernel,
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_WEBHOOK_SECRET: secret,
    });
    assert.deepEqual(config.channels.telegram, { botToken: "123:abc", webhookSecret: secret });
  });

  it("refuses a secret without a token, a weak secret, and conversations without wallets", () => {
    assert.throws(
      () => loadConfig({ ...kernel, TELEGRAM_WEBHOOK_SECRET: secret }),
      /TELEGRAM_BOT_TOKEN/,
    );
    for (const weak of ["short", "has spaces in it 123456", "bad/chars/123456789012"]) {
      assert.throws(
        () =>
          loadConfig({ ...kernel, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: weak }),
        ConfigError,
        weak,
      );
    }
    assert.throws(
      () => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: secret }),
      /WALLET_PROVIDER=kernel/,
    );
  });

  it("treats an empty secret as unset and never echoes the token or secret in an error", () => {
    assert.deepEqual(
      loadConfig({ ...kernel, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "" })
        .channels,
      {},
    );
    try {
      loadConfig({
        ...base,
        TELEGRAM_BOT_TOKEN: "123:SECRETTOKEN",
        TELEGRAM_WEBHOOK_SECRET: secret,
      });
      assert.fail("expected a failure");
    } catch (error) {
      const message = (error as Error).message;
      assert.equal(message.includes("SECRETTOKEN"), false);
      assert.equal(message.includes(secret), false);
    }
  });
});
