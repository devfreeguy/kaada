import { z } from "zod";

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

const postgresUrl = z
  .url()
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "must be a postgres:// or postgresql:// URL",
  );

/** An optional secret: surrounding whitespace is trimmed and an empty value counts as unset. */
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

/** A base64 string of exactly 32 bytes, or unset. */
function isAesKey(value: string | undefined): boolean {
  return (
    value === undefined ||
    (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32)
  );
}

/** A 0x-prefixed 20-byte address. */
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

const envSchemaShape = {
  TEXTILE_API_URL: z
    .url()
    .refine((value) => !/\/v[0-9]+\/?$/.test(value), "give the host only, without /v2")
    .default("https://api.textilecredit.com"),
  TEXTILE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(80_000).default(8000),
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    WEB_URL: z.url().default("http://localhost:3000"),
    CORS_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.enum(logLevels).default("info"),
    // Pooled runtime connection (Neon: the "-pooler" host).
    DATABASE_URL: postgresUrl,
    // Direct connection used only by the Prisma CLI for migrations; optional.
    DATABASE_DIRECT_URL: postgresUrl.optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_POOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    // How long one interactive database transaction may run (Prisma's default is 5 s). Raise it only for a database that is far
    // from the API; the services keep their transactions short and never hold one across a chain or provider call.
    DATABASE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(5_000),
    // Wallet stack. "none" disables wallets; "kernel" is ZeroDev Kernel v3.3 with a passkey root
    // (see docs/wallet-architecture.md). No signing happens in this build either way.
    WALLET_PROVIDER: z.enum(["none", "kernel"]).default("none"),
    // Celo JSON-RPC for read-only calls (balances, address derivation). The public node works.
    CELO_RPC_URL: z.url().default("https://forno.celo.org"),
    // WebAuthn relying party: the domain passkeys are bound to, and the exact web origin allowed.
    PASSKEY_RP_ID: optionalSecret,
    PASSKEY_ORIGIN: z.url().optional(),
    // The name an authenticator shows for this service.
    PASSKEY_RP_NAME: z.string().trim().min(1).max(64).default("Kaada"),
    // Payment authorization. The session is the time to open the link and enter the PIN; the
    // authorization is how long an approved payment may still be executed. Both are deliberately short.
    AUTHORIZATION_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    PAYMENT_AUTHORIZATION_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(600),
    // A server-side secret mixed into every PIN hash (Argon2 "secret"). With only 10,000 possible
    // PINs, a leaked database alone must not be enough to recover them. Required in production.
    PIN_PEPPER: optionalSecret,
    // A Celo-capable ERC-4337 bundler. Required when EXECUTION_ENABLED=true: every UserOperation (account
    // deployment, permission install, approval, swap) goes through it, never through a raw transaction.
    BUNDLER_URL: z.url().optional(),
    // Build 13 can move funds. It is OFF unless this is exactly "true"; with it on, a bundler, the
    // secret key, the kernel wallet stack and Textile pricing must all be configured or startup fails.
    EXECUTION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The least native CELO (wei) the smart account must hold for network fees. No paymaster is used.
    EXECUTION_MIN_NATIVE_WEI: z
      .string()
      .regex(/^[1-9][0-9]{0,30}$/, "must be a positive integer in wei")
      .default("50000000000000000"),
    // Receipt polling inside one run; the reconciler continues anything still pending afterwards.
    EXECUTION_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
    EXECUTION_POLL_MAX_WAIT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
    // How often the reconciler looks at unfinished executions. 0 disables the timer (call it by hand).
    EXECUTION_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
    // Firm Textile quotes. The claim token Textile returns once is encrypted at rest with this key
    // (AES-256-GCM, 32 random bytes as base64). A previous key may stay for decryption after rotation.
    EXECUTION_SECRET_KEY: optionalSecret,
    EXECUTION_SECRET_KEY_VERSION: z.coerce.number().int().min(1).max(1_000_000).default(1),
    EXECUTION_SECRET_KEY_PREVIOUS: optionalSecret,
    // The least time that must remain on a firm quote before it is treated as executable.
    FIRM_QUOTE_MIN_WINDOW_SECONDS: z.coerce.number().int().min(5).max(45).default(12),
    // Textile documents ~70 s for a firm request and recommends a 75 s client timeout.
    FIRM_QUOTE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(80_000).default(75_000),
    // Textile allows 4 outstanding firm RFQs per key; Kaada counts its own to avoid avoidable 429s.
    TEXTILE_MAX_OUTSTANDING_RFQS: z.coerce.number().int().min(1).max(4).default(4),
    // Account recovery (docs/recovery-contracts.md). OFF unless exactly "true"; with it on, the recovery contracts, the
    // dedicated relayer and attestor keys (files OUTSIDE the repository), the email-challenge secret and a bundler must
    // all be configured or startup fails.
    RECOVERY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The chain the recovery contracts live on (11142220 for Celo Sepolia tests). Defaults to CELO_CHAIN_ID.
    RECOVERY_CHAIN_ID: z.coerce.number().int().min(1).optional(),
    RECOVERY_VALIDATOR_ADDRESS: evmAddress.optional(),
    RECOVERY_PASSKEY_FACTORY_ADDRESS: evmAddress.optional(),
    RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS: evmAddress.optional(),
    RECOVERY_DEVICE_FACTORY_ADDRESS: evmAddress.optional(),
    RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS: evmAddress.optional(),
    // Files holding one 0x-prefixed 32-byte key each. They must not live inside the repository.
    RECOVERY_RELAYER_KEY_FILE: optionalSecret,
    RECOVERY_ATTESTOR_KEY_FILE: optionalSecret,
    // Keys the email-code hash: 32 random bytes as base64.
    RECOVERY_CHALLENGE_SECRET: optionalSecret,
    // The delay a new recovery configuration uses, and the floor below which none may go. The contract enforces 24 h;
    // production refuses to start with a floor lower than that.
    RECOVERY_DELAY_SECONDS: z.coerce.number().int().min(1).default(259_200),
    RECOVERY_MIN_DELAY_SECONDS: z.coerce.number().int().min(1).default(86_400),
    // How recovery emails leave the system. "none" cannot send anything (recovery then refuses to start); "outbox" appends
    // each email to RECOVERY_EMAIL_OUTBOX_FILE for local runs and tests and is REFUSED in production.
    RECOVERY_EMAIL_PROVIDER: z.enum(["none", "outbox"]).default("none"),
    RECOVERY_EMAIL_OUTBOX_FILE: optionalSecret,
    // How often the recovery sweeper runs (finalize matured recoveries, reconcile, clean up). 0 disables the timer.
    RECOVERY_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
    // The most native CELO (wei) the platform may send an account so a recovery or a cancel is not stopped by an empty
    // wallet. 0 turns the sponsor off.
    RECOVERY_GAS_TOPUP_MAX_WEI: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .default("0"),
    // Device-key roots (docs/root-agnostic-flow.md): a wallet whose root is a P-256 key held by the device, for people whose
    // browser or phone has no passkeys. OFF unless exactly "true". It needs the validator factories (the RECOVERY_*
    // addresses above: they ship together) and the relayer key file that pays for the clone deployment.
    DEVICE_KEY_ROOTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Which IntentInterpreter the agent uses. "none" disables the agent.
    AGENT_INTERPRETER: z.enum(["none", "mock", "groq"]).default("none"),
    // Which price source routing uses. "none" disables pricing (the agent stops at ROUTING_REQUIRED);
    // "mock" is made-up fixture pricing for development and tests. No real provider yet.
    FX_PROVIDER: z.enum(["none", "mock", "textile"]).default("none"),
    // The blockchain Kaada settles on. Textile has no Celo testnet deployment, so only mainnet exists.
    CELO_NETWORK: z.enum(["mainnet"]).default("mainnet"),
    CELO_CHAIN_ID: z.coerce.number().int().default(42220),
    // Textile has two API ENVIRONMENTS, separate from the blockchain network. Required when
    // FX_PROVIDER=textile (no default, no fallback):
    //   live - mainnet corridors, including Celo 42220. Needs TEXTILE_LIVE_API_KEY (tx_live_...).
    //   test - ONLY BNB testnet (97) and Base Sepolia (84532); a Celo request is a 400. Kaada settles
    //          on Celo, so the app refuses this; it exists for the sandbox smoke script.
    TEXTILE_ENV: z.enum(["test", "live"]).optional(),
    TEXTILE_TEST_API_KEY: optionalSecret,
    TEXTILE_LIVE_API_KEY: optionalSecret,
    // The documented API host. The v2 paths (/v2/rfq/...) are added by the client.
    TEXTILE_API_URL: envSchemaShape.TEXTILE_API_URL,
    // Client timeout for indicative quotes. (Firm quotes can block up to about 75 s; not used yet.)
    TEXTILE_TIMEOUT_MS: envSchemaShape.TEXTILE_TIMEOUT_MS,
    // Only needed when AGENT_INTERPRETER=groq. An empty value counts as unset.
    GROQ_API_KEY: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : undefined)),
    // Must support strict structured output (json_schema).
    GROQ_MODEL: z.string().trim().min(1).default("openai/gpt-oss-20b"),
    GROQ_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8000),
  })
  .refine((env) => !(env.NODE_ENV === "production" && env.AGENT_INTERPRETER === "mock"), {
    message: "the mock interpreter cannot be used in production",
    path: ["AGENT_INTERPRETER"],
  })
  .refine((env) => !(env.NODE_ENV === "production" && env.FX_PROVIDER === "mock"), {
    message: "the mock FX provider cannot be used in production",
    path: ["FX_PROVIDER"],
  })
  .refine(
    (env) =>
      env.WALLET_PROVIDER !== "kernel" ||
      (env.PASSKEY_RP_ID !== undefined && env.PASSKEY_ORIGIN !== undefined),
    {
      message: "PASSKEY_RP_ID and PASSKEY_ORIGIN are required when WALLET_PROVIDER=kernel",
      path: ["PASSKEY_ORIGIN"],
    },
  )
  .refine(
    (env) => {
      if (env.WALLET_PROVIDER !== "kernel" || !env.PASSKEY_RP_ID || !env.PASSKEY_ORIGIN)
        return true;
      const host = new URL(env.PASSKEY_ORIGIN).hostname;
      return host === env.PASSKEY_RP_ID || host.endsWith(`.${env.PASSKEY_RP_ID}`);
    },
    {
      message: "PASSKEY_ORIGIN must be on PASSKEY_RP_ID (the same domain or a subdomain)",
      path: ["PASSKEY_ORIGIN"],
    },
  )
  .refine(
    (env) =>
      env.WALLET_PROVIDER !== "kernel" ||
      env.NODE_ENV !== "production" ||
      (env.PASSKEY_ORIGIN?.startsWith("https://") === true &&
        env.CELO_RPC_URL.startsWith("https://")),
    {
      message: "production wallets need an https PASSKEY_ORIGIN and an https CELO_RPC_URL",
      path: ["PASSKEY_ORIGIN"],
    },
  )
  .refine((env) => env.CELO_CHAIN_ID === 42220, {
    message: "CELO_CHAIN_ID must be 42220 (Celo mainnet); no other chain is supported",
    path: ["CELO_CHAIN_ID"],
  })
  .refine((env) => env.FX_PROVIDER !== "textile" || env.TEXTILE_ENV !== undefined, {
    message: "TEXTILE_ENV (test or live) is required when FX_PROVIDER=textile",
    path: ["TEXTILE_ENV"],
  })
  .refine((env) => env.FX_PROVIDER !== "textile" || env.TEXTILE_ENV !== "test", {
    message:
      "TEXTILE_ENV=test cannot quote Celo mainnet (42220): Textile's test environment only reaches chains 97 and 84532. Use TEXTILE_ENV=live",
    path: ["TEXTILE_ENV"],
  })
  .refine(
    (env) =>
      env.FX_PROVIDER !== "textile" ||
      env.TEXTILE_ENV !== "live" ||
      env.TEXTILE_LIVE_API_KEY !== undefined,
    {
      message: "TEXTILE_LIVE_API_KEY is required when TEXTILE_ENV=live",
      path: ["TEXTILE_LIVE_API_KEY"],
    },
  )
  .refine(
    (env) =>
      env.FX_PROVIDER !== "textile" ||
      env.TEXTILE_ENV !== "live" ||
      env.TEXTILE_LIVE_API_KEY === undefined ||
      env.TEXTILE_LIVE_API_KEY.startsWith("tx_live_"),
    {
      message: "TEXTILE_LIVE_API_KEY must be a live Textile key (tx_live_...)",
      path: ["TEXTILE_LIVE_API_KEY"],
    },
  )
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      env.WALLET_PROVIDER !== "kernel" ||
      (env.PIN_PEPPER !== undefined && env.PIN_PEPPER.length >= 32),
    {
      message: "production wallets need a PIN_PEPPER of at least 32 characters",
      path: ["PIN_PEPPER"],
    },
  )
  .refine(
    (env) => isAesKey(env.EXECUTION_SECRET_KEY) && isAesKey(env.EXECUTION_SECRET_KEY_PREVIOUS),
    {
      message: "EXECUTION_SECRET_KEY must be 32 random bytes encoded as base64",
      path: ["EXECUTION_SECRET_KEY"],
    },
  )
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      env.WALLET_PROVIDER !== "kernel" ||
      env.FX_PROVIDER !== "textile" ||
      env.EXECUTION_SECRET_KEY !== undefined,
    {
      message: "production firm quotes need EXECUTION_SECRET_KEY to encrypt Textile claim tokens",
      path: ["EXECUTION_SECRET_KEY"],
    },
  )
  .refine(
    (env) =>
      !env.EXECUTION_ENABLED ||
      (env.BUNDLER_URL !== undefined &&
        env.EXECUTION_SECRET_KEY !== undefined &&
        env.WALLET_PROVIDER === "kernel" &&
        env.FX_PROVIDER === "textile" &&
        env.PASSKEY_RP_ID !== undefined &&
        env.PASSKEY_ORIGIN !== undefined),
    {
      message:
        "EXECUTION_ENABLED=true needs BUNDLER_URL, EXECUTION_SECRET_KEY, WALLET_PROVIDER=kernel, FX_PROVIDER=textile and the passkey settings",
      path: ["EXECUTION_ENABLED"],
    },
  )
  .refine(
    (env) =>
      !env.RECOVERY_ENABLED ||
      (env.WALLET_PROVIDER === "kernel" &&
        env.BUNDLER_URL !== undefined &&
        env.RECOVERY_VALIDATOR_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_RELAYER_KEY_FILE !== undefined &&
        env.RECOVERY_ATTESTOR_KEY_FILE !== undefined &&
        env.RECOVERY_CHALLENGE_SECRET !== undefined &&
        env.RECOVERY_EMAIL_PROVIDER !== "none" &&
        (env.RECOVERY_EMAIL_PROVIDER !== "outbox" ||
          env.RECOVERY_EMAIL_OUTBOX_FILE !== undefined) &&
        env.PASSKEY_RP_ID !== undefined &&
        env.PASSKEY_ORIGIN !== undefined),
    {
      message:
        "RECOVERY_ENABLED=true needs WALLET_PROVIDER=kernel, BUNDLER_URL, the recovery contract addresses, the relayer and attestor key files, RECOVERY_CHALLENGE_SECRET, an email provider and the passkey settings",
      path: ["RECOVERY_ENABLED"],
    },
  )
  .refine(
    (env) =>
      !env.DEVICE_KEY_ROOTS_ENABLED ||
      (env.WALLET_PROVIDER === "kernel" &&
        env.RECOVERY_PASSKEY_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_RELAYER_KEY_FILE !== undefined),
    {
      message:
        "DEVICE_KEY_ROOTS_ENABLED=true needs WALLET_PROVIDER=kernel, the validator factory and implementation addresses and RECOVERY_RELAYER_KEY_FILE",
      path: ["DEVICE_KEY_ROOTS_ENABLED"],
    },
  )
  .refine((env) => env.NODE_ENV !== "production" || env.RECOVERY_EMAIL_PROVIDER !== "outbox", {
    message: "the file outbox is for development; production needs a real email provider",
    path: ["RECOVERY_EMAIL_PROVIDER"],
  })
  .refine((env) => isAesKey(env.RECOVERY_CHALLENGE_SECRET), {
    message: "RECOVERY_CHALLENGE_SECRET must be 32 random bytes encoded as base64",
    path: ["RECOVERY_CHALLENGE_SECRET"],
  })
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      !env.RECOVERY_ENABLED ||
      env.RECOVERY_MIN_DELAY_SECONDS >= 86_400,
    {
      message: "production recovery must keep a delay floor of at least 24 hours",
      path: ["RECOVERY_MIN_DELAY_SECONDS"],
    },
  )
  .refine((env) => env.RECOVERY_DELAY_SECONDS >= env.RECOVERY_MIN_DELAY_SECONDS, {
    message: "RECOVERY_DELAY_SECONDS may not be below RECOVERY_MIN_DELAY_SECONDS",
    path: ["RECOVERY_DELAY_SECONDS"],
  })
  .refine((env) => env.AGENT_INTERPRETER !== "groq" || env.GROQ_API_KEY !== undefined, {
    message: "GROQ_API_KEY is required when AGENT_INTERPRETER=groq",
    path: ["GROQ_API_KEY"],
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    apiHost: env.API_HOST,
    webUrl: env.WEB_URL,
    corsOrigins: parseOrigins(env.CORS_ORIGINS, env.WEB_URL),
    logLevel: env.LOG_LEVEL,
    agent: {
      interpreter: env.AGENT_INTERPRETER,
      ...(env.AGENT_INTERPRETER === "groq" &&
        env.GROQ_API_KEY !== undefined && {
          groq: {
            apiKey: env.GROQ_API_KEY,
            model: env.GROQ_MODEL,
            timeoutMs: env.GROQ_TIMEOUT_MS,
          },
        }),
    },
    chain: { network: env.CELO_NETWORK, chainId: env.CELO_CHAIN_ID },
    wallet: {
      provider: env.WALLET_PROVIDER,
      rpcUrl: env.CELO_RPC_URL,
      // The chain the validators run on (what a device key's signed payload is bound to).
      onChainId: env.RECOVERY_CHAIN_ID ?? env.CELO_CHAIN_ID,
      ...(env.DEVICE_KEY_ROOTS_ENABLED &&
        env.RECOVERY_PASSKEY_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_RELAYER_KEY_FILE !== undefined && {
          deviceKeyRoots: {
            contracts: {
              passkeyFactory: env.RECOVERY_PASSKEY_FACTORY_ADDRESS,
              passkeyImplementation: env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS,
              deviceFactory: env.RECOVERY_DEVICE_FACTORY_ADDRESS,
              deviceImplementation: env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS,
            },
            relayerKeyFile: env.RECOVERY_RELAYER_KEY_FILE,
          },
        }),
      ...(env.WALLET_PROVIDER === "kernel" &&
        env.PASSKEY_RP_ID !== undefined &&
        env.PASSKEY_ORIGIN !== undefined && {
          passkey: {
            rpId: env.PASSKEY_RP_ID,
            rpName: env.PASSKEY_RP_NAME,
            origin: env.PASSKEY_ORIGIN,
          },
        }),
    },
    authorization: {
      sessionTtlMs: env.AUTHORIZATION_SESSION_TTL_SECONDS * 1000,
      paymentTtlMs: env.PAYMENT_AUTHORIZATION_TTL_SECONDS * 1000,
      ...(env.PIN_PEPPER !== undefined && { pinPepper: env.PIN_PEPPER }),
    },
    execution: {
      minFirmWindowMs: env.FIRM_QUOTE_MIN_WINDOW_SECONDS * 1000,
      firmTimeoutMs: env.FIRM_QUOTE_TIMEOUT_MS,
      bundlerConfigured: env.BUNDLER_URL !== undefined,
      // Build 13: moving funds is a separate switch from planning one.
      enabled: env.EXECUTION_ENABLED,
      ...(env.BUNDLER_URL !== undefined && { bundlerUrl: env.BUNDLER_URL }),
      minNativeWei: BigInt(env.EXECUTION_MIN_NATIVE_WEI),
      pollIntervalMs: env.EXECUTION_POLL_INTERVAL_MS,
      pollMaxWaitMs: env.EXECUTION_POLL_MAX_WAIT_MS,
      reconcileIntervalMs: env.EXECUTION_RECONCILE_INTERVAL_SECONDS * 1000,
      maxOutstandingRfqs: env.TEXTILE_MAX_OUTSTANDING_RFQS,
      // Newest first. Absent when no key is configured: firm quoting is then disabled.
      cipherKeys: [
        ...(env.EXECUTION_SECRET_KEY
          ? [{ version: env.EXECUTION_SECRET_KEY_VERSION, key: env.EXECUTION_SECRET_KEY }]
          : []),
        ...(env.EXECUTION_SECRET_KEY_PREVIOUS && env.EXECUTION_SECRET_KEY_VERSION > 1
          ? [
              {
                version: env.EXECUTION_SECRET_KEY_VERSION - 1,
                key: env.EXECUTION_SECRET_KEY_PREVIOUS,
              },
            ]
          : []),
      ],
    },
    fx: {
      provider: env.FX_PROVIDER,
      ...(env.FX_PROVIDER === "textile" &&
        env.TEXTILE_LIVE_API_KEY !== undefined && {
          textile: {
            env: "live" as const,
            apiKey: env.TEXTILE_LIVE_API_KEY,
            apiUrl: env.TEXTILE_API_URL,
            timeoutMs: env.TEXTILE_TIMEOUT_MS,
          },
        }),
    },
    recovery: {
      enabled: env.RECOVERY_ENABLED,
      chainId: env.RECOVERY_CHAIN_ID ?? env.CELO_CHAIN_ID,
      delaySeconds: env.RECOVERY_DELAY_SECONDS,
      minDelaySeconds: env.RECOVERY_MIN_DELAY_SECONDS,
      gasTopUpMaxWei: BigInt(env.RECOVERY_GAS_TOPUP_MAX_WEI),
      sweepIntervalMs: env.RECOVERY_SWEEP_INTERVAL_SECONDS * 1000,
      emailProvider: env.RECOVERY_EMAIL_PROVIDER,
      ...(env.RECOVERY_EMAIL_OUTBOX_FILE !== undefined && {
        emailOutboxFile: env.RECOVERY_EMAIL_OUTBOX_FILE,
      }),
      ...(env.RECOVERY_ENABLED &&
        env.RECOVERY_VALIDATOR_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_FACTORY_ADDRESS !== undefined &&
        env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS !== undefined &&
        env.RECOVERY_RELAYER_KEY_FILE !== undefined &&
        env.RECOVERY_ATTESTOR_KEY_FILE !== undefined &&
        env.RECOVERY_CHALLENGE_SECRET !== undefined && {
          setup: {
            contracts: {
              validator: env.RECOVERY_VALIDATOR_ADDRESS,
              passkeyFactory: env.RECOVERY_PASSKEY_FACTORY_ADDRESS,
              passkeyImplementation: env.RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS,
              deviceFactory: env.RECOVERY_DEVICE_FACTORY_ADDRESS,
              deviceImplementation: env.RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS,
            },
            relayerKeyFile: env.RECOVERY_RELAYER_KEY_FILE,
            attestorKeyFile: env.RECOVERY_ATTESTOR_KEY_FILE,
            challengeSecret: env.RECOVERY_CHALLENGE_SECRET,
          },
        }),
    },
    database: {
      url: env.DATABASE_URL,
      ...(env.DATABASE_DIRECT_URL && { directUrl: env.DATABASE_DIRECT_URL }),
      poolMax: env.DATABASE_POOL_MAX,
      poolTimeoutMs: env.DATABASE_POOL_TIMEOUT_MS,
      transactionTimeoutMs: env.DATABASE_TRANSACTION_TIMEOUT_MS,
    },
  }));

