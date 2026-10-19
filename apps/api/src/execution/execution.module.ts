import { Logger, Module } from "@nestjs/common";
import { errorDetails } from "../core/channels/error-details.js";
import { errorText } from "../logging/error-text.js";
import { nestLog } from "../logging/nest-log.js";
import {
  attributionSuffix,
  createViemAllowanceReader,
  createViemDeploymentChecker,
  createZeroDevKernelAdapter,
} from "@kaada/blockchain";
import { isKaadaError } from "@kaada/domain";
import type { KernelExecutionPort, RootValidatorDeployer } from "@kaada/domain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import {
  AUTHORIZATION_POLICY_SERVICE,
  PAYMENT_AUTHORIZATION_SERVICE,
} from "../authorization/authorization.tokens.js";
import type { PaymentAuthorizationService } from "../core/authorization/payment-authorization-service.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import type { AuthorizationPolicyService } from "../core/authorization/policy-service.js";
import { AccountReadinessService } from "../core/execution/account-readiness.js";
import { FirmQuoteService } from "../core/execution/firm-quote-service.js";
import { ExecutionPreparationService } from "../core/execution/preparation-service.js";
import type { ExecutionUnitOfWork } from "../core/execution/ports.js";
import { ExecutionRunner } from "../core/execution/runner.js";
import { RootActionService } from "../core/execution/root-action-service.js";
import { RootPaymentService } from "../core/execution/root-payment-service.js";
import { RunTracker } from "../core/execution/run-tracker.js";
import { PreparationTracker } from "../core/execution/tracker.js";
import { ValidatedExecutionSigner } from "../core/execution/validated-signer.js";
import type { WalletBalanceService } from "../core/wallets/balance-service.js";
import type { WalletService } from "../core/wallets/wallet-service.js";
import {
  TextileClient,
  TextileFirmQuoteProvider,
  TextileOrderProvider,
  createFetchTransport,
} from "../infrastructure/fx/textile/index.js";
import { AesGcmSecretCipher } from "../infrastructure/security/aes-gcm-cipher.js";
import type { RootAdapters, RootCredentialService } from "../core/roots/root-credentials.js";
import { RootsModule } from "../roots/roots.module.js";
import {
  ROOT_ADAPTERS,
  ROOT_CREDENTIAL_SERVICE,
  ROOT_VALIDATOR_DEPLOYER,
} from "../roots/roots.tokens.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { WALLET_BALANCE_SERVICE, WALLET_SERVICE } from "../wallet/wallet.tokens.js";
import { ExecutionController } from "./execution.controller.js";
import { RootPaymentController } from "./root-payment.controller.js";
import { ExecutionReconciler } from "./execution-reconciler.js";
import { RootActionController } from "./root-action.controller.js";
import {
  EXECUTION_PREPARATION_SERVICE,
  EXECUTION_REPOSITORIES,
  EXECUTION_RUNNER,
  KERNEL_EXECUTION_PORT,
  PREPARATION_TRACKER,
  ROOT_ACTION_SERVICE,
  ROOT_PAYMENT_SERVICE,
  RUN_TRACKER,
} from "./execution.tokens.js";

function unitOfWork(database: Database): ExecutionUnitOfWork {
  return {
    read: createRepositories(database),
    transaction: (work) => withTransaction(database, work),
  };
}

/**
 * Firm quoting and execution planning. Present only when ALL of these are configured: a wallet
 * provider, Textile pricing, and a secret key to encrypt the provider's claim token. Otherwise the
 * service is null and no firm quote can be requested. It plans only: nothing here signs or sends.
 */
/**
 * What the production Kernel adapter is built with. Every UserOperation it prepares (root and delegated) carries the Celo ERC-8021
 * attribution suffix (celo_51c4a2ae2240) at the end of its callData, through the same encoder the platform wallet uses. Kept as one
 * exported function so a test can pin that the production wiring supplies it.
 */
export function kernelAdapterConfig(config: AppConfig, bundlerUrl: string) {
  return {
    bundlerUrl,
    rpcUrl: config.wallet.rpcUrl,
    attributionSuffix: attributionSuffix(),
  };
}

