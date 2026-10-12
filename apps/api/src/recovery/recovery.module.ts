import { Module } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import type { Database } from "@kaada/database";
import { celo, celoSepolia } from "viem/chains";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { TRANSACTION_PIN_SERVICE } from "../authorization/authorization.tokens.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import { FileOutboxEmailSender } from "../infrastructure/recovery/email.js";
import { SimpleWebAuthnVerifier } from "../infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { RecoveryController } from "./recovery.controller.js";
import { createRecoveryChainAndAttestor, createRecoveryRuntime } from "./recovery.runtime.js";
import type { RecoveryRuntime } from "./recovery.runtime.js";
import { RecoverySweeper } from "./recovery-sweeper.js";
import { RECOVERY_RUNTIME } from "./recovery.tokens.js";

/**
 * Account recovery. Present only when RECOVERY_ENABLED=true (null otherwise): every route then answers "not enabled". The
 * relayer and attestor keys are read from files outside the repository at startup; nothing here can move funds.
 */
@Module({
  imports: [WalletModule, AuthorizationModule],
  controllers: [RecoveryController],
  providers: [
    {
      provide: RECOVERY_RUNTIME,
      inject: [DATABASE, APP_CONFIG, TRANSACTION_PIN_SERVICE],
      useFactory: (
        database: Database,
        config: AppConfig,
        pins: TransactionPinService | null,
      ): RecoveryRuntime | null => {
        const recovery = config.recovery;
        const passkey = config.wallet.passkey;
        const bundlerUrl = config.execution.bundlerUrl;
        if (!recovery.enabled || !recovery.setup || !passkey || !pins || !bundlerUrl) return null;
        if (recovery.emailProvider !== "outbox" || !recovery.emailOutboxFile) {
          throw new Error("no recovery email provider is configured");
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
          attestorKeyFile: recovery.setup.attestorKeyFile,
          p256Precompile: true,
          gasTopUpMaxWei: recovery.gasTopUpMaxWei,
        });
        return createRecoveryRuntime({
          database,
          chain: viemChain,
          attestor,
          email: new FileOutboxEmailSender(recovery.emailOutboxFile),
          passkeyVerifier: new SimpleWebAuthnVerifier(),
          pins,
          rpId: passkey.rpId,
          origin: passkey.origin,
          webUrl: config.webUrl,
          challengeSecret: Buffer.from(recovery.setup.challengeSecret, "base64"),
          policy: {
            defaultDelaySeconds: recovery.delaySeconds,
            minDelaySeconds: recovery.minDelaySeconds,
          },
        });
      },
    },
    RecoverySweeper,
  ],
  exports: [RECOVERY_RUNTIME],
})
export class RecoveryModule {}
