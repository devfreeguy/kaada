import { randomBytes } from "node:crypto";

import { CELO_CHAIN_ID, KaadaError, WALLET_AUDIT_EVENTS, createId } from "@kaada/domain";
import type { PasskeyCredential, PasskeyVerifier } from "@kaada/domain";

import type { WalletRepositories, WalletUnitOfWork } from "./ports.js";

/** How long a challenge can be answered. Short: it is only the time to touch an authenticator. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PasskeyServiceDeps {
  unitOfWork: WalletUnitOfWork;
  verifier: PasskeyVerifier;
  /** The relying party id (a domain) and the exact web origin that may register and use passkeys. */
  rpId: string;
  origin: string;
  now?: () => Date;
}

/** What the browser needs to start a ceremony. Nothing here is secret. */
export interface PasskeyChallengeOptions {
  challenge: string;
  rpId: string;
  /** Credentials already registered, so an authenticator is not enrolled twice. */
  existingCredentialIds: string[];
}

/** The challenge a client signed, read from clientDataJSON. */
function challengeOf(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const inner = (response as { response?: { clientDataJSON?: unknown } }).response;
  if (typeof inner?.clientDataJSON !== "string") return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(inner.clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof decoded.challenge === "string" ? decoded.challenge : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server side of passkey registration and authentication: one-time challenges, verification
 * with a standard WebAuthn library, and storage of PUBLIC credential data only. The browser half
 * (navigator.credentials) is Build 10.1.
 *
 * A passkey is the user's root authority for their wallet. Registering one is audited. Email
 * possession never creates or replaces one here.
 */
export class PasskeyService {
  private readonly uow: WalletUnitOfWork;
  private readonly verifier: PasskeyVerifier;
  private readonly rpId: string;
  private readonly origin: string;
  private readonly now: () => Date;

  constructor(deps: PasskeyServiceDeps) {
    this.uow = deps.unitOfWork;
    this.verifier = deps.verifier;
    this.rpId = deps.rpId;
    this.origin = deps.origin;
    this.now = deps.now ?? (() => new Date());
  }

  beginRegistration(userId: string): Promise<PasskeyChallengeOptions> {
    return this.issue(userId, "REGISTRATION");
  }

  beginAuthentication(userId: string): Promise<PasskeyChallengeOptions> {
    return this.issue(userId, "AUTHENTICATION");
  }

  /**
   * Verifies a registration response against the challenge issued to THIS user (single use) and
   * stores the public credential. Returns the stored credential.
   */
  async completeRegistration(userId: string, response: unknown): Promise<PasskeyCredential> {
    const challenge = challengeOf(response);
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    if (!challenge) throw reject("the registration response is malformed");

    const consumed = await this.uow.read.passkeys.consumeChallenge({
      userId,
      purpose: "REGISTRATION",
      challenge,
      now: this.now(),
    });
    if (!consumed) throw reject("the challenge is unknown, expired or already used");

    const verified = await this.verifier.verifyRegistration({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRpId: this.rpId,
    });
    if (!verified) throw reject("the registration could not be verified");

    return this.uow.transaction(async (repositories) => {
      if (await repositories.passkeys.findByCredentialId(verified.credentialId)) {
        throw reject("this credential is already registered");
      }
      const credential = await repositories.passkeys.create({
        id: createId(),
        userId,
        credentialId: verified.credentialId,
        publicKeyX: verified.publicKeyX,
        publicKeyY: verified.publicKeyY,
        rpId: this.rpId,
        signCount: verified.signCount,
      });
      await this.audit(
        repositories,
        userId,
        WALLET_AUDIT_EVENTS.credentialRegistered,
        credential.id,
      );
      return credential;
    });
  }

  /**
   * Verifies an authentication response from one of this user's own, unrevoked credentials. The
   * signature counter must move forward (an authenticator that always reports 0 is accepted only
   * while it stays 0). Proves the user holds the passkey; it grants no spending by itself.
   */
  async completeAuthentication(userId: string, response: unknown): Promise<PasskeyCredential> {
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    const challenge = challengeOf(response);
    const credentialId = (response as { id?: unknown } | null)?.id;
    if (!challenge || typeof credentialId !== "string")
      throw reject("the authentication response is malformed");

    const consumed = await this.uow.read.passkeys.consumeChallenge({
      userId,
      purpose: "AUTHENTICATION",
      challenge,
      now: this.now(),
    });
    if (!consumed) throw reject("the challenge is unknown, expired or already used");

    const credential = await this.uow.read.passkeys.findByCredentialId(credentialId);
    if (!credential || credential.userId !== userId || credential.revokedAt) {
      throw reject("this credential cannot be used");
    }
    const verified = await this.verifier.verifyAuthentication({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRpId: this.rpId,
      credential,
    });
    if (!verified) throw reject("the authentication could not be verified");

    const bothZero = credential.signCount === 0 && verified.newSignCount === 0;
    if (
      !bothZero &&
      !(await this.uow.read.passkeys.advanceCounter(
        credential.id,
        verified.newSignCount,
        this.now(),
      ))
    ) {
      throw reject("the signature counter did not advance (possible cloned authenticator)");
    }
    return credential;
  }

  /**
   * Revokes one of the user's credentials. If it was their last active one, the embedded wallet is
   * moved to RECOVERY_REQUIRED: without a root authority nothing can be authorised, and Kaada has no
   * way to substitute one.
   */
  async revokeCredential(userId: string, credentialId: string): Promise<void> {
    await this.uow.transaction(async (repositories) => {
      const credential = await repositories.passkeys.findByCredentialId(credentialId);
      if (!credential || credential.userId !== userId) {
        throw new KaadaError("CREDENTIAL_REJECTED", "no such credential");
      }
      if (!(await repositories.passkeys.revoke(credential.id, this.now()))) return;
      await this.audit(repositories, userId, WALLET_AUDIT_EVENTS.credentialRevoked, credential.id);

      if ((await repositories.passkeys.listActiveForUser(userId)).length === 0) {
        await repositories.wallets.lockUser(userId);
        const wallet = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
        if (wallet && (wallet.status === "ACTIVE" || wallet.status === "SUSPENDED")) {
          await repositories.wallets.setStatus(
            wallet.id,
            "RECOVERY_REQUIRED",
            "LAST_CREDENTIAL_REVOKED",
          );
          await this.audit(repositories, userId, WALLET_AUDIT_EVENTS.recoveryRequired, wallet.id, {
            reason: "LAST_CREDENTIAL_REVOKED",
          });
        }
      }
    });
  }

  private async issue(
    userId: string,
    purpose: "REGISTRATION" | "AUTHENTICATION",
  ): Promise<PasskeyChallengeOptions> {
    const challenge = randomBytes(32).toString("base64url");
    await this.uow.read.passkeys.issueChallenge({
      id: createId(),
      userId,
      purpose,
      challenge,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_MS),
    });
    const existing = await this.uow.read.passkeys.listActiveForUser(userId);
    return {
      challenge,
      rpId: this.rpId,
      existingCredentialIds: existing.map((credential) => credential.credentialId),
    };
  }

  private async audit(
    repositories: WalletRepositories,
    userId: string,
    type: string,
    entityId: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await repositories.audit.append({
      id: createId(),
      userId,
      type,
      entityType: type.startsWith("wallet.credential") ? "passkey" : "wallet",
      entityId,
      // Identifiers and reason codes only: never a public key, a signature or a challenge.
      ...(data && { data }),
    });
  }
}
