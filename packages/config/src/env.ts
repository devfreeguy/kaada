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
    // Wallet stack. "none" disables wallets; "kernel" is ZeroDev Kernel v3.3 with a passkey root
    // (see docs/wallet-architecture.md). No signing happens in this build either way.
    WALLET_PROVIDER: z.enum(["none", "kernel"]).default("none"),
    // Celo JSON-RPC for read-only calls (balances, address derivation). The public node works.
    CELO_RPC_URL: z.url().default("https://forno.celo.org"),
    // WebAuthn relying party: the domain passkeys are bound to, and the exact web origin allowed.
    PASSKEY_RP_ID: optionalSecret,
    PASSKEY_ORIGIN: z.url().optional(),
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
      ...(env.WALLET_PROVIDER === "kernel" &&
        env.PASSKEY_RP_ID !== undefined &&
        env.PASSKEY_ORIGIN !== undefined && {
          passkey: { rpId: env.PASSKEY_RP_ID, origin: env.PASSKEY_ORIGIN },
        }),
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
    database: {
      url: env.DATABASE_URL,
      ...(env.DATABASE_DIRECT_URL && { directUrl: env.DATABASE_DIRECT_URL }),
      poolMax: env.DATABASE_POOL_MAX,
      poolTimeoutMs: env.DATABASE_POOL_TIMEOUT_MS,
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
