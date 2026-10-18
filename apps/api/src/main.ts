import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { AppConfig } from "@kaada/config";
import { createLogger } from "@kaada/logger";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { APP_CONFIG } from "./config/config.module.js";

// Repo-root .env is optional; real environment variables always win.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/** Used before the application logger exists, and for faults that escape it. Always JSON on stdout. */
const fallbackLog = createLogger({ level: process.env["LOG_LEVEL"] ?? "info" });

// A fault nobody caught must leave a trace that names it; the process then exits so the supervisor restarts a clean one.
process.on("unhandledRejection", (reason) => {
  fallbackLog.error(
    {
      event: "process.unhandled_rejection",
      err: reason instanceof Error ? reason : new Error(String(reason)),
    },
    `an unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
});
process.on("uncaughtException", (error) => {
  fallbackLog.fatal(
    { event: "process.uncaught_exception", err: error },
    `an uncaught exception, shutting down: ${error.message}`,
  );
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));
  configureApp(app, config);

  await app.listen(config.port, config.apiHost);

  // What this instance is actually configured to do, with no secret in it. A web page that cannot reach or verify against
  // this API is almost always a mismatch between these values and the web host's, so they are the first thing to read.
  const passkey = config.wallet.passkey;
  fallbackLog.info(
    {
      event: "app.started",
      nodeEnv: config.nodeEnv,
      listening: `${config.apiHost}:${String(config.port)}`,
      webUrl: config.webUrl,
      corsOrigins: config.corsOrigins,
      passkeyRpId: passkey?.rpId ?? null,
      passkeyOrigin: passkey?.origin ?? null,
      walletProvider: config.wallet.provider,
      executionEnabled: config.execution.enabled,
    },
    "Kaada API started",
  );
  warnOnMisconfiguration(config);
}

/** Problems that do not stop the server from starting but will break a user's flow. Each one says exactly what to change. */
function warnOnMisconfiguration(config: AppConfig): void {
  const passkey = config.wallet.passkey;
  if (config.nodeEnv === "production") {
    if (!config.webUrl.startsWith("https://")) {
      fallbackLog.warn(
        { event: "config.web_url_not_https", webUrl: config.webUrl },
        "WEB_URL is not https in production: the setup and authorization links sent to people will not work in a browser",
      );
    }
    if (/localhost|127.0.0.1|trycloudflare.com/.test(config.webUrl)) {
      fallbackLog.warn(
        { event: "config.web_url_is_development", webUrl: config.webUrl },
        "WEB_URL points at localhost or a development tunnel in production: set it to the deployed web app's address",
      );
    }
  }
  if (passkey) {
    let originHost = "";
    try {
      originHost = new URL(passkey.origin).hostname;
    } catch {
      fallbackLog.warn(
        { event: "config.passkey_origin_invalid", passkeyOrigin: passkey.origin },
        "PASSKEY_ORIGIN is not a valid URL: every passkey registration will be rejected",
      );
    }
    if (originHost && originHost !== passkey.rpId && !originHost.endsWith(`.${passkey.rpId}`)) {
      fallbackLog.warn(
        {
          event: "config.passkey_rp_id_mismatch",
          passkeyRpId: passkey.rpId,
          passkeyOrigin: passkey.origin,
        },
        `PASSKEY_RP_ID (${passkey.rpId}) must be the host of PASSKEY_ORIGIN (${originHost}) or a parent domain of it: every passkey registration will be rejected`,
      );
    }
    let webHost = "";
    try {
      webHost = new URL(config.webUrl).hostname;
    } catch {
      /* WEB_URL is validated at startup; nothing more to say here */
    }
    if (webHost && originHost && webHost !== originHost) {
      fallbackLog.warn(
        {
          event: "config.passkey_origin_differs_from_web_url",
          webUrl: config.webUrl,
          passkeyOrigin: passkey.origin,
        },
        "PASSKEY_ORIGIN and WEB_URL are on different hosts: people open links on WEB_URL, so passkeys created there will not verify against PASSKEY_ORIGIN",
      );
    }
  }
}

bootstrap().catch((error: unknown) => {
  fallbackLog.fatal(
    { event: "app.start_failed", err: error instanceof Error ? error : new Error(String(error)) },
    `Kaada API failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
