/**
 * What is safe to log about a failure from a channel provider: its name, message and (when the provider's client attaches them)
 * the method, HTTP status and Telegram-style description. Never the request URL (a bot token lives in it), never headers.
 */
export interface ErrorDetails {
  error: string;
  message?: string;
  method?: string;
  status?: number;
  description?: string;
  retryAfter?: number;
}

export function errorDetails(error: unknown): ErrorDetails {
  if (!(error instanceof Error)) return { error: "unknown" };
  const fields = error as unknown as Record<string, unknown>;
  return {
    error: error.name,
    message: error.message.slice(0, 200),
    ...(typeof fields["method"] === "string" && { method: fields["method"] }),
    ...(typeof fields["status"] === "number" && { status: fields["status"] }),
    ...(typeof fields["description"] === "string" && { description: fields["description"] }),
    ...(typeof fields["retryAfter"] === "number" && { retryAfter: fields["retryAfter"] }),
  };
}

/**
 * A provider refusal that will be refused again however often it is retried (bad request, bot blocked, chat gone). Rate limits
 * (429) and server errors are not permanent.
 */
export function isPermanentProviderError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    error instanceof Error &&
    error.name === "TelegramApiError" &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 429 &&
    status !== 408
  );
}
