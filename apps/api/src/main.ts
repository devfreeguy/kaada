import "reflect-metadata";

import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { AppConfig } from "@kaada/config";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { APP_CONFIG } from "./config/config.module.js";

// Repo-root .env is optional; real environment variables always win.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix("api");
  // Unversioned by default; controllers opt in with `version: "1"` → /api/v1/...
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL });
  app.enableCors({ origin: config.corsOrigins });
  app.enableShutdownHooks();

  await app.listen(config.port, config.apiHost);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
