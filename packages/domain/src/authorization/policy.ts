import type { Money } from "../money/index.js";
import { boundLimits } from "./payment-authorization.js";
import type { PaymentAuthorization } from "./payment-authorization.js";

/**
 * What a future execution is about to do, in normalized domain values. It carries no provider DTO:
 * a later build turns a firm quote into this shape, then asks whether the authorization covers it.
 */
export interface ExecutionCandidate {
  userId: string;
  walletId: string;
  chainId: number;
  intentRevision: number;
  operation: "SEND" | "CONVERT";
  recipient: { recipientId?: string; address?: string };
  /** What would leave the wallet. */
  input: Money;
  /** What the recipient would receive. */
  output: Money;
  route: { assetPath: string[]; providers?: string[] };
}

export const AUTHORIZATION_VIOLATIONS = [
  "NOT_ACTIVE",
  "EXPIRED",
  "WRONG_USER",
  "WRONG_WALLET",
  "WRONG_CHAIN",
  "REVISION_MISMATCH",
  "OPERATION_MISMATCH",
  "RECIPIENT_MISMATCH",
  "INPUT_ASSET_MISMATCH",
  "OUTPUT_ASSET_MISMATCH",
  "INPUT_EXCEEDS_MAXIMUM",
  "OUTPUT_BELOW_MINIMUM",
  "ROUTE_MISMATCH",
  "INVALID_AMOUNT",
] as const;
export type AuthorizationViolation = (typeof AUTHORIZATION_VIOLATIONS)[number];

export type AuthorizationCheck = { ok: true } | { ok: false; violations: AuthorizationViolation[] };

const isAmount = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Can this execution happen under this authorization? Deterministic, no I/O, no model, integers only.
 * It reports EVERY reason it cannot, so a refusal can be explained and tested.
 *
 *  - the authorization must be ACTIVE, unexpired and not consumed;
 *  - user, wallet, chain, operation, intent revision and recipient must be the ones approved;
 *  - the funding and destination assets and the route shape must be the ones approved
 *    (a silent USDT -> USDC switch is a violation);
 *  - the input must not exceed the approved maximum and the output must not fall below the approved
 *    minimum (EXACT_INPUT and EXACT_OUTPUT reduce to these two limits).
 *
 * Checking does not consume: consumption is a separate atomic repository transition.
 */
export function validateExecutionAgainstAuthorization(
  authorization: PaymentAuthorization,
  candidate: ExecutionCandidate,
  now: Date,
): AuthorizationCheck {
  const violations = new Set<AuthorizationViolation>();

  if (authorization.status !== "ACTIVE") violations.add("NOT_ACTIVE");
  if (authorization.expiresAt.getTime() <= now.getTime()) violations.add("EXPIRED");
  if (authorization.userId !== candidate.userId) violations.add("WRONG_USER");
  if (authorization.walletId !== candidate.walletId) violations.add("WRONG_WALLET");
  if (authorization.chainId !== candidate.chainId) violations.add("WRONG_CHAIN");
  if (authorization.intentRevision !== candidate.intentRevision) {
    violations.add("REVISION_MISMATCH");
  }
  if (authorization.operation !== candidate.operation) violations.add("OPERATION_MISMATCH");

  const { recipientId, address } = authorization.recipient;
  if (
    recipientId !== candidate.recipient.recipientId ||
    (address ?? "") !== (candidate.recipient.address?.toLowerCase() ?? "")
  ) {
    violations.add("RECIPIENT_MISMATCH");
  }

  const { maxInput, minOutput } = boundLimits(authorization.bounds);
  if (candidate.input.assetId !== maxInput.assetId) violations.add("INPUT_ASSET_MISMATCH");
  if (candidate.output.assetId !== minOutput.assetId) violations.add("OUTPUT_ASSET_MISMATCH");

  if (!isAmount(candidate.input.amount) || !isAmount(candidate.output.amount)) {
    violations.add("INVALID_AMOUNT");
  } else {
    if (BigInt(candidate.input.amount) === 0n || BigInt(candidate.output.amount) === 0n) {
      violations.add("INVALID_AMOUNT");
    }
    if (
      candidate.input.assetId === maxInput.assetId &&
      BigInt(candidate.input.amount) > BigInt(maxInput.amount)
    ) {
      violations.add("INPUT_EXCEEDS_MAXIMUM");
    }
    if (
      candidate.output.assetId === minOutput.assetId &&
      BigInt(candidate.output.amount) < BigInt(minOutput.amount)
    ) {
      violations.add("OUTPUT_BELOW_MINIMUM");
    }
  }

  if (!sameList(authorization.route.assetPath, candidate.route.assetPath)) {
    violations.add("ROUTE_MISMATCH");
  }
  if (
    candidate.route.providers !== undefined &&
    authorization.route.providers.length > 0 &&
    !candidate.route.providers.every((slug) => authorization.route.providers.includes(slug))
  ) {
    violations.add("ROUTE_MISMATCH");
  }

  return violations.size === 0 ? { ok: true } : { ok: false, violations: [...violations] };
}
