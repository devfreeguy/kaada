/*
 * The only place that talks HTTP to Textile. Everything above it works against this interface, so
 * tests inject fixtures and no test ever needs the network.
 */

/** A response as the client needs it: status, a header reader and the parsed JSON body (if any). */
export interface TextileHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
}

export interface TextileTransport {
  /**
   * POSTs JSON to a path under the configured base URL. Resolves for ANY HTTP status. Rejects with a
   * TextileTransportError for a timeout or a network failure.
   */
  post(path: string, body: unknown, options: { timeoutMs: number }): Promise<TextileHttpResponse>;
}

export type TextileTransportFailure = "TIMEOUT" | "NETWORK";

export class TextileTransportError extends Error {
  override readonly name = "TextileTransportError";
  constructor(readonly failure: TextileTransportFailure) {
    // A fixed message: never the URL, headers or an underlying error that could carry them.
    super(failure === "TIMEOUT" ? "Textile request timed out" : "Textile request failed");
  }
}

export interface FetchTransportOptions {
  /** Documented API host, e.g. https://api.textilecredit.com (the client adds /v2/rfq/...) */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>` (documented). Never logged or included in errors. */
  apiKey: string;
  fetch?: typeof fetch;
}

export function createFetchTransport(options: FetchTransportOptions): TextileTransport {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    async post(path, body, { timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
        } catch {
          parsed = undefined;
        }
        return { status: response.status, headers: response.headers, body: parsed };
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new TextileTransportError(aborted ? "TIMEOUT" : "NETWORK");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
