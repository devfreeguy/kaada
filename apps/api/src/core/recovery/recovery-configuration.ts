import { deviceKeyPayload } from "@kaada/contracts";
import {
  KaadaError,
  RECOVERY_AUDIT_EVENTS,
  createId,
  depositValueUsdMicros,
  isWalletActive,
} from "@kaada/domain";
import type { RecoveryConfiguration, Wallet } from "@kaada/domain";

import type { RecoveryContext } from "./context.js";
import type { TotpEnrolment } from "./recovery-totp.js";
import { toRootCredential } from "../roots/root-credentials.js";
import { ensureRootCredential } from "./recovery-flow.js";
import type { RootSigningRequest } from "./recovery-flow.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Opening an account costs about 0.015 CELO; a grant smaller than this cannot be trusted to cover it. */
const OPEN_COST_CEILING_WEI = 50_000_000_000_000_000n;

type SponsorRefusal =
  "SPONSORING_OFF" | "BELOW_MINIMUM_DEPOSIT" | "WALLET_CAP" | "DAILY_BUDGET" | "RELAYER_RESERVE";
interface Grant {
  id: string;
  grantedWei: bigint;
}

const isGasFundingRequired = (error: unknown): boolean =>
  error instanceof KaadaError &&
  error.code === "RECOVERY_BLOCKED" &&
  (error.details as { reason?: unknown } | undefined)?.reason === "GAS_FUNDING_REQUIRED";

