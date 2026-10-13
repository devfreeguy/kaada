import { KaadaError } from "@kaada/domain";

import { BalanceReadError } from "../agent/agent-service.js";

/**
 * Names why a read failed, without ever exposing a URL or key: a token that cannot be read on this chain, an RPC that did not
 * answer, or something else. The wording the person sees stays friendly; the log carries the reason.
 */
export function classifyBalanceFailure(error: unknown): BalanceReadError {
  if (error instanceof BalanceReadError) return error;
  if (error instanceof KaadaError) {
    if (error.code === "ASSET_NOT_SUPPORTED" || error.code === "ASSET_MISMATCH") {
      const symbol = error.details?.["symbol"];
      return new BalanceReadError(
        "ASSET_UNSUPPORTED",
        typeof symbol === "string" ? symbol : error.code,
        {
          cause: error,
        },
      );
    }
    if (error.code === "WALLET_NOT_ACTIVE")
      return new BalanceReadError("WALLET_NOT_READY", undefined, { cause: error });
  }
  const text = `${error instanceof Error ? error.name : ""} ${error instanceof Error ? error.message : ""}`;
  if (/HttpRequest|Timeout|RpcRequest|RpcError|fetch failed|ECONN|ENOTFOUND|socket/i.test(text)) {
    return new BalanceReadError(
      "RPC_UNAVAILABLE",
      error instanceof Error ? error.name : undefined,
      { cause: error },
    );
  }
  return new BalanceReadError(
    "BALANCE_UNAVAILABLE",
    error instanceof Error ? error.name : undefined,
    { cause: error },
  );
}
