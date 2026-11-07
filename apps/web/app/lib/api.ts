import { LINK_UNAVAILABLE, failureCopy } from "./app-copy";
import { loggedFetch } from "./client-log";

/** One way to call the Kaada API from the browser: same origin, never cached, the token only ever in a header. */
export async function api(
  path: string,
  token: string | null,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<Response> {
  return loggedFetch(`/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    cache: "no-store",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** A failed call, reduced to what a person may be told. The server's wording is never echoed back. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: "invalid" | "rate-limited" | "rejected" | "unavailable",
    readonly code?: string,
  ) {
    super(kind);
    this.name = "ApiError";
  }
}

export async function json<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const payload: unknown = await response.json().catch(() => null);
  const code =
    payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : undefined;
  throw new ApiError(
    response.status,
    response.status === 401 && code !== "INVALID_PIN"
      ? "invalid"
      : response.status === 429
        ? "rate-limited"
        : response.status >= 500
          ? "unavailable"
          : "rejected",
    code,
  );
}

export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "INVALID_PIN") return failureCopy.wrongPin();
    if (error.code === "PIN_LOCKED" || error.status === 423) return failureCopy.locked;
    if (error.code === "PIN_NOT_SET") return failureCopy.pinNotSet;
    if (error.code === "GAS_ESTIMATE_UNAVAILABLE")
      return "We can't confirm the network fee right now. Try again in a few minutes.";
    if (error.code === "GAS_FUNDING_REQUIRED")
      return "Your wallet needs a little CELO for the network fee.";
    if (error.code === "SPONSORSHIP_UNAVAILABLE")
      return "Your wallet needs a little CELO for the network fee. Add some, or deposit a larger amount.";
    if (error.code === "PIN_RESET_REQUIRED") return failureCopy.pinResetRequired;
    if (error.kind === "invalid") return LINK_UNAVAILABLE;
    if (error.kind === "rate-limited") return "Too many attempts. Please wait a few minutes.";
    if (error.kind === "unavailable") return "Kaada is temporarily unavailable. Please try again.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return failureCopy.cancelled;
  }
  if (error instanceof Error && error.name === "SecurityError")
    return "Open this link on the Kaada address it was sent for, in a supported browser.";
  if (error instanceof Error && error.name === "NotSupportedError")
    return "This device can't create that passkey or key. Try another device.";
  if (error instanceof Error && error.name === "InvalidStateError")
    return "This device already has that passkey. Try a different authenticator.";
  return fallback;
}
