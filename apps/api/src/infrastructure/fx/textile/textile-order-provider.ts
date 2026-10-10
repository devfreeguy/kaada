import { KaadaError } from "@kaada/domain";
import type { ProviderOrderPort, ProviderOrderState, ProviderOrderStatus } from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { TextileClientError } from "./client.js";
import type { TextileClient } from "./client.js";
import type { OrderStatusResponse } from "./schemas.js";

const STATES: Record<string, ProviderOrderState> = {
  quoted: "QUOTED",
  submitted: "SUBMITTED",
  filled: "FILLED",
  failed: "FAILED",
  expired: "EXPIRED",
};

/**
 * Tells Textile about an executed order and reads how it settled. Both calls need the claim token as
 * proof of ownership; it is revealed HERE, for the length of one request, and nowhere else is it
 * decrypted. It is never logged and never part of an error.
 *
 * Textile documents `submit` as a courtesy (a fill is detected from the chain anyway), idempotent for
 * the same transaction hash, with a 409 for a different one. A failed or expired order can still flip
 * to filled for up to 24 hours, so a "not filled" status is a state to keep watching, not a verdict.
 */
export class TextileOrderProvider implements ProviderOrderPort {
  readonly id = "textile";
  private readonly log: AgentLog;

  constructor(
    private readonly options: { client: Pick<TextileClient, "submit" | "status">; log?: AgentLog },
  ) {
    this.log = options.log ?? noopLog;
  }

  async submit(input: {
    providerQuoteId: string;
    claimToken: { reveal(): string };
    txHash: string;
  }): Promise<ProviderOrderStatus> {
    try {
      const { data } = await this.options.client.submit(
        input.providerQuoteId,
        input.txHash,
        input.claimToken.reveal(),
      );
      const status =
        typeof data === "object" && data !== null && "status" in data
          ? String(data.status)
          : "submitted";
      return { state: STATES[status] ?? "SUBMITTED", txHash: input.txHash };
    } catch (error) {
      throw this.failure("submit", error);
    }
  }

  async status(input: {
    providerQuoteId: string;
    claimToken: { reveal(): string };
  }): Promise<ProviderOrderStatus> {
    try {
      const { data } = await this.options.client.status(
        input.providerQuoteId,
        input.claimToken.reveal(),
      );
      return this.map(data);
    } catch (error) {
      throw this.failure("status", error);
    }
  }

  private map(data: OrderStatusResponse["data"]): ProviderOrderStatus {
    return {
      state: STATES[data.status] ?? "UNKNOWN",
      ...(data.txHash && { txHash: data.txHash.toLowerCase() }),
      ...(data.sellAmount && { sellAmount: data.sellAmount }),
      ...(data.buyAmount && { buyAmount: data.buyAmount }),
      ...(data.feeAmount && { feeAmount: data.feeAmount }),
      ...(data.failReason && { failReason: data.failReason }),
    };
  }

  /** Never carries the token, a header or the response body. `retryable` says whether trying again is safe. */
  private failure(call: string, error: unknown): KaadaError {
    const kind = error instanceof TextileClientError ? error.kind : "UNKNOWN";
    this.log("warn", "provider_order.failed", { call, kind });
    const retryable =
      kind === "TIMEOUT" || kind === "NETWORK" || kind === "UPSTREAM" || kind === "RATE_LIMITED";
    return new KaadaError("PROVIDER_UNAVAILABLE", `the provider ${call} did not complete`, {
      details: { call, kind, retryable },
    });
  }
}
