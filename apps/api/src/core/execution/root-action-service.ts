import { KaadaError, createId, rootActionFor } from "@kaada/domain";
import type { AgentLog } from "../agent/ports.js";
import { errorDetails } from "../channels/error-details.js";
import type {
  ExecutionPlan,
  KernelExecutionPort,
  PermissionRequest,
  RootActionSession,
  RootChallenge,
  RootCredential,
  RootProof,
  RootValidatorDeployer,
  Wallet,
} from "@kaada/domain";
import type { DelegatedPermission } from "@kaada/domain";

import { OPAQUE_TOKEN_PATTERN, hashOpaqueToken, newOpaqueToken } from "../authorization/token.js";
import type { RootAdapters, RootCredentialService } from "../roots/root-credentials.js";
import type { LiveExecution } from "./live-execution.js";
import type { ExecutionUnitOfWork, SecretCipher } from "./ports.js";

/** How long a person has to open the link and confirm with their root credential. */
export const ROOT_ACTION_TTL_MS = 10 * 60 * 1000;
const KIND = "DEPLOY_AND_INSTALL_PERMISSION" as const;

export interface RootActionServiceDeps {
  log?: AgentLog;
  unitOfWork: ExecutionUnitOfWork;
  kernel: KernelExecutionPort;
  cipher: SecretCipher;
  /** Creates the PENDING delegated permission record (WalletService). */
  wallets: {
    createDelegatedPermission(request: PermissionRequest): Promise<DelegatedPermission>;
    getWallet(userId: string): Promise<Wallet | null>;
  };
  /** Which root a wallet has, and the adapter that checks a proof of that root's type. */
  roots: RootCredentialService;
  adapters: RootAdapters;
  /** The chain id the validators run on: what a signed payload is bound to. */
  onChainId: number;
  /** Puts a device-key clone on chain before the account that names it is deployed. Optional: a passkey root needs none. */
  validators?: RootValidatorDeployer;
  /** The exact web origin of the root-action page; the link is `${origin}/root-action/${token}`. */
  origin: string;
  now?: () => Date;
}

/** What the secure page shows. No ids, no operation internals. */
export interface RootActionView {
  title: string;
  message: string;
  expiresAt: Date;
  /** Which signer UX the client must show: decided by the wallet's root, never by the client. */
  action: "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED";
  rootType: RootCredential["type"];
}

/**
 * Root actions: deploying the smart account and installing the restricted permission for one payment.
 * These are WALLET-SETUP actions authorized by the wallet's ROOT credential (a passkey or a P-256 device
 * key); they never touch the PIN, and the browser never supplies calldata: the server fixes the operation
 * and its challenge (the UserOperation hash), and the page only returns the root's proof over that challenge.
 */
export class RootActionService {
  private readonly uow: ExecutionUnitOfWork;
  private readonly now: () => Date;