export type AppConfig = z.output<typeof envSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parses and validates environment variables. Throws ConfigError listing every invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

function parseOrigins(raw: string, fallback: string): string[] {
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : [fallback];
}

export interface TextileCredentials {
  env: "test" | "live";
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
}

/**
 * Credentials for one explicitly chosen Textile environment, for tools such as the smoke script that
 * are not the app. There is no default environment and no fallback from one to the other: the key
 * must exist and carry that environment's prefix (tx_test_ / tx_live_). Throws ConfigError, and the
 * message never contains the key.
 */
export function loadTextileCredentials(
  textileEnv: "test" | "live",
  env: NodeJS.ProcessEnv = process.env,
): TextileCredentials {
  const name = textileEnv === "test" ? "TEXTILE_TEST_API_KEY" : "TEXTILE_LIVE_API_KEY";
  const prefix = textileEnv === "test" ? "tx_test_" : "tx_live_";
  const result = z
    .object({
      key: optionalSecret,
      url: envSchemaShape.TEXTILE_API_URL,
      timeout: envSchemaShape.TEXTILE_TIMEOUT_MS,
    })
    .safeParse({
      key: env[name],
      url: env["TEXTILE_API_URL"],
      timeout: env["TEXTILE_TIMEOUT_MS"],
    });
  if (!result.success) {
    throw new ConfigError(
      `Invalid Textile configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const { key, url, timeout } = result.data;
  if (key === undefined) throw new ConfigError(`${name} is not set`);
  if (!key.startsWith(prefix)) throw new ConfigError(`${name} must be a ${prefix}... key`);
  return { env: textileEnv, apiKey: key, apiUrl: url, timeoutMs: timeout };
}
