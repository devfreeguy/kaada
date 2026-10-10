import type { ZodType } from "zod";

import { retryAfterMs } from "./retry-after.js";
import { firmResponseSchema, previewResponseSchema, textileErrorSchema } from "./schemas.js";
import type { FirmResponse, PreviewResponse } from "./schemas.js";
import { TextileTransportError } from "./transport.js";
import type { TextileHttpResponse, TextileTransport } from "./transport.js";

/*
 * The narrow Textile client: build the request, send it, check the status, validate the body with
 * Zod, and normalise failures. It exposes only what TextileFxProvider needs, in Kaada-neutral types;
 * no raw Textile DTO leaves this folder. It sends only RFQ price requests: there is deliberately no
 * method for submit, cancel or any order or swap operation.
 */

/** Which side the amount fixes, expressed the way Textile names it (documented). */
export type TextileExactAmount =
  { mode: "EXACT_INPUT"; sellAmount: string } | { mode: "EXACT_OUTPUT"; buyAmount: string };

export interface TextileRfqRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  exact: TextileExactAmount;
}

/** The request body. EXACT_INPUT sends `sellAmount`, EXACT_OUTPUT sends `buyAmount`; never both. */
export function rfqBody(request: TextileRfqRequest): Record<string, unknown> {
  return {
    chainId: request.chainId,
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    ...(request.exact.mode === "EXACT_INPUT"
      ? { sellAmount: request.exact.sellAmount }
      : { buyAmount: request.exact.buyAmount }),
  };
}

export type TextileFailureKind =
  | "TIMEOUT"
  | "NETWORK"
  | "RATE_LIMITED"
  | "UPSTREAM"
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "NOT_FOUND_OR_CONFLICT"
  | "MALFORMED_RESPONSE"
  | "UNEXPECTED_STATUS";

/** A normalised Textile failure. Never carries a header, a key or the raw response body. */
export class TextileClientError extends Error {
  override readonly name = "TextileClientError";
  constructor(
    readonly kind: TextileFailureKind,
    readonly meta: {
      httpStatus?: number;
      /** The stable documented error `code`, e.g. "invalid_request". */
      providerCode?: string;
      /** The documented `details.reason`, e.g. "corridor_unavailable". */
      reason?: string;
      requestId?: string;
      attempts: number;
    },
  ) {
    super(`Textile request failed: ${kind}`);
  }
}

export interface TextileCallMeta {
  attempts: number;
  httpStatus: number;
  requestId?: string;
}

export interface TextileClientOptions {
  transport: TextileTransport;
  timeoutMs: number;
  /** Extra attempts after the first for a transient failure. Default 1; never more than 2. */
  maxRetries?: number;
  /** Pause before a retry that has no Retry-After. Default 250 ms. */
  backoffMs?: number;
  /** A Retry-After longer than this is not waited for. Default 2000 ms. */
  maxRetryAfterMs?: number;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TextileClient {
  private readonly transport: TextileTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TextileClientOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = Math.min(options.maxRetries ?? 1, 2);
    this.backoffMs = options.backoffMs ?? 250;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 2000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** POST /v2/rfq/preview: an indicative price. Needs no wallet and reserves nothing. */
  preview(
    request: TextileRfqRequest,
  ): Promise<{ data: PreviewResponse["data"]; meta: TextileCallMeta }> {
    return this.call("/v2/rfq/preview", rfqBody(request), previewResponseSchema);
  }

  /**
   * POST /v2/rfq/request: a firm quote bound to `taker`. Not used by routing yet: it needs a funded
   * wallet that signs, and a live quote holds an outstanding-RFQ slot (4 per key) until its order
   * deadline, so it must not be called speculatively. Kept here, validated against the documented
   * shape, for the wallet build. Textile documents a 75 s client timeout for this call.
   */
  requestFirm(
    request: TextileRfqRequest & { taker: string },
    timeoutMs?: number,
  ): Promise<{ data: FirmResponse["data"]; meta: TextileCallMeta }> {
    return this.call(
      "/v2/rfq/request",
      { ...rfqBody(request), taker: request.taker },
      firmResponseSchema,
      timeoutMs,
    );
  }

  private async call<T extends { data: unknown }>(
    path: string,
    body: Record<string, unknown>,
    schema: ZodType<T>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ data: T["data"]; meta: TextileCallMeta }> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const canRetry = attempts <= this.maxRetries;
      let response: TextileHttpResponse;
      try {
        response = await this.transport.post(path, body, { timeoutMs });
      } catch (error) {
        const kind =
          error instanceof TextileTransportError && error.failure === "TIMEOUT"
            ? "TIMEOUT"
            : "NETWORK";
        if (canRetry) {
          await this.sleep(this.backoffMs);
          continue;
        }
        throw new TextileClientError(kind, { attempts });
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;

      if (response.status >= 200 && response.status < 300) {
        const parsed = schema.safeParse(response.body);
        // A 2xx that does not match the schema is never retried: asking again cannot fix it.
        if (!parsed.success) {
          throw new TextileClientError("MALFORMED_RESPONSE", {
            attempts,
            httpStatus: response.status,
            ...(requestId && { requestId }),
          });
        }
        return {
          data: parsed.data.data,
          meta: { attempts, httpStatus: response.status, ...(requestId && { requestId }) },
        };
      }

      const failure = this.classify(response, attempts, requestId);
      const wait = this.retryDelay(failure, response);
      if (canRetry && wait !== undefined) {
        await this.sleep(wait);
        continue;
      }
      throw failure;
    }
  }

  private classify(
    response: TextileHttpResponse,
    attempts: number,
    headerRequestId: string | undefined,
  ): TextileClientError {
    const envelope = textileErrorSchema.safeParse(response.body);
    const providerCode = envelope.success ? envelope.data.error.code : undefined;
    const reason = envelope.success ? envelope.data.error.details?.reason : undefined;
    const requestId =
      (envelope.success ? envelope.data.error.request_id : undefined) ?? headerRequestId;
    const meta = {
      attempts,
      httpStatus: response.status,
      ...(providerCode && { providerCode }),
      ...(reason && { reason }),
      ...(requestId && { requestId }),
    };
    const { status } = response;
    if (status === 429) return new TextileClientError("RATE_LIMITED", meta);
    if (status === 500 || status === 502 || status === 503) {
      return new TextileClientError("UPSTREAM", meta);
    }
    if (status === 401 || status === 403) return new TextileClientError("UNAUTHORIZED", meta);
    if (status === 400) return new TextileClientError("INVALID_REQUEST", meta);
    if (status === 404 || status === 409) {
      return new TextileClientError("NOT_FOUND_OR_CONFLICT", meta);
    }
    return new TextileClientError("UNEXPECTED_STATUS", meta);
  }

  /**
   * How long to wait before retrying, or undefined for "do not retry". Only transient failures are
   * retried: the documented transient statuses 500/502/503, and a 429 that says when to come back.
   * A 429 from the outstanding-RFQ cap has no Retry-After and is not retried.
   */
  private retryDelay(
    failure: TextileClientError,
    response: TextileHttpResponse,
  ): number | undefined {
    if (failure.kind === "UPSTREAM") return this.backoffMs;
    if (failure.kind === "RATE_LIMITED") {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      return wait !== undefined && wait <= this.maxRetryAfterMs ? wait : undefined;
    }
    return undefined;
  }
}
