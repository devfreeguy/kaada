import { z } from "zod";

import {
  NETWORK_CHAIN_IDS,
  RECOVERY_DELAYS,
  RECOVERY_DEPLOYMENTS,
  RECOVERY_NETWORKS,
} from "./deployments.js";
import type { RecoveryContracts, RecoveryNetwork } from "./deployments.js";
import { DEFAULT_CELO_SEPOLIA_RPC_URL, NETWORK_PROFILES, WALLET_NETWORKS } from "./networks.js";
import { SETTINGS } from "./settings.js";

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

/*
 * ENVIRONMENT VARIABLES: secrets, and facts that differ per deployment. Nothing else.
 *   - tunables and policy (lifetimes, timeouts, intervals, models, public URLs)  -> settings.ts
 *   - per-network contract addresses and recovery delays                         -> deployments.ts
 * See .env.example for every variable, grouped and documented.
 */

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

/** A switch: ON only when exactly "true". Anything else (including "yes") is refused. */
const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

/** A base64 string of exactly 32 bytes, or unset. */
function isAesKey(value: string | undefined): boolean {
  return (
    value === undefined ||
    (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32)
  );
}

const envShape = {
  // ── server ──
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  WEB_URL: z.url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default(""),
  LOG_LEVEL: z.enum(logLevels).default("info"),

  // ── database and redis ──
  // Pooled runtime connection (Neon: the "-pooler" host).
  DATABASE_URL: postgresUrl,
  // Direct connection used only by the Prisma CLI for migrations; optional.
  DATABASE_DIRECT_URL: postgresUrl.optional(),
  REDIS_URL: z
    .string()
    .trim()
    .regex(/^rediss?:\/\/\S+$/, "must be a redis:// or rediss:// URL")
    .optional(),

  // ── agent and pricing ──
  AGENT_INTERPRETER: z.enum(["none", "mock", "groq"]).default("none"),
  GROQ_API_KEY: optionalSecret,
  FX_PROVIDER: z.enum(["none", "mock", "textile"]).default("none"),
  // Kaada uses Textile's LIVE environment only (Celo exists nowhere else). The test key is for the sandbox smoke script.
  TEXTILE_LIVE_API_KEY: optionalSecret,

  // ── wallets and payment authorization ──
  WALLET_PROVIDER: z.enum(["none", "kernel"]).default("none"),
  CELO_RPC_URL: z.url().default("https://forno.celo.org"),
  // Which network a person's balance (and deposit detection) is read on. Mainnet unless a development setup says otherwise;
  // a test network is refused in production. Payments and everything else stay on Celo mainnet.
  WALLET_NETWORK: z.enum(WALLET_NETWORKS).default("celo-mainnet"),
  CELO_SEPOLIA_RPC_URL: z.url().default(DEFAULT_CELO_SEPOLIA_RPC_URL),
  PASSKEY_RP_ID: optionalSecret,
  PASSKEY_ORIGIN: z.url().optional(),
  // A server-side secret mixed into every PIN hash. Required in production wallets.
  PIN_PEPPER: optionalSecret,

  // ── payment execution (can move funds) ──
  EXECUTION_ENABLED: flag,
  BUNDLER_URL: z.url().optional(),
  // The least native CELO (wei) the smart account must hold for network fees. No paymaster is used.
  EXECUTION_MIN_NATIVE_WEI: z
    .string()
    .regex(/^[1-9][0-9]{0,30}$/, "must be a positive integer in wei")
    .default("50000000000000000"),
  // AES-256-GCM key for stored claim tokens and session keys (32 random bytes, base64), with rotation.
  EXECUTION_SECRET_KEY: optionalSecret,
  EXECUTION_SECRET_KEY_VERSION: z.coerce.number().int().min(1).max(1_000_000).default(1),
  EXECUTION_SECRET_KEY_PREVIOUS: optionalSecret,

  // ── account recovery and device keys ──
  RECOVERY_ENABLED: flag,
  // Which network's contracts and delays apply (see deployments.ts).
  RECOVERY_NETWORK: z.enum(RECOVERY_NETWORKS).default("celo-mainnet"),
  // Files holding one 0x-prefixed 32-byte key each. They must not live inside the repository.
  RECOVERY_RELAYER_KEY_FILE: optionalSecret,
  // Development and tests only (production uses the KMS signer, named by RECOVERY_ATTESTOR_KMS_KEY_ID).
  RECOVERY_ATTESTOR_KEY_FILE: optionalSecret,
  RECOVERY_ATTESTOR_KMS_KEY_ID: optionalSecret,
  // Keys the email-code hash: 32 random bytes as base64.
  RECOVERY_CHALLENGE_SECRET: optionalSecret,
  // Email delivery is chosen by what is set: RECOVERY_SMTP_URL (+ FROM) = smtp, else RECOVERY_EMAIL_OUTBOX_FILE = a
  // development file outbox (refused in production), else none (recovery cannot start).
  RECOVERY_SMTP_URL: optionalSecret,
  RECOVERY_EMAIL_FROM: z.string().trim().min(3).max(200).optional(),
  RECOVERY_EMAIL_OUTBOX_FILE: optionalSecret,
  // The most native CELO (wei) the platform may send an account so a recovery or cancel is not stopped by an empty wallet.
  RECOVERY_GAS_TOPUP_MAX_WEI: z
    .string()
    .regex(/^[0-9]{1,30}$/)
    .default("0"),
  // The Telegram bot. With a token alone the bot can only SEND (recovery alerts). With the webhook secret too, people can talk
  // to Kaada in Telegram: Telegram echoes the secret in a header on every webhook call and Kaada rejects any call without it.
  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, "must be 16-256 characters of A-Z a-z 0-9 _ -")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  DEVICE_KEY_ROOTS_ENABLED: flag,
  // Device attestation is enabled by naming the apps whose keys are trusted (and needs DEVICE_KEY_ROOTS_ENABLED).
  // "package=sha256hex|sha256hex,package2=sha256hex" and "TEAMID.com.bundle.id,..."
  ATTESTATION_ANDROID_APPS: z.string().trim().min(1).optional(),
  ATTESTATION_IOS_APP_IDS: z.string().trim().min(1).optional(),
};

