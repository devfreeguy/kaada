import { Logger, Module } from "@nestjs/common";
import { createRepositories, withTransaction } from "@kaada/database";
import type { KernelExecutionPort, RootValidatorDeployer } from "@kaada/domain";
import type { AppConfig } from "@kaada/config";
import type { Database } from "@kaada/database";
import {
  checkRecoveryDeployment,
  createDeploymentReader,
  createKernelFactoryCallReader,
} from "@kaada/blockchain";
import type { WalletFundingStore } from "@kaada/domain";
import { celo, celoSepolia } from "viem/chains";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { TRANSACTION_PIN_SERVICE } from "../authorization/authorization.tokens.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import { EmailChannelMessenger, FileOutboxEmailSender } from "../infrastructure/recovery/email.js";
import { SmtpEmailSender, resolveSmtpConnection } from "../infrastructure/recovery/smtp-email.js";
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
import { DEVICE_TIER_SERVICE, WALLET_FUNDING_STORE } from "../wallet/wallet.tokens.js";
import type { DeviceTierService } from "../core/attestation/device-tier-service.js";
import { RecoveryController } from "./recovery.controller.js";
import {
  assertRelayerMatchesDeployment,
  createRecoveryChain,
  createRecoveryRuntime,
} from "./recovery.runtime.js";
import type { RecoveryRuntime } from "./recovery.runtime.js";
import { DeploymentGuard } from "./deployment-guard.js";
import { RECOVERY_SWITCH } from "./recovery-switch.js";
import type { RecoverySwitch } from "./recovery-switch.js";
import { RecoverySweeper } from "./recovery-sweeper.js";
import { RECOVERY_RUNTIME } from "./recovery.tokens.js";
import { AesGcmSecretCipher } from "../infrastructure/security/aes-gcm-cipher.js";

/**
 * Account recovery. Present only when RECOVERY_ENABLED=true (null otherwise): every route then answers "not enabled". The
 * relayer's gas key is read from a file outside the repository at startup; nothing here can move funds, and nothing here can
 * recover a wallet without the person's Recovery Code.
 */
@Module({
  imports: [WalletModule, AuthorizationModule, RootsModule, ExecutionModule],
  controllers: [RecoveryController, RootChangeController],
  providers: [
    {
      // Compares the configured contracts with the chain at startup (see DeploymentGuard). Inert when neither recovery nor device-key
      // wallets are on.
      provide: DeploymentGuard,
      inject: [APP_CONFIG, RECOVERY_SWITCH],
      useFactory: (config: AppConfig, off: RecoverySwitch): DeploymentGuard => {
        const contracts =
          config.recovery.setup?.contracts ?? config.wallet.deviceKeyRoots?.contracts;
        if (!contracts) return new DeploymentGuard({ check: null });
        const chain = config.recovery.chainId === celoSepolia.id ? celoSepolia : celo;
        const reader = createDeploymentReader({ chain, rpcUrl: config.wallet.rpcUrl });
        return new DeploymentGuard({
          onLateMismatch: (message) => off.disable(message),
          check: () =>
            checkRecoveryDeployment(reader, {
              ...contracts,
              minDelaySeconds: config.recovery.minDelaySeconds,
            }),
        });
      },
    },
    {
      provide: RECOVERY_RUNTIME,
      inject: [
        DATABASE,
        APP_CONFIG,
        TRANSACTION_PIN_SERVICE,
        DEVICE_TIER_SERVICE,
        RATE_LIMIT_FACTORY,
        WALLET_FUNDING_STORE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        pins: TransactionPinService | null,
        deviceTiers: DeviceTierService | null,
        limits: RateLimitFactory,
        funding: WalletFundingStore,
      ): RecoveryRuntime | null => {
        const recovery = config.recovery;
        const passkey = config.wallet.passkey;
        const bundlerUrl = config.execution.bundlerUrl;
        if (!recovery.enabled || !recovery.setup || !passkey || !pins || !bundlerUrl) return null;
        let email: RecoveryEmailSender;
        if (recovery.emailProvider === "smtp" && recovery.smtp) {
          // The password file (if used) is read here, server-side, once. Nothing about the connection is logged.
          const { from, ...settings } = recovery.smtp;
          email = new SmtpEmailSender({ from, connection: resolveSmtpConnection(settings) });
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
        const chain = recovery.chainId === celoSepolia.id ? celoSepolia : celo;
        if (chain.id !== recovery.chainId)
          throw new Error(`unsupported recovery chain ${String(recovery.chainId)}`);
        const viemChain = createRecoveryChain({
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
          p256Precompile: true,
          gasTopUpMaxWei: recovery.gasTopUpMaxWei,
          ...(recovery.sponsorPerWalletWei > 0n && {
            accountFactoryCall: createKernelFactoryCallReader({ rpcUrl: config.wallet.rpcUrl }),
          }),
        });
        // Fail closed: the validator only accepts `initiate` from the relayer address it was deployed with, so a key file that
        // derives to any other address could never start a recovery. Refuse to boot instead of failing mid-recovery.
        assertRelayerMatchesDeployment(viemChain.relayerAddress, recovery.setup.contracts.relayer);
        // The PUBLIC address only; the key never reaches a log.
        new Logger("Recovery").log(
          `recovery relayer ${viemChain.relayerAddress} on ${recovery.network}`,
        );
        return createRecoveryRuntime({
          database,
          chain: viemChain,
          totpCipher: new AesGcmSecretCipher(recovery.setup.totpCipherKeys),
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
          ...(recovery.sponsorPerWalletWei > 0n && {
            sponsorship: {
              perWalletWei: recovery.sponsorPerWalletWei,
              funded: (userId: string) => funding.hasBeenFunded(userId, recovery.chainId),
            },
          }),
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