/** What the person is told. The reason stays in the log and in `details`; it never reaches them. */
const sponsorshipRefused = (reason: SponsorRefusal): KaadaError =>
  new KaadaError(
    "RECOVERY_SPONSORSHIP_REFUSED",
    "to finish securing your account, add a small amount of CELO to your wallet, or deposit a larger amount",
    { details: { reason } },
  );

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

  /** Which account and chain a new Recovery Code must be derived for (the code is bound to both). Public data only. */
  async describe(userId: string): Promise<{
    account: string;
    chainId: number;
    authenticatorEnrolled: boolean;
    emailRegistered: boolean;
  }> {
    const wallet = await this.walletOf(userId);
    return {
      account: wallet.address,
      chainId: this.ctx.chain.chainId,
      authenticatorEnrolled: await this.ctx.totp.isEnrolled(wallet.id),
      emailRegistered: await this.hasEmail(userId),
    };
  }

  /** Starts the authenticator-app setup: the secret is returned ONCE here and kept only encrypted. */
  async beginAuthenticator(userId: string): Promise<TotpEnrolment> {
    await this.requireEmail(userId);
    const wallet = await this.walletOf(userId);
    return this.ctx.totp.begin({
      userId,
      walletId: wallet.id,
      accountName: await this.accountName(userId),
    });
  }

  /** Setup is complete only when a code from the app verifies. */
  async confirmAuthenticator(userId: string, code: unknown): Promise<void> {
    const wallet = await this.walletOf(userId);
    await this.ctx.totp.confirm({ userId, walletId: wallet.id, code });
  }

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
    await this.requireEmail(input.userId);
    const delaySeconds = input.delaySeconds ?? this.ctx.policy.defaultDelaySeconds;
    if (!Number.isInteger(delaySeconds) || delaySeconds < this.ctx.policy.minDelaySeconds) {
      throw new KaadaError("RECOVERY_REJECTED", "the recovery delay is below the minimum");
    }
    const wallet = await this.walletOf(input.userId);
    // Recovery needs both user-held factors. A Recovery Code alone is not armed: the authenticator app comes first.
    if (!(await this.ctx.totp.isEnrolled(wallet.id))) {
      throw new KaadaError(
        "RECOVERY_TOTP_REQUIRED",
        "set up your authenticator app before saving a Recovery Code",
      );
    }
    const { root, validator, prepared } = await this.prepareInstall(wallet, address, delaySeconds);
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
            keyId: root.credentialRef,
            payload: deviceKeyPayload({
              chainId: this.ctx.chain.chainId,
              validator: root.validatorAddress as `0x${string}`,
              account: wallet.address as `0x${string}`,
              keyId: root.credentialRef as `0x${string}`,
              userOpHash: hash as `0x${string}`,
            }),
          },
        }),
      },
    };
  }

  /**
   * The chain part of arming: the account (opened first where the platform sponsors it), the validator state, and the install
   * operation to sign. A wallet that was only ever funded has no account on chain and may hold no CELO. Where the platform sponsors,
   * it opens the account and pays the gas of this one step, but only for a wallet that has really received money, only within the
   * wallet's lifetime budget and the platform's daily budget, and never below the relayer's reserve (see reserveSponsorship).
   */
  private async prepareInstall(
    wallet: Wallet & { address: string },
    recoveryAddress: string,
    delaySeconds: number,
  ) {
    const chain = this.ctx.chain;
    let account = await chain.accountState(wallet.address);
    let grant: Grant | null = null;
    let spent = 0n;
    try {
      if (!account.deployed) {
        const reservation = await this.reserveSponsorship(wallet, true);
        if (reservation === "SPONSORING_OFF") {
          throw new KaadaError(
            "RECOVERY_REJECTED",
            "the wallet must be set up on chain before recovery can be armed",
          );
        }
        if (typeof reservation === "string") throw sponsorshipRefused(reservation);
        grant = reservation;
        const opened = await this.openAccount(wallet);
        spent += opened;
        account = await chain.accountState(wallet.address);
      }
      if (!account.deployed || !account.rootValidator) {
        throw new KaadaError(
          "RECOVERY_REJECTED",
          "the wallet must be set up on chain before recovery can be armed",
        );
      }
      const validator = await chain.validatorState(wallet.address);
      if (validator.pending) {
        throw new KaadaError(
          "RECOVERY_CONFLICT",
          "a recovery is pending; it must finish or be cancelled first",
        );
      }
      const root = await ensureRootCredential(this.ctx.uow.read, wallet, account.rootValidator);
      const calls = chain.armCalls({
        account: wallet.address,
        recoveryAddress: recoveryAddress.toLowerCase(),
        delaySeconds,
        currentNonce: account.currentNonce,
        alreadyConfigured: validator.initialized,
      });
      const operation = {
        account: wallet.address,
        rootValidator: account.rootValidator,
        rootKind: root.kind,
        calls,
      };
      let prepared;
      try {
        // First without sponsoring: a wallet that holds enough CELO of its own costs the platform nothing.
        prepared = await chain.prepareRootOperation(operation);
      } catch (error) {
        if (!isGasFundingRequired(error) || !this.sponsoringOn()) throw error;
        if (!grant) {
          const reservation = await this.reserveSponsorship(wallet, false);
          if (typeof reservation === "string") throw sponsorshipRefused(reservation);
          grant = reservation;
        }
        const left = grant.grantedWei - spent;
        if (left <= 0n) throw sponsorshipRefused("WALLET_CAP");
        try {
          prepared = await chain.prepareRootOperation({
            ...operation,
            sponsorUpToWei: left.toString(),
          });
        } catch (second) {
          if (isGasFundingRequired(second)) throw sponsorshipRefused("WALLET_CAP");
          throw second;
        }
        if (prepared.sponsoredWei) {
          const topUp = BigInt(prepared.sponsoredWei);
          spent += topUp;
          await this.recordSponsored(wallet, topUp, "gas_topup");
        }
      }
      return { root, validator, prepared };
    } finally {
      if (grant) {
        await this.ctx.sponsorship?.ledger.settle({
          id: grant.id,
          userId: wallet.userId,
          walletId: wallet.id,
          spentWei: spent,
        });
        await this.warnIfLow();
      }
    }
  }

  private sponsoringOn() {
    const s = this.ctx.sponsorship;
    return s && s.perWalletWei > 0n && s.dailyBudgetWei > 0n ? s : null;
  }

  /**
   * Decides whether the platform may spend on this wallet, and reserves the most it may spend, in one atomic step with the caps. A
   * refusal is a reason (logged, and shown to the person as a plain request to add a little CELO or a larger deposit). Checked in
   * order: what the wallet has received is worth enough; the relayer keeps its reserve; the wallet's and the day's caps.
   */
  private async reserveSponsorship(
    wallet: Wallet & { address: string },
    needsOpen: boolean,
  ): Promise<Grant | SponsorRefusal> {
    const s = this.sponsoringOn();
    if (!s) return "SPONSORING_OFF";
    const refuse = (reason: SponsorRefusal, extra: Record<string, string> = {}): SponsorRefusal => {
      this.ctx.log("warn", "recovery.sponsor_refused", { walletId: wallet.id, reason, ...extra });
      return reason;
    };
    const received = depositValueUsdMicros(await s.depositItems(wallet.userId));
    if (received < s.minDepositUsdMicros) {
      return refuse("BELOW_MINIMUM_DEPOSIT", {
        receivedUsdMicros: received.toString(),
        minimumUsdMicros: s.minDepositUsdMicros.toString(),
      });
    }
    // Unreadable is treated as empty: sponsoring never spends when it cannot see what the relayer has left.
    const balance = this.ctx.chain.relayerBalanceWei
      ? BigInt(await this.ctx.chain.relayerBalanceWei().catch(() => "0"))
      : 0n;
    const affordable = balance > s.relayerReserveWei ? balance - s.relayerReserveWei : 0n;
    if (affordable === 0n) {
      return refuse("RELAYER_RESERVE", {
        relayerBalanceWei: balance.toString(),
        reserveWei: s.relayerReserveWei.toString(),
      });
    }
    const want = s.perWalletWei < affordable ? s.perWalletWei : affordable;
    const reservation = await s.ledger.reserve({
      userId: wallet.userId,
      walletId: wallet.id,
      wantWei: want,
      walletCapWei: s.perWalletWei,
      dailyCapWei: s.dailyBudgetWei,
      windowMs: DAY_MS,
      now: this.ctx.now(),
    });
    if (!reservation.granted) return refuse(reservation.reason);
    if (needsOpen && reservation.grantedWei < OPEN_COST_CEILING_WEI) {
      await s.ledger.settle({
        id: reservation.id,
        userId: wallet.userId,
        walletId: wallet.id,
        spentWei: 0n,
      });
      return refuse(reservation.limitedBy ?? "RELAYER_RESERVE");
    }
    return { id: reservation.id, grantedWei: reservation.grantedWei };
  }

  /** Opens the wallet's account on chain, paid by the platform. Returns what it cost. */
  private async openAccount(wallet: Wallet & { address: string }): Promise<bigint> {
    const chain = this.ctx.chain;
    const rootRow = await this.ctx.uow.read.walletCredentials.findRoot(wallet.id);
    if (!rootRow || !chain.openAccount) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the wallet must be set up on chain before recovery can be armed",
      );
    }
    try {
      const opened = await chain.openAccount({
        account: wallet.address,
        root: toRootCredential(rootRow, this.ctx.rpId),
      });
      const cost = BigInt(opened.costWei);
      if (opened.opened) await this.recordSponsored(wallet, cost, "open_account");
      return cost;
    } catch (error) {
      this.ctx.log("error", "recovery.account_open_failed", {
        walletId: wallet.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** A detail record of one spend (what it was for). The caps are enforced from the ledger, not from these. */
  private async recordSponsored(
    wallet: Wallet & { address: string },
    wei: bigint,
    purpose: string,
  ): Promise<void> {
    await this.ctx.uow.read.audit.append({
      id: createId(),
      userId: wallet.userId,
      type: RECOVERY_AUDIT_EVENTS.relayerSponsored,
      entityType: "wallet",
      entityId: wallet.id,
      data: { wei: wei.toString(), purpose },
    });
    this.ctx.log("info", "recovery.relayer_sponsored", {
      walletId: wallet.id,
      purpose,
      wei: wei.toString(),
    });
  }

  /** Tells the operator, at error level, before the money runs out: the day's budget over 80% used, or the relayer near its reserve. */
  private async warnIfLow(): Promise<void> {
    const s = this.sponsoringOn();
    if (!s) return;
    try {
      const used = await s.ledger.usedInWindow(this.ctx.now(), DAY_MS);
      if (used * 100n >= s.dailyBudgetWei * 80n) {
        this.ctx.log("error", "recovery.sponsor_budget_low", {
          reason: "DAILY_BUDGET_OVER_80_PERCENT",
          usedWei: used.toString(),
          dailyBudgetWei: s.dailyBudgetWei.toString(),
        });
      }
      if (this.ctx.chain.relayerBalanceWei) {
        const balance = BigInt(await this.ctx.chain.relayerBalanceWei());
        if (balance * 100n < s.relayerReserveWei * 125n) {
          this.ctx.log("error", "recovery.sponsor_budget_low", {
            reason: "RELAYER_NEAR_RESERVE",
            relayerBalanceWei: balance.toString(),
            reserveWei: s.relayerReserveWei.toString(),
          });
        }
      }
    } catch (error) {
      this.ctx.log("warn", "recovery.sponsor_budget_check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private async hasEmail(userId: string): Promise<boolean> {
    const identities = await this.ctx.uow.read.identities.listForUser(userId);
    return identities.some((identity) => identity.type === "EMAIL");
  }

  /** Recovery starts from an email, so a Recovery Code for an account with none would protect nothing. */
  private async requireEmail(userId: string): Promise<void> {
    if (!(await this.hasEmail(userId))) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "add and verify your recovery email before setting up recovery",
      );
    }
  }

  /** The label shown in the authenticator app: the registered email, else a plain name. */
  private async accountName(userId: string): Promise<string> {
    const identities = await this.ctx.uow.read.identities.listForUser(userId);
    return identities.find((identity) => identity.type === "EMAIL")?.externalId ?? "wallet";
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
