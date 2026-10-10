import { KaadaError, validateExecutionAgainstAuthorization } from "@kaada/domain";
import { SecretValue } from "@kaada/domain";
import type {
  ExecutionPlan,
  ExecutionSigner,
  KernelExecutionPort,
  SignedExecution,
  TokenPolicy,
  Wallet,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { loadLiveExecution } from "./live-execution.js";
import type { LiveExecution } from "./live-execution.js";
import { freshPlan } from "./fresh-plan.js";
import type { ChainState, ExecutionUnitOfWork, SecretCipher } from "./ports.js";
import { ALLOWED_SELECTORS, plannedSteps } from "./steps.js";
import type { PlannedStep } from "./steps.js";

export interface ValidatedSignerDeps {
  unitOfWork: ExecutionUnitOfWork;
  wallets: { getWallet(userId: string): Promise<Wallet | null> };
  kernel: KernelExecutionPort;
  cipher: SecretCipher;
  chain: Pick<ChainState, "allowances" | "isDeployed">;
  tokenPolicy?: TokenPolicy;
  /** The least time that must remain on the firm quote when the swap is sent. */
  minWindowMs: number;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  now?: () => Date;
  log?: AgentLog;
}

/** Why the signer refused. Codes only: nothing here carries calldata, a key or a token. */
export type SignerRefusal =
  | "EXECUTION_NOT_SIGNING"
  | "PAYMENT_CHANGED"
  | "WALLET_NOT_ACTIVE"
  | "NO_FIRM_QUOTE"
  | "AUTHORIZATION_NOT_CONSUMED_FOR_THIS_EXECUTION"
  | "OUTSIDE_AUTHORIZATION"
  | "PLAN_NOT_READY"
  | "PERMISSION_NOT_INSTALLED"
  | "QUOTE_TOO_CLOSE_TO_EXPIRY"
  | "STEP_IN_FLIGHT"
  | "STEP_FAILED"
  | "NOTHING_TO_SIGN"
  | "CALL_NOT_ALLOWED"
  | "SESSION_KEY_UNAVAILABLE";

const refuse = (reason: SignerRefusal, details: Record<string, unknown> = {}): KaadaError =>
  new KaadaError("AUTHORIZATION_REJECTED", `the signer refused: ${reason}`, {
    details: { reason, ...details },
  });

/**
 * THE signer boundary. Its only public method takes an execution ID. It loads the execution itself,
 * re-derives the plan from stored facts and fresh chain reads, re-validates everything, and only then
 * asks the restricted session key to sign ONE step: the next one that was never sent.
 *
 * What is NOT here: a method that signs bytes, a transaction, a typed-data payload or a UserOperation
 * a caller supplies; any parameter carrying calldata, an amount or an address; any use of the user's
 * passkey (root actions are a different path, completed by the user's own assertion); the PIN.
 *
 * A step that was already sent (or may have been) is never sent again: it is reported as in flight.
 */
export class ValidatedExecutionSigner implements ExecutionSigner {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: ValidatedSignerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async signValidatedExecution(executionId: string): Promise<SignedExecution> {
    const repositories = this.deps.unitOfWork.read;
    const loaded = await loadLiveExecution(repositories, this.deps.wallets, executionId);
    if (!loaded.ok) {
      throw refuse(loaded.reason === "NOT_FOUND" ? "PAYMENT_CHANGED" : loaded.reason, {
        loaded: loaded.reason,
      });
    }
    const { live } = loaded;
    const now = this.now();

    // 1. Execution rights: only an execution that has ACQUIRED them (SIGNING, or SUBMITTING for the final swap) and whose authorization
    //    was consumed FOR IT may sign anything.
    const { record, authorization } = live;
    if (
      (record.status !== "SIGNING" && record.status !== "SUBMITTING") ||
      !record.authorizationConsumedAt
    ) {
      throw refuse("EXECUTION_NOT_SIGNING", { status: record.status });
    }
    if (authorization.status !== "CONSUMED" || authorization.id !== record.paymentAuthorizationId) {
      throw refuse("AUTHORIZATION_NOT_CONSUMED_FOR_THIS_EXECUTION");
    }

    // 2. The operation must still fit what the person approved, judged as of the moment the
    //    authorization was consumed (the approval is spent; its bounds are not).
    const consumedAt = record.authorizationConsumedAt;
    const check = validateExecutionAgainstAuthorization(
      { ...authorization, status: "ACTIVE" },
      live.candidate,
      consumedAt,
    );
    if (!check.ok) throw refuse("OUTSIDE_AUTHORIZATION", { violations: check.violations });

    // 3. Re-derive the plan from stored facts and fresh reads, instead of trusting a stored copy.
    const plan = await this.freshPlan(live, now);
    if (plan.status !== "READY" || plan.blockers.length > 0) {
      throw refuse("PLAN_NOT_READY", { status: plan.status, blockers: plan.blockers });
    }
    if (
      plan.permissionRequirement.state !== "SATISFIED" ||
      plan.accountRequirements.deploymentRequired
    ) {
      throw refuse("PERMISSION_NOT_INSTALLED");
    }
    const permissionId = plan.permissionRequirement.existingPermissionId;
    const permission = permissionId
      ? ((await repositories.delegatedPermissions.findById(permissionId)) ?? undefined)
      : undefined;
    if (
      !permission ||
      permission.status !== "ACTIVE" ||
      !permission.installedAt ||
      !permission.sessionKeyAddress ||
      !permission.sessionKeySecretId ||
      !permission.approvalSecretId
    ) {
      throw refuse("PERMISSION_NOT_INSTALLED");
    }
    // The chain, not the database, is the authority on whether the permission exists.
    if (
      !(await this.deps.kernel.isPermissionInstalled({
        walletAddress: live.wallet.address,
        sessionKeyAddress: permission.sessionKeyAddress,
        scope: plan.permissionRequirement.scope,
      }))
    ) {
      throw refuse("PERMISSION_NOT_INSTALLED", { readBack: false });
    }

    // 4. The next step that was never sent. A step already sent, or that may have been, is never resent.
    const steps = plannedSteps(executionId, plan, live.transactions.swap);
    const next = await this.nextStep(steps);
    if (next.kind === "SWAP") {
      if (live.quote.expiresAt.getTime() - now.getTime() < this.deps.minWindowMs) {
        throw refuse("QUOTE_TOO_CLOSE_TO_EXPIRY");
      }
    }
    this.assertCallsAllowed(next, plan);

    // 5. Persist the attempt FIRST, then send once.
    const { transaction } = await repositories.executionTransactions.begin({
      idempotencyKey: next.key,
      executionId,
      type: next.type,
      chainId: live.quote.chainId,
      fromAddress: live.wallet.address,
      toAddress: next.toAddress,
      assetId: next.assetId,
      amount: next.amount,
      metadata: { step: next.kind },
    });
    if (transaction.status !== "CREATED") {
      throw refuse("STEP_IN_FLIGHT", { step: next.kind });
    }

    // 6. The restricted key and its enable data are decrypted only here, for this one send.
    const [keySecret, approvalSecret] = await Promise.all([
      repositories.executionSecrets.get(permission.sessionKeySecretId),
      repositories.executionSecrets.get(permission.approvalSecretId),
    ]);
    if (!keySecret || !approvalSecret) throw refuse("SESSION_KEY_UNAVAILABLE");

    try {
      const sent = await this.deps.kernel.sendDelegatedCalls({
        walletAddress: live.wallet.address,
        sessionKey: new SecretValue(
          this.deps.cipher.decrypt(keySecret.ciphertext, `session-key:${keySecret.id}`),
        ),
        approval: new SecretValue(
          this.deps.cipher.decrypt(
            approvalSecret.ciphertext,
            `permission-approval:${approvalSecret.id}`,
          ),
        ),
        calls: next.calls,
      });
      await repositories.executionTransactions.markSubmitted(transaction.id, {
        userOpHash: sent.userOpHash.toLowerCase(),
        now: this.now(),
      });
      this.log("info", "execution.step_sent", { executionId, step: next.kind });
      return { executionId, reference: sent.userOpHash.toLowerCase() };
    } catch (error) {
      if (error instanceof KaadaError && error.code === "BUNDLER_REJECTED") {
        // Definitely not sent: the bundler refused it.
        await repositories.executionTransactions.markNotSent(
          transaction.id,
          "BUNDLER_REJECTED",
          this.now(),
        );
      } else {
        // Anything else may have reached the bundler. It is NEVER resent; it is reconciled.
        await repositories.executionTransactions.markUnknown(transaction.id, this.now());
      }
      this.log("warn", "execution.step_send_failed", {
        executionId,
        step: next.kind,
        code: error instanceof KaadaError ? error.code : "UNKNOWN",
      });
      throw error;
    }
  }

  /** Builds the plan from stored facts and fresh read-only chain state. */
  private freshPlan(live: LiveExecution, now: Date): Promise<ExecutionPlan> {
    return freshPlan(
      {
        repositories: this.deps.unitOfWork.read,
        chain: this.deps.chain,
        infrastructure: this.deps.infrastructure,
        ...(this.deps.tokenPolicy && { tokenPolicy: this.deps.tokenPolicy }),
      },
      live,
      now,
    );
  }

  private async nextStep(steps: PlannedStep[]): Promise<PlannedStep> {
    const repositories = this.deps.unitOfWork.read;
    for (const step of steps) {
      const existing = await repositories.executionTransactions.findByKey(step.key);
      if (!existing || existing.status === "CREATED") {
        if (existing?.status === "CREATED") {
          // A row that was created but never marked sent: the earlier attempt died before sending or
          // while sending. It is not resent blindly: the earlier send is treated as possibly done.
          throw refuse("STEP_IN_FLIGHT", { step: step.kind, note: "created, outcome unknown" });
        }
        return step;
      }
      if (existing.status === "CONFIRMED") continue;
      if (existing.status === "FAILED") throw refuse("STEP_FAILED", { step: step.kind });
      throw refuse("STEP_IN_FLIGHT", { step: step.kind, status: existing.status });
    }
    throw refuse("NOTHING_TO_SIGN");
  }

  /** Every call must target an allowed contract, carry no native value (but the swap's own, always 0) and use an allowed selector. */
  private assertCallsAllowed(step: PlannedStep, plan: ExecutionPlan): void {
    const allowed = new Set(
      plan.permissionRequirement.scope.allowedContracts.map((a) => a.toLowerCase()),
    );
    for (const call of step.calls) {
      const selector = call.data.slice(0, 10).toLowerCase();
      const isSwapCall =
        step.kind === "SWAP" && call.to.toLowerCase() === plan.swapRequirement.target;
      if (
        !allowed.has(call.to.toLowerCase()) ||
        call.value !== "0" ||
        (!isSwapCall && !(ALLOWED_SELECTORS as readonly string[]).includes(selector))
      ) {
        throw refuse("CALL_NOT_ALLOWED", { step: step.kind });
      }
    }
  }
}
