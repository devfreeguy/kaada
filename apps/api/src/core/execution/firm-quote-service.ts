import { CELO_CHAIN_ID, EXECUTION_AUDIT_EVENTS, KaadaError, createId } from "@kaada/domain";
import type {
  Asset,
  FirmQuoteAttempt,
  FirmQuoteFailureCode,
  FirmQuoteProvider,
  PaymentAuthorization,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { ChainState, ExecutionUnitOfWork, SecretCipher } from "./ports.js";

/** How long a request that gave no answer is still counted as holding a provider slot. */
export const TIMED_OUT_SLOT_HOLD_MS = 3 * 60 * 1000;
/** A REQUESTING row older than the provider timeout plus this is an abandoned request (a crash). */
const ABANDONED_GRACE_MS = 15_000;
/** Firm requests per authorization. A user-driven retry is allowed once; never a loop. */
export const MAX_FIRM_ATTEMPTS_PER_AUTHORIZATION = 2;
/** After the provider reports its capacity is full, do not ask again for this long. */
export const CAPACITY_COOLDOWN_MS = 30_000;

/** Everything needed to ask for a firm quote, already checked against the live payment. */
export interface FirmQuoteContext {
  authorization: PaymentAuthorization;
  /** The wallet address, from WalletService, for the authorization's wallet. */
  takerAddress: string;
  sellAsset: Asset & { contractAddress: string };
  buyAsset: Asset & { contractAddress: string };
}

export type FirmQuoteOutcome =
  | { status: "QUOTED"; attempt: FirmQuoteAttempt; reused: boolean }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "PROVIDER_CAPACITY_REACHED" }
  | { status: "FINAL_PRICE_UNAVAILABLE"; code: FirmQuoteFailureCode | "ATTEMPTS_EXHAUSTED" }
  | { status: "IN_PROGRESS" };

export interface FirmQuoteServiceDeps {
  unitOfWork: ExecutionUnitOfWork;
  provider: FirmQuoteProvider;
  cipher: SecretCipher;
  chain: Pick<ChainState, "balances">;
  /** The most outstanding firm quotes Kaada allows itself at the provider (Textile's cap is 4). */
  maxOutstanding: number;
  /** The provider request timeout, used to recognise an abandoned REQUESTING row. */
  requestTimeoutMs: number;
  now?: () => Date;
  log?: AgentLog;
}

/**
 * Obtains ONE firm quote for an authorization, safely.
 *
 * Provider slots are scarce (4 per key, held until the quote's latest order deadline, not freed by
 * cancelling), so every guard runs BEFORE the provider is called:
 *  - a live attempt for the authorization is reused (unexpired) or reported in progress, never repeated;
 *  - Kaada's own count of held slots is respected;
 *  - the wallet's fresh balance must cover the authorized ceiling;
 *  - the attempt is recorded (and a database index allows only one live one) before the call.
 *
 * It never retries, never loops, and never consumes the authorization.
 */
