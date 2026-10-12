import { KaadaError, isValidPinFormat, isWalletActive } from "@kaada/domain";
import type { RootChallenge, RootProof } from "@kaada/domain";

import type { RootProofService } from "../roots/root-proof-service.js";
import type { WalletService } from "../wallets/wallet-service.js";
import type { TransactionPinService } from "./pin-service.js";

/**
 * Setting or changing the PIN is security-sensitive, so it needs a STRONG credential: a fresh proof by the wallet's ROOT (a
 * passkey assertion with user verification, or a device-key signature over a single-use challenge), on top of the secure
 * link that identified the person. The old PIN alone can never change the PIN, and neither can an email. The PIN is never
 * a wallet key and never an input to the root: the root only vouches that the person asked.
 *
 * A forgotten PIN is not handled here: that is account recovery.
 */
export class PinEnrollmentService {
  constructor(
    private readonly deps: {
      proofs: Pick<RootProofService, "begin" | "complete">;
      pins: Pick<TransactionPinService, "setPin" | "status">;
      wallets: Pick<WalletService, "getWallet">;
    },
  ) {}

  /** What the person's root must sign before a PIN is set or changed. */
  async begin(userId: string): Promise<RootChallenge> {
    await this.requireActiveWallet(userId);
    return this.deps.proofs.begin(userId, "PIN_ENROLLMENT");
  }

  /** Verifies the root's proof, then stores the PIN. */
  async complete(userId: string, input: { pin: string; proof: RootProof }) {
    // Refuse a malformed PIN before the single-use challenge is spent on it.
    if (!isValidPinFormat(input.pin)) {
      throw new KaadaError("PIN_REJECTED", "a PIN is exactly six digits");
    }
    await this.requireActiveWallet(userId);
    // A PIN flagged for recovery is replaced only through account recovery, not here.
    if ((await this.deps.pins.status(userId)).resetRequired) {
      throw new KaadaError(
        "PIN_RESET_REQUIRED",
        "this PIN can only be reset through account recovery",
      );
    }
    await this.deps.proofs.complete(userId, "PIN_ENROLLMENT", input.proof);
    return this.deps.pins.setPin(userId, input.pin);
  }

  private async requireActiveWallet(userId: string): Promise<void> {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "set up your wallet before creating a PIN");
    }
  }
}
