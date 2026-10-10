import { KaadaError, isValidPinFormat, isWalletActive } from "@kaada/domain";

import type { PasskeyService } from "../wallets/passkey-service.js";
import type { WalletService } from "../wallets/wallet-service.js";
import type { TransactionPinService } from "./pin-service.js";

/** Browser-ready WebAuthn request options (the JSON form `navigator.credentials.get` takes). */
export interface PinAuthenticationOptions {
  challenge: string;
  rpId: string;
  allowCredentials: { type: "public-key"; id: string }[];
  userVerification: "required";
  timeout: number;
}

/**
 * Setting or changing the PIN is security-sensitive, so it needs a STRONG credential: a fresh
 * passkey assertion (user verification required) for this user, on top of the secure link that
 * identified them. The old PIN alone can never change the PIN, and neither can an email.
 *
 * A forgotten PIN is not handled here: that is account recovery, a later build.
 */
export class PinEnrollmentService {
  constructor(
    private readonly deps: {
      passkeys: Pick<PasskeyService, "beginAuthentication" | "completeAuthentication">;
      pins: Pick<TransactionPinService, "setPin" | "status">;
      wallets: Pick<WalletService, "getWallet">;
    },
  ) {}

  /** The challenge the person's passkey must sign before a PIN is set or changed. */
  async begin(userId: string): Promise<PinAuthenticationOptions> {
    await this.requireActiveWallet(userId);
    const challenge = await this.deps.passkeys.beginAuthentication(userId);
    return {
      challenge: challenge.challenge,
      rpId: challenge.rpId,
      allowCredentials: challenge.existingCredentialIds.map((id) => ({
        type: "public-key" as const,
        id,
      })),
      userVerification: "required",
      timeout: 5 * 60 * 1000,
    };
  }

  /** Verifies the passkey assertion, then stores the PIN. */
  async complete(userId: string, input: { pin: string; assertion: unknown }) {
    // Refuse a malformed PIN before the single-use challenge is spent on it.
    if (!isValidPinFormat(input.pin)) {
      throw new KaadaError("PIN_REJECTED", "a PIN is exactly four digits");
    }
    await this.requireActiveWallet(userId);
    // A PIN flagged for recovery is replaced only through account recovery (a later build), not here.
    if ((await this.deps.pins.status(userId)).resetRequired) {
      throw new KaadaError(
        "PIN_RESET_REQUIRED",
        "this PIN can only be reset through account recovery",
      );
    }
    await this.deps.passkeys.completeAuthentication(userId, input.assertion);
    return this.deps.pins.setPin(userId, input.pin);
  }

  private async requireActiveWallet(userId: string): Promise<void> {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "set up your wallet before creating a PIN");
    }
  }
}
