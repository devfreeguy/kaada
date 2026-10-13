import { Module } from "@nestjs/common";
import type { AttestorSigner } from "@kaada/blockchain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { KernelExecutionPort, RootValidatorDeployer } from "@kaada/domain";
import type { AppConfig } from "@kaada/config";
import type { Database } from "@kaada/database";
import { celo, celoSepolia } from "viem/chains";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { TRANSACTION_PIN_SERVICE } from "../authorization/authorization.tokens.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import { EmailChannelMessenger, FileOutboxEmailSender } from "../infrastructure/recovery/email.js";
import { SmtpEmailSender } from "../infrastructure/recovery/smtp-email.js";
import { TelegramAdapter } from "../infrastructure/channels/telegram/telegram-adapter.js";
import { TelegramChannelMessenger } from "../infrastructure/recovery/telegram.js";
import { RATE_LIMIT_FACTORY } from "../rate-limit/rate-limit.tokens.js";
import type { RateLimitFactory } from "../rate-limit/rate-limit.module.js";
import type { ChannelMessenger, RecoveryEmailSender } from "@kaada/domain";
import { SimpleWebAuthnVerifier } from "../infrastructure/wallet/simplewebauthn-verifier.js";
import type { RootAdapters, RootCredentialService } from "../core/roots/root-credentials.js";
import { RootChangeService } from "../core/roots/root-change-service.js";
import { ExecutionModule } from "../execution/execution.module.js";
import { KERNEL_EXECUTION_PORT } from "../execution/execution.tokens.js";
import { RootChangeController } from "../roots/root-change.controller.js";
import { RootsModule } from "../roots/roots.module.js";
import {
  ROOT_ADAPTERS,
  ROOT_CHANGE_SERVICE,
  ROOT_CREDENTIAL_SERVICE,
  ROOT_VALIDATOR_DEPLOYER,
} from "../roots/roots.tokens.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { DEVICE_TIER_SERVICE } from "../wallet/wallet.tokens.js";
import type { DeviceTierService } from "../core/attestation/device-tier-service.js";
import { RecoveryController } from "./recovery.controller.js";
import { createRecoveryChainAndAttestor, createRecoveryRuntime } from "./recovery.runtime.js";
import type { RecoveryRuntime } from "./recovery.runtime.js";
import { RecoverySweeper } from "./recovery-sweeper.js";
import { ATTESTOR_SIGNER_FACTORY, RECOVERY_RUNTIME } from "./recovery.tokens.js";

/**
 * Account recovery. Present only when RECOVERY_ENABLED=true (null otherwise): every route then answers "not enabled". The
 * relayer and attestor keys are read from files outside the repository at startup; nothing here can move funds.
 */
