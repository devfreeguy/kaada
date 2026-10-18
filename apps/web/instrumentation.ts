import type { Instrumentation } from "next";

import { describeFailure, logServer, maskPath } from "./app/lib/server-log";

/**
 * Runs once when a server instance starts. It reports how this deployment is configured (no secret), and says plainly when
 * something the app cannot work without is missing, so a bad deployment is visible in the log before anyone opens a page.
 */
export function register(): void {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const configured = process.env["API_URL"];
  const vercelEnv = process.env["VERCEL_ENV"] ?? null;

  if (!configured) {
    logServer("error", "web.config_api_url_missing", {
      vercelEnv,
      fix: "Set API_URL (for example https://api.kaada.xyz) in this deployment's environment variables, for the environment named in vercelEnv, then redeploy. Every call to the API fails until then",
    });
    return;
  }
  try {
    const url = new URL(configured);
    logServer("info", "web.started", {
      vercelEnv,
      apiHost: url.host,
      apiProtocol: url.protocol,
      ...(url.pathname !== "/" && {
        warning: `API_URL has the path "${url.pathname}": it should be only the origin, such as https://api.kaada.xyz`,
      }),
      ...(url.protocol === "http:" &&
        vercelEnv === "production" && {
          warning: "API_URL is plain http in production: the API address should be https",
        }),
    });
  } catch (error) {
    logServer("error", "web.config_api_url_invalid", {
      vercelEnv,
      configuredValue: configured.slice(0, 120),
      fix: "API_URL must be an absolute URL such as https://api.kaada.xyz",
      ...describeFailure(error),
    });
  }
}

/** Every error Next catches while serving a request (a page that failed to render, a route handler that threw). */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : undefined;
  logServer("error", "web.request_error", {
    method: request.method,
    path: maskPath(request.path),
    route: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
    digest,
    ...describeFailure(error),
  });
};
