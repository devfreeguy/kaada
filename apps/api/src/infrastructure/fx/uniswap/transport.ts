/*
 * The only place that talks HTTP to Uniswap. Everything above it works against this interface, so tests inject
 * fixtures and no test ever needs the network.
 *
 * Deliberately NOT shared with the Textile transport: Uniswap authenticates with `x-api-key` where Textile uses a
 * bearer token, and one transport serving two auth schemes is the kind of thing that sends a key to the wrong host.
 */

export interface UniswapHttpResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
}

export interface UniswapTransport {
  /**
   * POSTs JSON to a path under the configured base URL. Resolves for ANY HTTP status. Rejects with a
   * UniswapTransportError for a timeout or a network failure.
   */
  post(path: string, body: unknown, options: { timeoutMs: number }): Promise<UniswapHttpResponse>;
}

export type UniswapTransportFailure = "TIMEOUT" | "NETWORK";

export class UniswapTransportError extends Error {
  override readonly name = "UniswapTransportError";
  constructor(readonly failure: UniswapTransportFailure) {
    // A fixed message: never the URL, the headers, or an underlying error that could carry either.
    super(failure === "TIMEOUT" ? "Uniswap request timed out" : "Uniswap request failed");
  }
}

export interface UniswapFetchTransportOptions {
  /** The API root, e.g. https://trade-api.gateway.uniswap.org/v1 (the client adds /quote, /swap). */
  baseUrl: string;
  /** Sent as `x-api-key`. Never logged or included in an error. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export function createUniswapFetchTransport(
  options: UniswapFetchTransportOptions,
): UniswapTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    async post(path, body, { timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "x-api-key": options.apiKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          /*
           * Never follow a redirect. This API answers directly, so a redirect is not a normal event, and following one
           * would send the key to wherever it points: a custom header such as \`x-api-key\` is forwarded to a different
           * origin on a redirect (only \`Authorization\` is stripped). Demonstrated on this Node version, 2026-11-06.
           * With "error" the request fails instead, and the key goes nowhere.
           */
          redirect: "error",
        });
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
        } catch {
          parsed = undefined;
        }
        return { status: response.status, body: parsed };
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new UniswapTransportError(aborted ? "TIMEOUT" : "NETWORK");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
