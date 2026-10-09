import { z } from "zod";

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

const postgresUrl = z
  .url()
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "must be a postgres:// or postgresql:// URL",
  );

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
    // Which IntentInterpreter the agent uses. "none" disables the agent.
    AGENT_INTERPRETER: z.enum(["none", "mock", "groq"]).default("none"),
    // Which price source routing uses. "none" disables pricing (the agent stops at ROUTING_REQUIRED);
    // "mock" is made-up fixture pricing for development and tests. No real provider yet.
    FX_PROVIDER: z.enum(["none", "mock"]).default("none"),
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
    fx: { provider: env.FX_PROVIDER },
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
