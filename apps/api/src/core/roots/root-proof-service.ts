import { randomBytes } from "node:crypto";

import type { DeviceProofPurpose } from "@kaada/contracts";
import { KaadaError, createId, isWalletActive, rootActionFor } from "@kaada/domain";
import type { PasskeyRepository, RootChallenge, RootProof, Wallet } from "@kaada/domain";

import type { PasskeyService } from "../wallets/passkey-service.js";
import type { DeviceKeyRootAdapter } from "./adapters.js";
import type { RootCredentialService } from "./root-credentials.js";

/** How long an off-chain proof can be answered: only the time to touch an authenticator or approve a key use. */
export const ROOT_PROOF_TTL_MS = 5 * 60 * 1000;

export interface RootProofServiceDeps {
  roots: RootCredentialService;
  passkeys: Pick<PasskeyService, "beginAuthentication" | "completeAuthentication">;
  /** Challenge storage for device-key proofs (passkey proofs use the PasskeyService's own). */
  challenges: Pick<PasskeyRepository, "issueChallenge" | "consumeChallenge">;
  device: DeviceKeyRootAdapter;
  wallets: { getWallet(userId: string): Promise<Wallet | null> };
  /** The chain id the validators run on: what a device proof is bound to. */
  onChainId: number;
  now?: () => Date;
}

/**
 * Proof that the person holds the wallet's ROOT, for things that are not a UserOperation (today: creating or changing the
 * PIN). The same two calls work for both root types: `begin` says what the client must sign, `complete` checks what comes
 * back. A proof is single-use, short-lived and bound to one purpose, so it cannot be replayed for something else, and a
 * device proof can never be replayed as a UserOperation signature (its payload carries a different domain tag).
 */
export class RootProofService {
  private readonly now: () => Date;

  constructor(private readonly deps: RootProofServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async begin(userId: string, purpose: DeviceProofPurpose): Promise<RootChallenge> {
    const { wallet, root } = await this.context(userId);
    if (root.type === "PASSKEY") {
      const challenge = await this.deps.passkeys.beginAuthentication(userId);
      return {
        action: rootActionFor("PASSKEY") as "ROOT_PASSKEY_REQUIRED",
        type: "PASSKEY",
        options: {
          challenge: challenge.challenge,
          rpId: challenge.rpId,
          userVerification: "required",
          timeout: ROOT_PROOF_TTL_MS,
        },
      };
    }
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    await this.deps.challenges.issueChallenge({
      id: createId(),
      userId,
      purpose: "AUTHENTICATION",
      challenge: nonce,
      expiresAt: new Date(this.now().getTime() + ROOT_PROOF_TTL_MS),
    });
    return {
      action: rootActionFor("DEVICE_KEY") as "ROOT_DEVICE_KEY_REQUIRED",
      type: "DEVICE_KEY",
      keyId: root.keyId,
      payload: this.deps.device.proofPayload(
        root,
        { account: wallet.address ?? "", chainId: this.deps.onChainId },
        purpose,
        nonce,
      ),
      algorithm: "ECDSA_P256_SHA256",
      format: "KaadaRootProof/v1",
      challenge: nonce,
    };
  }

  /** Throws CREDENTIAL_REJECTED unless `proof` is a valid, unused proof by this wallet's root for `purpose`. */
  async complete(userId: string, purpose: DeviceProofPurpose, proof: RootProof): Promise<void> {
    const { wallet, root } = await this.context(userId);
    if (root.type !== proof.type) {
      throw new KaadaError("CREDENTIAL_REJECTED", "this wallet's root is not of that type");
    }
    if (proof.type === "PASSKEY") {
      await this.deps.passkeys.completeAuthentication(userId, proof.assertion);
      return;
    }
    if (root.type !== "DEVICE_KEY" || !proof.challenge) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the device proof is malformed");
    }
    // Single use: the nonce is spent before the signature is looked at, so a replay (or a wrong signature) gets nothing.
    const consumed = await this.deps.challenges.consumeChallenge({
      userId,
      purpose: "AUTHENTICATION",
      challenge: proof.challenge,
      now: this.now(),
    });
    if (!consumed) {
      throw new KaadaError(
        "CREDENTIAL_REJECTED",
        "the challenge is unknown, expired or already used",
      );
    }
    const ok = this.deps.device.verifyProof(
      root,
      { account: wallet.address ?? "", chainId: this.deps.onChainId },
      purpose,
      proof.challenge,
      proof,
    );
    if (!ok)
      throw new KaadaError("CREDENTIAL_REJECTED", "the device signature could not be verified");
  }

  private async context(userId: string) {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "set up your wallet first");
    }
    return { wallet, root: await this.deps.roots.activeRoot(wallet) };
  }
}