type Env = z.output<z.ZodObject<typeof envShape>>;

export interface LoadOptions {
  /** Tests only: the committed deployments table, replaced. Production always uses deployments.ts. */
  deployments?: Readonly<Record<RecoveryNetwork, RecoveryContracts | null>>;
}

function buildConfig(
  env: Env,
  deployments: Readonly<Record<RecoveryNetwork, RecoveryContracts | null>>,
) {
  const production = env.NODE_ENV === "production";
  const chainId = NETWORK_CHAIN_IDS[env.RECOVERY_NETWORK];
  const contracts = deployments[env.RECOVERY_NETWORK];
  const delays = RECOVERY_DELAYS[env.RECOVERY_NETWORK];

  const emailProvider: "none" | "outbox" | "smtp" = env.RECOVERY_SMTP_URL
    ? "smtp"
    : env.RECOVERY_EMAIL_OUTBOX_FILE
      ? "outbox"
      : "none";
  const androidApps = parseAndroidApps(env.ATTESTATION_ANDROID_APPS) ?? [];
  const iosAppIds = parseIosAppIds(env.ATTESTATION_IOS_APP_IDS) ?? [];
  const attestationOn = androidApps.length > 0 || iosAppIds.length > 0;
  // Production never uses a file-held attestor key; everything else (development, tests) does.
  const attestorSigner: "file" | "kms" = production ? "kms" : "file";

  const deviceKeyContracts =
    env.DEVICE_KEY_ROOTS_ENABLED && contracts && env.RECOVERY_RELAYER_KEY_FILE !== undefined
      ? { contracts, relayerKeyFile: env.RECOVERY_RELAYER_KEY_FILE }
      : undefined;

  const recoverySetup =
    env.RECOVERY_ENABLED &&
    contracts &&
    env.RECOVERY_RELAYER_KEY_FILE !== undefined &&
    env.RECOVERY_CHALLENGE_SECRET !== undefined &&
    (attestorSigner === "file"
      ? env.RECOVERY_ATTESTOR_KEY_FILE !== undefined
      : env.RECOVERY_ATTESTOR_KMS_KEY_ID !== undefined)
      ? {
          contracts: {
            validator: contracts.validator,
            passkeyFactory: contracts.passkeyFactory,
            passkeyImplementation: contracts.passkeyImplementation,
            deviceFactory: contracts.deviceFactory,
            deviceImplementation: contracts.deviceImplementation,
          },
          relayerKeyFile: env.RECOVERY_RELAYER_KEY_FILE,
          attestor:
            attestorSigner === "kms"
              ? { signer: "kms" as const, kmsKeyId: env.RECOVERY_ATTESTOR_KMS_KEY_ID ?? "" }
              : { signer: "file" as const, keyFile: env.RECOVERY_ATTESTOR_KEY_FILE ?? "" },
          challengeSecret: env.RECOVERY_CHALLENGE_SECRET,
        }
      : undefined;

  return {
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
            model: SETTINGS.agent.groq.model,
            timeoutMs: SETTINGS.agent.groq.timeoutMs,
            presentation: SETTINGS.agent.groq.presentation,
          },
        }),
    },
    chain: { network: SETTINGS.celo.network, chainId: SETTINGS.celo.chainId },
    wallet: {
      provider: env.WALLET_PROVIDER,
      rpcUrl: env.CELO_RPC_URL,
      // Where balances are read: the network, its chain id, and the RPC to read it through.
      balances: {
        ...NETWORK_PROFILES[env.WALLET_NETWORK],
        rpcUrl: env.WALLET_NETWORK === "celo-sepolia" ? env.CELO_SEPOLIA_RPC_URL : env.CELO_RPC_URL,
      },
      // The chain the validators run on (what a device key's signed payload is bound to).
      onChainId: chainId,
      ...(deviceKeyContracts && { deviceKeyRoots: deviceKeyContracts }),
      ...(env.DEVICE_KEY_ROOTS_ENABLED &&
        attestationOn && {
          deviceAttestation: {
            androidApps,
            androidMinimumLevel: SETTINGS.attestation.androidMinimumLevel,
            iosAppIds,
            // Apple's sandbox attestation is accepted everywhere EXCEPT production, by construction.
            iosAllowDevelopment: !production,
            challengeTtlMs: SETTINGS.attestation.challengeTtlSeconds * 1000,
            revocationUrl: SETTINGS.attestation.revocationUrl,
            revocationCacheMs: SETTINGS.attestation.revocationCacheSeconds * 1000,
          },
        }),
      ...(env.WALLET_PROVIDER === "kernel" &&
        env.PASSKEY_RP_ID !== undefined &&
        env.PASSKEY_ORIGIN !== undefined && {
          passkey: {
            rpId: env.PASSKEY_RP_ID,
            rpName: SETTINGS.passkey.rpName,
            origin: env.PASSKEY_ORIGIN,
          },
        }),
    },
    authorization: {
      sessionTtlMs: SETTINGS.authorization.sessionTtlSeconds * 1000,
      paymentTtlMs: SETTINGS.authorization.paymentTtlSeconds * 1000,
      ...(env.PIN_PEPPER !== undefined && { pinPepper: env.PIN_PEPPER }),
    },
    execution: {
      minFirmWindowMs: SETTINGS.execution.minFirmWindowSeconds * 1000,
      firmTimeoutMs: SETTINGS.execution.firmTimeoutMs,
      bundlerConfigured: env.BUNDLER_URL !== undefined,
      // Moving funds is a separate switch from planning a payment.
      enabled: env.EXECUTION_ENABLED,
      ...(env.BUNDLER_URL !== undefined && { bundlerUrl: env.BUNDLER_URL }),
      minNativeWei: BigInt(env.EXECUTION_MIN_NATIVE_WEI),
      pollIntervalMs: SETTINGS.execution.pollIntervalMs,
      pollMaxWaitMs: SETTINGS.execution.pollMaxWaitMs,
      reconcileIntervalMs: SETTINGS.execution.reconcileIntervalSeconds * 1000,
      maxOutstandingRfqs: SETTINGS.execution.maxOutstandingRfqs,
      // Newest first. Empty when no key is configured: firm quoting is then disabled.
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
            apiUrl: SETTINGS.textile.apiUrl,
            timeoutMs: SETTINGS.textile.timeoutMs,
          },
        }),
    },
    recovery: {
      enabled: env.RECOVERY_ENABLED,
      network: env.RECOVERY_NETWORK,
      chainId,
      delaySeconds: delays.delaySeconds,
      minDelaySeconds: delays.minDelaySeconds,
      gasTopUpMaxWei: BigInt(env.RECOVERY_GAS_TOPUP_MAX_WEI),
      sweepIntervalMs: SETTINGS.recovery.sweepIntervalSeconds * 1000,
      emailProvider,
      ...(env.RECOVERY_SMTP_URL !== undefined &&
        env.RECOVERY_EMAIL_FROM !== undefined && {
          smtp: { url: env.RECOVERY_SMTP_URL, from: env.RECOVERY_EMAIL_FROM },
        }),
      ...(env.TELEGRAM_BOT_TOKEN !== undefined && { telegramBotToken: env.TELEGRAM_BOT_TOKEN }),
      ...(env.RECOVERY_EMAIL_OUTBOX_FILE !== undefined && {
        emailOutboxFile: env.RECOVERY_EMAIL_OUTBOX_FILE,
      }),
      ...(recoverySetup && { setup: recoverySetup }),
    },
    // Chat channels people can talk to. Telegram needs both the bot token and the webhook secret.
    channels: {
      ...(env.TELEGRAM_BOT_TOKEN !== undefined &&
        env.TELEGRAM_WEBHOOK_SECRET !== undefined && {
          telegram: {
            botToken: env.TELEGRAM_BOT_TOKEN,
            webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
          },
        }),
    },
    ...(env.REDIS_URL !== undefined && {
      redis: { url: env.REDIS_URL, prefix: SETTINGS.redis.keyPrefix },
    }),
    database: {
      url: env.DATABASE_URL,
      ...(env.DATABASE_DIRECT_URL && { directUrl: env.DATABASE_DIRECT_URL }),
      poolMax: SETTINGS.database.poolMax,
      poolTimeoutMs: SETTINGS.database.poolTimeoutMs,
      transactionTimeoutMs: SETTINGS.database.transactionTimeoutMs,
    },
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Cross-field rules. Each returns the problem, or null. They run on the validated env. */
function crossChecks(
  env: Env,
  deployments: Readonly<Record<RecoveryNetwork, RecoveryContracts | null>>,
): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  const production = env.NODE_ENV === "production";
  const kernel = env.WALLET_PROVIDER === "kernel";
  const contracts = deployments[env.RECOVERY_NETWORK];
  const emailProvider = env.RECOVERY_SMTP_URL
    ? "smtp"
    : env.RECOVERY_EMAIL_OUTBOX_FILE
      ? "outbox"
      : "none";

  if (production && env.AGENT_INTERPRETER === "mock")
    add("AGENT_INTERPRETER", "the mock interpreter cannot be used in production");
  if (production && env.FX_PROVIDER === "mock")
    add("FX_PROVIDER", "the mock FX provider cannot be used in production");
  if (env.AGENT_INTERPRETER === "groq" && env.GROQ_API_KEY === undefined)
    add("GROQ_API_KEY", "GROQ_API_KEY is required when AGENT_INTERPRETER=groq");

  // Wallets and passkeys.
  if (kernel && (env.PASSKEY_RP_ID === undefined || env.PASSKEY_ORIGIN === undefined))
    add(
      "PASSKEY_ORIGIN",
      "PASSKEY_RP_ID and PASSKEY_ORIGIN are required when WALLET_PROVIDER=kernel",
    );
  if (kernel && env.PASSKEY_RP_ID && env.PASSKEY_ORIGIN) {
    const host = new URL(env.PASSKEY_ORIGIN).hostname;
    if (!(host === env.PASSKEY_RP_ID || host.endsWith(`.${env.PASSKEY_RP_ID}`)))
      add(
        "PASSKEY_ORIGIN",
        "PASSKEY_ORIGIN must be on PASSKEY_RP_ID (the same domain or a subdomain)",
      );
  }
  if (
    kernel &&
    production &&
    !(
      env.PASSKEY_ORIGIN?.startsWith("https://") === true && env.CELO_RPC_URL.startsWith("https://")
    )
  )
    add(
      "PASSKEY_ORIGIN",
      "production wallets need an https PASSKEY_ORIGIN and an https CELO_RPC_URL",
    );
  if (production && env.WALLET_NETWORK !== "celo-mainnet")
    add("WALLET_NETWORK", "production reads balances on celo-mainnet only");
  if (production && kernel && (env.PIN_PEPPER === undefined || env.PIN_PEPPER.length < 32))
    add("PIN_PEPPER", "production wallets need a PIN_PEPPER of at least 32 characters");
  if (production && (env.RECOVERY_ENABLED || kernel) && env.REDIS_URL === undefined)
    add("REDIS_URL", "production wallets and recovery need REDIS_URL for the shared rate limits");

  // Pricing.
  if (env.FX_PROVIDER === "textile") {
    if (env.TEXTILE_LIVE_API_KEY === undefined)
      add("TEXTILE_LIVE_API_KEY", "TEXTILE_LIVE_API_KEY is required when FX_PROVIDER=textile");
    else if (!env.TEXTILE_LIVE_API_KEY.startsWith("tx_live_"))
      add("TEXTILE_LIVE_API_KEY", "TEXTILE_LIVE_API_KEY must be a live Textile key (tx_live_...)");
  }

  // Secrets and execution.
  if (!isAesKey(env.EXECUTION_SECRET_KEY) || !isAesKey(env.EXECUTION_SECRET_KEY_PREVIOUS))
    add("EXECUTION_SECRET_KEY", "EXECUTION_SECRET_KEY must be 32 random bytes encoded as base64");
  if (
    production &&
    kernel &&
    env.FX_PROVIDER === "textile" &&
    env.EXECUTION_SECRET_KEY === undefined
  )
    add(
      "EXECUTION_SECRET_KEY",
      "production firm quotes need EXECUTION_SECRET_KEY to encrypt Textile claim tokens",
    );
  if (
    env.EXECUTION_ENABLED &&
    !(
      env.BUNDLER_URL !== undefined &&
      env.EXECUTION_SECRET_KEY !== undefined &&
      kernel &&
      env.FX_PROVIDER === "textile" &&
      env.PASSKEY_RP_ID !== undefined &&
      env.PASSKEY_ORIGIN !== undefined
    )
  )
    add(
      "EXECUTION_ENABLED",
      "EXECUTION_ENABLED=true needs BUNDLER_URL, EXECUTION_SECRET_KEY, WALLET_PROVIDER=kernel, FX_PROVIDER=textile and the passkey settings",
    );

  if (env.TELEGRAM_WEBHOOK_SECRET !== undefined && env.TELEGRAM_BOT_TOKEN === undefined)
    add("TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET needs TELEGRAM_BOT_TOKEN");
  if (env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_WEBHOOK_SECRET !== undefined && !kernel)
    add(
      "TELEGRAM_BOT_TOKEN",
      "talking to Kaada in Telegram needs WALLET_PROVIDER=kernel (payments need wallets)",
    );

  // Recovery, device keys, attestation.
  if (!isAesKey(env.RECOVERY_CHALLENGE_SECRET))
    add(
      "RECOVERY_CHALLENGE_SECRET",
      "RECOVERY_CHALLENGE_SECRET must be 32 random bytes encoded as base64",
    );
  if (env.RECOVERY_SMTP_URL !== undefined && !/^smtps?:\/\/\S+$/.test(env.RECOVERY_SMTP_URL))
    add("RECOVERY_SMTP_URL", "RECOVERY_SMTP_URL must be an smtp:// or smtps:// URL");
  if (env.RECOVERY_SMTP_URL !== undefined && env.RECOVERY_EMAIL_FROM === undefined)
    add("RECOVERY_EMAIL_FROM", "RECOVERY_EMAIL_FROM is required with RECOVERY_SMTP_URL");
  if (production && emailProvider === "outbox")
    add(
      "RECOVERY_EMAIL_OUTBOX_FILE",
      "the file outbox is for development; production needs RECOVERY_SMTP_URL",
    );
  if (env.RECOVERY_ENABLED) {
    const missing: string[] = [];
    if (!kernel) missing.push("WALLET_PROVIDER=kernel");
    if (env.BUNDLER_URL === undefined) missing.push("BUNDLER_URL");
    if (env.PASSKEY_RP_ID === undefined || env.PASSKEY_ORIGIN === undefined)
      missing.push("the passkey settings");
    if (env.RECOVERY_RELAYER_KEY_FILE === undefined) missing.push("RECOVERY_RELAYER_KEY_FILE");
    if (production) {
      if (env.RECOVERY_ATTESTOR_KMS_KEY_ID === undefined)
        missing.push(
          "RECOVERY_ATTESTOR_KMS_KEY_ID (production attests with a KMS/HSM signer, never a key file)",
        );
    } else if (env.RECOVERY_ATTESTOR_KEY_FILE === undefined)
      missing.push("RECOVERY_ATTESTOR_KEY_FILE");
    if (env.RECOVERY_CHALLENGE_SECRET === undefined) missing.push("RECOVERY_CHALLENGE_SECRET");
    if (emailProvider === "none")
      missing.push(
        "an email provider (RECOVERY_SMTP_URL, or RECOVERY_EMAIL_OUTBOX_FILE in development)",
      );
    if (missing.length > 0)
      add("RECOVERY_ENABLED", `RECOVERY_ENABLED=true needs ${missing.join(", ")}`);
    if (!contracts)
      add(
        "RECOVERY_NETWORK",
        `the recovery contracts are not deployed on ${env.RECOVERY_NETWORK} yet (see deployments.ts)`,
      );
  }
  if (env.DEVICE_KEY_ROOTS_ENABLED) {
    if (!kernel || env.RECOVERY_RELAYER_KEY_FILE === undefined)
      add(
        "DEVICE_KEY_ROOTS_ENABLED",
        "DEVICE_KEY_ROOTS_ENABLED=true needs WALLET_PROVIDER=kernel and RECOVERY_RELAYER_KEY_FILE",
      );
    if (!contracts)
      add(
        "RECOVERY_NETWORK",
        `the validator contracts are not deployed on ${env.RECOVERY_NETWORK} yet (see deployments.ts)`,
      );
  }
  if (parseAndroidApps(env.ATTESTATION_ANDROID_APPS) === null)
    add(
      "ATTESTATION_ANDROID_APPS",
      'ATTESTATION_ANDROID_APPS must look like "app.id=<64 hex>|<64 hex>,other.app=<64 hex>"',
    );
  if (parseIosAppIds(env.ATTESTATION_IOS_APP_IDS) === null)
    add(
      "ATTESTATION_IOS_APP_IDS",
      'ATTESTATION_IOS_APP_IDS must look like "TEAMID123.com.example.app,..."',
    );
  if (
    (env.ATTESTATION_ANDROID_APPS !== undefined || env.ATTESTATION_IOS_APP_IDS !== undefined) &&
    !env.DEVICE_KEY_ROOTS_ENABLED
  )
    add(
      "ATTESTATION_ANDROID_APPS",
      "device attestation (ATTESTATION_*_APPS) needs DEVICE_KEY_ROOTS_ENABLED=true",
    );
  return problems;
}

