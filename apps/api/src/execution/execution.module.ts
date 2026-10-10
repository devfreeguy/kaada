import { Module } from "@nestjs/common";
import { createViemAllowanceReader, createViemDeploymentChecker } from "@kaada/blockchain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { AUTHORIZATION_POLICY_SERVICE } from "../authorization/authorization.tokens.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import type { AuthorizationPolicyService } from "../core/authorization/policy-service.js";
import { AccountReadinessService } from "../core/execution/account-readiness.js";
import { FirmQuoteService } from "../core/execution/firm-quote-service.js";
import { ExecutionPreparationService } from "../core/execution/preparation-service.js";
import type { ExecutionUnitOfWork } from "../core/execution/ports.js";
import { PreparationTracker } from "../core/execution/tracker.js";
import type { WalletBalanceService } from "../core/wallets/balance-service.js";
import type { WalletService } from "../core/wallets/wallet-service.js";
import {
  TextileClient,
  TextileFirmQuoteProvider,
  createFetchTransport,
} from "../infrastructure/fx/textile/index.js";
import { AesGcmSecretCipher } from "../infrastructure/security/aes-gcm-cipher.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { WALLET_BALANCE_SERVICE, WALLET_SERVICE } from "../wallet/wallet.tokens.js";
import { ExecutionController } from "./execution.controller.js";
import {
  EXECUTION_PREPARATION_SERVICE,
  EXECUTION_REPOSITORIES,
  PREPARATION_TRACKER,
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
@Module({
  imports: [WalletModule, AuthorizationModule],
  controllers: [ExecutionController],
  providers: [
    {
      provide: EXECUTION_REPOSITORIES,
      inject: [DATABASE],
      useFactory: (database: Database): Repositories => createRepositories(database),
    },
    { provide: PREPARATION_TRACKER, useFactory: () => new PreparationTracker() },
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
  ],
  exports: [EXECUTION_PREPARATION_SERVICE],
})
export class ExecutionModule {}
