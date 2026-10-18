/**
 * One line naming a failure: "TypeError: message (code=ECONNREFUSED)". For a log message that must point at the exact problem.
 * The message is the library's or the platform's own words, so it is bounded and never includes request bodies or headers.
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return `non-error thrown: ${String(error).slice(0, 300)}`;
  const code = (error as { code?: unknown }).code;
  const cause =
    error.cause instanceof Error ? ` <- caused by ${error.cause.name}: ${error.cause.message}` : "";
  return `${error.name}: ${error.message.slice(0, 300)}${typeof code === "string" ? ` (code=${code})` : ""}${cause.slice(0, 400)}`;
}
