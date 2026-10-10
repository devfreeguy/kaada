import { SecretValue, createMoney } from "@kaada/domain";
import type { FirmQuoteProvider, FirmQuoteProviderResult, FirmQuoteRequest } from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { TextileClientError } from "./client.js";
import type { TextileClient } from "./client.js";
import type { FirmResponse } from "./schemas.js";

export interface TextileFirmProviderOptions {
  client: Pick<TextileClient, "requestFirm">;
  /** Textile documents ~70 s for a firm request and recommends a 75 s client timeout. */
  timeoutMs: number;
  log?: AgentLog;
}

const lower = (value: string) => value.toLowerCase();

/**
 * The firm-quote side of Textile (`POST /v2/rfq/request`), kept apart from indicative pricing because
 * its lifecycle is different: it reserves a quote for ONE wallet, holds one of the key's outstanding
 * slots, expires within about a minute, and returns a one-time claim token.
 *
 * It requests, validates and normalizes. It never retries, never submits an order, never signs and
 * never sends a transaction: the unsigned transactions it returns are handed back untouched.
 */
export class TextileFirmQuoteProvider implements FirmQuoteProvider {
  readonly id = "textile";
  private readonly log: AgentLog;

  constructor(private readonly options: TextileFirmProviderOptions) {
    this.log = options.log ?? noopLog;
  }

  async requestFirm(request: FirmQuoteRequest): Promise<FirmQuoteProviderResult> {
    let data: FirmResponse["data"];
    try {
      ({ data } = await this.options.client.requestFirm(
        {
          chainId: request.chainId,
          sellToken: request.sellToken,
          buyToken: request.buyToken,
          taker: request.taker,
          exact:
            request.mode === "EXACT_INPUT"
              ? { mode: "EXACT_INPUT", sellAmount: request.exactAmount }
              : { mode: "EXACT_OUTPUT", buyAmount: request.exactAmount },
        },
        this.options.timeoutMs,
      ));
    } catch (error) {
      return this.failure(error);
    }

    if (data.status === "no_quote") {
      this.log("info", "firm_quote.no_quote", { reason: data.reason ?? "unspecified" });
      return {
        status: "FAILED",
        code: "NO_QUOTE",
        mayHoldSlot: false,
        ...(data.reason && { providerReason: data.reason }),
      };
    }
    return this.normalize(request, data);
  }

  private normalize(
    request: FirmQuoteRequest,
    data: Extract<FirmResponse["data"], { status: "quoted" }>,
  ): FirmQuoteProviderResult {
    // From here a quote exists at the provider, so a mismatch still holds a slot.
    const mismatch = (reason: string): FirmQuoteProviderResult => {
      this.log("warn", "firm_quote.mismatch", { reason });
      return {
        status: "FAILED",
        code: "QUOTE_MISMATCH",
        mayHoldSlot: true,
        providerReason: reason,
      };
    };
    const { quote, transactions } = data;
    const exact = BigInt(request.exactAmount);
    const takerPays = BigInt(quote.takerPays);
    const buyAmount = BigInt(quote.buyAmount);
    const fee = BigInt(quote.feeAmount);

    if (lower(quote.taker) !== lower(request.taker)) return mismatch("taker_differs");
    if (request.mode === "EXACT_INPUT" && BigInt(quote.sellAmount) !== exact) {
      return mismatch("sell_amount_differs");
    }
    if (request.mode === "EXACT_OUTPUT" && buyAmount !== exact) {
      return mismatch("buy_amount_differs");
    }
    if (takerPays === 0n || buyAmount === 0n) return mismatch("zero_amount");
    if (fee > takerPays) return mismatch("fee_exceeds_total");
    if (
      transactions.approval.chainId !== request.chainId ||
      transactions.swap.chainId !== request.chainId
    ) {
      return mismatch("transaction_chain_differs");
    }

    return {
      status: "QUOTED",
      quote: {
        provider: this.id,
        providerQuoteId: data.rfqId,
        chainId: request.chainId,
        input: createMoney(quote.takerPays, request.sellAssetId),
        output: createMoney(quote.buyAmount, request.buyAssetId),
        fee: createMoney(quote.feeAmount, request.sellAssetId),
        expiresAt: new Date(quote.expiresAt),
        ...(quote.orderDeadline && { orderDeadline: new Date(quote.orderDeadline) }),
        ...(quote.latestOrderDeadline && {
          latestOrderDeadline: new Date(quote.latestOrderDeadline),
        }),
        reactor: lower(quote.reactor),
        ...(quote.spender && { spender: lower(quote.spender) }),
        taker: lower(quote.taker),
        executionReference: data.rfqId,
        indicative: false,
      },
      transactions: {
        approval: {
          to: lower(transactions.approval.to),
          data: transactions.approval.data,
          value: transactions.approval.value,
          chainId: transactions.approval.chainId,
        },
        swap: {
          to: lower(transactions.swap.to),
          data: transactions.swap.data,
          value: transactions.swap.value,
          chainId: transactions.swap.chainId,
        },
      },
      // The one-time claim token: wrapped at once so nothing can print or serialize it by accident.
      claimToken: new SecretValue(data.claimToken),
    };
  }

  /**
   * Maps a failed call. A timeout or network error leaves it UNKNOWN whether the provider reserved a
   * quote, so it is reported as possibly holding a slot. A 429 without a Retry-After is the
   * outstanding-quote cap and is reported as capacity, never retried.
   */
  private failure(error: unknown): FirmQuoteProviderResult {
    if (!(error instanceof TextileClientError)) {
      this.log("error", "firm_quote.failed", { kind: "UNKNOWN" });
      return { status: "FAILED", code: "PROVIDER_UNAVAILABLE", mayHoldSlot: false };
    }
    this.log("warn", "firm_quote.failed", {
      kind: error.kind,
      ...(error.meta.httpStatus !== undefined && { httpStatus: error.meta.httpStatus }),
      ...(error.meta.reason && { reason: error.meta.reason }),
      ...(error.meta.requestId && { requestId: error.meta.requestId }),
    });
    const reason = error.meta.reason;
    switch (error.kind) {
      case "RATE_LIMITED":
        return { status: "FAILED", code: "PROVIDER_CAPACITY_REACHED", mayHoldSlot: false };
      case "TIMEOUT":
      case "NETWORK":
        return { status: "FAILED", code: "PROVIDER_TIMEOUT", mayHoldSlot: true };
      case "MALFORMED_RESPONSE":
        return { status: "FAILED", code: "MALFORMED_RESPONSE", mayHoldSlot: true };
      case "INVALID_REQUEST":
        return reason === "insufficient_funds"
          ? {
              status: "FAILED",
              code: "INSUFFICIENT_FUNDS_AT_PROVIDER",
              mayHoldSlot: false,
              providerReason: reason,
            }
          : {
              status: "FAILED",
              code: "PROVIDER_UNAVAILABLE",
              mayHoldSlot: false,
              ...(reason && { providerReason: reason }),
            };
      default:
        return { status: "FAILED", code: "PROVIDER_UNAVAILABLE", mayHoldSlot: false };
    }
  }
}
