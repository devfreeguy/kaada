import { createMoney, isPermissionUsable } from "@kaada/domain";
import type {
  AccountRequirements,
  Asset,
  DelegatedPermission,
  ExecutionPlan,
  FirmExecutionCandidate,
  FirmQuote,
  JsonObject,
  PaymentAuthorization,
  PermissionRequirement,
  PermissionScope,
  PlanBlocker,
  TokenApprovalRequirement,
  UnsignedTransactions,
  TokenPolicy,
  Wallet,
} from "@kaada/domain";
import { boundLimits } from "@kaada/domain";

import { inspectApprovalTransaction, inspectSwapTransaction } from "./approval-inspector.js";

/** A delegated permission for one payment is short: long enough to run it, never a standing grant. */
export const PERMISSION_WINDOW_MS = 15 * 60 * 1000;

export interface PlanInputs {
  candidate: FirmExecutionCandidate;
  quote: FirmQuote;
  transactions: UnsignedTransactions;
  claimTokenStored: boolean;
  authorization: PaymentAuthorization;
  wallet: Wallet & { address: string };
  sellAsset: Asset & { contractAddress: string };
  /** The token the recipient is paid in; it is transferred out by the payout leg. */
  buyAsset: Asset & { contractAddress: string };
  tokenPolicy: TokenPolicy;
  /** Read-only: the allowance the wallet has already granted the spender. */
  currentAllowance: bigint;
  /** Read-only: whether the Kernel account exists on chain. */
  deployed: boolean;
  passkeyRootAvailable: boolean;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  permissions: readonly DelegatedPermission[];
  now: Date;
}

const sameSet = (have: readonly string[], need: readonly string[]) =>
  need.every((item) => have.some((h) => h.toLowerCase() === item.toLowerCase()));

/**
 * Assembles the pre-signing plan. Pure: it reads the values it is given and returns a description of
 * what execution would need. It performs no write, no signature and no chain call.
 */