/** Parses and validates environment variables. Throws ConfigError listing every invalid value. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadOptions = {},
): AppConfig {
  const deployments = options.deployments ?? RECOVERY_DEPLOYMENTS;
  const result = z.object(envShape).safeParse(env);
  const problems = result.success
    ? crossChecks(result.data, deployments)
    : result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(env)",
        message: issue.message,
      }));
  if (!result.success || problems.length > 0) {
    const issues = problems.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  return buildConfig(result.data, deployments);
}

export interface AndroidAppIdentity {
  packageName: string;
  signatureDigests: string[];
}

/** "app.id=<64 hex>|<64 hex>,other.app=<64 hex>" → identities; undefined → []; malformed → null. */
export function parseAndroidApps(raw: string | undefined): AndroidAppIdentity[] | null {
  if (raw === undefined) return [];
  const apps: AndroidAppIdentity[] = [];
  for (const entry of raw.split(",")) {
    const [packageName, digests, ...extra] = entry.trim().split("=");
    if (!packageName || !digests || extra.length > 0) return null;
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) return null;
    const list = digests.split("|").map((digest) => digest.trim().toLowerCase());
    if (!list.every((digest) => /^[0-9a-f]{64}$/.test(digest))) return null;
    apps.push({ packageName, signatureDigests: list });
  }
  return apps;
}