  constructor(private readonly deps: RootActionServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Prepares (once) the root operation an execution needs and records a session for the person to
   * confirm. Idempotent: a live session for the execution is returned as is. Sends nothing.
   */
  async request(
    live: Pick<LiveExecution, "record" | "wallet">,
    plan: Pick<ExecutionPlan, "permissionRequirement">,
  ): Promise<RootActionSession> {
    const repositories = this.uow.read;
    const now = this.now();
    const existing = await repositories.rootActions.findPendingByExecution(live.record.id);
    if (existing && existing.expiresAt.getTime() > now.getTime()) return existing;

    const root = await this.deps.roots.activeRoot(live.wallet);
    await this.ensureValidator(root, live.wallet);

    const scope = plan.permissionRequirement.scope;
    const prepared = await this.deps.kernel.prepareRootOperation({
      walletAddress: live.wallet.address,
      credential: root,
      calls: [],
      permission: { scope },
    });
    if (!prepared.sessionKey) throw new Error("the kernel adapter returned no session key");

    // The restricted permission record (PENDING: an intention, not authority) and its encrypted key.
    const permission = await this.deps.wallets.createDelegatedPermission({
      userId: live.wallet.userId,
      walletId: live.wallet.id,
      chainId: scope.chainId,
      allowedOperations: scope.allowedOperations,
      allowedContracts: scope.allowedContracts,
      allowedAssetIds: scope.allowedAssetIds,
      perTransactionLimit: scope.perTransactionLimit,
      validFrom: scope.validFrom,
      expiresAt: scope.expiresAt,
    });
    const keyId = createId();
    const sealed = this.deps.cipher.encrypt(
      prepared.sessionKey.privateKey.reveal(),
      `session-key:${keyId}`,
    );
    const session = await this.uow.transaction(async (tx) => {
      await tx.executionSecrets.put({
        id: keyId,
        purpose: "SESSION_KEY",
        keyVersion: sealed.keyVersion,
        ciphertext: sealed.ciphertext,
        now,
      });
      await tx.delegatedPermissions.attachSessionKey(permission.id, {
        address: prepared.sessionKey!.address,
        sessionKeySecretId: keyId,
      });
      const created = await tx.rootActions.createOrGetPending(
        {
          id: createId(),
          userId: live.wallet.userId,
          walletId: live.wallet.id,
          executionId: live.record.id,
          kind: KIND,
          challenge: prepared.challenge,
          // The adapter's unsigned operation plus the permission it will install. No secret.
          prepared: {
            operation: prepared.prepared,
            permissionId: permission.id,
            rootType: root.type,
          },
          expiresAt: new Date(now.getTime() + ROOT_ACTION_TTL_MS),
        },
        now,
      );
      return created.session;
    });
    return session;
  }

  /** Issues the secure link for a session to the user it belongs to. Only the hash is stored. */
  async issueLink(input: { sessionId: string; userId: string }) {
    const session = await this.uow.read.rootActions.findById(input.sessionId);
    const now = this.now();
    if (
      !session ||
      session.userId !== input.userId ||
      session.status !== "PENDING" ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action is not available");
    }
    const token = newOpaqueToken();
    const updated = await this.uow.read.rootActions.issueToken({
      id: session.id,
      tokenHash: hashOpaqueToken(token),
      now,
    });
    if (!updated)
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action is not available");
    return {
      url: `${this.deps.origin.replace(/\/$/, "")}/root-action/${token}`,
      token,
      expiresAt: updated.expiresAt,
    };
  }

  async view(token: string): Promise<RootActionView> {
    const { session, root } = await this.resolveWithRoot(token);
    return {
      title: "Confirm wallet setup to continue payment",
      message:
        root.type === "PASSKEY"
          ? "Your payment is waiting on a one-time wallet setup. Confirm it with your passkey. This does not authorize any payment amount: your PIN already did that, and it cannot be changed here."
          : "Your payment is waiting on a one-time wallet setup. Confirm it with this device. This does not authorize any payment amount: your PIN already did that, and it cannot be changed here.",
      expiresAt: session.expiresAt,
      action: rootActionFor(root.type),
      rootType: root.type,
    };
  }

  /** What the client must sign: a WebAuthn request (passkey) or the documented payload (device key). */
  async options(token: string): Promise<RootChallenge> {
    const { session, root, wallet } = await this.resolveWithRoot(token);
    return this.deps.adapters.prepareOperationChallenge(
      root,
      { account: wallet.address ?? "", chainId: this.deps.onChainId },
      session.challenge,
    );
  }

  /**
   * Verifies the root's proof over THIS session's challenge, takes the session (once), records the root
   * step and sends the operation. A failed or ambiguous send is recorded; it is not retried here and the
   * root action is not treated as done until the chain says so.
   */
  async complete(token: string, proof: RootProof): Promise<{ userOpHash: string }> {
    const { session, root, wallet } = await this.resolveWithRoot(token);
    const repositories = this.uow.read;
    await this.deps.adapters.verifyOperationProof(
      root,
      { account: wallet.address ?? "", chainId: this.deps.onChainId },
      session.challenge,
      proof,
    );

    // Exactly one caller takes the session.
    const taken = await repositories.rootActions.complete(session.id, this.now());
    if (!taken)
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action was already used");

    const operation = session.prepared["operation"];
    const permissionId = session.prepared["permissionId"];
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      throw new KaadaError("EXECUTION_FAILED", "the prepared operation is malformed");
    }
    const key = `exec:${session.executionId}:ROOT_ACTION`;
    const { transaction } = await repositories.executionTransactions.begin({
      idempotencyKey: key,
      executionId: session.executionId,
      type: "PERMISSION_INSTALL",
      chainId: 42220,
      fromAddress: wallet.address ?? "",
      metadata: { permissionId: typeof permissionId === "string" ? permissionId : "" },
    });
    if (transaction.status !== "CREATED") {
      throw new KaadaError("EXECUTION_FAILED", "this root action was already sent");
    }
    // The root operation's hash IS the challenge the root signed: record it before anything is sent.
    await repositories.executionTransactions.recordUserOpHash(
      transaction.id,
      session.challenge.toLowerCase(),
    );
    try {
      const sent = await this.deps.kernel.sendRootOperation({ prepared: operation, proof });
      await repositories.executionTransactions.markSubmitted(transaction.id, {
        userOpHash: sent.userOpHash.toLowerCase(),
        now: this.now(),
      });
      if (sent.approval && typeof permissionId === "string") {
        // The root-signed enable data is needed to use the permission later; it is kept encrypted.
        const approvalId = createId();
        const sealed = this.deps.cipher.encrypt(
          sent.approval.reveal(),
          `permission-approval:${approvalId}`,
        );
        await repositories.executionSecrets.put({
          id: approvalId,
          purpose: "PERMISSION_APPROVAL",
          keyVersion: sealed.keyVersion,
          ciphertext: sealed.ciphertext,
          now: this.now(),
        });
        await repositories.delegatedPermissions.attachApproval(permissionId, approvalId);
      }
      return { userOpHash: sent.userOpHash.toLowerCase() };
    } catch (error) {
      if (error instanceof KaadaError && error.code === "BUNDLER_REJECTED") {
        await repositories.executionTransactions.markNotSent(
          transaction.id,
          "BUNDLER_REJECTED",
          this.now(),
        );
      } else {
        await repositories.executionTransactions.markUnknown(transaction.id, this.now());
      }
      throw error;
    }
  }

