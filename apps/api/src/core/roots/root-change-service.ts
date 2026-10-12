import { randomBytes } from "node:crypto";

import {
  PASSKEY_PURPOSE,
  buildRecoveryRoot,
  classifyDeviceKey,
  deviceKeyIdFromPoint,
  deviceProofPayload,
  isOnP256Curve,
  rootChangeCalls,
  validatorLaneInstallCalls,
} from "@kaada/contracts";
import type {
  AttestationVerifier,
  NewRootCredential,
  ValidatorDeployments,
} from "@kaada/contracts";
import {
  CELO_CHAIN_ID,
  KaadaError,
  WALLET_AUDIT_EVENTS,
  createId,
  isWalletActive,
} from "@kaada/domain";
import type {
  AccountCall,
  AuditRepository,
  DelegatedPermissionRepository,
  DeviceSecurityTier,
  ExecutionSecretRepository,
  KernelExecutionPort,
  PasskeyRepository,
  PasskeyVerifier,
  RecoveryChainPort,
  RecoveryCleanupRepository,
  RootChange,
  RootChangeKind,
  RootChangeRepository,
  RootChallenge,
  RootProof,
  RootValidatorDeployer,
  Wallet,
  WalletCredential,
  WalletCredentialRepository,
  WalletRepository,
  WalletSetupSessionRepository,
} from "@kaada/domain";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex } from "viem";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { verifyP256 } from "./p256.js";
import type { RootAdapters, RootCredentialService } from "./root-credentials.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const HEX64 = /^[0-9a-f]{64}$/;
const REASON = "ROOT_CHANGE";

export interface RootChangeRepositories {
  wallets: WalletRepository;
  passkeys: PasskeyRepository;
  walletCredentials: WalletCredentialRepository;
  rootChanges: RootChangeRepository;
  delegatedPermissions: DelegatedPermissionRepository;
  executionSecrets: ExecutionSecretRepository;
  recoveryCleanup: RecoveryCleanupRepository;
  walletSetupSessions: WalletSetupSessionRepository;
  audit: AuditRepository;
}

export interface RootChangeUnitOfWork {
  read: RootChangeRepositories;
  transaction<T>(work: (repositories: RootChangeRepositories) => Promise<T>): Promise<T>;
}

export interface RootChangeServiceDeps {
  unitOfWork: RootChangeUnitOfWork;
  kernel: Pick<
    KernelExecutionPort,
    "prepareRootOperation" | "sendRootOperation" | "getUserOperationReceipt"
  >;
  /** Chain READS only. */
  chain: Pick<RecoveryChainPort, "accountState" | "laneVoided" | "validatorLaneId">;
  roots: RootCredentialService;
  adapters: RootAdapters;
  validators: RootValidatorDeployer;
  deployments: ValidatorDeployments;
  /** The chain id the validators run on. */
  onChainId: number;
  /** Verifies a passkey registration made on this device (nothing is stored until the change is confirmed). */
  passkeyVerifier: PasskeyVerifier;
  rpId: string;
  origin: string;
  /** Absent until a real platform-attestation verifier exists: then no key is ever TRUSTED_DEVICE. */
  attestationVerifier?: AttestationVerifier;
  /** How long a prepared change can be signed. */
  ttlMs?: number;
  /** How long `confirm` waits for the chain to show the change before leaving it SUBMITTED for the next call. */
  inclusionWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: AgentLog;
}

export type NewCredentialInput =
  | { type: "PASSKEY"; response: unknown }
  | {
      type: "DEVICE_KEY";
      publicKeyX: string;
      publicKeyY: string;
      /** The enrolment challenge and the key's signature over it (proof of possession). */
      challenge: string;
      r: string;
      s: string;
    };

/** What a person is shown after a change was prepared: what to sign, by which root, for which new credential. */
export interface PreparedRootChange {
  changeId: string;
  kind: RootChangeKind;
  /** What the CURRENT root must sign (its type, not the new credential's, decides the UX). */
  challenge: RootChallenge;
  newRootType: "PASSKEY" | "DEVICE_KEY";
  expiresAt: Date;
}

export interface RootChangeView {
  changeId: string;
  kind: RootChangeKind;
  status: RootChange["status"];
  newRootType: "PASSKEY" | "DEVICE_KEY";
  expiresAt: Date;
}

const toTier = (tier: "trusted-device" | "web-non-extractable" | "unknown"): DeviceSecurityTier =>
  tier === "trusted-device"
    ? "TRUSTED_DEVICE"
    : tier === "web-non-extractable"
      ? "WEB_NON_EXTRACTABLE"
      : "UNKNOWN";

