import { Module } from "@nestjs/common";
import {
  ChainBalanceReader,
  KernelPolicyAdapter,
  KernelProvisioningAdapter,
  createKernelAddressDeriver,
  createViemChainReader,
} from "@kaada/blockchain";
import { createCachedAssetRepository, createAssetRegistry } from "@kaada/domain";
import type { WalletBalanceReader } from "@kaada/domain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { PasskeyService } from "../core/wallets/passkey-service.js";
import type { WalletUnitOfWork } from "../core/wallets/ports.js";
import { WalletService } from "../core/wallets/wallet-service.js";
import { SimpleWebAuthnVerifier } from "../infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletBalanceService } from "../core/wallets/balance-service.js";
import { WalletSetupService } from "../core/wallets/setup-service.js";
import { WalletController } from "./wallet.controller.js";
import {
  BALANCE_READER,
  PASSKEY_SERVICE,
  WALLET_BALANCE_SERVICE,
  WALLET_REPOSITORIES,
  WALLET_SERVICE,
  WALLET_SETUP_SERVICE,
} from "./wallet.tokens.js";

function unitOfWork(database: Database): WalletUnitOfWork {
  return {
    read: createRepositories(database),
    transaction: (work) => withTransaction(database, work),
  };
}

/**
 * Wallet services, present only when WALLET_PROVIDER=kernel (null otherwise). Read-only until the
 * authorization build: nothing here can sign or move funds. The controller is a thin edge whose only
 * identity is a setup-link token.
 */
@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: WALLET_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): WalletService | null => {
        if (config.wallet.provider !== "kernel") return null;
        return new WalletService({
          unitOfWork: unitOfWork(database),
          provisioning: new KernelProvisioningAdapter(
            createKernelAddressDeriver({ rpcUrl: config.wallet.rpcUrl }),
          ),
          policy: new KernelPolicyAdapter(),
        });
      },
    },
    {
      provide: PASSKEY_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): PasskeyService | null => {
        const passkey = config.wallet.passkey;
        if (config.wallet.provider !== "kernel" || !passkey) return null;
        return new PasskeyService({
          unitOfWork: unitOfWork(database),
          verifier: new SimpleWebAuthnVerifier(),
          rpId: passkey.rpId,
          origin: passkey.origin,
        });
      },
    },
    {
      provide: WALLET_REPOSITORIES,
      inject: [DATABASE],
      useFactory: (database: Database) => createRepositories(database),
    },
    {
      provide: WALLET_SETUP_SERVICE,
      inject: [DATABASE, APP_CONFIG, WALLET_SERVICE, PASSKEY_SERVICE],
      useFactory: (
        database: Database,
        config: AppConfig,
        wallets: WalletService | null,
        passkeys: PasskeyService | null,
      ): WalletSetupService | null => {
        const passkey = config.wallet.passkey;
        if (!wallets || !passkeys || !passkey) return null;
        return new WalletSetupService({
          unitOfWork: unitOfWork(database),
          users: createRepositories(database).users,
          passkeys,
          wallets,
          origin: passkey.origin,
          rpId: passkey.rpId,
          rpName: passkey.rpName,
        });
      },
    },
    {
      provide: WALLET_BALANCE_SERVICE,
      inject: [DATABASE, WALLET_SERVICE, BALANCE_READER],
      useFactory: (
        database: Database,
        wallets: WalletService | null,
        reader: WalletBalanceReader | null,
      ): WalletBalanceService | null => {
        if (!wallets || !reader) return null;
        return new WalletBalanceService({
          assets: createCachedAssetRepository(createRepositories(database).assets),
          reader,
          wallets,
        });
      },
    },
    {
      // A read-only balance reader over the Celo RPC.
      provide: BALANCE_READER,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): WalletBalanceReader | null => {
        if (config.wallet.provider !== "kernel") return null;
        const assets = createAssetRegistry(
          createCachedAssetRepository(createRepositories(database).assets),
        );
        return new ChainBalanceReader({
          assets,
          chain: createViemChainReader({ rpcUrl: config.wallet.rpcUrl }),
        });
      },
    },
  ],
  exports: [
    WALLET_SERVICE,
    PASSKEY_SERVICE,
    BALANCE_READER,
    WALLET_SETUP_SERVICE,
    WALLET_BALANCE_SERVICE,
  ],
})
export class WalletModule {}