@Module({
  imports: [WalletModule, AuthorizationModule, RootsModule],
  controllers: [ExecutionController, RootActionController, RootPaymentController],
  providers: [
    {
      provide: EXECUTION_REPOSITORIES,
      inject: [DATABASE],
      useFactory: (database: Database): Repositories => createRepositories(database),
    },
    {
      provide: PREPARATION_TRACKER,
      useFactory: () => {
        const log = nestLog("ExecutionPrepare");
        return new PreparationTracker(Date.now, {
          outcome: (authorizationId, outcome) => {
            const ready = outcome.status === "EXECUTION_READY";
            // Anything but READY ends the page's progress and leaves Telegram on "confirming the price": say exactly why.
            log(ready ? "info" : "warn", "execution.prepare_outcome", {
              authorizationId,
              status: outcome.status,
              ...("reason" in outcome && { reason: outcome.reason }),
              ...("code" in outcome && { code: outcome.code }),
              ...("violations" in outcome &&
                outcome.violations && { violations: outcome.violations.join(",") }),
              ...("blockers" in outcome && {
                blockers: JSON.stringify(outcome.blockers).slice(0, 400),
              }),
            });
          },
          error: (authorizationId, error) =>
            log("error", "execution.prepare_threw", {
              authorizationId,
              ...errorDetails(error),
              reason: errorText(error),
              stack: error instanceof Error ? (error.stack ?? "").slice(0, 1500) : undefined,
            }),
        });
      },
    },
    {
      provide: EXECUTION_PREPARATION_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        WALLET_SERVICE,
        WALLET_BALANCE_SERVICE,
        AUTHORIZATION_POLICY_SERVICE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        wallets: WalletService | null,
        balances: WalletBalanceService | null,
        policy: AuthorizationPolicyService | null,
      ): ExecutionPreparationService | null => {
        const textile = config.fx.textile;
        const keys = config.execution.cipherKeys;
        if (
          config.wallet.provider !== "kernel" ||
          config.fx.provider !== "textile" ||
          !textile ||
          keys.length === 0 ||
          !wallets ||
          !balances ||
          !policy
        ) {
          return null;
        }
        const uow = unitOfWork(database);
        const chain = {
          allowances: createViemAllowanceReader({ rpcUrl: config.wallet.rpcUrl }),
          balances,
          ...createViemDeploymentChecker({ rpcUrl: config.wallet.rpcUrl }),
        };
        const provider = new TextileFirmQuoteProvider({
          client: new TextileClient({
            transport: createFetchTransport({ baseUrl: textile.apiUrl, apiKey: textile.apiKey }),
            timeoutMs: textile.timeoutMs,
          }),
          timeoutMs: config.execution.firmTimeoutMs,
        });
        const firmQuotes = new FirmQuoteService({
          unitOfWork: uow,
          provider,
          cipher: new AesGcmSecretCipher(keys),
          chain,
          maxOutstanding: config.execution.maxOutstandingRfqs,
          requestTimeoutMs: config.execution.firmTimeoutMs,
        });
        return new ExecutionPreparationService({
          unitOfWork: uow,
          firmQuotes,
          policy,
          readiness: new AccountReadinessService({
            repositories: uow.read,
            chain,
            infrastructure: {
              rpcConfigured: true,
              bundlerConfigured: config.execution.bundlerConfigured,
            },
          }),
          chain,
          wallets,
          minWindowMs: config.execution.minFirmWindowMs,
        });
      },
    },
    {
      provide: RUN_TRACKER,
      useFactory: () => {
        const logger = new Logger("ExecutionRun");
        // The reason is logged for operators (a code or a name, never a payload); the person only ever sees "pending".
        return new RunTracker(Date.now, (error) =>
          logger.warn(
            `a payment run ended unexpectedly: ${error instanceof Error ? error.name : "unknown"}${
              isKaadaError(error) ? ` (${error.code})` : ""
            }`,
          ),
        );
      },
    },
    {
      provide: KERNEL_EXECUTION_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): KernelExecutionPort | null => {
        // Off unless explicitly enabled (and the config schema has already required the bundler).
        if (!config.execution.enabled || !config.execution.bundlerUrl) return null;
        return createZeroDevKernelAdapter(kernelAdapterConfig(config, config.execution.bundlerUrl));
      },
    },
    {
      provide: ROOT_ACTION_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        WALLET_SERVICE,
        KERNEL_EXECUTION_PORT,
        ROOT_CREDENTIAL_SERVICE,
        ROOT_ADAPTERS,
        ROOT_VALIDATOR_DEPLOYER,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        wallets: WalletService | null,
        kernel: KernelExecutionPort | null,
        roots: RootCredentialService | null,
        adapters: RootAdapters | null,
        validators: RootValidatorDeployer | null,
      ): RootActionService | null => {
        const passkey = config.wallet.passkey;
        if (
          !kernel ||
          !wallets ||
          !passkey ||
          !roots ||
          !adapters ||
          config.execution.cipherKeys.length === 0
        ) {
          return null;
        }
        return new RootActionService({
          log: nestLog("RootAction"),
          unitOfWork: unitOfWork(database),
          kernel,
          cipher: new AesGcmSecretCipher(config.execution.cipherKeys),
          wallets,
          roots,
          adapters,
          onChainId: config.wallet.onChainId,
          ...(validators && { validators }),
          origin: passkey.origin,
        });
      },
    },
    {
      // Confirms a direct payment with the wallet's own passkey (or device key and PIN). Off when execution is off.
      provide: ROOT_PAYMENT_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        WALLET_BALANCE_SERVICE,
        PAYMENT_AUTHORIZATION_SERVICE,
        EXECUTION_PREPARATION_SERVICE,
        KERNEL_EXECUTION_PORT,
        ROOT_CREDENTIAL_SERVICE,
        ROOT_ADAPTERS,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        balances: WalletBalanceService | null,
        payments: PaymentAuthorizationService | null,
        preparation: ExecutionPreparationService | null,
        kernel: KernelExecutionPort | null,
        roots: RootCredentialService | null,
        adapters: RootAdapters | null,
      ): RootPaymentService | null => {
        if (
          !config.execution.enabled ||
          !kernel ||
          !balances ||
          !payments ||
          !preparation ||
          !roots ||
          !adapters ||
          config.execution.cipherKeys.length === 0
        ) {
          return null;
        }
        return new RootPaymentService({
          log: nestLog("RootPayment"),
          payments,
          preparation,
          unitOfWork: unitOfWork(database),
          kernel,
          roots,
          adapters,
          cipher: new AesGcmSecretCipher(config.execution.cipherKeys),
          chain: { balances },
          minNativeWei: config.execution.minNativeWei,
          onChainId: config.wallet.onChainId,
        });
      },
    },
    {
      provide: EXECUTION_RUNNER,
      inject: [
        DATABASE,
        APP_CONFIG,
        WALLET_SERVICE,
        WALLET_BALANCE_SERVICE,
        EXECUTION_PREPARATION_SERVICE,
        KERNEL_EXECUTION_PORT,
        ROOT_ACTION_SERVICE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        wallets: WalletService | null,
        balances: WalletBalanceService | null,
        preparation: ExecutionPreparationService | null,
        kernel: KernelExecutionPort | null,
        rootActions: RootActionService | null,
      ): ExecutionRunner | null => {
        const textile = config.fx.textile;
        if (
          !config.execution.enabled ||
          !kernel ||
          !rootActions ||
          !preparation ||
          !wallets ||
          !balances ||
          !textile
        ) {
          return null;
        }
        const uow = unitOfWork(database);
        const cipher = new AesGcmSecretCipher(config.execution.cipherKeys);
        const chain = {
          allowances: createViemAllowanceReader({ rpcUrl: config.wallet.rpcUrl }),
          balances,
          ...createViemDeploymentChecker({ rpcUrl: config.wallet.rpcUrl }),
        };
        const infrastructure = { rpcConfigured: true, bundlerConfigured: true };
        const signer = new ValidatedExecutionSigner({
          unitOfWork: uow,
          wallets,
          kernel,
          cipher,
          chain,
          minWindowMs: config.execution.minFirmWindowMs,
          infrastructure,
        });
        return new ExecutionRunner({
          unitOfWork: uow,
          preparation,
          wallets,
          kernel,
          orders: new TextileOrderProvider({
            client: new TextileClient({
              transport: createFetchTransport({ baseUrl: textile.apiUrl, apiKey: textile.apiKey }),
              timeoutMs: textile.timeoutMs,
            }),
          }),
          cipher,
          chain,
          signer,
          rootActions,
          minWindowMs: config.execution.minFirmWindowMs,
          minNativeWei: config.execution.minNativeWei,
          infrastructure,
          poll: {
            intervalMs: config.execution.pollIntervalMs,
            maxWaitMs: config.execution.pollMaxWaitMs,
          },
        });
      },
    },
    ExecutionReconciler,
  ],
  exports: [
    EXECUTION_PREPARATION_SERVICE,
    EXECUTION_RUNNER,
    KERNEL_EXECUTION_PORT,
    ROOT_ACTION_SERVICE,
    RUN_TRACKER,
    EXECUTION_REPOSITORIES,
  ],
})
export class ExecutionModule {}