/** The per-change salt: a fresh validator instance for every change, never one the wallet has used. */
export const rootChangeDeploymentSalt = (changeId: string): Hex =>
  keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], ["kaada.root-change", changeId]),
  );

const challengeOf = (response: unknown): string | undefined => {
  const inner = (response as { response?: { clientDataJSON?: unknown } } | null)?.response;
  if (typeof inner?.clientDataJSON !== "string") return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(inner.clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof decoded.challenge === "string" ? decoded.challenge : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Changing a wallet's credentials with its ROOT, for both root types, without a recovery:
 *  - ROTATE_ROOT: a fresh validator instance becomes the root and everything installed under the old root is voided;
 *  - ENROLL_BACKUP: a second fresh credential is installed as an additional validator.
 *
 * The server fixes the operation (it can only be one of these two fixed shapes) and its challenge; the root signs exactly that
 * with the proof its type uses (a passkey assertion or a device-key signature); the server verifies it, sends it, and treats the
 * change as done ONLY when the chain reads back what was asked for. A validator instance is never reused: each change names a
 * clone derived from a salt unique to that change. Nothing here can sign.
 */
export class RootChangeService {
  private readonly uow: RootChangeUnitOfWork;
  private readonly now: () => Date;
  private readonly log: AgentLog;
  private readonly ttlMs: number;
  private readonly inclusionWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RootChangeServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
    this.ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
    this.inclusionWaitMs = deps.inclusionWaitMs ?? 90_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ───────────────────────────── the new credential ─────────────────────────────

  /** WebAuthn registration options for the NEW passkey. Nothing is stored until the change is confirmed. */
  async beginPasskey(userId: string): Promise<{
    challenge: string;
    rpId: string;
    userId: string;
    userName: string;
  }> {
    await this.activeWallet(userId);
    const challenge = randomBytes(32).toString("base64url");
    await this.uow.read.passkeys.issueChallenge({
      id: createId(),
      userId,
      purpose: "REGISTRATION",
      challenge,
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000),
    });
    return { challenge, rpId: this.deps.rpId, userId, userName: "Kaada wallet" };
  }

  /** The server derives the key id and issues the challenge the NEW device key must sign (proof of possession). */
  async beginDeviceKey(
    userId: string,
    key: { publicKeyX: string; publicKeyY: string },
  ): Promise<{
    keyId: string;
    payload: string;
    algorithm: "ECDSA_P256_SHA256";
    format: "KaadaRootProof/v1";
    challenge: string;
  }> {
    await this.activeWallet(userId);
    const { keyId } = this.checkedPoint(key);
    const challenge = `0x${randomBytes(32).toString("hex")}`;
    await this.uow.read.passkeys.issueChallenge({
      id: createId(),
      userId,
      purpose: "REGISTRATION",
      challenge,
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000),
    });
    return {
      keyId,
      payload: this.enrolmentPayload(keyId, challenge),
      algorithm: "ECDSA_P256_SHA256",
      format: "KaadaRootProof/v1",
      challenge,
    };
  }

  // ───────────────────────────────── prepare ─────────────────────────────────

  /**
   * Verifies the new credential, puts its FRESH validator clone on chain, and prepares the one operation the current root must
   * sign. Sends nothing to the bundler.
   */
  async prepare(
    userId: string,
    kind: RootChangeKind,
    input: NewCredentialInput,
  ): Promise<PreparedRootChange> {
    const wallet = await this.activeWallet(userId);
    const address = wallet.address as string;
    const current = await this.deps.roots.activeRoot(wallet);
    const account = await this.deps.chain.accountState(address);
    if (!account.deployed || !account.rootValidator) {
      throw new KaadaError(
        "ROOT_CHANGE_REJECTED",
        "the wallet must be set up on chain before its credentials can change",
      );
    }
    if (
      current.validatorAddress !== undefined &&
      current.validatorAddress.toLowerCase() !== account.rootValidator.toLowerCase()
    ) {
      throw new KaadaError("ROOT_CHANGE_REJECTED", "the recorded root does not match the chain");
    }
    const live = await this.uow.read.rootChanges.findLive(wallet.id);
    if (live && live.expiresAt.getTime() > this.now().getTime()) {
      throw new KaadaError(
        "ROOT_CHANGE_CONFLICT",
        "another change of this wallet's credentials is in progress",
      );
    }

    const credential = await this.verifiedCredential(userId, input);
    const changeId = createId();
    const purpose = kind === "ROTATE_ROOT" ? PASSKEY_PURPOSE.ROTATION : PASSKEY_PURPOSE.BACKUP;
    const built = buildRecoveryRoot({
      deployments: this.deps.deployments,
      account: address as Address,
      credential: credential.public,
      deploymentSalt: rootChangeDeploymentSalt(changeId),
      purpose,
    });
    const instance = built.instance.toLowerCase();
    if (await this.uow.read.walletCredentials.validatorEverUsed(wallet.id, instance)) {
      // Cannot happen with a per-change salt; refusing is the safe answer if it ever does.
      throw new KaadaError("ROOT_CHANGE_REJECTED", "that validator instance was already used");
    }
    // The clone must exist before the account can name it (rotation) or install it (backup).
    await this.deps.validators.ensureDeployed({
      type: credential.public.kind,
      account: address,
      purpose,
      deploymentSalt: built.deploymentSalt,
      validatorAddress: instance,
      publicKeyX: credential.public.publicKeyX,
      publicKeyY: credential.public.publicKeyY,
      credentialRef: credential.ref,
    });

    const calls: AccountCall[] =
      kind === "ROTATE_ROOT"
        ? rootChangeCalls({
            account: address as Address,
            root: built.root,
            currentNonce: account.currentNonce,
          }).map((call) => ({ to: call.target, data: call.callData, value: "0" }))
        : validatorLaneInstallCalls({
            account: address as Address,
            validator: built.instance,
            validatorData: built.root.validatorData,
            currentNonce: account.currentNonce,
          }).map((call) => ({ to: call.to, data: call.data, value: "0" }));
    const prepared = await this.deps.kernel.prepareRootOperation({
      walletAddress: address,
      credential: current,
      calls,
    });
    const challenge = prepared.challenge.toLowerCase();

    const now = this.now();
    const signer = await this.uow.read.walletCredentials.findRoot(wallet.id);
    const change = await this.uow.transaction(async (tx) => {
      const newCredentialId = createId();
      await tx.walletCredentials.create({
        id: newCredentialId,
        userId,
        walletId: wallet.id,
        kind: credential.public.kind,
        role: kind === "ROTATE_ROOT" ? "PRIMARY" : "BACKUP",
        status: "PENDING",
        isRoot: false,
        validatorAddress: instance,
        validatorPurpose: purpose,
        deploymentSalt: built.deploymentSalt,
        credentialRef: credential.ref,
        publicKeyX: credential.public.publicKeyX,
        publicKeyY: credential.public.publicKeyY,
        ...(credential.rpId && { rpId: credential.rpId }),
        securityTier: credential.tier,
      });
      const created = await tx.rootChanges.create(
        {
          id: changeId,
          userId,
          walletId: wallet.id,
          kind,
          newCredentialId,
          ...(signer && { signerCredentialId: signer.id }),
          challenge,
          prepared: {
            operation: prepared.prepared,
            nonceBefore: account.currentNonce,
            newValidator: instance,
            newRootType: credential.public.kind,
            signerType: current.type,
          },
          expiresAt: new Date(now.getTime() + this.ttlMs),
        },
        now,
      );
      if (!created) {
        throw new KaadaError(
          "ROOT_CHANGE_CONFLICT",
          "another change of this wallet's credentials is in progress",
        );
      }
      await tx.audit.append({
        id: createId(),
        userId,
        type: WALLET_AUDIT_EVENTS.rootChangePrepared,
        entityType: "root_change",
        entityId: created.id,
        data: { kind, newRootType: credential.public.kind, signerType: current.type },
      });
      return created;
    });

    return {
      changeId: change.id,
      kind,
      challenge: this.deps.adapters.prepareOperationChallenge(
        current,
        { account: address, chainId: this.deps.onChainId },
        challenge,
      ),
      newRootType: credential.public.kind,
      expiresAt: change.expiresAt,
    };
  }

  // ───────────────────────────────── complete ─────────────────────────────────

  /**
   * The current root signed the stored operation. The proof is verified for the wallet's root type, the change is claimed
   * (exactly one caller sends), the operation goes to the bundler, and the change is confirmed only from the chain.
   */
  async complete(userId: string, changeId: string, proof: RootProof): Promise<RootChangeView> {
    const change = await this.owned(userId, changeId);
    const now = this.now();
    if (change.status !== "PREPARED" || change.expiresAt.getTime() <= now.getTime()) {
      throw new KaadaError("ROOT_CHANGE_REJECTED", "this change is no longer available");
    }
    const wallet = await this.activeWallet(userId);
    const root = await this.deps.roots.activeRoot(wallet);
    if (change.prepared["signerType"] !== root.type) {
      throw new KaadaError("ROOT_CHANGE_REJECTED", "the wallet's root changed; prepare again");
    }
    await this.deps.adapters.verifyOperationProof(
      root,
      { account: wallet.address as string, chainId: this.deps.onChainId },
      change.challenge,
      proof,
    );
    // Exactly one caller takes the change; the operation hash is recorded BEFORE anything is sent.
    const claimed = await this.uow.read.rootChanges.advance({
      id: change.id,
      from: ["PREPARED"],
      to: "SUBMITTED",
      patch: { userOpHash: change.challenge },
    });
    if (!claimed) throw new KaadaError("ROOT_CHANGE_REJECTED", "this change was already used");

    const operation = change.prepared["operation"];
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      await this.fail(change, "MALFORMED");
      throw new KaadaError("ROOT_CHANGE_REJECTED", "the prepared operation is malformed");
    }
    try {
      await this.deps.kernel.sendRootOperation({ prepared: operation, proof });
    } catch (error) {
      if (error instanceof KaadaError && error.code === "BUNDLER_REJECTED") {
        // A definite refusal: nothing was sent, so the person can start over with a new change.
        await this.fail(change, "BUNDLER_REJECTED");
      }
      // Anything else is ambiguous: the change stays SUBMITTED and `confirm` asks the chain.
      throw error;
    }
    return (await this.confirm(change.id)) ?? this.view(claimed);
  }

  // ───────────────────────────────── confirm ─────────────────────────────────

  /**
   * Reads the chain and finishes the change if (and only if) it shows exactly what was asked: the new validator is the root and
   * the nonce advanced (rotation), or the new lane is installed (backup). Safe to call repeatedly.
   */
  async confirm(changeId: string): Promise<RootChangeView | null> {
    const read = this.uow.read;
    let change = await read.rootChanges.findById(changeId);
    if (!change) return null;
    const deadline = this.now().getTime() + this.inclusionWaitMs;
    while (change.status === "SUBMITTED") {
      const wallet = await read.wallets.findById(change.walletId);
      const credential = await read.walletCredentials.findById(change.newCredentialId);
      if (!wallet?.address || !credential) return this.view(change);
      if (await this.chainShowsChange(change, wallet.address, credential)) {
        await this.finish(change, wallet, credential);
        change = (await read.rootChanges.findById(changeId)) ?? change;
        break;
      }
      // The operation may have been included and reverted: the receipt says so.
      const receipt = change.userOpHash
        ? await this.deps.kernel.getUserOperationReceipt(change.userOpHash).catch(() => undefined)
        : undefined;
      if (receipt?.status === "INCLUDED" && !receipt.success) {
        await this.fail(change, "OPERATION_REVERTED");
        change = (await read.rootChanges.findById(changeId)) ?? change;
        break;
      }
      if (this.now().getTime() >= deadline) break;
      await this.sleep(2_000);
      change = (await read.rootChanges.findById(changeId)) ?? change;
    }
    return this.view(change);
  }

  async status(userId: string, changeId: string): Promise<RootChangeView> {
    return this.view(await this.owned(userId, changeId));
  }

  /** Finishes what a crash or a slow chain left behind: SUBMITTED changes are confirmed, stale PREPARED ones expire. */
  async reconcile(limit = 20): Promise<{ confirmed: number; expired: number }> {
    const now = this.now();
    let confirmed = 0;
    let expired = 0;
    for (const change of await this.uow.read.rootChanges.listExpired(now, limit)) {
      if (change.status === "PREPARED") {
        if (
          await this.uow.read.rootChanges.advance({
            id: change.id,
            from: ["PREPARED"],
            to: "EXPIRED",
          })
        ) {
          await this.dropPending(change);
          expired += 1;
        }
      } else {
        const view = await this.confirm(change.id);
        if (view?.status === "CONFIRMED") confirmed += 1;
      }
    }
    return { confirmed, expired };
  }

  // ───────────────────────────────── internals ─────────────────────────────────

  private async chainShowsChange(
    change: RootChange,
    address: string,
    credential: WalletCredential,
  ): Promise<boolean> {
    const state = await this.deps.chain.accountState(address);
    if (change.kind === "ROTATE_ROOT") {
      const nonceBefore = Number(change.prepared["nonceBefore"] ?? -1);
      return (
        state.rootValidator?.toLowerCase() === credential.validatorAddress &&
        state.currentNonce > nonceBefore
      );
    }
    // A backup is shown by its lane being installed and usable (not void) on the account.
    return !(await this.deps.chain.laneVoided(
      address,
      this.deps.chain.validatorLaneId(credential.validatorAddress),
    ));
  }

  /** The chain showed the change: record it, and for a rotation retire everything that was built under the old root. */
  private async finish(
    change: RootChange,
    wallet: Wallet,
    credential: WalletCredential,
  ): Promise<void> {
    const now = this.now();
    const done = await this.uow.transaction(async (tx) => {
      const moved = await tx.rootChanges.advance({
        id: change.id,
        from: ["SUBMITTED"],
        to: "CONFIRMED",
        patch: { completedAt: now },
      });
      if (!moved) return false; // another process already finished it
      if (change.kind === "ROTATE_ROOT") {
        const promoted = await tx.walletCredentials.promoteToRoot({
          walletId: wallet.id,
          newId: credential.id,
          at: now,
        });
        if (!promoted)
          throw new KaadaError("ROOT_CHANGE_REJECTED", "the new credential is not pending");
        if (promoted.promoted.kind === "PASSKEY") {
          // From now on the existing passkey flows recognise the new root.
          const mirror = await tx.passkeys.create({
            id: createId(),
            userId: wallet.userId,
            credentialId: promoted.promoted.credentialRef,
            publicKeyX: promoted.promoted.publicKeyX,
            publicKeyY: promoted.promoted.publicKeyY,
            rpId: promoted.promoted.rpId ?? this.deps.rpId,
            signCount: 0,
          });
          await tx.walletCredentials.linkPasskey(promoted.promoted.id, mirror.id);
        }
        // The old passkeys are no longer a root of this wallet.
        for (const passkey of await tx.passkeys.listActiveForUser(wallet.userId)) {
          if (passkey.credentialId === credential.credentialRef) continue;
          await tx.passkeys.revoke(passkey.id, now);
        }
        await this.retireAuthority(tx, wallet, now);
      } else {
        await tx.walletCredentials.activate(credential.id, now);
      }
      await tx.audit.append({
        id: createId(),
        userId: wallet.userId,
        type: WALLET_AUDIT_EVENTS.rootChangeConfirmed,
        entityType: "root_change",
        entityId: change.id,
        data: { kind: change.kind },
      });
      return true;
    });
    if (done) this.log("info", "wallet.root_change_confirmed", { kind: change.kind });
  }

  /**
   * After a rotation every delegated permission of the wallet is void on chain (the nonce was invalidated), so it is revoked
   * here, its session key and approval destroyed, and everything prepared under the old root cancelled. The PIN is not touched:
   * it was never tied to the root.
   */
  private async retireAuthority(
    tx: RootChangeRepositories,
    wallet: Wallet,
    now: Date,
  ): Promise<void> {
    for (const permission of await tx.delegatedPermissions.listForWallet(wallet.id)) {
      if (permission.status === "PENDING" || permission.status === "ACTIVE") {
        await tx.delegatedPermissions.revoke(permission.id, REASON, now);
      }
      for (const secretId of [permission.sessionKeySecretId, permission.approvalSecretId]) {
        if (secretId && (await tx.executionSecrets.get(secretId))) {
          await tx.executionSecrets.tombstone(secretId, now);
        }
      }
    }
    await tx.recoveryCleanup.cancelAuthorizationSessions(wallet.id, REASON, now);
    await tx.recoveryCleanup.revokePaymentAuthorizations(wallet.id, REASON, now);
    await tx.recoveryCleanup.cancelRootActionSessions(wallet.id);
    await tx.walletSetupSessions.revokePending(wallet.userId);
  }

  private async fail(change: RootChange, code: string): Promise<void> {
    const failed = await this.uow.read.rootChanges.advance({
      id: change.id,
      from: ["PREPARED", "SUBMITTED"],
      to: "FAILED",
      patch: { failureCode: code },
    });
    if (failed) {
      await this.dropPending(change);
      await this.uow.read.audit.append({
        id: createId(),
        userId: change.userId,
        type: WALLET_AUDIT_EVENTS.rootChangeFailed,
        entityType: "root_change",
        entityId: change.id,
        data: { code },
      });
    }
  }

  /** A change that will never happen must not leave its credential PENDING for ever. */
  private async dropPending(change: RootChange): Promise<void> {
    await this.uow.read.walletCredentials.revoke(change.newCredentialId, this.now());
  }

  private async owned(userId: string, changeId: string): Promise<RootChange> {
    const change = await this.uow.read.rootChanges.findById(changeId);
    if (!change || change.userId !== userId) {
      throw new KaadaError("ROOT_CHANGE_REJECTED", "no such change");
    }
    return change;
  }

  private view(change: RootChange): RootChangeView {
    return {
      changeId: change.id,
      kind: change.kind,
      status: change.status,
      newRootType: change.prepared["newRootType"] === "DEVICE_KEY" ? "DEVICE_KEY" : "PASSKEY",
      expiresAt: change.expiresAt,
    };
  }

  private async activeWallet(userId: string): Promise<Wallet> {
    const wallet = await this.uow.read.wallets.findEmbedded(userId, CELO_CHAIN_ID);
    if (!wallet || !isWalletActive(wallet) || !wallet.address) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "set up your wallet first");
    }
    return wallet;
  }

  /** The new credential, verified: a passkey registration, or a device key with proof of possession. */
  private async verifiedCredential(
    userId: string,
    input: NewCredentialInput,
  ): Promise<{
    public: NewRootCredential;
    ref: string;
    rpId?: string;
    tier: DeviceSecurityTier;
  }> {
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    if (input.type === "PASSKEY") {
      const challenge = challengeOf(input.response);
      if (!challenge) throw reject("the registration response is malformed");
      const consumed = await this.uow.read.passkeys.consumeChallenge({
        userId,
        purpose: "REGISTRATION",
        challenge,
        now: this.now(),
      });
      if (!consumed) throw reject("the challenge is unknown, expired or already used");
      const verified = await this.deps.passkeyVerifier.verifyRegistration({
        response: input.response,
        expectedChallenge: challenge,
        expectedOrigin: this.deps.origin,
        expectedRpId: this.deps.rpId,
      });
      if (!verified) throw reject("the registration could not be verified");
      if (await this.uow.read.passkeys.findByCredentialId(verified.credentialId)) {
        throw reject("this credential is already registered");
      }
      return {
        public: {
          kind: "PASSKEY",
          credentialId: verified.credentialId,
          publicKeyX: verified.publicKeyX,
          publicKeyY: verified.publicKeyY,
        },
        ref: verified.credentialId,
        rpId: this.deps.rpId,
        tier: "UNKNOWN",
      };
    }
    const { keyId, point } = this.checkedPoint(input);
    if (!/^0x[0-9a-f]{64}$/.test(input.challenge)) throw reject("the challenge is malformed");
    const consumed = await this.uow.read.passkeys.consumeChallenge({
      userId,
      purpose: "REGISTRATION",
      challenge: input.challenge,
      now: this.now(),
    });
    if (!consumed) throw reject("the challenge is unknown, expired or already used");
    const proven = verifyP256({
      x: input.publicKeyX,
      y: input.publicKeyY,
      message: Buffer.from(this.enrolmentPayload(keyId, input.challenge).slice(2), "hex"),
      r: input.r,
      s: input.s,
    });
    if (!proven) throw reject("the device key could not be verified");
    const tier = toTier(
      await classifyDeviceKey({
        // This is the WEB enrolment path: the server, not the client, decides the channel.
        channel: "web",
        point,
        verifier: this.deps.attestationVerifier,
      }),
    );
    return {
      public: {
        kind: "DEVICE_KEY",
        keyId,
        publicKeyX: input.publicKeyX,
        publicKeyY: input.publicKeyY,
      },
      ref: keyId,
      tier,
    };
  }

  private enrolmentPayload(keyId: string, challenge: string): Hex {
    return deviceProofPayload({
      chainId: this.deps.onChainId,
      validator: ZERO_ADDRESS,
      account: ZERO_ADDRESS,
      keyId: keyId as Hex,
      purpose: "ROOT_ENROLLMENT",
      challenge: challenge as Hex,
    });
  }

  private checkedPoint(key: { publicKeyX: string; publicKeyY: string }) {
    if (!HEX64.test(key.publicKeyX) || !HEX64.test(key.publicKeyY)) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the public key is malformed");
    }
    const point = { x: BigInt(`0x${key.publicKeyX}`), y: BigInt(`0x${key.publicKeyY}`) };
    if (!isOnP256Curve(point)) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the public key is not a valid P-256 point");
    }
    return { point, keyId: deviceKeyIdFromPoint(point) };
  }
}