export class FirmQuoteService {
  private readonly uow: ExecutionUnitOfWork;
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: FirmQuoteServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async obtain(context: FirmQuoteContext): Promise<FirmQuoteOutcome> {
    const { authorization } = context;
    const repositories = this.uow.read;
    const provider = await repositories.providers.findBySlug(this.deps.provider.id);
    if (!provider) throw new Error(`no Provider row for ${this.deps.provider.id}`);

    const attempts = await repositories.firmQuoteAttempts.listByAuthorization(authorization.id);
    const live = attempts.find((a) => a.status === "REQUESTING" || a.status === "QUOTED");
    const now = this.now();

    if (live?.status === "QUOTED") {
      if (live.expiresAt && live.expiresAt.getTime() > now.getTime()) {
        return { status: "QUOTED", attempt: live, reused: true };
      }
      // Expired: never reused. It stays as history and frees the "one live attempt" slot.
      await repositories.firmQuoteAttempts.markExpired(live.id, now);
    } else if (live?.status === "REQUESTING") {
      const abandonedAfter = this.deps.requestTimeoutMs + ABANDONED_GRACE_MS;
      if (now.getTime() - live.createdAt.getTime() <= abandonedAfter) {
        return { status: "IN_PROGRESS" };
      }
      // A crash left it behind. A quote may exist at the provider, so the slot stays counted.
      await repositories.firmQuoteAttempts.recordFailure(
        live.id,
        "TIMED_OUT",
        "PROVIDER_TIMEOUT",
        now,
      );
    }

    // A full provider does not empty because we asked again: no repeat inside the cooldown.
    const latest = attempts[0];
    if (
      latest?.status === "FAILED" &&
      latest.failureCode === "PROVIDER_CAPACITY_REACHED" &&
      now.getTime() - latest.updatedAt.getTime() < CAPACITY_COOLDOWN_MS
    ) {
      return { status: "PROVIDER_CAPACITY_REACHED" };
    }

    if (attempts.length >= MAX_FIRM_ATTEMPTS_PER_AUTHORIZATION) {
      return { status: "FINAL_PRICE_UNAVAILABLE", code: "ATTEMPTS_EXHAUSTED" };
    }

    // Kaada's own view of held slots. It does not replace the provider's limit; it avoids avoidable 429s.
    const held = await repositories.firmQuoteAttempts.countHeldSlots(
      provider.id,
      now,
      TIMED_OUT_SLOT_HOLD_MS,
    );
    if (held >= this.deps.maxOutstanding) return { status: "PROVIDER_CAPACITY_REACHED" };

    // Fresh chain balance, never a stored one: the wallet must cover the authorized ceiling.
    const { bounds } = authorization;
    const ceiling = bounds.mode === "EXACT_INPUT" ? bounds.authorizedInput : bounds.maximumInput;
    const balances = await this.deps.chain.balances.balancesOf(context.takerAddress, [
      ceiling.assetId,
    ]);
    if ((balances.get(ceiling.assetId) ?? 0n) < BigInt(ceiling.amount)) {
      return { status: "INSUFFICIENT_BALANCE" };
    }

    // EXACT_INPUT asks for the authorized input as the sell amount (never more); EXACT_OUTPUT asks for
    // the exact output as the buy amount (the maximum input is NOT sent: the provider prices the sell side).
    const exactAmount = bounds.mode === "EXACT_INPUT" ? bounds.authorizedInput : bounds.exactOutput;

    const claim = await repositories.firmQuoteAttempts.claim(
      {
        id: createId(),
        paymentAuthorizationId: authorization.id,
        userId: authorization.userId,
        walletId: authorization.walletId,
        providerId: provider.id,
        idempotencyKey: `firm:${authorization.id}:${provider.id}:${attempts.length + 1}`,
        amountMode: bounds.mode,
        exactAmount,
        takerAddress: context.takerAddress.toLowerCase(),
      },
      now,
    );
    if (!claim.claimed) {
      // Someone else (another delivery, another process) got there first.
      return claim.attempt.status === "QUOTED"
        ? { status: "QUOTED", attempt: claim.attempt, reused: true }
        : { status: "IN_PROGRESS" };
    }
    const attempt = claim.attempt;
    await this.audit(authorization, EXECUTION_AUDIT_EVENTS.firmQuoteRequested, attempt.id);

    // The provider call: outside any transaction, once, with the long firm timeout.
    const result = await this.deps.provider.requestFirm({
      chainId: CELO_CHAIN_ID,
      sellAssetId: context.sellAsset.id,
      buyAssetId: context.buyAsset.id,
      sellToken: context.sellAsset.contractAddress,
      buyToken: context.buyAsset.contractAddress,
      mode: bounds.mode,
      exactAmount: exactAmount.amount,
      taker: context.takerAddress,
    });

    const after = this.now();
    if (result.status === "FAILED") {
      const status = result.mayHoldSlot ? "TIMED_OUT" : "FAILED";
      await repositories.firmQuoteAttempts.recordFailure(attempt.id, status, result.code, after);
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.firmQuoteFailed, attempt.id, {
        code: result.code,
      });
      this.log("warn", "execution.firm_quote_failed", { attemptId: attempt.id, code: result.code });
      switch (result.code) {
        case "PROVIDER_CAPACITY_REACHED":
          return { status: "PROVIDER_CAPACITY_REACHED" };
        case "INSUFFICIENT_FUNDS_AT_PROVIDER":
          return { status: "INSUFFICIENT_BALANCE" };
        default:
          return { status: "FINAL_PRICE_UNAVAILABLE", code: result.code };
      }
    }

    // The claim token is encrypted before it touches storage, bound to its own record.
    const secretId = createId();
    const sealed = this.deps.cipher.encrypt(
      result.claimToken.reveal(),
      `textile-claim-token:${secretId}`,
    );
    const quoted = await this.uow.transaction(async (tx) => {
      await tx.executionSecrets.put({
        id: secretId,
        purpose: "TEXTILE_CLAIM_TOKEN",
        keyVersion: sealed.keyVersion,
        ciphertext: sealed.ciphertext,
        now: after,
      });
      return tx.firmQuoteAttempts.recordQuoted(
        attempt.id,
        {
          providerQuoteId: result.quote.providerQuoteId,
          input: result.quote.input,
          output: result.quote.output,
          ...(result.quote.fee && { fee: result.quote.fee }),
          ...(result.quote.reactor && { reactor: result.quote.reactor }),
          ...(result.quote.spender && { spender: result.quote.spender }),
          expiresAt: result.quote.expiresAt,
          ...(result.quote.orderDeadline && { orderDeadline: result.quote.orderDeadline }),
          ...(result.quote.latestOrderDeadline && {
            latestOrderDeadline: result.quote.latestOrderDeadline,
          }),
          unsignedTransactions: result.transactions,
          claimSecretId: secretId,
        },
        after,
      );
    });
    if (!quoted) throw new KaadaError("EXECUTION_FAILED", "the firm quote could not be recorded");
    await this.audit(authorization, EXECUTION_AUDIT_EVENTS.firmQuoteReceived, attempt.id);
    return { status: "QUOTED", attempt: quoted, reused: false };
  }

  private async audit(
    authorization: PaymentAuthorization,
    type: string,
    attemptId: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await this.uow.read.audit.append({
      id: createId(),
      userId: authorization.userId,
      type,
      entityType: "firm_quote_attempt",
      entityId: attemptId,
      // Identifiers and reason codes only: never an amount, calldata or a claim token.
      data: { authorizationId: authorization.id, ...data },
    });
  }
}
