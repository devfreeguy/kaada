import { Module } from "@nestjs/common";
import {
  ChainBalanceReader,
  KernelPolicyAdapter,
  KernelProvisioningAdapter,
  ViemValidatorDeployer,
  createKernelAddressDeriver,
  createViemChainReader,
  readKeyFileOutsideRepo,
} from "@kaada/blockchain";
import { createCachedAssetRepository, createAssetRegistry } from "@kaada/domain";
import type { RootValidatorDeployer, WalletBalanceReader } from "@kaada/domain";
import { celo, celoSepolia } from "viem/chains";
import { createRepositories, createWalletFundingStore, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import { SETTINGS } from "@kaada/config";
import type { AppConfig } from "@kaada/config";
import type { WalletFundingStore } from "@kaada/domain";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { PasskeyService } from "../core/wallets/passkey-service.js";
import type { WalletUnitOfWork } from "../core/wallets/ports.js";
import { WalletService } from "../core/wallets/wallet-service.js";
import { scopeAssetsToChain } from "./network-tokens.js";
import { SimpleWebAuthnVerifier } from "../infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletBalanceService } from "../core/wallets/balance-service.js";
import { WalletFundingWatcher } from "../core/wallets/funding-watcher.js";
import { WalletSetupService } from "../core/wallets/setup-service.js";
import { DeviceTierService } from "../core/attestation/device-tier-service.js";
import { GoogleRevocationList } from "../infrastructure/attestation/google-revocation-list.js";
import { repositoryRoot } from "../recovery/recovery.runtime.js";
import { ROOT_VALIDATOR_DEPLOYER } from "../roots/roots.tokens.js";
import { WalletController } from "./wallet.controller.js";
import {
  BALANCE_READER,
  PASSKEY_SERVICE,
  WALLET_BALANCE_SERVICE,
  WALLET_FUNDING_STORE,
  WALLET_FUNDING_WATCHER,
  WALLET_REPOSITORIES,
  WALLET_SERVICE,
  WALLET_SETUP_SERVICE,
  DEVICE_TIER_SERVICE,
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
          ...(config.wallet.passkey && { rpId: config.wallet.passkey.rpId }),
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
      // Puts a device key's validator clone on chain (paid by the relayer, which holds no authority). Off unless device-key
      // wallets are enabled. It lives here, not in the roots module, because wallet setup needs it.
      provide: ROOT_VALIDATOR_DEPLOYER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RootValidatorDeployer | null => {
        const deviceKeyRoots = config.wallet.deviceKeyRoots;
        if (!deviceKeyRoots) return null;
        const chain = config.wallet.onChainId === celoSepolia.id ? celoSepolia : celo;
        if (chain.id !== config.wallet.onChainId) {
          throw new Error(`unsupported chain ${String(config.wallet.onChainId)}`);
        }
        const { contracts } = deviceKeyRoots;
        return new ViemValidatorDeployer({
          chain,
          rpcUrl: config.wallet.rpcUrl,
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
          relayerKey: readKeyFileOutsideRepo(deviceKeyRoots.relayerKeyFile, repositoryRoot()),
        });
      },
    },
    {
      // Verifies platform key attestation and derives device-key tiers. Off unless DEVICE_ATTESTATION_ENABLED.
      provide: DEVICE_TIER_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): DeviceTierService | null => {
        const attestation = config.wallet.deviceAttestation;
        if (!attestation || !config.wallet.deviceKeyRoots) return null;
        return new DeviceTierService({
          attestations: createRepositories(database).deviceAttestations,
          challengeTtlMs: attestation.challengeTtlMs,
          ...(attestation.androidApps.length > 0 && {
            android: {
              applications: attestation.androidApps,
              minimumLevel: attestation.androidMinimumLevel,
              revocation: new GoogleRevocationList({
                url: attestation.revocationUrl,
                cacheMs: attestation.revocationCacheMs,
              }),
            },
          }),
          ...(attestation.iosAppIds.length > 0 && {
            ios: {
              appIds: attestation.iosAppIds,
              allowDevelopment: attestation.iosAllowDevelopment,
            },
          }),
        });
      },
    },
    {
      provide: WALLET_SETUP_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        WALLET_SERVICE,
        PASSKEY_SERVICE,
        ROOT_VALIDATOR_DEPLOYER,
        DEVICE_TIER_SERVICE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        wallets: WalletService | null,
        passkeys: PasskeyService | null,
        validators: RootValidatorDeployer | null,
        deviceTiers: DeviceTierService | null,
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
          ...(config.wallet.deviceKeyRoots && {
            deviceKeys: {
              onChainId: config.wallet.onChainId,
              ...(validators && { validators }),
              ...(deviceTiers && { deviceTiers }),
              deployments: {
                passkey: {
                  factory: config.wallet.deviceKeyRoots.contracts.passkeyFactory as `0x${string}`,
                  implementation: config.wallet.deviceKeyRoots.contracts
                    .passkeyImplementation as `0x${string}`,
                },
                device: {
                  factory: config.wallet.deviceKeyRoots.contracts.deviceFactory as `0x${string}`,
                  implementation: config.wallet.deviceKeyRoots.contracts
                    .deviceImplementation as `0x${string}`,
                },
              },
            },
          }),
        });
      },
    },
    {
      provide: WALLET_BALANCE_SERVICE,
      inject: [DATABASE, WALLET_SERVICE, BALANCE_READER, APP_CONFIG],
      useFactory: (
        database: Database,
        wallets: WalletService | null,
        reader: WalletBalanceReader | null,
        config: AppConfig,
      ): WalletBalanceService | null => {
        if (!wallets || !reader) return null;
        return new WalletBalanceService({
          assets: createCachedAssetRepository(createRepositories(database).assets),
          reader,
          wallets,
          network: config.wallet.balances,
          minNativeWei: config.execution.minNativeWei,
        });
      },
    },
    {
      // A read-only balance reader over the Celo RPC.
      provide: BALANCE_READER,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): WalletBalanceReader | null => {
        if (config.wallet.provider !== "kernel") return null;
        // This network's tokens (the database holds each network's by chain id + contract; see scopeAssetsToChain).
        const assets = createAssetRegistry(
          scopeAssetsToChain(
            createCachedAssetRepository(createRepositories(database).assets),
            config.wallet.balances.chainId,
          ),
        );
        const { chainId, network, rpcUrl, testnet } = config.wallet.balances;
        return new ChainBalanceReader({
          assets,
          chain: createViemChainReader({ rpcUrl: config.wallet.rpcUrl }),
          ...(testnet && { networks: { [chainId]: createViemChainReader({ rpcUrl, network }) } }),
        });
      },
    },
    {
      provide: WALLET_FUNDING_STORE,
      inject: [DATABASE],
      useFactory: (database: Database): WalletFundingStore => createWalletFundingStore(database),
    },
    {
      // Looks for supported tokens arriving at Kaada wallets (polled by the channel sweeper; no timers here).
      provide: WALLET_FUNDING_WATCHER,
      inject: [WALLET_FUNDING_STORE, BALANCE_READER, WALLET_BALANCE_SERVICE],
      useFactory: (
        store: WalletFundingStore,
        reader: WalletBalanceReader | null,
        balances: WalletBalanceService | null,
      ): WalletFundingWatcher | null => {
        if (!reader || !balances) return null;
        return new WalletFundingWatcher({
          store,
          reader,
          tokens: () => balances.supportedTokens(),
          chainId: balances.chainId,
          dustDecimalsBelow: SETTINGS.funding.dustDecimalsBelow,
          newWalletMs: SETTINGS.funding.newWalletMs,
        });
      },
    },
  ],
  exports: [
    WALLET_FUNDING_STORE,
    WALLET_FUNDING_WATCHER,
    WALLET_SERVICE,
    PASSKEY_SERVICE,
    BALANCE_READER,
    WALLET_SETUP_SERVICE,
    WALLET_BALANCE_SERVICE,
    ROOT_VALIDATOR_DEPLOYER,
    DEVICE_TIER_SERVICE,
  ],
})
export class WalletModule {}
