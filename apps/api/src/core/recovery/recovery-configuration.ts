import { KaadaError, RECOVERY_AUDIT_EVENTS, createId, isWalletActive } from "@kaada/domain";
import type { RecoveryConfiguration, Wallet } from "@kaada/domain";

import type { RecoveryContext } from "./context.js";
import { ensureRootCredential } from "./recovery-flow.js";
import type { RootSigningRequest } from "./recovery-flow.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export interface ArmRequest {
  configurationId: string;
  signing: RootSigningRequest;
}

/**
 * Arms (or re-arms) a wallet recovery: the CURRENT ROOT signs a UserOperation that installs the recovery validator with the
 * public verifier of a new Recovery Code. The Recovery Code never reaches the server; only the address derived from it does.
 *
 * Used the first time (the wallet's own session) and after a recovery (the recovery session): the old Recovery Code is spent,
 * and a new one must be created before the wallet is protected again.
 */
export class RecoveryConfigurationService {
  constructor(private readonly ctx: RecoveryContext) {}

  /** Builds and stores the install operation for the current root to sign. Sends nothing. */
  async prepare(input: {
    userId: string;
    recoveryAddress: unknown;
    delaySeconds?: number;
  }): Promise<ArmRequest> {
    const address = input.recoveryAddress;
    if (typeof address !== "string" || !ADDRESS.test(address) || ZERO.test(address)) {
      throw new KaadaError("RECOVERY_REJECTED", "the recovery verifier is not a valid address");
    }
    const delaySeconds = input.delaySeconds ?? this.ctx.policy.defaultDelaySeconds;
    if (!Number.isInteger(delaySeconds) || delaySeconds < this.ctx.policy.minDelaySeconds) {
      throw new KaadaError("RECOVERY_REJECTED", "the recovery delay is below the minimum");
    }
    const wallet = await this.walletOf(input.userId);
    const account = await this.ctx.chain.accountState(wallet.address);
    if (!account.deployed || !account.rootValidator) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the wallet must be set up on chain before recovery can be armed",
      );
    }
    const validator = await this.ctx.chain.validatorState(wallet.address);
    if (validator.pending) {
      throw new KaadaError(
        "RECOVERY_CONFLICT",
        "a recovery is pending; it must finish or be cancelled first",
      );
    }
    const root = await ensureRootCredential(this.ctx.uow.read, wallet, account.rootValidator);
    const calls = this.ctx.chain.armCalls({
      account: wallet.address,
      recoveryAddress: address.toLowerCase(),
      delaySeconds,
      currentNonce: account.currentNonce,
      alreadyConfigured: validator.initialized,
    });
    const prepared = await this.ctx.chain.prepareRootOperation({
      account: wallet.address,
      rootValidator: account.rootValidator,
      rootKind: root.kind,
      calls,
    });
    const configuration = await this.ctx.uow.transaction(async (tx) => {
      // An unfinished earlier preparation is superseded, never left dangling.
      for (const old of await tx.recoveryConfigurations.listForWallet(wallet.id)) {
        if (old.status === "PENDING_INSTALL")
          await tx.recoveryConfigurations.close(old.id, "SUPERSEDED");
      }
      const created = await tx.recoveryConfigurations.create({
        id: createId(),
        userId: wallet.userId,
        walletId: wallet.id,
        chainId: this.ctx.chain.chainId,
        validatorAddress: this.ctx.chain.recoveryValidator,
        recoveryAddress: address.toLowerCase(),
        delaySeconds,
        status: "PENDING_INSTALL",
        armedByCredentialId: root.id,
        recoveryNonce: validator.recoveryNonce,
        installUserOpHash: prepared.userOpHash.toLowerCase(),
        preparedOperation: prepared.operation,
      });
      await tx.audit.append({
        id: createId(),
        userId: wallet.userId,
        type: RECOVERY_AUDIT_EVENTS.configurationRequested,
        entityType: "recovery_configuration",
        entityId: created.id,
      });
      return created;
    });
    const hash = prepared.userOpHash.toLowerCase();
    return {
      configurationId: configuration.id,
      signing: {
        challenge: hash,
        rootKind: root.kind,
        chainId: this.ctx.chain.chainId,
        ...(root.kind === "PASSKEY" && {
          passkey: {
            challenge: Buffer.from(hash.slice(2), "hex").toString("base64url"),
            rpId: this.ctx.rpId,
            userVerification: "required" as const,
          },
        }),
        ...(root.kind === "DEVICE_KEY" && {
          device: {
            chainId: this.ctx.chain.chainId,
            validator: root.validatorAddress,
            account: wallet.address,
          },
        }),
      },
    };
  }

  /**
   * The root signed the stored install operation: the validator confirms the signature (an eth_call), the operation is
   * sent, and the configuration becomes ACTIVE only when the chain reads back exactly what was asked for.
   */
  async submit(input: {
    userId: string;
    configurationId: string;
    material: unknown;
  }): Promise<RecoveryConfiguration> {
    const read = this.ctx.uow.read;
    const configuration = await read.recoveryConfigurations.findById(input.configurationId);
    if (
      !configuration ||
      configuration.userId !== input.userId ||
      configuration.status !== "PENDING_INSTALL" ||
      !configuration.preparedOperation ||
      !configuration.installUserOpHash
    ) {
      throw new KaadaError("RECOVERY_REJECTED", "this configuration is not available");
    }
    const wallet = await this.walletOf(input.userId);
    const account = await this.ctx.chain.accountState(wallet.address);
    if (!account.rootValidator) throw new KaadaError("RECOVERY_REJECTED", "the wallet has no root");
    const root = await ensureRootCredential(read, wallet, account.rootValidator);
    const signature = this.ctx.chain.encodeRootSignature({
      kind: root.kind,
      material: input.material,
    });
    const valid = await this.ctx.chain.checkSignature({
      account: wallet.address,
      validator: account.rootValidator,
      kind: root.kind,
      hash: configuration.installUserOpHash,
      signature,
    });
    if (!valid) throw new KaadaError("CREDENTIAL_REJECTED", "the signature was not accepted");

    await this.ctx.chain.submitOperation({ operation: configuration.preparedOperation, signature });
    return (await this.confirm(configuration.id)) ?? configuration;
  }

  /**
   * Reads the validator back: ACTIVE only if it holds exactly this verifier and delay for the account. Safe to call
   * repeatedly (also from the reconciler for an operation that was still in flight).
   */
  async confirm(configurationId: string): Promise<RecoveryConfiguration | null> {
    const read = this.ctx.uow.read;
    const configuration = await read.recoveryConfigurations.findById(configurationId);
    if (!configuration || configuration.status !== "PENDING_INSTALL") return configuration;
    const wallet = await read.wallets.findById(configuration.walletId);
    if (!wallet?.address) return configuration;
    const deadline = this.ctx.now().getTime() + this.ctx.policy.inclusionWaitMs;
    for (;;) {
      const validator = await this.ctx.chain.validatorState(wallet.address);
      if (
        validator.initialized &&
        validator.recoveryKey?.toLowerCase() === configuration.recoveryAddress &&
        validator.delaySeconds === configuration.delaySeconds
      ) {
        const active = await this.ctx.uow.transaction(async (tx) => {
          const activated = await tx.recoveryConfigurations.activate({
            id: configuration.id,
            recoveryNonce: validator.recoveryNonce,
            at: this.ctx.now(),
          });
          if (activated) {
            await tx.audit.append({
              id: createId(),
              userId: wallet.userId,
              type: RECOVERY_AUDIT_EVENTS.configurationActivated,
              entityType: "recovery_configuration",
              entityId: activated.id,
            });
            // A recovery that was waiting for a new Recovery Code is now finished.
            const waiting = await tx.recoveryAttempts.findCompletedAwaitingConfiguration(wallet.id);
            if (waiting) {
              const attempt = waiting;
              await tx.recoveryAttempts.patch(
                attempt.id,
                { newConfigurationId: activated.id },
                { status: ["COMPLETED"] },
              );
              await tx.audit.append({
                id: createId(),
                userId: wallet.userId,
                type: RECOVERY_AUDIT_EVENTS.newRecoveryCodeConfigured,
                entityType: "recovery_attempt",
                entityId: attempt.id,
              });
            }
          }
          return activated;
        });
        return active ?? (await read.recoveryConfigurations.findById(configuration.id));
      }
      if (this.ctx.now().getTime() >= deadline) return configuration;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** The current root's configuration status, for the wallet owner. */
  async current(userId: string): Promise<RecoveryConfiguration | null> {
    const wallet = await this.walletOf(userId);
    return this.ctx.uow.read.recoveryConfigurations.findActive(wallet.id);
  }

  private async walletOf(userId: string): Promise<Wallet & { address: string }> {
    const wallets = await this.ctx.uow.read.wallets.listByUser(userId);
    const wallet = wallets.find(
      (candidate) => candidate.type === "EMBEDDED" && candidate.status !== "REVOKED",
    );
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "the wallet is not active");
    }
    return wallet;
  }
}
