import type { NextRequest } from "next/server";

import { describeFailure, logServer, maskPath } from "../../lib/server-log";

/**
 * The browser talks to the Kaada API through this same origin (so the page that registers a passkey and the origin the API
 * verifies are one and the same, and no CORS exception is needed). This handler replaces a plain rewrite for one reason: a
 * rewrite that cannot reach its target fails silently and leaves nothing in the logs. Here every failure is logged with the
 * exact cause, and the browser gets a machine-readable code (`x-kaada-error`) instead of an empty 500.
 *
 * Error codes:
 *   WEB_API_URL_NOT_SET     API_URL is missing in this deployment's environment variables
 *   WEB_API_URL_INVALID     API_URL is not an absolute http(s) URL
 *   API_UNREACHABLE         the request to the API threw (DNS, refused, TLS, reset); the log line has the system code
 *   API_TIMEOUT             the API did not answer within 25 seconds
 *   API_NOT_JSON            the API's address answered with a web page (a WAF/CDN challenge, a wrong host), not the API
 *   API_ERROR_<status>      the API answered with a 5xx
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 25_000;
/**
 * Only these request headers reach the API. The platform adds many of its own (Vercel's OIDC token, proxy signatures, geo and
 * routing headers); none of them is the API's business, and forwarding them would put them in the API's logs.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "origin",
  "referer",
  "x-forwarded-for",
  "x-real-ip",
]);
const SKIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

function failure(status: number, code: string, message: string, requestId: string): Response {
  return new Response(JSON.stringify({ statusCode: status, error: code, message, requestId }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-kaada-error": code,
      "x-kaada-request-id": requestId,
    },
  });
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const { path } = await context.params;
  const route = `${request.method} /api/${maskPath(path.join("/"))}`;
  const configured = process.env["API_URL"];

  if (!configured) {
    logServer("error", "proxy.api_url_not_set", {
      requestId,
      route,
      fix: "Set API_URL (for example https://api.kaada.xyz) in this deployment's environment variables and redeploy",
      vercelEnv: process.env["VERCEL_ENV"] ?? null,
    });
    return failure(
      500,
      "WEB_API_URL_NOT_SET",
      "The web app has no API address configured",
      requestId,
    );
  }

  let base: URL;
  try {
    base = new URL(configured);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error(`unsupported protocol ${base.protocol}`);
    }
  } catch (error) {
    logServer("error", "proxy.api_url_invalid", {
      requestId,
      route,
      configuredValue: configured.slice(0, 120),
      fix: "API_URL must be an absolute URL such as https://api.kaada.xyz (no trailing path)",
      ...describeFailure(error),
    });
    return failure(
      500,
      "WEB_API_URL_INVALID",
      "The web app's API address is not a valid URL",
      requestId,
    );
  }

  const target = new URL(`/api/${path.join("/")}${request.nextUrl.search}`, base);
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("x-request-id", requestId);
  // Tell the API which visitor this is (its own limits count per visitor), proven by a secret only the two share. The platform's
  // own address header is the visitor's; a client cannot set these two headers because only the allow-listed ones are forwarded.
  const proxySecret = process.env["PROXY_SHARED_SECRET"]?.trim();
  const visitor =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (proxySecret && visitor) {
    headers.set("x-kaada-client-ip", visitor);
    headers.set("x-kaada-proxy-auth", proxySecret);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : null,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    logServer("error", timedOut ? "proxy.api_timeout" : "proxy.api_unreachable", {
      requestId,
      route,
      apiHost: base.host,
      elapsedMs: Date.now() - started,
      hint: timedOut
        ? `The API at ${base.host} did not answer within ${String(TIMEOUT_MS / 1000)}s: check that the server is up and not overloaded`
        : `Could not connect to ${base.host}; the error code says why: ENOTFOUND = the DNS name does not exist, ECONNREFUSED = nothing listening or a firewall, ECONNRESET / UND_ERR_SOCKET = the connection dropped, CERT_* / ERR_TLS_* = a certificate problem`,
      ...describeFailure(error),
    });
    return timedOut
      ? failure(504, "API_TIMEOUT", "The API took too long to answer", requestId)
      : failure(502, "API_UNREACHABLE", "The web app could not connect to the API", requestId);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const elapsedMs = Date.now() - started;
  const summary = { requestId, route, apiHost: base.host, status: upstream.status, elapsedMs };

  // A web page where the API's JSON should be means the address answers, but it is not (only) the API: a WAF or CDN
  // challenge, a catch-all site, or a wrong host. The start of the body says which.
  if (!contentType.includes("json") && upstream.status !== 204 && upstream.status !== 304) {
    const body = (await upstream.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    logServer("error", "proxy.api_not_json", {
      ...summary,
      contentType,
      server: upstream.headers.get("server"),
      cfRay: upstream.headers.get("cf-ray"),
      bodyStart: body,
      hint: `${base.host} answered ${String(upstream.status)} with ${contentType || "no content type"} instead of JSON: the request is not reaching the Kaada API (a firewall / WAF / bot challenge in front of it, or API_URL points at the wrong host)`,
    });
    return failure(
      502,
      "API_NOT_JSON",
      "The API address did not return an API response",
      requestId,
    );
  }

  if (upstream.status >= 500) {
    const body = (
      await upstream
        .clone()
        .text()
        .catch(() => "")
    ).slice(0, 300);
    logServer("error", "proxy.api_error", {
      ...summary,
      bodyStart: body,
      hint: "The API itself failed; its own log (docker logs kaada-api) has the stack for this request",
    });
  } else if (upstream.status >= 400) {
    logServer("warn", "proxy.api_refused", summary);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!SKIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  });
  responseHeaders.set("x-kaada-request-id", requestId);
  if (upstream.status >= 500) {
    responseHeaders.set("x-kaada-error", `API_ERROR_${String(upstream.status)}`);
  }
  return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
