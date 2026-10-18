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
  ) {
    super(kind);
    this.name = "ApiError";
  }
}

export async function json<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  throw new ApiError(
    response.status,
    response.status === 401
      ? "invalid"
      : response.status === 429
        ? "rate-limited"
        : response.status >= 500
          ? "unavailable"
          : "rejected",
  );
}

export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "invalid") return "This link or session has expired. Start again.";
    if (error.kind === "rate-limited") return "Too many attempts. Please wait a few minutes.";
    if (error.kind === "unavailable") return "Kaada is temporarily unavailable. Please try again.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "That was cancelled. Nothing was changed; you can try again.";
  }
  return fallback;
}
