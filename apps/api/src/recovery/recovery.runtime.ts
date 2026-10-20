import { randomBytes } from "node:crypto";

import { ViemRecoveryChain, readKeyFileOutsideRepo } from "@kaada/blockchain";
import type { ViemRecoveryChainOptions } from "@kaada/blockchain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import type {
  ChannelMessenger,
  PasskeyVerifier,
  RecoveryChainPort,
  RecoveryEmailSender,
} from "@kaada/domain";
import type { Hex } from "viem";

import type { AgentLog } from "../core/agent/ports.js";
import { noopLog } from "../core/agent/ports.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import { applicationRoots } from "../security/application-roots.js";
import type { RecoveryContext } from "../core/recovery/context.js";
import { RecoveryNotifier } from "../core/recovery/notifier.js";
import { DEFAULT_RECOVERY_POLICY } from "../core/recovery/ports.js";
import type { RecoveryPolicy, RecoveryUnitOfWork } from "../core/recovery/ports.js";
import { RecoveryCleanup } from "../core/recovery/recovery-cleanup.js";
import { RecoveryConfigurationService } from "../core/recovery/recovery-configuration.js";
import { RecoveryEmailService } from "../core/recovery/recovery-email.js";
import { RecoveryFinalizer } from "../core/recovery/recovery-finalizer.js";
import { RecoveryFlowService } from "../core/recovery/recovery-flow.js";
import { RecoveryTotpService } from "../core/recovery/recovery-totp.js";
import type { SecretCipher } from "../core/execution/ports.js";
import { DefaultRecoveryRiskPolicy } from "../core/recovery/risk-policy.js";
import { EmailChannelMessenger } from "../infrastructure/recovery/email.js";

/** The composed recovery services, built once and shared by the controller and the sweeper. */
export interface RecoveryRuntime {
  context: RecoveryContext;
  flow: RecoveryFlowService;
  cleanup: RecoveryCleanup;
  finalizer: RecoveryFinalizer;
  configuration: RecoveryConfigurationService;
  /** Registering and verifying the email a person recovers with. */
  email: RecoveryEmailService;
}

import type { RateLimitFactory } from "../rate-limit/rate-limit.module.js";
import type { DeviceTierResolver } from "../core/attestation/device-tier-service.js";

export interface RecoveryRuntimeParams {
  database: Database;
  chain: RecoveryChainPort;
  /** Encrypts the authenticator-app secrets at rest: a dedicated key (RECOVERY_TOTP_SECRET_KEY). */
  totpCipher: SecretCipher;
  email: RecoveryEmailSender;
  passkeyVerifier: PasskeyVerifier;
  pins: Pick<TransactionPinService, "setPin">;
  rpId: string;
  origin: string;
  webUrl: string;
  /** 32 random bytes keying the email-code hash. */
  challengeSecret: Buffer;
  policy?: Partial<RecoveryPolicy>;
  deviceTiers?: DeviceTierResolver;
  /** What may be spent on one wallet so it can secure itself (see RecoveryContext.sponsorship). */
  sponsorship?: RecoveryContext["sponsorship"];
  /** Rate limits for the recovery steps. Absent: per-process limits (development and tests only). */
  limits?: RateLimitFactory;
  messengers?: ChannelMessenger[];
  now?: () => Date;
  log?: AgentLog;
}

