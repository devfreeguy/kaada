"use client";

/**
 * Browser-side logging. Every failure is written to the console as one structured object (so it is there when someone opens the
 * developer tools) and reported to /api/client-log, which puts it in the server's log next to the request that failed.
 * Nothing sensitive is ever passed here: no token, PIN, code, key or response body. Paths are masked before they leave.
 */
type Level = "info" | "warn" | "error";

export function maskPath(path: string): string {
  return (path.split("?")[0] ?? "")
    .split("/")
    .map((segment) => (/^[A-Za-z0-9_-]{20,}$/.test(segment) ? ":token" : segment))
    .join("/");
}

export function errorFields(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message.slice(0, 300) };
  }
  return { errorName: "NonError", errorMessage: String(error).slice(0, 300) };
}

export function logClient(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  const entry = {
    event,
    level,
    page: maskPath(window.location.pathname),
    origin: window.location.origin,
    secureContext: window.isSecureContext,
    ...fields,
  };
  console[level](`[kaada] ${event}`, entry);
  if (level === "info") return;
  try {
    const body = JSON.stringify(entry);
    const queued = navigator.sendBeacon?.(
      "/api/client-log",
      new Blob([body], { type: "application/json" }),
    );
    if (!queued) {
      void fetch("/api/client-log", { method: "POST", body, keepalive: true }).catch(
        () => undefined,
      );
    }
  } catch {
    /* reporting is best effort; the console line above is already written */
  }
}

/**
 * A caught error, logged with its name and message. A person cancelling the passkey / biometric prompt (NotAllowedError,
 * AbortError) is their choice and is a warning; anything else is an error. A WebAuthn SecurityError means the page's address
 * is not valid for the server's relying-party ID; InvalidStateError means that authenticator already holds a passkey for the
 * site; NotSupportedError means the device cannot make the requested key type.
 */
export function logFailure(
  event: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  const cancelled =
    error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
  logClient(cancelled ? "warn" : "error", event, { ...errorFields(error), ...extra });
}

/** fetch, with every network failure and every non-2xx answer logged (status, the proxy's error code, the request id). */
export async function loggedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    logClient("error", "http.network_error", {
      method,
      url: maskPath(url),
      online: navigator.onLine,
      ...errorFields(error),
    });
    throw error;
  }
  if (!response.ok) {
    logClient(response.status >= 500 ? "error" : "warn", "http.request_failed", {
      method,
      url: maskPath(url),
      status: response.status,
      code: response.headers.get("x-kaada-error") ?? undefined,
      requestId: response.headers.get("x-kaada-request-id") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
    });
  }
  return response;
}