@Module({
  imports: [WalletModule, AuthorizationModule, RootsModule, ExecutionModule],
  controllers: [RecoveryController, RootChangeController],
  providers: [
    {
      provide: RECOVERY_RUNTIME,
      inject: [
        DATABASE,
        APP_CONFIG,
        TRANSACTION_PIN_SERVICE,
        DEVICE_TIER_SERVICE,
        RATE_LIMIT_FACTORY,
        { token: ATTESTOR_SIGNER_FACTORY, optional: true },
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        pins: TransactionPinService | null,
        deviceTiers: DeviceTierService | null,
        limits: RateLimitFactory,
        signerFactory: ((kmsKeyId: string) => AttestorSigner) | undefined,
      ): RecoveryRuntime | null => {
        const recovery = config.recovery;
        const passkey = config.wallet.passkey;
        const bundlerUrl = config.execution.bundlerUrl;
        if (!recovery.enabled || !recovery.setup || !passkey || !pins || !bundlerUrl) return null;
        let email: RecoveryEmailSender;
        if (recovery.emailProvider === "smtp" && recovery.smtp) {
          email = new SmtpEmailSender({ from: recovery.smtp.from, url: recovery.smtp.url });
        } else if (recovery.emailProvider === "outbox" && recovery.emailOutboxFile) {
          email = new FileOutboxEmailSender(recovery.emailOutboxFile);
        } else {
          throw new Error("no recovery email provider is configured");
        }
        // Every linked channel is told: email always, Telegram when a bot is configured (and the person linked Telegram).
        const messengers: ChannelMessenger[] = [
          new EmailChannelMessenger(email),
          ...(recovery.telegramBotToken
            ? [
                new TelegramChannelMessenger(
                  new TelegramAdapter({ botToken: recovery.telegramBotToken }),
                ),
              ]
            : []),
        ];
        let attestorSource;
        if (recovery.setup.attestor.signer === "kms") {
          if (!signerFactory) {
            throw new Error(
              "RECOVERY_ATTESTOR_SIGNER=kms but no KMS signer adapter is installed (provide ATTESTOR_SIGNER_FACTORY)",
            );
          }
          attestorSource = {
            kind: "signer" as const,
            signer: signerFactory(recovery.setup.attestor.kmsKeyId),
          };
        } else {
          attestorSource = { kind: "file" as const, keyFile: recovery.setup.attestor.keyFile };
        }
        const chain = recovery.chainId === celoSepolia.id ? celoSepolia : celo;
        if (chain.id !== recovery.chainId)
          throw new Error(`unsupported recovery chain ${String(recovery.chainId)}`);
        const { chain: viemChain, attestor } = createRecoveryChainAndAttestor({
          chain,
          rpcUrl: config.wallet.rpcUrl,
          bundlerUrl,
          recoveryValidator: recovery.setup.contracts.validator as `0x${string}`,
          deployments: {
            passkey: {
              factory: recovery.setup.contracts.passkeyFactory as `0x${string}`,
              implementation: recovery.setup.contracts.passkeyImplementation as `0x${string}`,
            },
            device: {
              factory: recovery.setup.contracts.deviceFactory as `0x${string}`,
              implementation: recovery.setup.contracts.deviceImplementation as `0x${string}`,
            },
          },
          relayerKeyFile: recovery.setup.relayerKeyFile,
          attestor: attestorSource,
          p256Precompile: true,
          gasTopUpMaxWei: recovery.gasTopUpMaxWei,
        });
        return createRecoveryRuntime({
          database,
          chain: viemChain,
          attestor,
          email,
          messengers,
          limits,
          passkeyVerifier: new SimpleWebAuthnVerifier(),
          pins,
          rpId: passkey.rpId,
          origin: passkey.origin,
          webUrl: config.webUrl,
          challengeSecret: Buffer.from(recovery.setup.challengeSecret, "base64"),
          ...(deviceTiers && { deviceTiers }),
          policy: {
            defaultDelaySeconds: recovery.delaySeconds,
            minDelaySeconds: recovery.minDelaySeconds,
          },
        });
      },
    },
    {
      // Rotating the root and enrolling a backup need the chain reads recovery already has, a kernel port to send the
      // root-signed operation, and the clone deployer (device-key infrastructure). Off unless all of them exist.
      provide: ROOT_CHANGE_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        RECOVERY_RUNTIME,
        KERNEL_EXECUTION_PORT,
        ROOT_CREDENTIAL_SERVICE,
        ROOT_ADAPTERS,
        ROOT_VALIDATOR_DEPLOYER,
        DEVICE_TIER_SERVICE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        runtime: RecoveryRuntime | null,
        kernel: KernelExecutionPort | null,
        roots: RootCredentialService | null,
        adapters: RootAdapters | null,
        validators: RootValidatorDeployer | null,
        deviceTiers: DeviceTierService | null,
      ): RootChangeService | null => {
        const passkey = config.wallet.passkey;
        const deviceKeyRoots = config.wallet.deviceKeyRoots;
        if (
          !runtime ||
          !kernel ||
          !roots ||
          !adapters ||
          !validators ||
          !passkey ||
          !deviceKeyRoots
        ) {
          return null;
        }
        const { contracts } = deviceKeyRoots;
        return new RootChangeService({
          unitOfWork: {
            read: createRepositories(database),
            transaction: (work) => withTransaction(database, work),
          },
          kernel,
          chain: runtime.context.chain,
          roots,
          adapters,
          validators,
          deployments: {
            passkey: {
              factory: contracts.passkeyFactory as `0x${string}`,
              implementation: contracts.passkeyImplementation as `0x${string}`,
            },
            device: {
              factory: contracts.deviceFactory as `0x${string}`,
              implementation: contracts.deviceImplementation as `0x${string}`,
            },
          },
          onChainId: config.wallet.onChainId,
          passkeyVerifier: new SimpleWebAuthnVerifier(),
          rpId: passkey.rpId,
          origin: passkey.origin,
          ...(deviceTiers && { deviceTiers }),
        });
      },
    },
    RecoverySweeper,
  ],
  exports: [RECOVERY_RUNTIME, ROOT_CHANGE_SERVICE],
})
export class RecoveryModule {}