/** Assembles the recovery services over a database and explicit ports. Nothing here reads the environment. */
export function createRecoveryRuntime(params: RecoveryRuntimeParams): RecoveryRuntime {
  const uow: RecoveryUnitOfWork = {
    read: createRepositories(params.database),
    transaction: (work) => withTransaction(params.database, work),
  };
  const policy: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...params.policy };
  const log = params.log ?? noopLog;
  const read = uow.read;
  const context: RecoveryContext = {
    uow,
    chain: params.chain,
    totp: new RecoveryTotpService({
      totps: read.recoveryTotps,
      audit: read.audit,
      cipher: params.totpCipher,
      now: params.now ?? (() => new Date()),
      ...(params.limits && { limiter: params.limits("recovery:totp", 10, 10 * 60 * 1000) }),
    }),
    email: params.email,
    notifier: new RecoveryNotifier({
      identities: read.identities,
      audit: read.audit,
      messengers: params.messengers ?? [new EmailChannelMessenger(params.email)],
      log,
    }),
    risk: new DefaultRecoveryRiskPolicy(policy),
    policy,
    ...(params.sponsorship && { sponsorship: params.sponsorship }),
    passkeyVerifier: params.passkeyVerifier,
    rpId: params.rpId,
    origin: params.origin,
    webUrl: params.webUrl,
    challengeSecret: params.challengeSecret,
    now: params.now ?? (() => new Date()),
    log,
  };
  const limits = params.limits;
  const flow = new RecoveryFlowService({
    context,
    ...(params.deviceTiers && { deviceTiers: params.deviceTiers }),
    ...(limits && {
      limiters: {
        start: limits("recovery:start", 5, 60 * 60 * 1000),
        ip: limits("recovery:ip", 20, 60 * 60 * 1000),
        step: limits("recovery:step", 30, 10 * 60 * 1000),
      },
    }),
  });
  const cleanup = new RecoveryCleanup(context);
  return {
    context,
    flow,
    cleanup,
    finalizer: new RecoveryFinalizer({
      context,
      flow,
      cleanup,
      pins: params.pins,
      owner: `finalizer:${randomBytes(6).toString("hex")}`,
    }),
    configuration: new RecoveryConfigurationService(context),
    email: new RecoveryEmailService(context),
  };
}

/**
 * Startup guard: the recovery validator accepts `initiate` only from the relayer address it was deployed with, so a key file that
 * derives to any other address could never start a recovery. Refuse to boot instead of failing mid-recovery. The message names
 * the two PUBLIC addresses only; the key is never part of it.
 */
export function assertRelayerMatchesDeployment(
  derivedAddress: string,
  deployedAddress: string,
): void {
  if (derivedAddress.toLowerCase() !== deployedAddress.toLowerCase()) {
    throw new Error(
      `RECOVERY_RELAYER_KEY_FILE derives to ${derivedAddress.toLowerCase()}, but the recovery validator on this network was deployed with relayer ${deployedAddress.toLowerCase()} (deployments.ts). Refusing to start.`,
    );
  }
}

/**
 * Builds the chain adapter. The relayer's gas key is read from a FILE outside the repository (in production a read-only mounted
 * secret, /run/secrets/recovery-relayer.key). The relayer is a hot operational key: it submits recovery initiation and pays
 * gas, it does not have the Recovery Code, cannot forge a recovery, cannot cancel one and controls no user funds.
 */
export function createRecoveryChain(input: {
  chain: ViemRecoveryChainOptions["chain"];
  rpcUrl: string;
  bundlerUrl: string;
  recoveryValidator: `0x${string}`;
  deployments: ViemRecoveryChainOptions["deployments"];
  relayerKeyFile: string;
  p256Precompile: boolean;
  gasTopUpMaxWei: bigint;
  /** Present only where the platform opens wallets' accounts (RECOVERY_SPONSOR_PER_WALLET_WEI > 0). */
  accountFactoryCall?: ViemRecoveryChainOptions["accountFactoryCall"];
}): ViemRecoveryChain {
  const relayerKey: Hex = readKeyFileOutsideRepo(
    input.relayerKeyFile,
    applicationRoots(),
    "RECOVERY_RELAYER_KEY_FILE",
  );
  return new ViemRecoveryChain({
    chain: input.chain,
    rpcUrl: input.rpcUrl,
    bundlerUrl: input.bundlerUrl,
    recoveryValidator: input.recoveryValidator,
    deployments: input.deployments,
    relayerKey,
    p256Precompile: input.p256Precompile,
    ...(input.accountFactoryCall && { accountFactoryCall: input.accountFactoryCall }),
    gasSponsor:
      input.gasTopUpMaxWei > 0n
        ? { mode: "topup", maxTopUpWei: input.gasTopUpMaxWei }
        : { mode: "none" },
  });
}
