import { Module } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import { createRepositories } from "@kaada/database";
import type { Database } from "@kaada/database";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { DeviceKeyRootAdapter, PasskeyRootAdapter } from "../core/roots/adapters.js";
import { RootAdapters, RootCredentialService } from "../core/roots/root-credentials.js";
import { RootProofService } from "../core/roots/root-proof-service.js";
import type { PasskeyService } from "../core/wallets/passkey-service.js";
import type { WalletService } from "../core/wallets/wallet-service.js";
import { SimpleWebAuthnVerifier } from "../infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { PASSKEY_SERVICE, WALLET_SERVICE } from "../wallet/wallet.tokens.js";
import { ROOT_ADAPTERS, ROOT_CREDENTIAL_SERVICE, ROOT_PROOF_SERVICE } from "./roots.tokens.js";

/**
 * The root-agnostic layer: which root a wallet has (a passkey or a device key), the adapters that describe and verify what
 * each type signs, off-chain proofs by the root, and the deployer of a device key's validator clone. Nothing here can sign
 * or move funds: the private half of a root never exists on the server.
 */
@Module({
  imports: [WalletModule],
  providers: [
    {
      provide: ROOT_CREDENTIAL_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): RootCredentialService | null => {
        const passkey = config.wallet.passkey;
        if (config.wallet.provider !== "kernel" || !passkey) return null;
        return new RootCredentialService({
          repositories: createRepositories(database),
          rpId: passkey.rpId,
        });
      },
    },
    {
      provide: ROOT_ADAPTERS,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): RootAdapters | null => {
        const passkey = config.wallet.passkey;
        if (config.wallet.provider !== "kernel" || !passkey) return null;
        return new RootAdapters(
          new PasskeyRootAdapter({
            verifier: new SimpleWebAuthnVerifier(),
            passkeys: createRepositories(database).passkeys,
            rpId: passkey.rpId,
            origin: passkey.origin,
          }),
          new DeviceKeyRootAdapter(),
        );
      },
    },
    {
      provide: ROOT_PROOF_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        ROOT_CREDENTIAL_SERVICE,
        ROOT_ADAPTERS,
        WALLET_SERVICE,
        PASSKEY_SERVICE,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        roots: RootCredentialService | null,
        adapters: RootAdapters | null,
        wallets: WalletService | null,
        passkeys: PasskeyService | null,
      ): RootProofService | null => {
        if (!roots || !adapters || !wallets || !passkeys) return null;
        return new RootProofService({
          roots,
          passkeys,
          challenges: createRepositories(database).passkeys,
          device: adapters.device,
          wallets,
          onChainId: config.wallet.onChainId,
        });
      },
    },
  ],
  exports: [ROOT_CREDENTIAL_SERVICE, ROOT_ADAPTERS, ROOT_PROOF_SERVICE],
})
export class RootsModule {}
