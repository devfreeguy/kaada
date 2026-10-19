import {
  CELO_CHAIN_ID,
  boundLimits,
  createMoney,
  isPermissionUsable,
  isWalletActive,
} from "@kaada/domain";
import type {
  AccountRequirements,
  Asset,
  DelegatedPermission,
  ExecutionCandidate,
  ExecutionPlanRecord,
  Intent,
  PaymentAuthorization,
  PaymentRoute,
  PermissionRequirement,
  PermissionScope,
  PlanBlocker,
  TransferExecutionPlan,
  Wallet,
} from "@kaada/domain";

import { hasRoot } from "../roots/root-credentials.js";
import { PERMISSION_WINDOW_MS } from "./plan-builder.js";
import type { ExecutionRepositories } from "./ports.js";
import { encodeTransfer, stepKey } from "./steps.js";
import type { PlannedStep } from "./steps.js";

/**
 * A DIRECT transfer: the payment is already in the right currency, so the token goes from the wallet to the recipient. No swap,
 * no provider, no firm quote and no price to confirm. The whole on-chain job is one ERC-20 `transfer(recipient, amount)` sent by
 * the restricted session key, under a permission that allows that one transfer and nothing else.
 *
 * Everything that makes a swap payment safe applies here too, unchanged: the person's PIN authorization bounds it, the
 * authorization is consumed in the same atomic step that takes execution rights, a step that was sent (or may have been) is never
 * sent again, and the chain, not the database, is asked whether the permission for exactly this payment exists.
 */

/** A route is a direct transfer when its ONLY step is a transfer. */
export function isDirectTransferRoute(route: Pick<PaymentRoute, "steps">): boolean {
  return route.steps.length === 1 && route.steps[0]?.type === "TRANSFER";
}

/** Whether a stored plan (or plan record) is a direct-transfer plan. */
export function isTransferPlan(plan: unknown): boolean {
  return (
    typeof plan === "object" && plan !== null && (plan as { kind?: unknown }).kind === "TRANSFER"
  );
}

export const isTransferRecord = (record: Pick<ExecutionPlanRecord, "plan">): boolean =>
  isTransferPlan(record.plan);

/** The delegated permission must outlast "now" by this much to be worth using: the send follows right after the check. */
export const MIN_PERMISSION_REMAINING_MS = 60_000;

const sameSet = (have: readonly string[], need: readonly string[]) =>
  need.every((item) => have.some((h) => h.toLowerCase() === item.toLowerCase())) &&
  have.every((item) => need.some((n) => n.toLowerCase() === item.toLowerCase()));

/** The exact proposed operation, from the live intent, route and recipient. Never from a caller. */
export function transferCandidate(input: {
  authorization: PaymentAuthorization;
  intent: Pick<Intent, "id" | "revision" | "recipientId"> & { type: "SEND" | "CONVERT" };
  walletId: string;
  chainId: number;
  assetId: string;
  amount: string;
  recipientAddress: string | undefined;
}): ExecutionCandidate {
  const address = input.recipientAddress?.toLowerCase();
  return {
    userId: input.authorization.userId,
    walletId: input.walletId,
    chainId: input.chainId,
    intentRevision: input.intent.revision,
    operation: input.intent.type,
    recipient: {
      ...(input.intent.recipientId && { recipientId: input.intent.recipientId }),
      ...(address && /^0x[0-9a-f]{40}$/.test(address) && { address }),
    },
    input: createMoney(input.amount, input.assetId),
    output: createMoney(input.amount, input.assetId),
    route: { assetPath: [input.assetId], providers: [] },
  };
}

export interface TransferPlanInputs {
  candidate: ExecutionCandidate;
  authorization: PaymentAuthorization;
  wallet: Wallet & { address: string };
  asset: Asset & { contractAddress: string };
  /** Read-only: whether the Kernel account exists on chain. */
  deployed: boolean;
  rootAvailable: boolean;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  permissions: readonly DelegatedPermission[];
  now: Date;
}

