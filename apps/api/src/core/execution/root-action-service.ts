import { KaadaError, createId } from "@kaada/domain";
import type {
  ExecutionPlan,
  KernelExecutionPort,
  PasskeyCredential,
  PasskeyVerifier,
  PermissionRequest,
  RootActionSession,
  Wallet,
} from "@kaada/domain";
import type { DelegatedPermission } from "@kaada/domain";

import { OPAQUE_TOKEN_PATTERN, hashOpaqueToken, newOpaqueToken } from "../authorization/token.js";
import type { LiveExecution } from "./live-execution.js";
import type { ExecutionUnitOfWork, SecretCipher } from "./ports.js";

/** How long a person has to open the link and confirm with their passkey. */
export const ROOT_ACTION_TTL_MS = 10 * 60 * 1000;
const KIND = "DEPLOY_AND_INSTALL_PERMISSION" as const;

export interface RootActionServiceDeps {
  unitOfWork: ExecutionUnitOfWork;
  kernel: KernelExecutionPort;
  cipher: SecretCipher;
  /** Creates the PENDING delegated permission record (WalletService). */
  wallets: {
    createDelegatedPermission(request: PermissionRequest): Promise<DelegatedPermission>;
    getWallet(userId: string): Promise<Wallet | null>;
  };
  verifier: PasskeyVerifier;
  rpId: string;
  /** The exact web origin of the root-action page; the link is `${origin}/root-action/${token}`. */
  origin: string;
  now?: () => Date;
}

/** What the secure page shows. No ids, no operation internals. */
export interface RootActionView {
  title: string;
  message: string;
  expiresAt: Date;
}

const hexToBase64Url = (hex: string) =>
  Buffer.from(hex.replace(/^0x/, ""), "hex").toString("base64url");

/**
 * Root (passkey) actions: deploying the smart account and installing the restricted permission for
 * one payment. These are WALLET-SETUP actions authorized by the user's passkey; they never touch the
 * PIN, and the browser never supplies calldata: the server fixes the operation and its challenge
 * (the UserOperation hash), and the page only returns the passkey's assertion over that challenge.
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
  async request(live: LiveExecution, plan: ExecutionPlan): Promise<RootActionSession> {
    const repositories = this.uow.read;
    const now = this.now();
    const existing = await repositories.rootActions.findPendingByExecution(live.record.id);
    if (existing && existing.expiresAt.getTime() > now.getTime()) return existing;

    const [credential] = await repositories.passkeys.listActiveForUser(live.wallet.userId);
    if (!credential) throw new KaadaError("ROOT_CREDENTIAL_REQUIRED", "no passkey is registered");

    const scope = plan.permissionRequirement.scope;
    const prepared = await this.deps.kernel.prepareRootOperation({
      walletAddress: live.wallet.address,
      credential: toRoot(credential),
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
          prepared: { operation: prepared.prepared, permissionId: permission.id },
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
    const session = await this.resolve(token);
    return {
      title: "Confirm wallet setup to continue payment",
      message:
        "Your payment is waiting on a one-time wallet setup. Confirm it with your passkey. This does not authorize any payment amount: your PIN already did that, and it cannot be changed here.",
      expiresAt: session.expiresAt,
    };
  }

  /** The WebAuthn request options for the page: the server's challenge, nothing else. */
  async options(token: string) {
    const session = await this.resolve(token);
    const credentials = await this.uow.read.passkeys.listActiveForUser(session.userId);
    return {
      challenge: hexToBase64Url(session.challenge),
      rpId: this.deps.rpId,
      allowCredentials: credentials.map((c) => ({
        type: "public-key" as const,
        id: c.credentialId,
      })),
      userVerification: "required" as const,
      timeout: 5 * 60 * 1000,
    };
  }

  /**
   * Verifies the passkey's assertion over THIS session's challenge, takes the session (once), records
   * the root step and sends the operation. A failed or ambiguous send is recorded; it is not retried
   * here and the root action is not treated as done until the chain says so.
   */
  async complete(token: string, assertion: unknown): Promise<{ userOpHash: string }> {
    const session = await this.resolve(token);
    const repositories = this.uow.read;
    const credentialId = (assertion as { id?: unknown } | null)?.id;
    const credential =
      typeof credentialId === "string"
        ? await repositories.passkeys.findByCredentialId(credentialId)
        : null;
    if (!credential || credential.userId !== session.userId || credential.revokedAt) {
      throw new KaadaError("CREDENTIAL_REJECTED", "this credential cannot be used");
    }
    const verified = await this.deps.verifier.verifyAuthentication({
      response: assertion,
      expectedChallenge: hexToBase64Url(session.challenge),
      expectedOrigin: new URL(this.deps.origin).origin,
      expectedRpId: this.deps.rpId,
      credential,
    });
    if (!verified) throw new KaadaError("CREDENTIAL_REJECTED", "the passkey could not be verified");
    const bothZero = credential.signCount === 0 && verified.newSignCount === 0;
    if (
      !bothZero &&
      !(await repositories.passkeys.advanceCounter(
        credential.id,
        verified.newSignCount,
        this.now(),
      ))
    ) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the signature counter did not advance");
    }

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
      fromAddress: (await this.walletAddress(session.userId)) ?? "",
      metadata: { permissionId: typeof permissionId === "string" ? permissionId : "" },
    });
    if (transaction.status !== "CREATED") {
      throw new KaadaError("EXECUTION_FAILED", "this root action was already sent");
    }
    try {
      const sent = await this.deps.kernel.sendRootOperation({ prepared: operation, assertion });
      await repositories.executionTransactions.markSubmitted(transaction.id, {
        userOpHash: sent.userOpHash.toLowerCase(),
        now: this.now(),
      });
      if (sent.approval && typeof permissionId === "string") {
        // The passkey-signed enable data is needed to use the permission later; it is kept encrypted.
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

  private async walletAddress(userId: string): Promise<string | undefined> {
    return (await this.deps.wallets.getWallet(userId))?.address;
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

function toRoot(credential: PasskeyCredential) {
  return {
    credentialId: credential.credentialId,
    publicKeyX: credential.publicKeyX,
    publicKeyY: credential.publicKeyY,
    rpId: credential.rpId,
  };
}
