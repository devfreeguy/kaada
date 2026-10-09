import { fileURLToPath } from "node:url";

import { pino } from "pino";
import type { Logger, LoggerOptions } from "pino";

export interface LoggerConfig {
  level: string;
  /** Human-readable output instead of JSON. Intended for local development only. */
  pretty?: boolean;
}

const sensitiveKeys = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "clientSecret",
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "privateKey",
  "mnemonic",
];

/** Request/response header paths plus sensitive keys at the top level and one level deep. */
export const redactPaths: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...sensitiveKeys.flatMap((key) => [key, `*.${key}`]),
];

export function createLoggerOptions({ level, pretty = false }: LoggerConfig): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    ...(pretty && {
      transport: {
        target: fileURLToPath(import.meta.resolve("pino-pretty")),
        options: { colorize: true, singleLine: true, translateTime: "SYS:HH:MM:ss.l" },
      },
    }),
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(createLoggerOptions(config));
}