/**
 * Assembles the pre-signing plan of a direct transfer. Pure: it performs no write, no signature and no chain call. The scope it
 * produces lets the session key do ONE thing: `transfer` this token, to this recipient, up to this amount, within 15 minutes.
 */
export function buildTransferPlan(input: TransferPlanInputs): TransferExecutionPlan {
  const { candidate, authorization, asset, now } = input;
  const blockers: PlanBlocker[] = [];

  const recipientAddress = candidate.recipient.address?.toLowerCase();
  if (!recipientAddress) blockers.push("RECIPIENT_ADDRESS_REQUIRED");

  const amount = candidate.output;
  const scope: PermissionScope = {
    chainId: candidate.chainId,
    allowedOperations: ["TRANSFER_TOKEN"],
    allowedContracts: [asset.contractAddress.toLowerCase()],
    allowedAssetIds: [asset.id],
    // Exactly this payment, never more.
    perTransactionLimit: amount,
    ...(recipientAddress && {
      payout: {
        assetId: asset.id,
        tokenAddress: asset.contractAddress.toLowerCase(),
        recipient: recipientAddress,
        limit: amount,
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
      permission.perTransactionLimit.assetId === amount.assetId &&
      BigInt(permission.perTransactionLimit.amount) >= BigInt(amount.amount) &&
      permission.expiresAt.getTime() > now.getTime() + MIN_PERMISSION_REMAINING_MS,
  );
  // The database only proposes a candidate: the runner and the signer both ask the CHAIN whether this exact scope (recipient
  // and ceiling included) is installed, so a permission made for another recipient can never carry this payment.
  const permissionRequirement: PermissionRequirement = covering
    ? { state: "SATISFIED", existingPermissionId: covering.id, scope, installSigner: "ROOT" }
    : { state: "INSTALLATION_REQUIRED", scope, installSigner: "ROOT" };

  const deploymentRequired = !input.deployed;
  const rootSignatureRequired =
    deploymentRequired || permissionRequirement.state === "INSTALLATION_REQUIRED";
  if (rootSignatureRequired && !input.rootAvailable) blockers.push("NO_ROOT");
  const accountRequirements: AccountRequirements = {
    deploymentRequired,
    rootSignatureRequired,
    rootAvailable: input.rootAvailable,
    infrastructure: input.infrastructure,
  };

  const status: TransferExecutionPlan["status"] =
    authorization.expiresAt.getTime() <= now.getTime()
      ? "EXPIRED"
      : blockers.length > 0
        ? "BLOCKED"
        : "READY";

  return {
    kind: "TRANSFER",
    candidate,
    accountRequirements,
    permissionRequirement,
    payoutRequirement: {
      assetId: asset.id,
      tokenAddress: asset.contractAddress.toLowerCase(),
      recipient: recipientAddress ?? "",
      amount: amount.amount,
      signer: "DELEGATED_SIGNER",
    },
    signingPrerequisites: [
      ...(input.infrastructure.rpcConfigured ? [] : ["RPC_NOT_CONFIGURED"]),
      ...(input.infrastructure.bundlerConfigured ? [] : ["BUNDLER_NOT_CONFIGURED"]),
    ],
    blockers: [...new Set(blockers)],
    expiresAt: authorization.expiresAt,
    status,
  };
}

export interface FreshTransferPlanDeps {
  repositories: ExecutionRepositories;
  chain: { isDeployed(input: { chainId: number; address: string }): Promise<boolean> };
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
}

/**
 * The plan for a transfer execution, re-derived from stored facts plus fresh READ-ONLY chain state (whether the account exists,
 * the wallet's permissions and root). Nothing here trusts a plan stored earlier, and nothing writes.
 */
export async function freshTransferPlan(
  deps: FreshTransferPlanDeps,
  live: LiveTransfer,
  now: Date,
): Promise<TransferExecutionPlan> {
  const [deployed, rootAvailable, permissions] = await Promise.all([
    deps.chain.isDeployed({ chainId: live.wallet.chainId, address: live.wallet.address }),
    hasRoot(deps.repositories, live.wallet),
    deps.repositories.delegatedPermissions.listForWallet(live.wallet.id),
  ]);
  return buildTransferPlan({
    candidate: live.candidate,
    authorization: live.authorization,
    wallet: live.wallet,
    asset: live.asset,
    deployed,
    rootAvailable,
    infrastructure: deps.infrastructure,
    permissions,
    now,
  });
}

/** The one on-chain step: `transfer(recipient, amount)` on the token, no native value. Derived ONLY from a validated plan. */
export function plannedTransferStep(executionId: string, plan: TransferExecutionPlan): PlannedStep {
  const payout = plan.payoutRequirement;
  return {
    kind: "TRANSFER",
    key: stepKey(executionId, "TRANSFER"),
    type: "TRANSFER",
    calls: [
      {
        to: payout.tokenAddress,
        data: encodeTransfer(payout.recipient, BigInt(payout.amount)),
        value: "0",
      },
    ],
    toAddress: payout.recipient,
    assetId: payout.assetId,
    amount: payout.amount,
  };
}

/** Everything a transfer step is allowed to rely on, re-read from storage just now. */
export interface LiveTransfer {
  record: ExecutionPlanRecord;
  authorization: PaymentAuthorization;
  intent: Intent & { type: "SEND" | "CONVERT" };
  route: PaymentRoute;
  wallet: Wallet & { address: string };
  asset: Asset & { contractAddress: string };
  recipientAddress: string | undefined;
  amount: string;
  candidate: ExecutionCandidate;
}

export type LiveTransferResult =
  | { ok: true; live: LiveTransfer }
  | { ok: false; reason: "NOT_FOUND" | "PAYMENT_CHANGED" | "WALLET_NOT_ACTIVE" };

/**
 * Loads a transfer execution from STORAGE and checks it is still the payment that was authorized: same intent revision, a
 * still-valid route that is a single transfer, the user's own active Celo wallet. Callers never pass calldata or amounts.
 */
export async function loadLiveTransfer(
  repositories: ExecutionRepositories,
  wallets: { getWallet(userId: string): Promise<Wallet | null> },
  executionId: string,
): Promise<LiveTransferResult> {
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
    route.id !== authorization.routeId ||
    !isDirectTransferRoute(route) ||
    route.input.assetId !== route.output.assetId ||
    route.input.amount !== route.output.amount
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
  // The authorized ceiling and floor must be this very token: a transfer cannot change currency.
  const { maxInput, minOutput } = boundLimits(authorization.bounds);
  if (maxInput.assetId !== route.input.assetId || minOutput.assetId !== route.input.assetId) {
    return { ok: false, reason: "PAYMENT_CHANGED" };
  }
  const asset = await repositories.assets.findById(route.input.assetId);
  if (!asset?.contractAddress) return { ok: false, reason: "PAYMENT_CHANGED" };
  const recipient = intent.recipientId
    ? await repositories.recipients.findById(intent.recipientId)
    : null;
  const amount = route.input.amount;
  return {
    ok: true,
    live: {
      record,
      authorization,
      intent: intent as Intent & { type: "SEND" | "CONVERT" },
      route,
      wallet,
      asset: asset as Asset & { contractAddress: string },
      recipientAddress: recipient?.walletAddress,
      amount,
      candidate: transferCandidate({
        authorization,
        intent: intent as Intent & { type: "SEND" | "CONVERT" },
        walletId: wallet.id,
        chainId: wallet.chainId,
        assetId: asset.id,
        amount,
        recipientAddress: recipient?.walletAddress,
      }),
    },
  };
}
