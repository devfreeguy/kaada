import {
  PERMIT2,
  createMoney,
  encodePermit2Approve,
  isPermissionUsable,
  isTrustedPermit2Spender,
  permissionScopeKey,
  permit2AllowanceCovers,
  permit2GrantAmount,
} from "@kaada/domain";
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
  Permit2Allowance,
  Permit2GrantPolicy,
  PlanBlocker,
  SetupRequirement,
  StandingConversionPolicy,
  TokenApprovalRequirement,
  UnsignedTransactions,
  TokenPolicy,
  TransferExecutionPlan,
  Wallet,
} from "@kaada/domain";
import { boundLimits, standingLimitAmount } from "@kaada/domain";

import { inspectApprovalTransaction, inspectSwapTransaction } from "./approval-inspector.js";

/**
 * A delegated permission for one payment is short: long enough to run it. The one exception is a conversion between a
 * person's own currencies, which can use the standing policy below instead.
 */
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
  /**
   * Read-only: the Permit2 allowance the wallet has already granted the swap target, when the quote's
   * spender IS Permit2. Omitted for a provider that does not route through it.
   */
  currentPermit2Allowance?: Permit2Allowance;
  /**
   * How much a one-time Permit2 grant covers (in whole tokens, scaled by the token's decimals here) and for how
   * long. Generous on purpose, and safe because of where the real limit sits: Permit2 moves tokens by calling
   * `transferFrom` on the token itself, so it can never move more than the ERC-20 allowance granted to it, and Kaada
   * keeps THAT bounded to exactly one swap's input on every payment. Verified on chain: with a 1,000 cNGN Permit2
   * allowance and a 10 cNGN ERC-20 one, a 100 cNGN swap reverts with TRANSFER_FROM_FAILED.
   */
  permit2Grant?: Permit2GrantPolicy;
  /**
   * When present, a CONVERSION (the output is paid back to the same wallet) gets a standing permission pinned to
   * ceilings instead of this one payment's exact amounts, so the same pair can be converted again without installing
   * anything new. Absent, every payment gets an exact, short-lived permission as before. Never applied to a SEND.
   */
  standingConversion?: StandingConversionPolicy;
  /** Read-only: whether the Kernel account exists on chain. */
  deployed: boolean;
  rootAvailable: boolean;
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

  /*
   * The SECOND allowance a Permit2-routed swap needs: Permit2 -> the swap target.
   *
   * Only when the quote's spender is Permit2, which is how a provider says it routes that way. The
   * grant is `Permit2.approve(token, target, amount, expiration)`, whose four-argument selector is
   * deliberately NOT in the payment path's allowlist: a restricted session key may not make it. So it
   * is listed here as a one-time setup call for the ROOT to sign, beside the account deployment and
   * the permission install, and the payment path is untouched.
   *
   * Nothing is listed when the wallet already has a grant that covers this swap, so the root is asked
   * once per token rather than once per payment.
   */
  const setupRequirements: SetupRequirement[] = [];
  if (spender !== undefined && spender.toLowerCase() === PERMIT2) {
    const target = transactions.swap.to.toLowerCase();
    const grant = input.permit2Grant;
    const covered =
      input.currentPermit2Allowance !== undefined &&
      permit2AllowanceCovers(input.currentPermit2Allowance, required, now);
    /*
     * The swap target must be a contract Kaada has deliberately decided may hold a Permit2 allowance. It arrives in the
     * provider's API response, and the grant below is signed by the ROOT: a passkey tap the person cannot inspect. Taken
     * on trust, a hostile response turns one routine confirmation into a standing allowance for an attacker. Checked
     * whether or not a grant is currently needed, because the same address also becomes the permission's swap target.
     */
    if (!isTrustedPermit2Spender(quote.chainId, target)) {
      blockers.push("PERMIT2_SPENDER_NOT_TRUSTED");
    } else if (!covered) {
      if (!grant) {
        // The plan cannot describe a grant it was given no size for, and must not invent one.
        blockers.push("PERMIT2_GRANT_UNAVAILABLE");
      } else {
        setupRequirements.push({
          purpose: "PERMIT2_ROUTER_ALLOWANCE",
          to: PERMIT2,
          data: encodePermit2Approve({
            token: sellAsset.contractAddress,
            spender: target,
            amount: permit2GrantAmount(grant, sellAsset.decimals),
            expiration: BigInt(Math.floor(now.getTime() / 1000)) + grant.durationSeconds,
          }),
          value: "0",
          assetId: sellAsset.id,
          signer: "ROOT",
        });
      }
    }
  }

  // ── delegated permission: only an ACTIVE, installed one that covers THIS payment counts
  const { maxInput } = boundLimits(authorization.bounds);
  // The wallet receives the swap output, so the recipient is paid by a transfer in the same
  // UserOperation. It needs a destination address; without one the payment cannot execute.
  //
  // A CONVERSION has no recipient, and used to be blocked here for not having one — so swapping your own naira for
  // your own dollars priced, authorized, asked for a PIN, and then failed with "the payment didn't go through". The
  // money was never going anywhere: it is already in the wallet once the swap settles.
  //
  // So it pays out to the same wallet. The transfer leg is kept rather than removed because the validated signer
  // asserts the exact shape of this UserOperation, and a conversion must not be the one shape that skips that check.
  // Balance-neutral, a little gas, and the output ends where it was always going to end.
  //
  // A SEND with no address is still blocked: there the money is meant to leave, and having nowhere to send it is a
  // real fault rather than a shape of payment.
  const recipientAddress =
    input.candidate.recipient.address?.toLowerCase() ??
    (input.candidate.operation === "CONVERT" ? wallet.address.toLowerCase() : undefined);
  if (!recipientAddress) blockers.push("RECIPIENT_ADDRESS_REQUIRED");
  // The permission must NOT depend on the allowance as it is right now: the allowance changes mid-run
  // (the approval confirms, then the plan is re-derived with "no approval needed"), and a scope that
  // shrank would no longer match what was installed. So the approval leg is part of the scope whenever the
  // quote has a spender, pinned to that spender and the exact amount, whether or not it is used.
  const approvalPossible = spender !== undefined;
  const needsContracts = [
    ...(approvalPossible ? [sellAsset.contractAddress.toLowerCase()] : []),
    transactions.swap.to.toLowerCase(),
    input.buyAsset.contractAddress.toLowerCase(),
  ];
  const needsOperations: PermissionScope["allowedOperations"] = approvalPossible
    ? ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"]
    : ["EXECUTE_SWAP", "TRANSFER_TOKEN"];
  const mustLastUntil = quote.latestOrderDeadline ?? quote.expiresAt;
  /*
   * A conversion's output goes back to the wallet it came from, so nothing can leave: the payout recipient is the
   * wallet itself, whatever the amount. That is what makes a STANDING permission safe to install once. Its ceilings
   * are fixed per token instead of being this payment's exact figures, so the next conversion of the same pair has an
   * identical scope and reuses it. If this payment is larger than the ceiling, it falls back to the exact scope.
   */
  const standing =
    input.standingConversion !== undefined &&
    input.candidate.operation === "CONVERT" &&
    recipientAddress === wallet.address.toLowerCase()
      ? (() => {
          const sellCap = standingLimitAmount(input.standingConversion, sellAsset.decimals);
          const buyCap = standingLimitAmount(input.standingConversion, input.buyAsset.decimals);
          return sellCap >= required &&
            sellCap >= BigInt(maxInput.amount) &&
            buyCap >= BigInt(quote.output.amount)
            ? { policy: input.standingConversion, sellCap, buyCap }
            : undefined;
        })()
      : undefined;
  const scope: PermissionScope = {
    chainId: quote.chainId,
    allowedOperations: needsOperations,
    allowedContracts: [...new Set(needsContracts)],
    allowedAssetIds: [sellAsset.id, input.buyAsset.id],
    swapTarget: transactions.swap.to.toLowerCase(),
    swapSelector: transactions.swap.data.slice(0, 10).toLowerCase(),
    ...(approvalPossible && {
      approval: {
        tokenAddress: sellAsset.contractAddress.toLowerCase(),
        spender: spender.toLowerCase(),
        // The exact allowance this quote needs, never more (a standing conversion pins its ceiling instead).
        limit: createMoney((standing?.sellCap ?? required).toString(), sellAsset.id),
      },
    }),
    // Never above the authorized maximum spend (a standing conversion pins its ceiling instead).
    perTransactionLimit: standing
      ? createMoney(standing.sellCap.toString(), sellAsset.id)
      : maxInput,
    // The payout may go to this one recipient and no more than the firm output.
    ...(recipientAddress && {
      payout: {
        assetId: input.buyAsset.id,
        tokenAddress: input.buyAsset.contractAddress.toLowerCase(),
        recipient: recipientAddress,
        limit: standing ? createMoney(standing.buyCap.toString(), input.buyAsset.id) : quote.output,
      },
    }),
    validFrom: now,
    expiresAt: new Date(now.getTime() + (standing?.policy.windowMs ?? PERMISSION_WINDOW_MS)),
  };
  const covering = input.permissions.find(
    (permission) =>
      isPermissionUsable(permission, now) &&
      permission.providerPermissionId !== undefined &&
      permission.chainId === scope.chainId &&
      sameSet(permission.allowedOperations, scope.allowedOperations) &&
      sameSet(permission.allowedContracts, scope.allowedContracts) &&
      sameSet(permission.allowedAssetIds, scope.allowedAssetIds) &&
      /*
       * Identical on-chain pins, not just similar sets. The recipient and the amounts are pinned on chain by the
       * permission's call policies, and the signer reads the exact scope back before it signs anything. A permission
       * that merely shares contracts and assets with this payment (a different recipient, a larger amount) would be
       * planned as covered here and then refused at signing, and a retry would hit the same wall until it expired.
       * A permission with no key, created before the key existed, is never reused.
       */
      permission.scopeKey === permissionScopeKey(scope) &&
      permission.perTransactionLimit.assetId === maxInput.assetId &&
      BigInt(permission.perTransactionLimit.amount) >= BigInt(maxInput.amount) &&
      permission.expiresAt.getTime() > mustLastUntil.getTime(),
  );
  const permissionRequirement: PermissionRequirement = covering
    ? {
        state: "SATISFIED",
        existingPermissionId: covering.id,
        scope,
        installSigner: "ROOT",
      }
    : { state: "INSTALLATION_REQUIRED", scope, installSigner: "ROOT" };

  // ── account
  const deploymentRequired = !input.deployed;
  // A setup call is signed by the root, so needing one needs the root — even when the account exists
  // and its permission is already installed. Without this a payment would reach the signer, send a
  // swap with no Permit2 grant behind it, and revert on chain for want of a signature nobody asked for.
  const rootSignatureRequired =
    deploymentRequired ||
    permissionRequirement.state === "INSTALLATION_REQUIRED" ||
    setupRequirements.length > 0;
  if (rootSignatureRequired && !input.rootAvailable) blockers.push("NO_ROOT");
  const accountRequirements: AccountRequirements = {
    deploymentRequired,
    rootSignatureRequired,
    rootAvailable: input.rootAvailable,
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
    setupRequirements,
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
export function serializePlan(plan: ExecutionPlan | TransferExecutionPlan): JsonObject {
  return JSON.parse(
    JSON.stringify(plan, (_key, value: unknown) =>
      value instanceof Date ? value.toISOString() : value,
    ),
  ) as JsonObject;
}