  /** Which signer UX the person's wallet needs for a root action: decided by the wallet's root, never by the client. */
  async requiredAction(walletId: string): Promise<RootActionView["action"] | undefined> {
    const wallet = await this.uow.read.wallets.findById(walletId);
    if (!wallet) return undefined;
    try {
      return rootActionFor((await this.deps.roots.activeRoot(wallet)).type);
    } catch (error) {
      this.deps.log?.("warn", "root_action.active_root_unreadable", {
        walletId,
        ...errorDetails(error),
      });
      return undefined;
    }
  }

  /** A device-key root lives in a clone that must exist before the account that names it is created. */
  private async ensureValidator(root: RootCredential, wallet: Wallet): Promise<void> {
    if (root.type !== "DEVICE_KEY" || !this.deps.validators) return;
    await this.deps.validators.ensureDeployed({
      type: "DEVICE_KEY",
      account: root.purpose === 0 ? null : (wallet.address ?? null),
      purpose: root.purpose,
      deploymentSalt: root.deploymentSalt,
      validatorAddress: root.validatorAddress,
      publicKeyX: root.publicKeyX,
      publicKeyY: root.publicKeyY,
      credentialRef: root.keyId,
    });
  }

  /** The session, the wallet it belongs to and the wallet's CURRENT root (the one that must sign). */
  private async resolveWithRoot(token: string) {
    const session = await this.resolve(token);
    const wallet = await this.uow.read.wallets.findById(session.walletId);
    if (!wallet?.address || wallet.userId !== session.userId) {
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action link is not valid");
    }
    const root = await this.deps.roots.activeRoot(wallet);
    // The operation was prepared for one root; if the wallet's root changed since, it can no longer be signed.
    const prepared = session.prepared["rootType"];
    if (typeof prepared === "string" && prepared !== root.type) {
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action link is not valid");
    }
    return { session, root, wallet };
  }

  private async resolve(token: string): Promise<RootActionSession> {
    const invalid = () =>
      new KaadaError("AUTHORIZATION_SESSION_INVALID", "this action link is not valid");
    if (typeof token !== "string" || !OPAQUE_TOKEN_PATTERN.test(token)) throw invalid();
    const session = await this.uow.read.rootActions.findByTokenHash(hashOpaqueToken(token));
    if (
      !session ||
      session.status !== "PENDING" ||
      session.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw invalid();
    }
    return session;
  }
}
