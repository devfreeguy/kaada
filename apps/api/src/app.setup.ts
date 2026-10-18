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

  // Behind a proxy or a CDN (a development tunnel, a load balancer), a POST that has no body can reach us as an empty CHUNKED
  // request with no content type, which Fastify refuses with 415 before any handler runs. That broke every bodiless POST of the
  // web app (for example the first passkey step) the moment it was served through a tunnel. A request that declares no content
  // type carries no usable body, so it is handled as a bodiless request. A request that DOES declare a content type is untouched:
  // an unsupported one (application/xml, say) is still refused with 415.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", (request, _reply, done) => {
      // Routing rewrites the raw request's url; keep the one the client sent for the access log.
      (request.raw as { originalUrl?: string }).originalUrl ??= request.raw.url ?? "";
      const headers = request.raw.headers;
      if (headers["content-type"] === undefined && headers["transfer-encoding"] !== undefined) {
        delete headers["transfer-encoding"];
      }
      done();
    });
}
