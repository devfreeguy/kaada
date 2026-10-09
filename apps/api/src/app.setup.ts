import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { AppConfig } from "@kaada/config";

/** HTTP-level setup shared by the real server and by tests. */
export function configureApp(app: NestFastifyApplication, config: AppConfig): void {
  app.setGlobalPrefix("api");
  // Unversioned by default; controllers opt in with `version: "1"` -> /api/v1/...
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL });
  app.enableCors({ origin: config.corsOrigins });
  app.enableShutdownHooks();
}
