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
    if (error.code === "INVALID_PIN") return "That PIN is incorrect. Please try again.";
    if (error.code === "PIN_LOCKED" || error.status === 423)
      return "Too many wrong PIN attempts. Please try again later.";
    if (error.code === "PIN_NOT_SET") return "Create your payment PIN before continuing.";
    if (error.code === "GAS_ESTIMATE_UNAVAILABLE")
      return "We can't finish securing your account right now. Please try again in a few minutes.";
    if (error.code === "GAS_FUNDING_REQUIRED")
      return "To finish securing your account, add a small amount of CELO to your wallet.";
    if (error.code === "SPONSORSHIP_UNAVAILABLE")
      return "To finish securing your account, add a small amount of CELO to your wallet, or deposit a larger amount.";
    if (error.code === "PIN_RESET_REQUIRED")
      return "Your PIN needs to be reset through account recovery.";
    if (error.kind === "invalid") return "This link or session has expired. Start again.";
    if (error.kind === "rate-limited") return "Too many attempts. Please wait a few minutes.";
    if (error.kind === "unavailable") return "Kaada is temporarily unavailable. Please try again.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "That was cancelled. Nothing was changed; you can try again.";
  }
  if (error instanceof Error && error.name === "SecurityError")
    return "Open this link on the Kaada address it was sent for, in a supported browser.";
  if (error instanceof Error && error.name === "NotSupportedError")
    return "This device cannot create that credential. Try another supported device.";
  if (error instanceof Error && error.name === "InvalidStateError")
    return "This device already has that passkey. Try a different authenticator.";
  return fallback;
}
