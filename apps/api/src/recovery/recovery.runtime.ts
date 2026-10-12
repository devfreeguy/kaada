import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  KeyAttestor,
  ViemRecoveryChain,
  createVetoSender,
  readKeyFileOutsideRepo,
} from "@kaada/blockchain";
import type { AttestorSigner, ViemRecoveryChainOptions } from "@kaada/blockchain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import type {
  ChannelMessenger,
  PasskeyVerifier,
  RecoveryAttestor,
  RecoveryChainPort,
  RecoveryEmailSender,
} from "@kaada/domain";
import type { Hex } from "viem";

import type { AgentLog } from "../core/agent/ports.js";
import { noopLog } from "../core/agent/ports.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import type { RecoveryContext } from "../core/recovery/context.js";
import { RecoveryNotifier } from "../core/recovery/notifier.js";
import { DEFAULT_RECOVERY_POLICY } from "../core/recovery/ports.js";
import type { RecoveryPolicy, RecoveryUnitOfWork } from "../core/recovery/ports.js";
import { RecoveryCleanup } from "../core/recovery/recovery-cleanup.js";
import { RecoveryConfigurationService } from "../core/recovery/recovery-configuration.js";
import { RecoveryFinalizer } from "../core/recovery/recovery-finalizer.js";
import { RecoveryFlowService } from "../core/recovery/recovery-flow.js";
import { DefaultRecoveryRiskPolicy } from "../core/recovery/risk-policy.js";
import { EmailChannelMessenger } from "../infrastructure/recovery/email.js";

/** The composed recovery services, built once and shared by the controller and the sweeper. */
export interface RecoveryRuntime {
  context: RecoveryContext;
  flow: RecoveryFlowService;
  cleanup: RecoveryCleanup;
  finalizer: RecoveryFinalizer;
  configuration: RecoveryConfigurationService;
}

import type { RateLimitFactory } from "../rate-limit/rate-limit.module.js";
import type { DeviceTierResolver } from "../core/attestation/device-tier-service.js";

export interface RecoveryRuntimeParams {
  database: Database;
  chain: RecoveryChainPort;
  attestor: RecoveryAttestor;
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
    attestor: params.attestor,
    email: params.email,
    notifier: new RecoveryNotifier({
      identities: read.identities,
      audit: read.audit,
      messengers: params.messengers ?? [new EmailChannelMessenger(params.email)],
      log,
    }),
    risk: new DefaultRecoveryRiskPolicy(policy),
    policy,
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
  };
}

/** The repository checkout root: signing keys must live outside it. */
export const repositoryRoot = (): string => fileURLToPath(new URL("../../../../", import.meta.url));

/** Builds the chain adapter and the attestor from key FILES outside the repository. */
export function createRecoveryChainAndAttestor(input: {
  chain: ViemRecoveryChainOptions["chain"];
  rpcUrl: string;
  bundlerUrl: string;
  recoveryValidator: `0x${string}`;
  deployments: ViemRecoveryChainOptions["deployments"];
  relayerKeyFile: string;
  /**
   * Who holds the attestor key: a key FILE (development and tests; production configuration refuses it) or a signer backed
   * by a KMS/HSM (see `createExternalSigner`), which this process never sees the key of.
   */
  attestor: { kind: "file"; keyFile: string } | { kind: "signer"; signer: AttestorSigner };
  p256Precompile: boolean;
  gasTopUpMaxWei: bigint;
}): { chain: ViemRecoveryChain; attestor: KeyAttestor } {
  const relayerKey: Hex = readKeyFileOutsideRepo(input.relayerKeyFile, repositoryRoot());
  const keyed =
    input.attestor.kind === "file"
      ? {
          privateKey: readKeyFileOutsideRepo(input.attestor.keyFile, repositoryRoot()),
        }
      : { signer: input.attestor.signer };
  const chain = new ViemRecoveryChain({
    chain: input.chain,
    rpcUrl: input.rpcUrl,
    bundlerUrl: input.bundlerUrl,
    recoveryValidator: input.recoveryValidator,
    deployments: input.deployments,
    relayerKey,
    p256Precompile: input.p256Precompile,
    gasSponsor:
      input.gasTopUpMaxWei > 0n
        ? { mode: "topup", maxTopUpWei: input.gasTopUpMaxWei }
        : { mode: "none" },
  });
  const attestor = new KeyAttestor({
    ...keyed,
    chainId: input.chain.id,
    recoveryValidator: input.recoveryValidator,
    sendVeto: createVetoSender({
      chain: input.chain,
      rpcUrl: input.rpcUrl,
      ...keyed,
      recoveryValidator: input.recoveryValidator,
    }),
  });
  return { chain, attestor };
}
