import { CELO_CHAIN_ID, boundLimits, isWalletActive } from "@kaada/domain";
import type {
  Asset,
  FirmExecutionCandidate,
  FirmQuote,
  FirmQuoteAttempt,
  Intent,
  PaymentAuthorization,
  PaymentRoute,
  UnsignedTransactions,
  Wallet,
} from "@kaada/domain";
import type { ExecutionPlanRecord } from "@kaada/domain";

import type { ExecutionRepositories } from "./ports.js";

/** The firm quote an attempt holds, as a provider-independent value. */
export function quoteFromAttempt(attempt: FirmQuoteAttempt): FirmQuote | undefined {
  if (
    !attempt.providerQuoteId ||
    !attempt.input ||
    !attempt.output ||
    !attempt.expiresAt ||
    !attempt.unsignedTransactions
  ) {
    return undefined;
  }
  return {
    id: attempt.id,
    provider: "textile",
    providerQuoteId: attempt.providerQuoteId,
    chainId: attempt.unsignedTransactions.swap.chainId,
    input: attempt.input,
    output: attempt.output,
    ...(attempt.fee && { fee: attempt.fee }),
    expiresAt: attempt.expiresAt,
    ...(attempt.orderDeadline && { orderDeadline: attempt.orderDeadline }),
    ...(attempt.latestOrderDeadline && { latestOrderDeadline: attempt.latestOrderDeadline }),
    ...(attempt.spender && { spender: attempt.spender }),
    ...(attempt.reactor && { reactor: attempt.reactor }),
    taker: attempt.takerAddress,
    executionReference: attempt.providerQuoteId,
    indicative: false,
  };
}

/** The exact proposed operation, from the live intent and recipient. */
export function candidateFor(input: {
  authorization: PaymentAuthorization;
  intent: Intent & { type: "SEND" | "CONVERT" };
  walletId: string;
  quote: FirmQuote;
  recipientAddress: string | undefined;
}): FirmExecutionCandidate {
  const { authorization, intent, quote } = input;
  const address = input.recipientAddress?.toLowerCase();
  return {
    userId: authorization.userId,
    walletId: input.walletId,
    chainId: quote.chainId,
    intentRevision: intent.revision,
    operation: intent.type,
    recipient: {
      ...(intent.recipientId && { recipientId: intent.recipientId }),
      ...(address && /^0x[0-9a-f]{40}$/.test(address) && { address }),
    },
    input: quote.input,
    output: quote.output,
    route: { assetPath: [quote.input.assetId, quote.output.assetId], providers: [quote.provider] },
    intentId: intent.id,
    authorizationId: authorization.id,
    provider: quote.provider,
    providerQuoteId: quote.providerQuoteId,
    executionReference: quote.executionReference,
    ...(quote.fee && { fee: quote.fee }),
    expiresAt: quote.expiresAt,
    ...(quote.orderDeadline && { orderDeadline: quote.orderDeadline }),
    ...(quote.latestOrderDeadline && { latestOrderDeadline: quote.latestOrderDeadline }),
    routeSteps: [
      { type: "SWAP", provider: quote.provider, input: quote.input, output: quote.output },
    ],
  };
}

/** Everything an execution step is allowed to rely on, re-read from storage just now. */
export interface LiveExecution {
  record: ExecutionPlanRecord;
  authorization: PaymentAuthorization;
  attempt: FirmQuoteAttempt;
  quote: FirmQuote;
  transactions: UnsignedTransactions;
  intent: Intent & { type: "SEND" | "CONVERT" };
  route: PaymentRoute;
  wallet: Wallet & { address: string };
  sellAsset: Asset & { contractAddress: string };
  buyAsset: Asset & { contractAddress: string };
  candidate: FirmExecutionCandidate;
}

export type LiveExecutionResult =
  | { ok: true; live: LiveExecution }
  | { ok: false; reason: "NOT_FOUND" | "PAYMENT_CHANGED" | "WALLET_NOT_ACTIVE" | "NO_FIRM_QUOTE" };

/**
 * Loads an execution from STORAGE and checks it is still the payment that was authorized: same intent
 * revision, a still-valid route, the user's own active Celo wallet, and the firm quote of the plan.
 * Callers never pass calldata or amounts; everything an operation is built from comes through here.
 */
export async function loadLiveExecution(
  repositories: ExecutionRepositories,
  wallets: { getWallet(userId: string): Promise<Wallet | null> },
  executionId: string,
): Promise<LiveExecutionResult> {
  const record = await repositories.executionPlans.findById(executionId);
  if (!record) return { ok: false, reason: "NOT_FOUND" };
  const authorization = await repositories.paymentAuthorizations.findById(
    record.paymentAuthorizationId,
  );
  if (!authorization || authorization.id !== record.paymentAuthorizationId) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  const intent = await repositories.intents.findById(record.intentId);
  const route = await repositories.routes.findById(record.routeId);
  if (
    !intent ||
    !route ||
    (intent.type !== "SEND" && intent.type !== "CONVERT") ||
    intent.userId !== authorization.userId ||
    intent.revision !== authorization.intentRevision ||
    intent.status !== "RESOLVED" ||
    route.intentId !== intent.id ||
    route.intentRevision !== authorization.intentRevision ||
    route.status !== "VALID" ||
    route.id !== authorization.routeId
  ) {
    return { ok: false, reason: "PAYMENT_CHANGED" };
  }
  const wallet = await wallets.getWallet(authorization.userId);
  if (
    !wallet ||
    wallet.id !== authorization.walletId ||
    wallet.id !== record.walletId ||
    !isWalletActive(wallet) ||
    wallet.chainId !== CELO_CHAIN_ID
  ) {
    return { ok: false, reason: "WALLET_NOT_ACTIVE" };
  }
  const attempt = record.firmQuoteAttemptId
    ? await repositories.firmQuoteAttempts.findById(record.firmQuoteAttemptId)
    : null;
  const quote = attempt ? quoteFromAttempt(attempt) : undefined;
  if (!attempt || !quote || !attempt.unsignedTransactions || attempt.status !== "QUOTED") {
    return { ok: false, reason: "NO_FIRM_QUOTE" };
  }
  const { maxInput, minOutput } = boundLimits(authorization.bounds);
  const [sell, buy] = await Promise.all([
    repositories.assets.findById(maxInput.assetId),
    repositories.assets.findById(minOutput.assetId),
  ]);
  if (!sell?.contractAddress || !buy?.contractAddress) {
    return { ok: false, reason: "PAYMENT_CHANGED" };
  }
  const recipient = intent.recipientId
    ? await repositories.recipients.findById(intent.recipientId)
    : null;
  return {
    ok: true,
    live: {
      record,
      authorization,
      attempt,
      quote,
      transactions: attempt.unsignedTransactions,
      intent: intent as Intent & { type: "SEND" | "CONVERT" },
      route,
      wallet,
      sellAsset: sell as Asset & { contractAddress: string },
      buyAsset: buy as Asset & { contractAddress: string },
      candidate: candidateFor({
        authorization,
        intent: intent as Intent & { type: "SEND" | "CONVERT" },
        walletId: wallet.id,
        quote,
        recipientAddress: recipient?.walletAddress,
      }),
    },
  };
}