/** "TEAMID.com.example.app,..." → App IDs; undefined → []; malformed → null. */
export function parseIosAppIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  const ids = raw.split(",").map((id) => id.trim());
  return ids.every((id) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(id)) ? ids : null;
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
 * Credentials for one explicitly chosen Textile environment, for tools such as the smoke script that are not the app. There
 * is no default environment and no fallback from one to the other: the key must exist and carry that environment's prefix
 * (tx_test_ / tx_live_). Throws ConfigError, and the message never contains the key.
 */
export function loadTextileCredentials(
  textileEnv: "test" | "live",
  env: NodeJS.ProcessEnv = process.env,
): TextileCredentials {
  const name = textileEnv === "test" ? "TEXTILE_TEST_API_KEY" : "TEXTILE_LIVE_API_KEY";
  const prefix = textileEnv === "test" ? "tx_test_" : "tx_live_";
  const result = z.object({ key: optionalSecret }).safeParse({ key: env[name] });
  if (!result.success) {
    throw new ConfigError(`Invalid Textile configuration: ${name}`);
  }
  const { key } = result.data;
  if (key === undefined) throw new ConfigError(`${name} is not set`);
  if (!key.startsWith(prefix)) throw new ConfigError(`${name} must be a ${prefix}... key`);
  return {
    env: textileEnv,
    apiKey: key,
    apiUrl: SETTINGS.textile.apiUrl,
    timeoutMs: SETTINGS.textile.timeoutMs,
  };
}
