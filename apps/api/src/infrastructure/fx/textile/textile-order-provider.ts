import { KaadaError } from "@kaada/domain";
import type { SettlementConfirmer, SettlementOutcome, SettlementState } from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { TextileClientError } from "./client.js";
import type { TextileClient } from "./client.js";
import type { OrderStatusResponse } from "./schemas.js";

const STATES: Record<string, SettlementState> = {
  quoted: "QUOTED",
  submitted: "SUBMITTED",
  // Textile's "filled" IS settlement for an RFQ: the maker has paid out.
  filled: "SETTLED",
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
export class TextileOrderProvider implements SettlementConfirmer {
  readonly id = "textile";
  /** An RFQ holds the order off chain, so reporting the hash to it is a documented courtesy. */
  readonly notifiesProvider = true;
  private readonly log: AgentLog;

  constructor(
    private readonly options: { client: Pick<TextileClient, "submit" | "status">; log?: AgentLog },
  ) {
    this.log = options.log ?? noopLog;
  }

  async notify(input: {
    providerQuoteId: string;
    claimToken?: { reveal(): string };
    txHash: string;
  }): Promise<SettlementOutcome> {
    // Textile cannot be asked about an order without proof of ownership of it.
    if (!input.claimToken) throw this.missingClaim("notify");
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
      throw this.failure("notify", error);
    }
  }

  async confirm(input: {
    providerQuoteId: string;
    claimToken?: { reveal(): string };
  }): Promise<SettlementOutcome> {
    if (!input.claimToken) throw this.missingClaim("confirm");
    try {
      const { data } = await this.options.client.status(
        input.providerQuoteId,
        input.claimToken.reveal(),
      );
      return this.map(data);
    } catch (error) {
      throw this.failure("confirm", error);
    }
  }

  private map(data: OrderStatusResponse["data"]): SettlementOutcome {
    return {
      state: STATES[data.status] ?? "UNKNOWN",
      ...(data.txHash && { txHash: data.txHash.toLowerCase() }),
      ...(data.sellAmount && { sellAmount: data.sellAmount }),
      ...(data.buyAmount && { buyAmount: data.buyAmount }),
      ...(data.feeAmount && { feeAmount: data.feeAmount }),
      ...(data.failReason && { failReason: data.failReason }),
    };
  }

  /**
   * A token was expected and is not there. Retryable is false: re-asking cannot conjure the secret. The
   * caller keeps the execution under reconciliation rather than failing a payment that is already on chain.
   */
  private missingClaim(call: string): KaadaError {
    this.log("warn", "settlement.claim_token_missing", { call, provider: this.id });
    return new KaadaError("PROVIDER_UNAVAILABLE", `the provider ${call} needs a claim token`, {
      details: { call, kind: "CLAIM_TOKEN_MISSING", retryable: false },
    });
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