export function buildExecutionPlan(input: PlanInputs): ExecutionPlan {
  const { quote, transactions, authorization, wallet, sellAsset, now } = input;
  const blockers: PlanBlocker[] = [];

  if (quote.taker.toLowerCase() !== wallet.address.toLowerCase()) blockers.push("TAKER_MISMATCH");

  // ── token approval: read, then inspect what the provider wants approved
  const spender = quote.spender ?? quote.reactor;
  const required = BigInt(quote.input.amount);
  let approvalNeeded = input.currentAllowance < required;
  const approvals: TokenApprovalRequirement[] = [];
  if (spender === undefined) {
    blockers.push("APPROVAL_TARGET_MISMATCH");
  } else {
    // The provider's approval calldata is inspected even when no approval turns out to be needed, so
    // a hostile or mistaken one is flagged before anyone is asked to sign anything.
    const inspection = inspectApprovalTransaction(transactions.approval, {
      chainId: quote.chainId,
      token: sellAsset.contractAddress,
      spender,
      requiredAmount: required,
    });
    if (approvalNeeded) blockers.push(...inspection.blockers);
    approvals.push({
      assetId: sellAsset.id,
      tokenAddress: sellAsset.contractAddress.toLowerCase(),
      owner: wallet.address.toLowerCase(),
      spender: spender.toLowerCase(),
      currentAllowance: input.currentAllowance.toString(),
      requiredAllowance: required.toString(),
      required: approvalNeeded,
      // Token-specific quirks live in the token policy, not in this code.
      resetToZeroFirst:
        approvalNeeded &&
        input.currentAllowance > 0n &&
        input.tokenPolicy.requiresZeroResetBeforeChange({
          chainId: quote.chainId,
          symbol: sellAsset.symbol,
          address: sellAsset.contractAddress,
        }),
      signer: "DELEGATED_SIGNER",
    });
  }
  approvalNeeded = approvals.some((approval) => approval.required);
  blockers.push(...inspectSwapTransaction(transactions.swap, { chainId: quote.chainId }));

  // ── delegated permission: only an ACTIVE, installed one that covers THIS payment counts
  const { maxInput } = boundLimits(authorization.bounds);
  // The wallet receives the swap output, so the recipient is paid by a transfer in the same
  // UserOperation. It needs a destination address; without one the payment cannot execute.
  const recipientAddress = input.candidate.recipient.address?.toLowerCase();
  if (!recipientAddress) blockers.push("RECIPIENT_ADDRESS_REQUIRED");
  const needsContracts = [
    ...(approvalNeeded ? [sellAsset.contractAddress.toLowerCase()] : []),
    transactions.swap.to.toLowerCase(),
    input.buyAsset.contractAddress.toLowerCase(),
  ];
  const needsOperations: PermissionScope["allowedOperations"] = approvalNeeded
    ? ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"]
    : ["EXECUTE_SWAP", "TRANSFER_TOKEN"];
  const mustLastUntil = quote.latestOrderDeadline ?? quote.expiresAt;
  const scope: PermissionScope = {
    chainId: quote.chainId,
    allowedOperations: needsOperations,
    allowedContracts: [...new Set(needsContracts)],
    allowedAssetIds: [sellAsset.id, input.buyAsset.id],
    swapTarget: transactions.swap.to.toLowerCase(),
    swapSelector: transactions.swap.data.slice(0, 10).toLowerCase(),
    ...(approvalNeeded &&
      spender !== undefined && {
        approval: {
          tokenAddress: sellAsset.contractAddress.toLowerCase(),
          spender: spender.toLowerCase(),
          // The exact allowance this quote needs, never more.
          limit: createMoney(required.toString(), sellAsset.id),
        },
      }),
    // Never above the authorized maximum spend.
    perTransactionLimit: maxInput,
    // The payout may go to this one recipient and no more than the firm output.
    ...(recipientAddress && {
      payout: {
        assetId: input.buyAsset.id,
        tokenAddress: input.buyAsset.contractAddress.toLowerCase(),
        recipient: recipientAddress,
        limit: quote.output,
      },
    }),
    validFrom: now,
    expiresAt: new Date(now.getTime() + PERMISSION_WINDOW_MS),
  };
  const covering = input.permissions.find(
    (permission) =>
      isPermissionUsable(permission, now) &&
      permission.providerPermissionId !== undefined &&
      permission.chainId === scope.chainId &&
      sameSet(permission.allowedOperations, scope.allowedOperations) &&
      sameSet(permission.allowedContracts, scope.allowedContracts) &&
      sameSet(permission.allowedAssetIds, scope.allowedAssetIds) &&
      permission.perTransactionLimit.assetId === maxInput.assetId &&
      BigInt(permission.perTransactionLimit.amount) >= BigInt(maxInput.amount) &&
      permission.expiresAt.getTime() > mustLastUntil.getTime(),
  );
  const permissionRequirement: PermissionRequirement = covering
    ? {
        state: "SATISFIED",
        existingPermissionId: covering.id,
        scope,
        installSigner: "ROOT_PASSKEY",
      }
    : { state: "INSTALLATION_REQUIRED", scope, installSigner: "ROOT_PASSKEY" };

  // ── account
  const deploymentRequired = !input.deployed;
  const rootSignatureRequired =
    deploymentRequired || permissionRequirement.state === "INSTALLATION_REQUIRED";
  if (rootSignatureRequired && !input.passkeyRootAvailable) blockers.push("NO_PASSKEY_ROOT");
  const accountRequirements: AccountRequirements = {
    deploymentRequired,
    rootSignatureRequired,
    passkeyRootAvailable: input.passkeyRootAvailable,
    infrastructure: input.infrastructure,
  };

  const signingPrerequisites = [
    ...(input.infrastructure.rpcConfigured ? [] : ["RPC_NOT_CONFIGURED"]),
    ...(input.infrastructure.bundlerConfigured ? [] : ["BUNDLER_NOT_CONFIGURED"]),
  ];

  const status: ExecutionPlan["status"] =
    quote.expiresAt.getTime() <= now.getTime()
      ? "EXPIRED"
      : blockers.length > 0
        ? "BLOCKED"
        : "READY";

  return {
    candidate: input.candidate,
    accountRequirements,
    permissionRequirement,
    approvalRequirements: approvals,
    payoutRequirement: {
      assetId: input.buyAsset.id,
      tokenAddress: input.buyAsset.contractAddress.toLowerCase(),
      recipient: recipientAddress ?? "",
      amount: quote.output.amount,
      signer: "DELEGATED_SIGNER",
    },
    swapRequirement: {
      provider: quote.provider,
      providerQuoteId: quote.providerQuoteId,
      target: transactions.swap.to.toLowerCase(),
      nativeValue: transactions.swap.value,
      input: quote.input,
      output: quote.output,
      expiresAt: quote.expiresAt,
      claimTokenStored: input.claimTokenStored,
      signer: "DELEGATED_SIGNER",
    },
    signingPrerequisites,
    blockers: [...new Set(blockers)],
    expiresAt: quote.expiresAt,
    status,
  };
}

/** JSON-safe form of a plan for storage and display: dates as ISO text. Contains no secret. */
export function serializePlan(plan: ExecutionPlan): JsonObject {
  return JSON.parse(
    JSON.stringify(plan, (_key, value: unknown) =>
      value instanceof Date ? value.toISOString() : value,
    ),
  ) as JsonObject;
}
