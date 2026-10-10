import {
  CELO_CHAIN_ID,
  KaadaError,
  WALLET_AUDIT_EVENTS,
  compareMoney,
  createAssetRegistry,
  createId,
  evmAddressCodec,
  isWalletActive,
  isPermissionUsable,
} from "@kaada/domain";
import type {
  DelegatedPermission,
  FirmQuoteContext,
  PaymentRoute,
  PermissionOperation,
  PermissionRequest,
  RootCredential,
  Wallet,
  WalletPolicyAdapter,
  WalletProvisioningAdapter,
  WalletStatus,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { WalletRepositories, WalletUnitOfWork } from "./ports.js";

/** The longest a delegated permission may live. Short on purpose: it is renewed, not left open. */
export const MAX_PERMISSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WalletServiceDeps {
  unitOfWork: WalletUnitOfWork;
  provisioning: WalletProvisioningAdapter;
  policy: WalletPolicyAdapter;
  now?: () => Date;
  log?: AgentLog;
}

/**
 * Wallet lifecycle: provisioning, status, delegated permissions and the taker address. It talks to
 * the wallet stack only through the Kaada-owned adapter interfaces, and it never touches a key, a
 * signer or a session secret: there is nothing here that can sign.
 *
 * The AgentService may read a wallet through this service; it cannot sign, and this service cannot
 * either.
 */
export class WalletService {
  private readonly uow: WalletUnitOfWork;
  private readonly provisioning: WalletProvisioningAdapter;
  private readonly policy: WalletPolicyAdapter;
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(deps: WalletServiceDeps) {
    this.uow = deps.unitOfWork;
    this.provisioning = deps.provisioning;
    this.policy = deps.policy;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  /** The user's embedded Celo wallet in whatever state it is in, or null. Read-only. */
  getWallet(userId: string): Promise<Wallet | null> {
    return this.uow.read.wallets.findEmbedded(userId, CELO_CHAIN_ID);
  }

  /** The address of an ACTIVE wallet, or WALLET_NOT_ACTIVE. The only source of a taker address. */
  async requireActiveAddress(userId: string): Promise<string> {
    const wallet = await this.getWallet(userId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "the user has no active wallet");
    }
    return wallet.address;
  }

  /**
   * What a future firm Textile quote is given. The taker is the user's own wallet address from here,
   * never a value from a request. Nothing requests a firm quote yet.
   */
  async firmQuoteContext(input: {
    userId: string;
    intentId: string;
    intentRevision: number;
    route: PaymentRoute;
  }): Promise<FirmQuoteContext> {
    return {
      takerAddress: await this.requireActiveAddress(input.userId),
      intentId: input.intentId,
      intentRevision: input.intentRevision,
      route: input.route,
    };
  }

  /**
   * Returns the user's embedded wallet, provisioning it if needed. Idempotent and safe under
   * concurrency: provisioning decisions are serialised per user by a row lock, the database allows
   * one non-revoked embedded wallet per user and chain, and the address derivation is deterministic,
   * so a retry (or two callers at once) ends in the same single ACTIVE wallet.
   *
   * Needs the user's root passkey (public data), so a user who has not registered one gets
   * ROOT_CREDENTIAL_REQUIRED. A provider failure leaves the wallet PROVISIONING with a reason code
   * for the next call to resume.
   */
  async ensureEmbeddedWallet(userId: string): Promise<Wallet> {
    const started = await this.uow.transaction(async (repositories) => {
      await repositories.wallets.lockUser(userId);
      const existing = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
      if (existing && existing.status !== "PROVISIONING") return { done: existing } as const;

      const [root] = await repositories.passkeys.listActiveForUser(userId);
      if (!root) {
        throw new KaadaError(
          "ROOT_CREDENTIAL_REQUIRED",
          "register a passkey before creating a wallet",
        );
      }
      if (existing) return { wallet: existing, root: toRoot(root) } as const;

      const created = await repositories.wallets.create({
        id: createId(),
        userId,
        chainId: CELO_CHAIN_ID,
        isPrimary: true,
        type: "EMBEDDED",
        status: "PROVISIONING",
        deployment: "NOT_APPLICABLE",
      });
      await this.audit(repositories, userId, WALLET_AUDIT_EVENTS.provisioningStarted, created.id);
      return { wallet: created, root: toRoot(root) } as const;
    });
    if ("done" in started) return started.done;

    // The provider call is outside any transaction.
    let account;
    let address: string;
    try {
      account = await this.provisioning.deriveAccount({
        chainId: CELO_CHAIN_ID,
        root: started.root,
      });
      // An address that is not a valid EVM address is a provider failure, not a stored wallet.
      address = evmAddressCodec.normalize(account.address);
    } catch (error) {
      const reason = error instanceof KaadaError ? error.code : "PROVIDER_ERROR";
      await this.uow.transaction(async (repositories) => {
        await repositories.wallets.recordFailure(started.wallet.id, reason);
        await this.audit(
          repositories,
          userId,
          WALLET_AUDIT_EVENTS.provisioningFailed,
          started.wallet.id,
          {
            reason,
          },
        );
      });
      this.log("error", "wallet.provisioning_failed", {
        userId,
        walletId: started.wallet.id,
        reason,
      });
      throw new KaadaError(
        "WALLET_PROVISIONING_FAILED",
        "the wallet could not be provisioned right now",
        {
          details: { reason },
        },
      );
    }

    return this.uow.transaction(async (repositories) => {
      await repositories.wallets.lockUser(userId);
      const activated = await repositories.wallets.activate(started.wallet.id, {
        address,
        deployment: account.deployment,
        provider: account.provider,
        ...(account.providerAccountId && { providerAccountId: account.providerAccountId }),
        at: this.now(),
      });
      if (activated) {
        await this.audit(repositories, userId, WALLET_AUDIT_EVENTS.provisioned, activated.id, {
          deployment: activated.deployment,
          provider: activated.provider ?? "",
        });
        return activated;
      }
      // A concurrent call finished first: return the one wallet that exists.
      const current = await repositories.wallets.findById(started.wallet.id);
      if (!current) throw new KaadaError("WALLET_PROVISIONING_FAILED", "the wallet disappeared");
      return current;
    });
  }

  /** ACTIVE -> SUSPENDED. A suspended wallet is not usable until reactivated. */
  suspend(walletId: string, reason: string): Promise<Wallet> {
    return this.transition(
      walletId,
      ["ACTIVE"],
      "SUSPENDED",
      reason,
      WALLET_AUDIT_EVENTS.suspended,
    );
  }

  /** SUSPENDED -> ACTIVE. */
  reactivate(walletId: string): Promise<Wallet> {
    return this.transition(
      walletId,
      ["SUSPENDED"],
      "ACTIVE",
      undefined,
      WALLET_AUDIT_EVENTS.reactivated,
    );
  }

  /** The root authority is lost or compromised; spending stays blocked until a verified recovery. */
  markRecoveryRequired(walletId: string, reason: string): Promise<Wallet> {
    return this.transition(
      walletId,
      ["ACTIVE", "SUSPENDED"],
      "RECOVERY_REQUIRED",
      reason,
      WALLET_AUDIT_EVENTS.recoveryRequired,
    );
  }

  /**
   * Creates a PENDING delegated permission after validating that it is bounded. It issues no key and
   * installs nothing on chain: activating one needs the user's root passkey in a later build. There is
   * no way to ask for an unrestricted permission: contracts, assets, operations, a per-transaction
   * limit and a short expiry are all mandatory.
   */
  async createDelegatedPermission(request: PermissionRequest): Promise<DelegatedPermission> {
    const now = this.now();
    const reject = (message: string) => new KaadaError("PERMISSION_REJECTED", message);

    if (request.chainId !== CELO_CHAIN_ID) throw reject("permissions exist on Celo mainnet only");
    if (request.allowedOperations.length === 0) throw reject("at least one operation is required");
    if (request.allowedContracts.length === 0)
      throw reject("at least one allowed contract is required");
    if (request.allowedAssetIds.length === 0)
      throw reject("at least one allowed asset is required");
    if (!request.allowedAssetIds.includes(request.perTransactionLimit.assetId)) {
      throw reject("the per-transaction limit must be in an allowed asset");
    }
    if (BigInt(request.perTransactionLimit.amount) === 0n)
      throw reject("the per-transaction limit must be above zero");
    if (request.cumulativeLimit) {
      if (!request.allowedAssetIds.includes(request.cumulativeLimit.assetId)) {
        throw reject("the cumulative limit must be in an allowed asset");
      }
      if (
        request.cumulativeLimit.assetId === request.perTransactionLimit.assetId &&
        compareMoney(request.cumulativeLimit, request.perTransactionLimit) < 0
      ) {
        throw reject("the cumulative limit cannot be below the per-transaction limit");
      }
    }
    if (request.expiresAt.getTime() <= request.validFrom.getTime())
      throw reject("it must expire after it starts");
    if (request.expiresAt.getTime() <= now.getTime()) throw reject("it is already expired");
    if (request.expiresAt.getTime() - request.validFrom.getTime() > MAX_PERMISSION_TTL_MS) {
      throw reject("a permission may last at most 30 days");
    }

    const contracts = request.allowedContracts.map((address) => {
      if (!evmAddressCodec.isValid(address))
        throw reject("an allowed contract is not a valid address");
      return evmAddressCodec.normalize(address);
    });
    const operations = [...new Set<PermissionOperation>(request.allowedOperations)];

    const plan = this.policy.plan(request);
    if (plan.unsupported.length > 0) {
      throw reject(`the wallet stack cannot enforce: ${plan.unsupported.join(", ")}`);
    }

    return this.uow.transaction(async (repositories) => {
      const wallet = await repositories.wallets.findById(request.walletId);
      if (!wallet || wallet.userId !== request.userId || wallet.chainId !== request.chainId) {
        throw reject("the wallet does not belong to this user");
      }
      if (!isWalletActive(wallet))
        throw new KaadaError("WALLET_NOT_ACTIVE", "the wallet is not active");

      const registry = createAssetRegistry(repositories.assets);
      for (const assetId of request.allowedAssetIds) {
        const asset = await registry.getById(assetId);
        if (!asset?.isActive || asset.chainId !== CELO_CHAIN_ID)
          throw reject("an allowed asset is not a Celo token");
      }

      const permission = await repositories.delegatedPermissions.create({
        id: createId(),
        userId: request.userId,
        walletId: request.walletId,
        provider: plan.provider,
        chainId: request.chainId,
        status: "PENDING",
        allowedOperations: operations,
        allowedContracts: contracts,
        allowedAssetIds: [...new Set(request.allowedAssetIds)],
        perTransactionLimit: request.perTransactionLimit,
        ...(request.cumulativeLimit && { cumulativeLimit: request.cumulativeLimit }),
        enforcement: plan.enforcement,
        validFrom: request.validFrom,
        expiresAt: request.expiresAt,
      });
      await this.audit(
        repositories,
        request.userId,
        WALLET_AUDIT_EVENTS.permissionCreated,
        permission.id,
        {
          walletId: request.walletId,
        },
      );
      return permission;
    });
  }

  /** Called once the permission exists on chain (a later build). PENDING -> ACTIVE. */
  async activatePermission(
    permissionId: string,
    providerPermissionId: string,
  ): Promise<DelegatedPermission> {
    return this.uow.transaction(async (repositories) => {
      const activated = await repositories.delegatedPermissions.activate(
        permissionId,
        providerPermissionId,
      );
      if (!activated)
        throw new KaadaError("PERMISSION_REJECTED", "only a pending permission can be activated");
      await this.audit(
        repositories,
        activated.userId,
        WALLET_AUDIT_EVENTS.permissionActivated,
        activated.id,
      );
      return activated;
    });
  }

  /** PENDING or ACTIVE -> REVOKED. Idempotent for the caller: an already-revoked one returns as is. */
  async revokePermission(permissionId: string, reason: string): Promise<DelegatedPermission> {
    return this.uow.transaction(async (repositories) => {
      const revoked = await repositories.delegatedPermissions.revoke(
        permissionId,
        reason,
        this.now(),
      );
      if (revoked) {
        await this.audit(
          repositories,
          revoked.userId,
          WALLET_AUDIT_EVENTS.permissionRevoked,
          revoked.id,
          {
            reason,
          },
        );
        return revoked;
      }
      const current = await repositories.delegatedPermissions.findById(permissionId);
      if (!current) throw new KaadaError("PERMISSION_REJECTED", "no such permission");
      return current;
    });
  }

  /** Marks permissions past their expiry EXPIRED; returns how many. */
  expireDuePermissions(): Promise<number> {
    return this.uow.read.delegatedPermissions.expireDue(this.now());
  }

  /** The permission only if it is usable right now (ACTIVE, inside its window, not revoked). */
  async getUsablePermission(permissionId: string): Promise<DelegatedPermission | null> {
    const permission = await this.uow.read.delegatedPermissions.findById(permissionId);
    return permission && isPermissionUsable(permission, this.now()) ? permission : null;
  }

  private transition(
    walletId: string,
    from: WalletStatus[],
    to: WalletStatus,
    reason: string | undefined,
    event: string,
  ): Promise<Wallet> {
    return this.uow.transaction(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);
      if (!wallet) throw new KaadaError("WALLET_NOT_ACTIVE", "no such wallet");
      await repositories.wallets.lockUser(wallet.userId);
      const current = await repositories.wallets.findById(walletId);
      if (!current || !from.includes(current.status)) {
        throw new KaadaError(
          "WALLET_NOT_ACTIVE",
          `the wallet cannot move from ${current?.status ?? "?"} to ${to}`,
        );
      }
      const updated = await repositories.wallets.setStatus(walletId, to, reason);
      await this.audit(
        repositories,
        current.userId,
        event,
        walletId,
        reason ? { reason } : undefined,
      );
      return updated;
    });
  }

  private async audit(
    repositories: WalletRepositories,
    userId: string,
    type: string,
    walletId: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await repositories.audit.append({
      id: createId(),
      userId,
      type,
      entityType: "wallet",
      entityId: walletId,
      // Identifiers, statuses and reason codes only. Never a key, a credential or provider output.
      ...(data && { data }),
    });
  }
}

function toRoot(credential: {
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  rpId: string;
}): RootCredential {
  return {
    credentialId: credential.credentialId,
    publicKeyX: credential.publicKeyX,
    publicKeyY: credential.publicKeyY,
    rpId: credential.rpId,
  };
}
