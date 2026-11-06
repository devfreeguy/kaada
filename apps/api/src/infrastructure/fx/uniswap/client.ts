import {
  approvalResponseSchema,
  quoteResponseSchema,
  swapResponseSchema,
  uniswapErrorSchema,
} from "./schemas.js";
import type {
  UniswapApprovalResponse,
  UniswapQuoteResponse,
  UniswapSwapResponse,
} from "./schemas.js";
import { UniswapTransportError } from "./transport.js";
import type { UniswapTransport } from "./transport.js";

export type UniswapFailureKind =
  | "TIMEOUT"
  | "NETWORK"
  | "AUTH"
  | "RATE_LIMITED"
  | "NO_QUOTE"
  | "BAD_REQUEST"
  | "UNAVAILABLE"
  | "MALFORMED";

/**
 * A failed call to Uniswap, reduced to a kind.
 *
 * `detail` is the API's own `errorCode` — a short machine string such as "RequestValidationError" — and never its
 * `detail` prose, which echoes the request back. Knowing WHICH validation failed is worth keeping; knowing which
 * wallet and amount it failed for is not something a log should carry.
 */
export class UniswapClientError extends Error {
  override readonly name = "UniswapClientError";
  constructor(
    readonly kind: UniswapFailureKind,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(`Uniswap request failed: ${kind}${status === undefined ? "" : ` (${status})`}`);
  }
}

export interface UniswapQuoteParams {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  /** The fixed side, in that token's smallest unit. */
  amount: string;
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  /** The wallet the swap is for. Uniswap prices against it and writes it into the calldata. */
  swapper: string;
  /** Percent, as Uniswap counts it: 0.5 means 0.5%. Omitted, Uniswap picks its own (observed: 2.5). */
  slippagePercent?: number;
  /** Which pool versions Uniswap may route through. Omitted, it chooses freely, including ones Kaada cannot verify. */
  protocols?: readonly ("V2" | "V3" | "V4")[];
}

export interface UniswapClientOptions {
  transport: UniswapTransport;
  timeoutMs: number;
}

/**
 * The Uniswap Trading API, as far as Kaada uses it: a price, the swap calldata for that price, and the approval the
 * wallet needs before either will work.
 *
 * It requests and validates. It never signs, never sends a transaction, and never decides whether a price is
 * acceptable: the unsigned transactions it returns are handed back untouched.
 */
export class UniswapClient {
  constructor(private readonly options: UniswapClientOptions) {}

  /** A price for the pair. Read-only: nothing is reserved and no slot is held, unlike an RFQ. */
  async quote(params: UniswapQuoteParams): Promise<UniswapQuoteResponse> {
    const body = await this.call("/quote", {
      type: params.type,
      amount: params.amount,
      tokenInChainId: params.chainId,
      tokenOutChainId: params.chainId,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      swapper: params.swapper,
      ...(params.slippagePercent !== undefined && { slippageTolerance: params.slippagePercent }),
      ...(params.protocols !== undefined && { protocols: [...params.protocols] }),
    });
    return this.parse(quoteResponseSchema, body);
  }

  /**
   * The swap transaction for a quote.
   *
   * `permitData` is deliberately NOT sent. Passing it obliges us to also send a Permit2 EIP-712 signature — the API
   * rejects one without the other ("contains [permitData] without its required peers [signature]") — and Kaada's
   * executor signs UserOperations, not typed data. Omitted, the API returns calldata whose only router command is
   * V3_SWAP_EXACT_IN, which draws the input through an allowance that already exists on chain.
   */
  async swap(quote: UniswapQuoteResponse["quote"]): Promise<UniswapSwapResponse> {
    const body = await this.call("/swap", { quote });
    return this.parse(swapResponseSchema, body);
  }

  /** The approval the wallet needs, or `approval: null` when it is already in place. */
  async checkApproval(params: {
    chainId: number;
    walletAddress: string;
    token: string;
    amount: string;
  }): Promise<UniswapApprovalResponse> {
    const body = await this.call("/check_approval", {
      walletAddress: params.walletAddress,
      token: params.token,
      amount: params.amount,
      chainId: params.chainId,
    });
    return this.parse(approvalResponseSchema, body);
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    let response;
    try {
      response = await this.options.transport.post(path, body, {
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof UniswapTransportError) {
        throw new UniswapClientError(error.failure);
      }
      throw new UniswapClientError("NETWORK");
    }
    if (response.status >= 200 && response.status < 300) return response.body;
    throw new UniswapClientError(
      kindOf(response.status),
      response.status,
      errorCode(response.body),
    );
  }

  private parse<T>(
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    body: unknown,
  ): T {
    const result = schema.safeParse(body);
    if (!result.success || result.data === undefined) {
      throw new UniswapClientError("MALFORMED");
    }
    return result.data;
  }
}

function kindOf(status: number): UniswapFailureKind {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMITED";
  // No route for the pair at this size is an ordinary answer, not a fault.
  if (status === 404) return "NO_QUOTE";
  if (status >= 500) return "UNAVAILABLE";
  return "BAD_REQUEST";
}

/** The API's short error code only; its `detail` prose echoes the request and is dropped. */
function errorCode(body: unknown): string | undefined {
  const parsed = uniswapErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.errorCode : undefined;
}
