import { Module } from "@nestjs/common";
import { createAssetRegistry, createCachedAssetRepository } from "@kaada/domain";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { PaymentAuthorizationService } from "../core/authorization/payment-authorization-service.js";
import { PinEnrollmentService } from "../core/authorization/pin-enrollment.js";
import { TransactionPinService } from "../core/authorization/pin-service.js";
import { AuthorizationPolicyService } from "../core/authorization/policy-service.js";
import type { AuthorizationUnitOfWork } from "../core/authorization/ports.js";
import { AuthorizationSessionService } from "../core/authorization/session-service.js";
import type { PasskeyService } from "../core/wallets/passkey-service.js";
import type { WalletService } from "../core/wallets/wallet-service.js";
import { Argon2PinHasher } from "../infrastructure/auth/argon2-pin-hasher.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { PASSKEY_SERVICE, WALLET_SERVICE } from "../wallet/wallet.tokens.js";
import { AuthorizationController } from "./authorization.controller.js";
import {
  AUTHORIZATION_POLICY_SERVICE,
  AUTHORIZATION_SESSION_SERVICE,
  PAYMENT_AUTHORIZATION_SERVICE,
  PIN_ENROLLMENT_SERVICE,
  TRANSACTION_PIN_SERVICE,
} from "./authorization.tokens.js";
import { PinController } from "./pin.controller.js";

function unitOfWork(database: Database): AuthorizationUnitOfWork {
  return {
    read: createRepositories(database),
    transaction: (work) => withTransaction(database, work),
  };
}

const enabled = (config: AppConfig) => config.wallet.provider === "kernel";

/**
 * PIN, authorization sessions and payment authorizations. Present only when a wallet provider is
 * configured (null otherwise), because an authorization needs a wallet to authorize from. Nothing
 * here can sign or move funds: it records what a person approved and answers whether a future
 * execution would fit inside it.
 */
@Module({
  imports: [WalletModule],
  controllers: [AuthorizationController, PinController],
  providers: [
    {
      provide: TRANSACTION_PIN_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): TransactionPinService | null => {
        if (!enabled(config)) return null;
        const { pinPepper } = config.authorization;
        return new TransactionPinService({
          unitOfWork: unitOfWork(database),
          hasher: new Argon2PinHasher({ ...(pinPepper && { pepper: pinPepper }) }),
        });
      },
    },
    {
      provide: AUTHORIZATION_SESSION_SERVICE,
      inject: [DATABASE, APP_CONFIG, TRANSACTION_PIN_SERVICE],
      useFactory: (
        database: Database,
        config: AppConfig,
        pins: TransactionPinService | null,
      ): AuthorizationSessionService | null => {
        if (!enabled(config) || !pins) return null;
        return new AuthorizationSessionService({
          unitOfWork: unitOfWork(database),
          assets: createAssetRegistry(
            createCachedAssetRepository(createRepositories(database).assets),
          ),
          pins,
          origin: config.wallet.passkey?.origin ?? config.webUrl,
          sessionTtlMs: config.authorization.sessionTtlMs,
        });
      },
    },
    {
      provide: PAYMENT_AUTHORIZATION_SERVICE,
      inject: [DATABASE, APP_CONFIG, AUTHORIZATION_SESSION_SERVICE, TRANSACTION_PIN_SERVICE],
      useFactory: (
        database: Database,
        config: AppConfig,
        sessions: AuthorizationSessionService | null,
        pins: TransactionPinService | null,
      ): PaymentAuthorizationService | null => {
        if (!sessions || !pins) return null;
        return new PaymentAuthorizationService({
          unitOfWork: unitOfWork(database),
          sessions,
          pins,
          authorizationTtlMs: config.authorization.paymentTtlMs,
        });
      },
    },
    {
      provide: AUTHORIZATION_POLICY_SERVICE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AuthorizationPolicyService | null =>
        enabled(config)
          ? new AuthorizationPolicyService({ unitOfWork: unitOfWork(database) })
          : null,
    },
    {
      provide: PIN_ENROLLMENT_SERVICE,
      inject: [PASSKEY_SERVICE, TRANSACTION_PIN_SERVICE, WALLET_SERVICE],
      useFactory: (
        passkeys: PasskeyService | null,
        pins: TransactionPinService | null,
        wallets: WalletService | null,
      ): PinEnrollmentService | null =>
        passkeys && pins && wallets ? new PinEnrollmentService({ passkeys, pins, wallets }) : null,
    },
  ],
  exports: [
    TRANSACTION_PIN_SERVICE,
    AUTHORIZATION_SESSION_SERVICE,
    PAYMENT_AUTHORIZATION_SERVICE,
    AUTHORIZATION_POLICY_SERVICE,
    PIN_ENROLLMENT_SERVICE,
  ],
})
export class AuthorizationModule {}
