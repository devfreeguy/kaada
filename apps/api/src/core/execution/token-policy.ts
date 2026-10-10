import type { TokenPolicy } from "@kaada/domain";

/**
 * ERC-20 behaviours that differ from the standard, as data about specific tokens. Execution code asks
 * the policy; it never branches on a symbol itself.
 *
 * USDT: Textile documents that USDT-style tokens may refuse to move an allowance from one non-zero
 * value to another, so a non-zero allowance is reset to zero first. This applies to the token
 * symbol "USDT" on the chains listed; extend the table (not the callers) for another token.
 */
const RESET_BEFORE_CHANGE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["USDT", new Set(["42220"])],
]);

export const defaultTokenPolicy: TokenPolicy = {
  requiresZeroResetBeforeChange: ({ chainId, symbol }) =>
    RESET_BEFORE_CHANGE.get(symbol)?.has(String(chainId)) ?? false,
};
