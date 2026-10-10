/**
 * A user's passkey as Kaada knows it: public data only. The private key stays in the user's
 * authenticator and is never seen, stored or derivable by Kaada.
 */
export interface PasskeyCredential {
  id: string;
  userId: string;
  /** The authenticator's credential id, base64url. */
  credentialId: string;
  /** P-256 public key coordinates, 64 lower-case hex characters each (no 0x). */
  publicKeyX: string;
  publicKeyY: string;
  /** Relying party id the credential is bound to (a domain). */
  rpId: string;
  /** Last accepted signature counter; a non-increasing counter is rejected as a possible clone. */
  signCount: number;
  label?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export type NewPasskeyCredential = Omit<
  PasskeyCredential,
  "createdAt" | "lastUsedAt" | "revokedAt" | "signCount"
> & {
  signCount?: number;
};

export const PASSKEY_CHALLENGE_PURPOSES = ["REGISTRATION", "AUTHENTICATION"] as const;
export type PasskeyChallengePurpose = (typeof PASSKEY_CHALLENGE_PURPOSES)[number];

/** A one-time, short-lived WebAuthn challenge issued for a user. */
export interface PasskeyChallenge {
  id: string;
  userId: string;
  purpose: PasskeyChallengePurpose;
  /** base64url random bytes. */
  challenge: string;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

export type NewPasskeyChallenge = Omit<PasskeyChallenge, "createdAt" | "usedAt">;

export interface PasskeyRepository {
  create(credential: NewPasskeyCredential): Promise<PasskeyCredential>;
  findByCredentialId(credentialId: string): Promise<PasskeyCredential | null>;
  /** Not revoked, oldest first. */
  listActiveForUser(userId: string): Promise<PasskeyCredential[]>;
  /** Moves the counter forward only (and stamps lastUsedAt). False if the new counter is not higher. */
  advanceCounter(id: string, signCount: number, at: Date): Promise<boolean>;
  revoke(id: string, at: Date): Promise<boolean>;
  issueChallenge(challenge: NewPasskeyChallenge): Promise<PasskeyChallenge>;
  /**
   * Atomically claims an unused, unexpired challenge of this purpose for this user (single use).
   * Returns null when there is none, so a replay or a wrong user gets nothing.
   */
  consumeChallenge(input: {
    userId: string;
    purpose: PasskeyChallengePurpose;
    challenge: string;
    now: Date;
  }): Promise<PasskeyChallenge | null>;
}

/** What verifying a registration yields: the public credential to store. */
export interface VerifiedRegistration {
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  signCount: number;
}

/** Verifies WebAuthn ceremonies. Implemented over a standard library; the domain never parses CBOR. */
export interface PasskeyVerifier {
  verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<VerifiedRegistration | null>;
  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: Pick<PasskeyCredential, "credentialId" | "publicKeyX" | "publicKeyY" | "signCount">;
  }): Promise<{ newSignCount: number } | null>;
}
