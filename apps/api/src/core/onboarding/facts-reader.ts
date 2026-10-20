import { CELO_CHAIN_ID } from "@kaada/domain";
import type {
  IdentityRepository,
  RecoveryConfigurationRepository,
  TransactionPinRepository,
  WalletFundingStore,
  WalletRepository,
} from "@kaada/domain";

import type { OnboardingFacts, OnboardingStateReader } from "./state.js";

export interface OnboardingFactsDeps {
  wallets: Pick<WalletRepository, "findEmbedded">;
  transactionPins: Pick<TransactionPinRepository, "findByUserId">;
  identities: Pick<IdentityRepository, "listForUser">;
  recoveryConfigurations: Pick<RecoveryConfigurationRepository, "findActive">;
  funding: Pick<WalletFundingStore, "hasBeenFunded">;
  /** Whether this deployment has account recovery at all. Where it does not, the step cannot apply. */
  recoveryEnabled: boolean;
}

/**
 * Where a person stands, read from the services' own records (never from chat). Recovery counts as set up only when a recovery could
 * really start: a verified email (recovery starts from it) AND an armed Recovery Code. Either alone protects nothing.
 */
export function createOnboardingStateReader(deps: OnboardingFactsDeps): OnboardingStateReader {
  return {
    async read(userId): Promise<OnboardingFacts> {
      const wallet = await deps.wallets.findEmbedded(userId, CELO_CHAIN_ID);
      const walletReady = wallet?.status === "ACTIVE" && wallet.address !== undefined;
      const pinConfigured = (await deps.transactionPins.findByUserId(userId)) !== null;
      let recoveryConfigured: boolean | null = null;
      if (deps.recoveryEnabled) {
        const hasEmail = (await deps.identities.listForUser(userId)).some(
          (identity) => identity.type === "EMAIL",
        );
        recoveryConfigured =
          wallet !== null && hasEmail
            ? (await deps.recoveryConfigurations.findActive(wallet.id)) !== null
            : false;
      }
      return {
        walletReady,
        ...(walletReady && wallet?.address && { walletAddress: wallet.address }),
        pinConfigured,
        walletFunded: walletReady ? await deps.funding.hasBeenFunded(userId, CELO_CHAIN_ID) : false,
        recoveryConfigured,
      };
    },
  };
}
