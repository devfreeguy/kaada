import {
  EXECUTION_AUDIT_EVENTS,
  KaadaError,
  SecretValue,
  boundLimits,
  createId,
} from "@kaada/domain";
import type {
  ExecutionPlan,
  ExecutionPlanRecord,
  ExecutionSigner,
  KernelExecutionPort,
  PlanRecordStatus,
  ProviderOrderPort,
  ProviderOrderStatus,
  TokenPolicy,
  Transaction,
  Wallet,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { freshPlan } from "./fresh-plan.js";
import { loadLiveExecution } from "./live-execution.js";
import type { LiveExecution } from "./live-execution.js";
import type { PreparationOutcome } from "./preparation-service.js";
import type { ChainState, ExecutionUnitOfWork, SecretCipher } from "./ports.js";
import type { RootActionService } from "./root-action-service.js";
import { plannedSteps, stepKey } from "./steps.js";

/** What a run reports. NOTHING here claims a payment was sent unless the chain and the provider agree. */
export type RunOutcome =
  | { status: "ROOT_ACTION_REQUIRED"; rootActionId: string }
  | { status: "PROCESSING_PAYMENT" }
  | { status: "PAYMENT_SENT" }
  | { status: "PAYMENT_PENDING" }
  | { status: "PAYMENT_FAILED"; code: string }
  | { status: "REAUTHORIZATION_REQUIRED"; reason: string }
  | { status: "GAS_FUNDING_REQUIRED" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "EXECUTION_ROUTE_UNSUPPORTED" }
  | { status: "NOT_READY" };

export function runMessage(outcome: RunOutcome): string {
  switch (outcome.status) {
    case "ROOT_ACTION_REQUIRED":
      return "Confirm wallet setup to continue your payment.";
    case "PROCESSING_PAYMENT":
      return "Processing your payment...";
    case "PAYMENT_SENT":
      return "Payment sent.";
    case "PAYMENT_PENDING":
      return "Your payment is being processed. We'll confirm it as soon as it settles. Please don't send it again.";
    case "PAYMENT_FAILED":
      return "The payment didn't go through. Please check your wallet and try again.";
    case "REAUTHORIZATION_REQUIRED":
      return "Please authorize the payment again.";
    case "GAS_FUNDING_REQUIRED":
      return "Your wallet needs a little CELO to pay network fees before this payment can continue.";
    case "INSUFFICIENT_BALANCE":
      return "Your wallet no longer holds enough for this payment.";
    case "EXECUTION_ROUTE_UNSUPPORTED":
      return "This payment route can't be executed yet.";
    case "NOT_READY":
      return "Your payment isn't ready yet.";
  }
}

export interface ExecutionRunnerDeps {
  unitOfWork: ExecutionUnitOfWork;
  preparation: {
    prepare(
      authorizationId: string,
      options?: { minRemainingMs?: number },
    ): Promise<PreparationOutcome>;
  };
  wallets: { getWallet(userId: string): Promise<Wallet | null> };
  kernel: KernelExecutionPort;
  orders: ProviderOrderPort;
  cipher: SecretCipher;
  chain: ChainState;
  signer: ExecutionSigner;
  rootActions: Pick<RootActionService, "request">;
  tokenPolicy?: TokenPolicy;
  /** The least time that must remain on the firm quote before an execution starts. */
  minWindowMs: number;
  /** The least native CELO the wallet needs for network fees (no paymaster is configured). */
  minNativeWei: bigint;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  /** Receipt polling inside one `run`; the reconciler continues anything still pending. */
  poll?: { intervalMs: number; maxWaitMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: AgentLog;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ACTIVE_STATES: readonly PlanRecordStatus[] = [
  "READY",
  "REQUIRES_USER_ACTION",
  "SIGNING",
  "SUBMITTING",
  "SUBMITTED",
  "SETTLING",
];
/** Rows whose chain outcome is awaited. */
const AWAITING: readonly Transaction["status"][] = ["SUBMITTED", "CONFIRMING", "UNKNOWN"];

/**
 * Runs an authorized, planned payment to a CONFIRMED result, and can be called again at any point:
 * every call reads the persisted state and continues from there.
 *
 *   READY -> (REQUIRES_USER_ACTION -> READY) -> SIGNING -> SUBMITTING -> SUBMITTED -> SETTLING -> COMPLETED
 *
 *  - The authorization is consumed in the same atomic step that takes execution rights (READY ->
 *    SIGNING), and only after every precondition was re-checked. Nothing before that spends it.
 *  - Every irreversible step has a persisted Transaction row, written before it is sent. A step that
 *    was sent, or may have been, is NEVER sent again; it is tracked until the chain says what happened.
 *  - COMPLETED needs BOTH a successful on-chain receipt AND the provider reporting the order filled
 *    with amounts inside what the person authorized.
 *  - A failure after the authorization was consumed leaves it consumed: no silent replay.
 */
export class ExecutionRunner {
  private readonly uow: ExecutionUnitOfWork;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: AgentLog;

  constructor(private readonly deps: ExecutionRunnerDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? noopLog;
  }

  async run(executionId: string): Promise<RunOutcome> {
    let refreshed = false;
    // A bounded number of state hops per call: each hop is one persisted transition.
    for (let hop = 0; hop < 12; hop += 1) {
      const record = await this.uow.read.executionPlans.findById(executionId);
      if (!record) return { status: "PAYMENT_FAILED", code: "NOT_FOUND" };
      switch (record.status) {
        case "READY": {
          const next = await this.fromReady(record, refreshed);
          if (next === "REFRESHED") {
            refreshed = true;
            continue;
          }
          if (next === "CONTINUE") continue;
          return next;
        }
        case "REQUIRES_USER_ACTION": {
          const next = await this.rootActionProgress(record);
          if (next === "CONTINUE") continue;
          return next;
        }
        case "SIGNING": {
          const next = await this.driveSteps(record);
          if (next === "CONTINUE") continue;
          return next;
        }
        case "SUBMITTING":
        case "SUBMITTED":
        case "SETTLING": {
          const next = await this.settle(record);
          if (next === "CONTINUE") continue;
          return next;
        }
        case "COMPLETED":
          return { status: "PAYMENT_SENT" };
        case "FAILED":
          return { status: "PAYMENT_FAILED", code: record.failureCode ?? "FAILED" };
        case "EXPIRED":
          return { status: "REAUTHORIZATION_REQUIRED", reason: "EXPIRED" };
        case "BLOCKED":
          return { status: "PAYMENT_FAILED", code: record.failureCode ?? "BLOCKED" };
        case "PREPARING":
          return { status: "NOT_READY" };
      }
    }
    return { status: "PAYMENT_PENDING" };
  }

  /** Continues every execution that has not reached an end. Safe to call repeatedly or concurrently. */
  async reconcile(limit = 25): Promise<{ examined: number; outcomes: Record<string, number> }> {
    const records = await this.uow.read.executionPlans.listByStatus(
      ACTIVE_STATES.filter((status) => status !== "READY"),
      limit,
    );
    const outcomes: Record<string, number> = {};
    for (const record of records) {
      let status: string;
      try {
        status = (await this.run(record.id)).status;
      } catch {
        status = "ERROR";
      }
      outcomes[status] = (outcomes[status] ?? 0) + 1;
    }
    return { examined: records.length, outcomes };
  }

  // ── READY: re-check everything, then take execution rights (or ask for a root action)

  private async fromReady(
    record: ExecutionPlanRecord,
    alreadyRefreshed: boolean,
  ): Promise<RunOutcome | "CONTINUE" | "REFRESHED"> {
    const repositories = this.uow.read;
    const loaded = await loadLiveExecution(repositories, this.deps.wallets, record.id);
    if (!loaded.ok) {
      if (loaded.reason === "NO_FIRM_QUOTE" && !alreadyRefreshed) return this.refresh(record);
      return { status: "REAUTHORIZATION_REQUIRED", reason: loaded.reason };
    }
    const { live } = loaded;
    const now = this.now();

    if (live.authorization.status !== "ACTIVE") {
      return { status: "REAUTHORIZATION_REQUIRED", reason: "AUTHORIZATION_NOT_ACTIVE" };
    }
    if (live.authorization.expiresAt.getTime() <= now.getTime()) {
      return { status: "REAUTHORIZATION_REQUIRED", reason: "AUTHORIZATION_EXPIRED" };
    }

    // The firm quote must still have a safe window. If not, ONE refresh (a new quote under the same
    // authorization, within its attempt cap); the second time round it is a stop, not a loop.
    if (live.quote.expiresAt.getTime() - now.getTime() < this.deps.minWindowMs) {
      return alreadyRefreshed
        ? { status: "REAUTHORIZATION_REQUIRED", reason: "QUOTE_EXPIRED" }
        : this.refresh(record);
    }

    const plan = await this.plan(live, now);
    if (plan.status !== "READY") {
      await this.deps.unitOfWork.read.executionPlans.transition(record.id, ["READY"], "BLOCKED", {
        failureCode: plan.blockers[0] ?? plan.status,
      });
      return { status: "PAYMENT_FAILED", code: plan.blockers[0] ?? plan.status };
    }

    // Network fees: there is no paymaster, so the account itself must hold native CELO.
    if ((await this.deps.kernel.nativeBalance(live.wallet.address)) < this.deps.minNativeWei) {
      return { status: "GAS_FUNDING_REQUIRED" };
    }

    // Fresh balance for the authorized ceiling.
    const { maxInput } = boundLimits(live.authorization.bounds);
    const balances = await this.deps.chain.balances.balancesOf(live.wallet.address, [
      maxInput.assetId,
    ]);
    if ((balances.get(maxInput.assetId) ?? 0n) < BigInt(maxInput.amount)) {
      return { status: "INSUFFICIENT_BALANCE" };
    }

    // Wallet setup that needs the user's passkey comes first and never involves the payment.
    const permissionReady =
      plan.permissionRequirement.state === "SATISFIED" &&
      (await this.permissionReadBack(live, plan));
    if (plan.accountRequirements.rootSignatureRequired || !permissionReady) {
      const session = await this.deps.rootActions.request(live, plan);
      await this.deps.unitOfWork.read.executionPlans.transition(
        record.id,
        ["READY"],
        "REQUIRES_USER_ACTION",
        { userActionKind: session.kind },
      );
      await this.audit(live, EXECUTION_AUDIT_EVENTS.rootActionRequested, session.id);
      return { status: "ROOT_ACTION_REQUIRED", rootActionId: session.id };
    }

    // Take execution rights: lock, require READY, consume the authorization, move to SIGNING.
    const acquired = await this.uow.transaction((tx) =>
      tx.executionPlans.acquire(record.id, this.now()),
    );
    if (acquired.status === "NOT_READY") return { status: "PROCESSING_PAYMENT" };
    if (acquired.status === "AUTHORIZATION_UNAVAILABLE") {
      return { status: "REAUTHORIZATION_REQUIRED", reason: "AUTHORIZATION_NOT_ACTIVE" };
    }
    await this.audit(live, EXECUTION_AUDIT_EVENTS.acquired, record.id);
    await this.audit(live, "authorization.payment_authorization_consumed", live.authorization.id);
    return "CONTINUE";
  }

  private async refresh(record: ExecutionPlanRecord): Promise<RunOutcome | "REFRESHED"> {
    const outcome = await this.deps.preparation.prepare(record.paymentAuthorizationId, {
      minRemainingMs: this.deps.minWindowMs,
    });
    if (outcome.status === "EXECUTION_READY") return "REFRESHED";
    switch (outcome.status) {
      case "REAUTHORIZATION_REQUIRED":
        return { status: "REAUTHORIZATION_REQUIRED", reason: outcome.reason };
      case "INSUFFICIENT_BALANCE":
        return { status: "INSUFFICIENT_BALANCE" };
      case "EXECUTION_ROUTE_UNSUPPORTED":
        return { status: "EXECUTION_ROUTE_UNSUPPORTED" };
      case "PREPARATION_IN_PROGRESS":
        return { status: "PROCESSING_PAYMENT" };
      default:
        return { status: "PAYMENT_FAILED", code: outcome.status };
    }
  }

  private plan(live: LiveExecution, now: Date): Promise<ExecutionPlan> {
    return freshPlan(
      {
        repositories: this.uow.read,
        chain: this.deps.chain,
        infrastructure: this.deps.infrastructure,
        ...(this.deps.tokenPolicy && { tokenPolicy: this.deps.tokenPolicy }),
      },
      live,
      now,
    );
  }

  /** The chain, not the database, says whether the permission for exactly this payment exists. */
  private async permissionReadBack(live: LiveExecution, plan: ExecutionPlan): Promise<boolean> {
    const id = plan.permissionRequirement.existingPermissionId;
    const permission = id ? await this.uow.read.delegatedPermissions.findById(id) : null;
    if (!permission?.sessionKeyAddress) return false;
    return this.deps.kernel.isPermissionInstalled({
      walletAddress: live.wallet.address,
      sessionKeyAddress: permission.sessionKeyAddress,
      scope: plan.permissionRequirement.scope,
    });
  }

  // ── REQUIRES_USER_ACTION: wait for the passkey, then confirm on chain before going on

  private async rootActionProgress(record: ExecutionPlanRecord): Promise<RunOutcome | "CONTINUE"> {
    const repositories = this.uow.read;
    const key = `exec:${record.id}:ROOT_ACTION`;
    const tx = await repositories.executionTransactions.findByKey(key);
    if (!tx) {
      const pending = await repositories.rootActions.findPendingByExecution(record.id);
      if (pending && pending.expiresAt.getTime() > this.now().getTime()) {
        return { status: "ROOT_ACTION_REQUIRED", rootActionId: pending.id };
      }
      // Nothing pending (it expired): back to READY, which asks again with a fresh operation.
      await repositories.executionPlans.transition(record.id, ["REQUIRES_USER_ACTION"], "READY", {
        userActionKind: null,
      });
      return "CONTINUE";
    }
    if (tx.status === "FAILED") {
      // Rejected by the bundler before it was sent: ask for a new confirmation.
      await repositories.executionPlans.transition(record.id, ["REQUIRES_USER_ACTION"], "READY", {
        userActionKind: null,
      });
      return "CONTINUE";
    }
    const settled = await this.awaitTransaction(tx);
    if (settled === "REVERTED") {
      await this.fail(record, "ROOT_ACTION_REVERTED");
      return { status: "PAYMENT_FAILED", code: "ROOT_ACTION_REVERTED" };
    }
    // No receipt yet (or an outage / lost bookkeeping): the CHAIN decides. If the account exists and
    // the permission reads back as installed, the earlier send succeeded and we simply carry on.
    if (settled === "PENDING" && !(await this.rootActionVisibleOnChain(record))) {
      return { status: "PROCESSING_PAYMENT" };
    }

    // Included. Verify on the chain: the account exists and the permission reads back as installed.
    const loaded = await loadLiveExecution(repositories, this.deps.wallets, record.id);
    if (!loaded.ok) return { status: "REAUTHORIZATION_REQUIRED", reason: loaded.reason };
    const { live } = loaded;
    const plan = await this.plan(live, this.now());
    const rawPermissionId = tx.metadata?.["permissionId"];
    const permissionId = typeof rawPermissionId === "string" ? rawPermissionId : "";
    const permission = permissionId
      ? await repositories.delegatedPermissions.findById(permissionId)
      : null;
    const installed =
      !!permission?.sessionKeyAddress &&
      (await this.deps.chain.isDeployed({
        chainId: live.quote.chainId,
        address: live.wallet.address,
      })) &&
      (await this.deps.kernel.isPermissionInstalled({
        walletAddress: live.wallet.address,
        sessionKeyAddress: permission.sessionKeyAddress,
        scope: plan.permissionRequirement.scope,
      }));
    if (!installed || !permission) {
      await this.fail(record, "PERMISSION_NOT_VERIFIED");
      return { status: "PAYMENT_FAILED", code: "PERMISSION_NOT_VERIFIED" };
    }
    // ACTIVE only now that the chain confirmed it.
    await repositories.delegatedPermissions.activate(permission.id, permission.sessionKeyAddress!);
    await repositories.executionPlans.transition(record.id, ["REQUIRES_USER_ACTION"], "READY", {
      userActionKind: null,
    });
    await this.audit(live, EXECUTION_AUDIT_EVENTS.rootActionConfirmed, permission.id);
    return "CONTINUE";
  }

  private async rootActionVisibleOnChain(record: ExecutionPlanRecord): Promise<boolean> {
    try {
      const loaded = await loadLiveExecution(this.uow.read, this.deps.wallets, record.id);
      if (!loaded.ok) return false;
      const plan = await this.plan(loaded.live, this.now());
      return (
        !plan.accountRequirements.deploymentRequired &&
        (await this.permissionReadBack(loaded.live, plan))
      );
    } catch {
      return false;
    }
  }

  // ── SIGNING: approvals one at a time, each confirmed, then the swap + payout in one UserOperation

  private async driveSteps(record: ExecutionPlanRecord): Promise<RunOutcome | "CONTINUE"> {
    const repositories = this.uow.read;
    for (let guard = 0; guard < 8; guard += 1) {
      // Anything already sent is awaited first; nothing is sent while something is unresolved.
      const rows = await repositories.executionTransactions.listByExecution(record.id);
      const awaiting = rows.find((tx) => AWAITING.includes(tx.status));
      if (awaiting) {
        const settled = await this.awaitTransaction(awaiting);
        if (settled === "PENDING") return { status: "PAYMENT_PENDING" };
        if (settled === "REVERTED") {
          await this.fail(record, "STEP_REVERTED");
          return { status: "PAYMENT_FAILED", code: "STEP_REVERTED" };
        }
        continue;
      }
      if (rows.some((tx) => tx.status === "CREATED")) {
        // A step row exists that was never marked sent: an earlier run died around the send. It may
        // have gone out, so it is treated as unknown and reconciled, never resent.
        for (const tx of rows.filter((row) => row.status === "CREATED")) {
          await repositories.executionTransactions.markUnknown(tx.id, this.now());
        }
        return { status: "PAYMENT_PENDING" };
      }

      const loaded = await loadLiveExecution(repositories, this.deps.wallets, record.id);
      if (!loaded.ok) {
        await this.fail(record, loaded.reason);
        return { status: "PAYMENT_FAILED", code: loaded.reason };
      }
      const { live } = loaded;
      const plan = await this.plan(live, this.now());
      const steps = plannedSteps(record.id, plan, live.transactions.swap);
      const next = steps.find(
        (step) => !rows.some((tx) => tx.idempotencyKey === step.key && tx.status === "CONFIRMED"),
      );
      // An approval confirmed in a block but not yet visible in the allowance must not be followed by
      // the swap: wait for the chain to show it, or stop and let the reconciler look again.
      if (
        next?.kind === "SWAP" &&
        rows.some(
          (tx) => tx.idempotencyKey === stepKey(record.id, "APPROVAL") && tx.status === "CONFIRMED",
        ) &&
        !(await this.allowanceVisible(live, plan))
      ) {
        return { status: "PAYMENT_PENDING" };
      }
      if (!next) {
        // Every planned step is confirmed (the swap included).
        await repositories.executionPlans.transition(
          record.id,
          ["SIGNING", "SUBMITTING", "SUBMITTED"],
          "SETTLING",
        );
        return "CONTINUE";
      }

      if (next.kind === "SWAP") {
        await repositories.executionPlans.transition(record.id, ["SIGNING"], "SUBMITTING");
      }

      try {
        await this.deps.signer.signValidatedExecution(record.id);
      } catch (error) {
        return this.afterSignerError(record, error);
      }
      if (next.kind === "SWAP") {
        await repositories.executionPlans.transition(record.id, ["SUBMITTING"], "SUBMITTED");
        await this.audit(live, EXECUTION_AUDIT_EVENTS.stepSent, stepKey(record.id, "SWAP"));
      }
    }
    // Many steps in a row: hand back to the state loop, which bounds the total work per call.
    return "CONTINUE";
  }

  private async afterSignerError(record: ExecutionPlanRecord, error: unknown): Promise<RunOutcome> {
    if (error instanceof KaadaError) {
      if (error.code === "BUNDLER_UNAVAILABLE") return { status: "PAYMENT_PENDING" };
      if (error.code === "BUNDLER_REJECTED") {
        await this.fail(record, "BUNDLER_REJECTED");
        return { status: "PAYMENT_FAILED", code: "BUNDLER_REJECTED" };
      }
      const rawReason = error.details?.["reason"];
      const reason = typeof rawReason === "string" ? rawReason : error.code;
      // A step in flight is waited for, not failed.
      if (reason === "STEP_IN_FLIGHT") return { status: "PAYMENT_PENDING" };
      await this.fail(record, reason);
      return { status: "PAYMENT_FAILED", code: reason };
    }
    // An unexpected failure while sending: unknown whether it went out, so it is not resent.
    this.log("error", "execution.signer_error", { executionId: record.id });
    return { status: "PAYMENT_PENDING" };
  }

  /**
   * After an approval was confirmed, the chain must actually SHOW the allowance before anything depends
   * on it (a pending or lagging read is not enough). Polls a bounded time; false means "not yet".
   */
  private async allowanceVisible(live: LiveExecution, plan: ExecutionPlan): Promise<boolean> {
    const poll = this.deps.poll ?? { intervalMs: 2000, maxWaitMs: 60_000 };
    const started = this.now().getTime();
    let current = plan;
    for (;;) {
      if (!current.approvalRequirements[0]?.required) return true;
      if (this.now().getTime() - started >= poll.maxWaitMs) return false;
      await this.sleep(poll.intervalMs);
      current = await this.plan(live, this.now());
    }
  }

  // ── SETTLING: chain receipt + provider report, bounds checked, then COMPLETED

  private async settle(record: ExecutionPlanRecord): Promise<RunOutcome | "CONTINUE"> {
    const repositories = this.uow.read;
    const swapKey = stepKey(record.id, "SWAP");
    const swap = await repositories.executionTransactions.findByKey(swapKey);
    if (!swap) {
      // Rights were taken but no swap was ever recorded: nothing was sent. The authorization stays consumed.
      await this.fail(record, "SWAP_NEVER_SENT");
      return { status: "PAYMENT_FAILED", code: "SWAP_NEVER_SENT" };
    }
    if (swap.status === "CREATED") {
      await repositories.executionTransactions.markUnknown(swap.id, this.now());
      return { status: "PAYMENT_PENDING" };
    }
    if (swap.status === "FAILED") {
      await this.fail(record, swap.failureCode ?? "SWAP_FAILED");
      return { status: "PAYMENT_FAILED", code: swap.failureCode ?? "SWAP_FAILED" };
    }
    const settled = await this.awaitTransaction(swap);
    if (settled === "PENDING") return { status: "PAYMENT_PENDING" };
    if (settled === "REVERTED") {
      await this.fail(record, "SWAP_REVERTED");
      return { status: "PAYMENT_FAILED", code: "SWAP_REVERTED" };
    }
    const confirmed = await repositories.executionTransactions.findByKey(swapKey);
    const txHash = confirmed?.hash;
    if (!txHash) return { status: "PAYMENT_PENDING" };

    if (record.status !== "SETTLING") {
      await repositories.executionPlans.transition(
        record.id,
        ["SUBMITTING", "SUBMITTED"],
        "SETTLING",
      );
    }

    const loaded = await loadLiveExecution(repositories, this.deps.wallets, record.id);
    if (!loaded.ok) return { status: "PAYMENT_PENDING" };
    const { live } = loaded;

    // Tell the provider (a courtesy it documents as repeat-safe), then read how the order settled.
    const claim = await this.claimToken(live);
    let status: ProviderOrderStatus;
    try {
      if (record.providerSubmitState !== "SUBMITTED") {
        await this.deps.orders.submit({
          providerQuoteId: live.quote.providerQuoteId,
          claimToken: claim,
          txHash,
        });
        await repositories.executionPlans.transition(record.id, ["SETTLING"], "SETTLING", {
          providerSubmitState: "SUBMITTED",
        });
        await this.audit(live, EXECUTION_AUDIT_EVENTS.providerSubmitted, record.id);
      }
      status = await this.deps.orders.status({
        providerQuoteId: live.quote.providerQuoteId,
        claimToken: claim,
      });
    } catch {
      // The provider could not be reached or answered oddly. The swap is on chain; keep reconciling.
      await repositories.executionPlans.transition(record.id, ["SETTLING"], "SETTLING", {
        lastReconciledAt: this.now(),
      });
      return { status: "PAYMENT_PENDING" };
    }

    if (status.state !== "FILLED") {
      // Not filled (yet): a failed/expired order can still be corrected for up to 24 hours, and the
      // swap is confirmed on chain, so this is a state to keep watching, never a verdict.
      await repositories.executionPlans.transition(record.id, ["SETTLING"], "SETTLING", {
        lastReconciledAt: this.now(),
      });
      return { status: "PAYMENT_PENDING" };
    }

    // Settlement must be inside what the person authorized.
    const sell = BigInt(status.sellAmount ?? live.quote.input.amount);
    const buy = BigInt(status.buyAmount ?? live.quote.output.amount);
    const { bounds } = live.authorization;
    const withinBounds =
      bounds.mode === "EXACT_INPUT"
        ? sell <= BigInt(bounds.authorizedInput.amount) &&
          buy >= BigInt(bounds.minimumOutput.amount)
        : buy >= BigInt(bounds.exactOutput.amount) && sell <= BigInt(bounds.maximumInput.amount);
    if (!withinBounds) {
      await this.audit(live, EXECUTION_AUDIT_EVENTS.settlementViolation, record.id);
      await this.fail(record, "SETTLEMENT_POLICY_VIOLATION", {
        settledInputAmount: sell.toString(),
        settledOutputAmount: buy.toString(),
      });
      return { status: "PAYMENT_FAILED", code: "SETTLEMENT_POLICY_VIOLATION" };
    }

    await repositories.executionPlans.transition(record.id, ["SETTLING"], "COMPLETED", {
      settledInputAmount: sell.toString(),
      settledOutputAmount: buy.toString(),
      completedAt: this.now(),
    });
    await this.destroyClaim(record, live);
    await this.audit(live, EXECUTION_AUDIT_EVENTS.completed, record.id);
    return { status: "PAYMENT_SENT" };
  }

  // ── shared helpers

  /**
   * Looks for the outcome of a sent step. Polls a bounded time; a pending or unreachable chain is
   * reported as PENDING and the step is NEVER resent. A reverted inclusion is a definite failure.
   */
  private async awaitTransaction(tx: Transaction): Promise<"CONFIRMED" | "REVERTED" | "PENDING"> {
    const repositories = this.uow.read;
    if (tx.status === "CONFIRMED") return "CONFIRMED";
    if (tx.status === "FAILED") return "REVERTED";
    const poll = this.deps.poll ?? { intervalMs: 2000, maxWaitMs: 60_000 };
    const started = this.now().getTime();
    for (;;) {
      try {
        if (tx.userOpHash) {
          const receipt = await this.deps.kernel.getUserOperationReceipt(tx.userOpHash);
          if (receipt.status === "INCLUDED") {
            await repositories.executionTransactions.markIncluded(tx.id, {
              hash: receipt.txHash.toLowerCase(),
              blockNumber: receipt.blockNumber,
              success: receipt.success,
              now: this.now(),
            });
            return receipt.success ? "CONFIRMED" : "REVERTED";
          }
        } else if (tx.hash) {
          const receipt = await this.deps.kernel.getTransactionReceipt(tx.hash);
          if (receipt.status === "SUCCESS" || receipt.status === "REVERTED") {
            await repositories.executionTransactions.markIncluded(tx.id, {
              hash: tx.hash,
              blockNumber: receipt.blockNumber ?? "0",
              success: receipt.status === "SUCCESS",
              now: this.now(),
            });
            return receipt.status === "SUCCESS" ? "CONFIRMED" : "REVERTED";
          }
        }
      } catch {
        // An outage after sending is not a failure and not a reason to resend.
        await repositories.executionTransactions.markUnknown(tx.id, this.now());
        return "PENDING";
      }
      if (this.now().getTime() - started >= poll.maxWaitMs) return "PENDING";
      await this.sleep(poll.intervalMs);
    }
  }

  /** The provider claim token, decrypted only for the call that needs it. */
  private async claimToken(live: LiveExecution): Promise<SecretValue> {
    const secretId = live.attempt.claimSecretId;
    const secret = secretId ? await this.uow.read.executionSecrets.get(secretId) : null;
    if (!secret)
      throw new KaadaError("EXECUTION_FAILED", "the provider claim token is unavailable");
    return new SecretValue(
      this.deps.cipher.decrypt(secret.ciphertext, `textile-claim-token:${secret.id}`),
    );
  }

  private async destroyClaim(record: ExecutionPlanRecord, live: LiveExecution): Promise<void> {
    if (!live.attempt.claimSecretId) return;
    await this.uow.read.executionSecrets.tombstone(live.attempt.claimSecretId, this.now());
    await this.uow.read.executionPlans.transition(record.id, ["COMPLETED"], "COMPLETED", {
      claimTombstonedAt: this.now(),
    });
    await this.audit(live, EXECUTION_AUDIT_EVENTS.claimDestroyed, live.attempt.claimSecretId);
  }

  private async fail(
    record: ExecutionPlanRecord,
    code: string,
    extra: { settledInputAmount?: string; settledOutputAmount?: string } = {},
  ): Promise<void> {
    const moved = await this.uow.read.executionPlans.transition(
      record.id,
      ["READY", "REQUIRES_USER_ACTION", "SIGNING", "SUBMITTING", "SUBMITTED", "SETTLING"],
      "FAILED",
      { failureCode: code, failedAt: this.now(), ...extra },
    );
    if (!moved) return;
    // A failed execution no longer needs the provider's reusable claim token.
    const loaded = await loadLiveExecution(this.uow.read, this.deps.wallets, record.id);
    if (loaded.ok) {
      await this.destroyClaimQuietly(loaded.live);
      await this.audit(loaded.live, EXECUTION_AUDIT_EVENTS.failed, record.id, { code });
    }
  }

  private async destroyClaimQuietly(live: LiveExecution): Promise<void> {
    if (live.attempt.claimSecretId) {
      await this.uow.read.executionSecrets.tombstone(live.attempt.claimSecretId, this.now());
    }
  }

  private async audit(
    live: LiveExecution,
    type: string,
    entityId: string,
    data: Record<string, string> = {},
  ): Promise<void> {
    await this.uow.read.audit.append({
      id: createId(),
      userId: live.wallet.userId,
      executionId: live.record.id,
      type,
      entityType: "execution",
      entityId,
      // Identifiers and codes only: never an amount, calldata, a key or a token.
      data: { authorizationId: live.authorization.id, ...data },
    });
  }
}
