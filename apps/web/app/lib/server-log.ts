/**
 * Server-side logging for the web app (route handlers, instrumentation). One JSON object per line on stdout/stderr, which is
 * what Vercel's log viewer indexes: filter on `event`, `level` or `requestId`. Never pass a token, a header or a request body.
 */
export type LogLevel = "info" | "warn" | "error";

export function logServer(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** name, message, platform code and (one level of) cause of anything thrown: the words that say what actually went wrong. */
export function describeFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: "NonError", errorMessage: String(error).slice(0, 300) };
  }
  const code = (error as { code?: unknown }).code;
  const cause = error.cause;
  const causeCode = (cause as { code?: unknown } | undefined)?.code;
  return {
    errorName: error.name,
    errorMessage: error.message.slice(0, 300),
    ...(typeof code === "string" && { errorCode: code }),
    ...(cause instanceof Error && {
      causeName: cause.name,
      causeMessage: cause.message.slice(0, 300),
      ...(typeof causeCode === "string" && { causeCode }),
    }),
  };
}

/** A path that is safe to log: long opaque segments are one-time tokens (setup, authorize, recovery links) and are masked. */
export function maskPath(path: string): string {
  return (path.split("?")[0] ?? "")
    .split("/")
    .map((segment) => (/^[A-Za-z0-9_-]{20,}$/.test(segment) ? ":token" : segment))
    .join("/");
}
