import { KaadaError } from "../errors/index.js";

export function isExpired(expiresAt: Date | undefined, now: Date): boolean {
  return expiresAt !== undefined && expiresAt.getTime() <= now.getTime();
}

/** Throws QUOTE_EXPIRED for a quote (or route) whose expiry has passed. No expiry means no limit. */
export function assertNotExpired(expiresAt: Date | undefined, now: Date): void {
  if (isExpired(expiresAt, now)) {
    throw new KaadaError("QUOTE_EXPIRED", "the quote has expired");
  }
}

/** Throws SLIPPAGE_EXCEEDED when the quoted slippage is above the user limit. Absent values pass. */
export function assertSlippageWithin(
  slippageBps: number | undefined,
  maxSlippageBps: number | undefined,
): void {
  if (slippageBps !== undefined && maxSlippageBps !== undefined && slippageBps > maxSlippageBps) {
    throw new KaadaError("SLIPPAGE_EXCEEDED", "quoted slippage is above the allowed maximum", {
      details: { slippageBps, maxSlippageBps },
    });
  }
}
