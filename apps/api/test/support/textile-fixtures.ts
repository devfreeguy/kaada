import type {
  TextileHttpResponse,
  TextileTransport,
} from "../../src/infrastructure/fx/textile/index.js";
import { TextileTransportError } from "../../src/infrastructure/fx/textile/index.js";

/*
 * TEST FIXTURES, NOT CAPTURED LIVE RESPONSES.
 *
 * Everything here is hand-written to match the field names and shapes documented at
 * https://fx-docs.textilecredit.com/api/v2/rfq.html and /api/v2/errors.html. The numbers are made up
 * and say nothing about Textile's real prices, fees or behaviour. When live responses are captured
 * (Build 9B), they replace these.
 */

export interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  headers?: Record<string, string>;
}

export type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throws: "TIMEOUT" | "NETWORK" };

/** A transport that plays back scripted replies and records every call. No network. */
export class FakeTextileTransport implements TextileTransport {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Reply[];

  constructor(
    replies: Reply[],
    /** Used when the queue is empty. */
    private readonly fallback?: (call: RecordedCall) => Reply,
  ) {
    this.queue = [...replies];
  }

  /** Adds a scripted reply after construction (a reply that depends on the test clock). */
  enqueue(reply: Reply): void {
    this.queue.push(reply);
  }

  get(
    path: string,
    options: { timeoutMs: number; headers?: Record<string, string> },
  ): Promise<TextileHttpResponse> {
    return this.post(path, undefined, options);
  }

  post(
    path: string,
    body: unknown,
    options: { timeoutMs: number; headers?: Record<string, string> },
  ): Promise<TextileHttpResponse> {
    const call: RecordedCall = {
      path,
      body: body as Record<string, unknown>,
      timeoutMs: options.timeoutMs,
      ...(options.headers && { headers: options.headers }),
    };
    this.calls.push(call);
    const reply = this.queue.shift() ?? this.fallback?.(call);
    if (!reply) return Promise.reject(new Error("FakeTextileTransport: no reply scripted"));
    if ("throws" in reply) return Promise.reject(new TextileTransportError(reply.throws));
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return Promise.resolve({
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: reply.body,
    });
  }
}

/** A documented-shape preview response (made-up numbers). */
export const previewReply = (fields: {
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  takerPays: string;
  rateRay?: string;
}): Reply => ({
  status: 200,
  headers: { "x-request-id": "req_fixture_1" },
  body: { data: { status: "preview", ...fields } },
});

export const noQuoteReply = (reason = "no_valid_quote"): Reply => ({
  status: 200,
  body: { data: { status: "no_quote", reason } },
});

/** A documented-shape error envelope. */
export const errorReply = (
  status: number,
  code: string,
  details?: { reason: string },
  headers: Record<string, string> = {},
): Reply => ({
  status,
  headers: { "x-request-id": "req_fixture_err", ...headers },
  body: {
    error: {
      code,
      message: "fixture message",
      request_id: "req_fixture_err",
      ...(details && { details }),
    },
  },
});

/**
 * A fixture price engine for the routing tests: charges ceil(1 bps) of the sell amount as the fee
 * (contained in takerPays) and applies an invented per-pair multiplier. Keyed by token address.
 */
export function pricingFixture(
  rates: Record<
    string,
    { numerator: bigint; denominator: bigint; sellDecimals: number; buyDecimals: number }
  >,
): (call: RecordedCall) => Reply {
  return (call) => {
    const body = call.body;
    const key = `${String(body["sellToken"])}>${String(body["buyToken"])}`;
    const rate = rates[key];
    if (!rate) return errorReply(400, "invalid_request", { reason: "corridor_unavailable" });
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const scale = (value: bigint, from: number, to: number) =>
      to >= from ? value * 10n ** BigInt(to - from) : value / 10n ** BigInt(from - to);
    if (typeof body["sellAmount"] === "string") {
      const sell = BigInt(body["sellAmount"]);
      const fee = ceilDiv(sell, 10_000n);
      const buy = scale(
        ((sell - fee) * rate.numerator) / rate.denominator,
        rate.sellDecimals,
        rate.buyDecimals,
      );
      return previewReply({
        sellAmount: sell.toString(),
        buyAmount: buy.toString(),
        feeAmount: fee.toString(),
        takerPays: sell.toString(),
      });
    }
    const buy = BigInt(String(body["buyAmount"]));
    const netSell = scale(
      ceilDiv(buy * rate.denominator, rate.numerator),
      rate.buyDecimals,
      rate.sellDecimals,
    );
    const takerPays = ceilDiv(netSell * 10_000n, 9_999n);
    const fee = ceilDiv(takerPays, 10_000n);
    return previewReply({
      sellAmount: takerPays.toString(),
      buyAmount: buy.toString(),
      feeAmount: fee.toString(),
      takerPays: takerPays.toString(),
    });
  };
}
