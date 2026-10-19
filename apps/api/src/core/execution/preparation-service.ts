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
  ExecutionPlanRecord,
  Intent,
  PaymentAuthorization,
  PaymentRoute,
  PlanBlocker,
  TokenPolicy,
  Wallet,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { AuthorizationPolicyService } from "../authorization/policy-service.js";
import type { AccountReadinessService } from "./account-readiness.js";
import type { FirmQuoteService } from "./firm-quote-service.js";
import { buildExecutionPlan, serializePlan } from "./plan-builder.js";
import { buildTransferPlan, isDirectTransferRoute, transferCandidate } from "./transfer.js";
import { defaultTokenPolicy } from "./token-policy.js";
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
  /** Token-specific ERC-20 quirks. Defaults to the built-in table. */
  tokenPolicy?: TokenPolicy;
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

  async prepare(
    authorizationId: string,
    options: { minRemainingMs?: number } = {},
  ): Promise<PreparationOutcome> {
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
      if (expiresAt && expiresAt.getTime() - (options.minRemainingMs ?? 0) > now.getTime()) {
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

    // The payment is already in the right currency: a direct transfer. No swap, no provider, no firm quote.
    if (isDirectTransferRoute(route)) {
      return this.prepareTransfer({
        authorization,
        intent: intent as Intent & { type: "SEND" | "CONVERT" },
        route,
        wallet,
        existing,
      });
    }

    // MVP restriction: only a single provider hop is executed. A two-hop route would need two firm
    // quotes (two slots, doubled expiry pressure) with no atomicity between them: hop 1 could settle
    // and hop 2 fail. Indicative routing keeps multi-hop; execution refuses it, before any provider call.
    const swaps = route.steps.filter((step) => step.type === "SWAP");
    if (swaps.length !== 1) {
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.routeUnsupported, authorization.id, {
        swaps: String(swaps.length),
      });
      await this.recordTerminal(authorization, "EXECUTION_ROUTE_UNSUPPORTED");
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
      await this.recordTerminal(authorization, "PAYMENT_CHANGED");
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
      minRemainingMs: this.deps.minWindowMs,
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
      buyAsset: buy,
      tokenPolicy: this.deps.tokenPolicy ?? defaultTokenPolicy,
      currentAllowance,
      deployed: snapshot.deployed,
      rootAvailable: snapshot.rootAvailable,
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

  /**
   * A direct transfer needs no price to confirm: the plan is built from the stored payment alone, and it is READY (or BLOCKED,
   * for instance without a recipient address) straight away. The transfer itself is sent later, by the runner, under the same
   * rules as any payment.
   */
  private async prepareTransfer(input: {
    authorization: PaymentAuthorization;
    intent: Intent & { type: "SEND" | "CONVERT" };
    route: PaymentRoute;
    wallet: Wallet & { address: string };
    existing: ExecutionPlanRecord | null;
  }): Promise<PreparationOutcome> {
    const { authorization, intent, route, wallet, existing } = input;
    const repositories = this.uow.read;

    // A person already confirming wallet setup keeps that step: nothing here may reset it.
    if (existing?.status === "REQUIRES_USER_ACTION") {
      return {
        status: "EXECUTION_READY",
        executionId: existing.id,
        expiresAt: authorization.expiresAt,
        reused: true,
      };
    }

    // A transfer cannot change currency or amount.
    if (
      route.input.assetId !== route.output.assetId ||
      route.input.amount !== route.output.amount
    ) {
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.routeUnsupported, authorization.id, {
        transfer: "input and output differ",
      });
      await this.recordTerminal(authorization, "EXECUTION_ROUTE_UNSUPPORTED");
      return { status: "EXECUTION_ROUTE_UNSUPPORTED" };
    }
    const asset = await repositories.assets.findById(route.input.assetId);
    if (!hasContract(asset)) return this.reauthorize(authorization, "PAYMENT_CHANGED");

    const recipient = intent.recipientId
      ? await repositories.recipients.findById(intent.recipientId)
      : null;
    const candidate = transferCandidate({
      authorization,
      intent,
      walletId: wallet.id,
      chainId: wallet.chainId,
      assetId: asset.id,
      amount: route.input.amount,
      recipientAddress: recipient?.walletAddress,
    });
    // Is this exactly what the person approved? A changed recipient, wallet, asset or amount is refused here.
    const check = this.deps.policy.check(authorization, candidate);
    if (!check.ok) {
      await this.audit(
        authorization,
        EXECUTION_AUDIT_EVENTS.reauthorizationRequired,
        authorization.id,
        { violations: check.violations.join(",") },
      );
      await this.recordTerminal(authorization, "OUTSIDE_AUTHORIZED_LIMITS");
      return {
        status: "REAUTHORIZATION_REQUIRED",
        reason: "OUTSIDE_AUTHORIZED_LIMITS",
        violations: check.violations,
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

    const snapshot = await this.deps.readiness.inspect(wallet);
    const plan = buildTransferPlan({
      candidate,
      authorization,
      wallet,
      asset,
      deployed: snapshot.deployed,
      rootAvailable: snapshot.rootAvailable,
      infrastructure: snapshot.infrastructure,
      permissions: snapshot.permissions,
      now: this.now(),
    });
    const status =
      plan.status === "READY" ? "READY" : plan.status === "BLOCKED" ? "BLOCKED" : "EXPIRED";
    await repositories.executionPlans.update(record.id, { status, plan: serializePlan(plan) });
    if (plan.status === "READY") {
      await this.audit(authorization, EXECUTION_AUDIT_EVENTS.planReady, record.id, {
        kind: "TRANSFER",
      });
      return {
        status: "EXECUTION_READY",
        executionId: record.id,
        expiresAt: plan.expiresAt,
        reused: false,
      };
    }
    await this.audit(authorization, EXECUTION_AUDIT_EVENTS.planBlocked, record.id, {
      kind: "TRANSFER",
      blockers: plan.blockers.join(","),
    });
    if (plan.status === "EXPIRED") return this.reauthorize(authorization, "AUTHORIZATION_EXPIRED");
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
    // The payment itself changed (or its wallet did): nothing will ever run for this authorization, and the chat must say so.
    if (authorization && (reason === "PAYMENT_CHANGED" || reason === "WALLET_NOT_ACTIVE")) {
      await this.recordTerminal(authorization, reason);
    }
    this.log("info", "execution.reauthorization_required", { reason });
    return { status: "REAUTHORIZATION_REQUIRED", reason };
  }

  /**
   * Remembers, on the execution record, why this payment will not run. The preparation result otherwise lives only in one
   * process's memory, so without this the chat would say "confirming the final price" for ever. Only a record that has not
   * started (PREPARING) is changed: a payment that is moving, or finished, is never marked failed here.
   */
  private async recordTerminal(authorization: PaymentAuthorization, code: string): Promise<void> {
    const repositories = this.uow.read;
    try {
      const existing = await repositories.executionPlans.findByAuthorization(authorization.id);
      const record =
        existing ??
        (
          await repositories.executionPlans.begin({
            id: createId(),
            userId: authorization.userId,
            intentId: authorization.intentId,
            routeId: authorization.routeId,
            paymentAuthorizationId: authorization.id,
            walletId: authorization.walletId,
          })
        ).record;
      await repositories.executionPlans.transition(record.id, ["PREPARING"], "FAILED", {
        failureCode: code,
      });
    } catch (error) {
      // Telling the person is a courtesy on top of the refusal itself: never turn a refusal into a crash.
      this.log("warn", "execution.terminal_record_failed", {
        authorizationId: authorization.id,
        code,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
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
