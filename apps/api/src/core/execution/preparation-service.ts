import {
  CELO_CHAIN_ID,
  EXECUTION_AUDIT_EVENTS,
  boundLimits,
  createId,
  isWalletActive,
} from "@kaada/domain";
import type {
  Asset,
  AuthorizationViolation,
  FirmExecutionCandidate,
  FirmQuote,
  PaymentAuthorization,
  PlanBlocker,
  Wallet,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { AuthorizationPolicyService } from "../authorization/policy-service.js";
import type { AccountReadinessService } from "./account-readiness.js";
import type { FirmQuoteService } from "./firm-quote-service.js";
import { buildExecutionPlan, serializePlan } from "./plan-builder.js";
import { planExpiresAt } from "./tracker.js";
import type { ChainState, ExecutionUnitOfWork } from "./ports.js";

/**
 * Why a payment must be authorized again. The person's earlier PIN is still valid for what they
 * approved; it just does not cover what the world looks like now.
 */
export type ReauthorizationReason =
  | "AUTHORIZATION_NOT_ACTIVE"
  | "AUTHORIZATION_EXPIRED"
  | "PAYMENT_CHANGED"
  | "WALLET_NOT_ACTIVE"
  | "OUTSIDE_AUTHORIZED_LIMITS";

/** The result of preparing an authorized payment. None of them means money moved. */
export type PreparationOutcome =
  | { status: "EXECUTION_READY"; executionId: string; expiresAt: Date; reused: boolean }
  | { status: "EXECUTION_BLOCKED"; executionId: string; blockers: PlanBlocker[] }
  | {
      status: "REAUTHORIZATION_REQUIRED";
      reason: ReauthorizationReason;
      violations?: AuthorizationViolation[];
    }
  | { status: "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY" }
  | { status: "FINAL_PRICE_UNAVAILABLE"; code: string }
  | { status: "PROVIDER_CAPACITY_REACHED" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "EXECUTION_ROUTE_UNSUPPORTED" }
  | { status: "PREPARATION_IN_PROGRESS" };

export interface PreparationServiceDeps {
  unitOfWork: ExecutionUnitOfWork;
  firmQuotes: FirmQuoteService;
  policy: Pick<AuthorizationPolicyService, "check">;
  readiness: AccountReadinessService;
  chain: Pick<ChainState, "allowances">;
  wallets: { getWallet(userId: string): Promise<Wallet | null> };
  /** The least time that must remain on a firm quote for it to count as executable. */
  minWindowMs: number;
  now?: () => Date;
  log?: AgentLog;
}

/** The text a person may be shown after a PIN. It never says a payment was sent. */
export function preparationMessage(outcome: PreparationOutcome): string {
  switch (outcome.status) {
    case "EXECUTION_READY":
      return "Payment authorized and final pricing confirmed.";
    case "EXECUTION_BLOCKED":
      return "Payment authorized, but it needs a manual check before it can continue. Nothing was sent.";
    case "REAUTHORIZATION_REQUIRED":
      return "The final price is outside what you approved, or your approval is no longer valid. Please authorize again. Nothing was sent.";
    case "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY":
      return "The final price expired too quickly. Please try again. Nothing was sent.";
    case "FINAL_PRICE_UNAVAILABLE":
      return "We couldn't confirm a final price right now. Please try again shortly. Nothing was sent.";
    case "PROVIDER_CAPACITY_REACHED":
      return "The pricing provider is busy right now. Please try again in a few minutes. Nothing was sent.";
    case "INSUFFICIENT_BALANCE":
      return "Your wallet no longer holds enough for this payment. Nothing was sent.";
    case "EXECUTION_ROUTE_UNSUPPORTED":
      return "This payment route can't be executed yet. Nothing was sent.";
    case "PREPARATION_IN_PROGRESS":
      return "Confirming the final price...";
  }
}

/**
 * Takes an ACTIVE payment authorization to a ready (or blocked) execution plan, and stops there:
 *
 *   authorization -> ONE firm quote -> normalized candidate -> checked against the authorization
 *   -> account / permission / allowance requirements -> ExecutionPlan -> Execution READY
 *
 * It never consumes the authorization (a failed signing later must not burn the approval), never signs,
 * never broadcasts, never deploys, never approves and never submits an order. Repeating it is safe:
 * the firm quote and the plan are reused while valid.
 */
export class ExecutionPreparationService {
  private readonly uow: ExecutionUnitOfWork;
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: PreparationServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async prepare(authorizationId: string): Promise<PreparationOutcome> {
    const repositories = this.uow.read;
    const now = this.now();

    const authorization = await repositories.paymentAuthorizations.findById(authorizationId);
    if (!authorization || authorization.status !== "ACTIVE") {
      return this.reauthorize(authorization, "AUTHORIZATION_NOT_ACTIVE");
    }
    if (authorization.expiresAt.getTime() <= now.getTime()) {
      return this.reauthorize(authorization, "AUTHORIZATION_EXPIRED");
    }

    // A plan that is still READY and unexpired is simply returned.
    const existing = await repositories.executionPlans.findByAuthorization(authorization.id);
    if (existing?.status === "READY") {
      const expiresAt = planExpiresAt(existing.plan);
      if (expiresAt && expiresAt.getTime() > now.getTime()) {
        return { status: "EXECUTION_READY", executionId: existing.id, expiresAt, reused: true };
      }
    }

    // The payment must still be exactly what was authorized.
    const intent = await repositories.intents.findById(authorization.intentId);
    const route = await repositories.routes.findById(authorization.routeId);
    if (
      !intent ||
      !route ||
      intent.userId !== authorization.userId ||
      intent.revision !== authorization.intentRevision ||
      intent.status !== "RESOLVED" ||
      (intent.type !== "SEND" && intent.type !== "CONVERT") ||
      route.intentId !== intent.id ||
      route.intentRevision !== authorization.intentRevision ||
      route.status !== "VALID"
    ) {
      return this.reauthorize(authorization, "PAYMENT_CHANGED");
    }

    // The taker comes from the wallet service, for the authorization's own wallet. Never from a caller.
    const wallet = await this.deps.wallets.getWallet(authorization.userId);
    if (
      !wallet ||
      wallet.id !== authorization.walletId ||
      !isWalletActive(wallet) ||
      wallet.chainId !== CELO_CHAIN_ID
    ) {
      return this.reauthorize(authorization, "WALLET_NOT_ACTIVE");
    }

    // MVP restriction: only a single provider hop is executed. A two-hop route would need two firm
    // quotes (two slots, doubled expiry pressure) with no atomicity between them: hop 1 could settle
    // and hop 2 fail. Indicative routing keeps multi-hop; execution refuses it, before any provider call.
    const swaps = route.steps.filter((step) => step.type === "SWAP");
    if (swaps.length !== 1) {
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.routeUnsupported, authorization.id, {
        swaps: String(swaps.length),
      });
      return { status: "EXECUTION_ROUTE_UNSUPPORTED" };
    }

    const { maxInput, minOutput } = boundLimits(authorization.bounds);
    const [sell, buy] = await Promise.all([
      repositories.assets.findById(maxInput.assetId),
      repositories.assets.findById(minOutput.assetId),
    ]);
    if (!hasContract(sell) || !hasContract(buy)) {
      return this.reauthorize(authorization, "PAYMENT_CHANGED");
    }

    // Everything about the payment EXCEPT the final price is checked first, with the authorized limits
    // standing in for the price, so a changed recipient, wallet or route is refused BEFORE a provider
    // slot is spent on a quote that could never be used.
    const recipient = intent.recipientId
      ? await repositories.recipients.findById(intent.recipientId)
      : null;
    const address = recipient?.walletAddress?.toLowerCase();
    const preflight = this.deps.policy.check(authorization, {
      userId: authorization.userId,
      walletId: wallet.id,
      chainId: wallet.chainId,
      intentRevision: intent.revision,
      operation: intent.type,
      recipient: {
        ...(intent.recipientId && { recipientId: intent.recipientId }),
        ...(address && /^0x[0-9a-f]{40}$/.test(address) && { address }),
      },
      input: maxInput,
      output: minOutput,
      route: {
        assetPath: [...authorization.route.assetPath],
        providers: authorization.route.providers,
      },
    });
    if (!preflight.ok) {
      await this.audit(
        authorization,
        EXECUTION_AUDIT_EVENTS.reauthorizationRequired,
        authorization.id,
        {
          violations: preflight.violations.join(","),
        },
      );
      return {
        status: "REAUTHORIZATION_REQUIRED",
        reason: "PAYMENT_CHANGED",
        violations: preflight.violations,
      };
    }

    const record =
      existing ??
      (
        await repositories.executionPlans.begin({
          id: createId(),
          userId: authorization.userId,
          intentId: intent.id,
          routeId: route.id,
          paymentAuthorizationId: authorization.id,
          walletId: wallet.id,
        })
      ).record;

    const obtained = await this.deps.firmQuotes.obtain({
      authorization,
      takerAddress: wallet.address,
      sellAsset: sell,
      buyAsset: buy,
    });
    switch (obtained.status) {
      case "IN_PROGRESS":
        return { status: "PREPARATION_IN_PROGRESS" };
      case "INSUFFICIENT_BALANCE":
      case "PROVIDER_CAPACITY_REACHED":
      case "FINAL_PRICE_UNAVAILABLE":
        await repositories.executionPlans.update(record.id, {
          status: "FAILED",
          failureCode:
            obtained.status === "FINAL_PRICE_UNAVAILABLE" ? obtained.code : obtained.status,
        });
        return obtained.status === "FINAL_PRICE_UNAVAILABLE"
          ? { status: "FINAL_PRICE_UNAVAILABLE", code: obtained.code }
          : { status: obtained.status };
      case "QUOTED":
        break;
    }

    const attempt = obtained.attempt;
    if (
      !attempt.providerQuoteId ||
      !attempt.input ||
      !attempt.output ||
      !attempt.expiresAt ||
      !attempt.unsignedTransactions
    ) {
      throw new Error("a QUOTED attempt is missing its quote fields");
    }
    const quote: FirmQuote = {
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

    // Normalize into the exact proposed operation, using the LIVE intent and recipient, then ask the
    // authorization policy whether it fits. `check` is pure: nothing is consumed.
    const candidate: FirmExecutionCandidate = {
      userId: authorization.userId,
      walletId: wallet.id,
      chainId: quote.chainId,
      intentRevision: intent.revision,
      operation: intent.type,
      recipient: {
        ...(intent.recipientId && { recipientId: intent.recipientId }),
        ...(address && /^0x[0-9a-f]{40}$/.test(address) && { address }),
      },
      input: quote.input,
      output: quote.output,
      route: {
        assetPath: [quote.input.assetId, quote.output.assetId],
        providers: [quote.provider],
      },
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

    const check = this.deps.policy.check(authorization, candidate);
    if (!check.ok) {
      // The quote stays on record (it still holds its provider slot) but is not used. The
      // authorization is NOT consumed or changed: the person authorizes again for the new price.
      await repositories.firmQuoteAttempts.markUnusable(attempt.id, "OUT_OF_BOUNDS", this.now());
      await repositories.executionPlans.update(record.id, {
        status: "FAILED",
        failureCode: "OUTSIDE_AUTHORIZED_LIMITS",
        firmQuoteAttemptId: attempt.id,
      });
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.reauthorizationRequired, attempt.id, {
        violations: check.violations.join(","),
      });
      return {
        status: "REAUTHORIZATION_REQUIRED",
        reason: "OUTSIDE_AUTHORIZED_LIMITS",
        violations: check.violations,
      };
    }

    // A deterministic time budget: no plan is called ready without a safe window left to act.
    if (quote.expiresAt.getTime() - this.now().getTime() < this.deps.minWindowMs) {
      await repositories.firmQuoteAttempts.markUnusable(
        attempt.id,
        "TOO_CLOSE_TO_EXPIRY",
        this.now(),
      );
      await repositories.executionPlans.update(record.id, {
        status: "FAILED",
        failureCode: "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY",
        firmQuoteAttemptId: attempt.id,
      });
      return { status: "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY" };
    }

    // Account, permission and allowance requirements: reads only.
    const snapshot = await this.deps.readiness.inspect(wallet);
    const spender = quote.spender ?? quote.reactor;
    const currentAllowance = spender
      ? await this.deps.chain.allowances.readAllowance({
          chainId: quote.chainId,
          token: sell.contractAddress,
          owner: wallet.address,
          spender,
        })
      : 0n;
    const plan = buildExecutionPlan({
      candidate,
      quote,
      transactions: attempt.unsignedTransactions,
      claimTokenStored: attempt.claimSecretId !== undefined,
      authorization,
      wallet,
      sellAsset: sell,
      currentAllowance,
      deployed: snapshot.deployed,
      passkeyRootAvailable: snapshot.passkeyRootAvailable,
      infrastructure: snapshot.infrastructure,
      permissions: snapshot.permissions,
      now: this.now(),
    });

    const status =
      plan.status === "READY" ? "READY" : plan.status === "BLOCKED" ? "BLOCKED" : "EXPIRED";
    await repositories.executionPlans.update(record.id, {
      status,
      plan: serializePlan(plan),
      firmQuoteAttemptId: attempt.id,
    });
    if (plan.status === "READY") {
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.planReady, record.id);
      return {
        status: "EXECUTION_READY",
        executionId: record.id,
        expiresAt: plan.expiresAt,
        reused: false,
      };
    }
    await this.audit(authorization, EXECUTION_AUDIT_EVENTS.planBlocked, record.id, {
      blockers: plan.blockers.join(","),
    });
    return { status: "EXECUTION_BLOCKED", executionId: record.id, blockers: plan.blockers };
  }

  private async reauthorize(
    authorization: PaymentAuthorization | null,
    reason: ReauthorizationReason,
  ): Promise<PreparationOutcome> {
    if (authorization) {
      await this.audit(
        authorization,
        EXECUTION_AUDIT_EVENTS.reauthorizationRequired,
        authorization.id,
        {
          reason,
        },
      );
    }
    this.log("info", "execution.reauthorization_required", { reason });
    return { status: "REAUTHORIZATION_REQUIRED", reason };
  }

  private async audit(
    authorization: PaymentAuthorization,
    type: string,
    entityId: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await this.uow.read.audit.append({
      id: createId(),
      userId: authorization.userId,
      type,
      entityType: "execution",
      entityId,
      data: { authorizationId: authorization.id, ...data },
    });
  }
}

function hasContract(asset: Asset | null): asset is Asset & { contractAddress: string } {
  return asset !== null && asset.contractAddress !== undefined;
}
