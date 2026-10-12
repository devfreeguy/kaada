/*
 * What Kaada knows about the roots a wallet has had. PUBLIC data only: a credential's private key lives in the
 * user's authenticator or device keystore and is never seen, stored or derivable by Kaada.
 */

export const WALLET_CREDENTIAL_KINDS = ["PASSKEY", "DEVICE_KEY"] as const;
/** PASSKEY = a WebAuthn credential (ZeroDev passkey validator); DEVICE_KEY = a raw P-256 key (KaadaDeviceKeyValidator). */
export type WalletCredentialKind = (typeof WALLET_CREDENTIAL_KINDS)[number];

/**
 * - PRIMARY:  created with the wallet (or rotated to) as its root.
 * - BACKUP:   an optional second root-capable credential the user enrolled.
 * - RECOVERY: created through account recovery; becomes the root when the recovery completes.
 */
export const WALLET_CREDENTIAL_ROLES = ["PRIMARY", "BACKUP", "RECOVERY"] as const;
export type WalletCredentialRole = (typeof WALLET_CREDENTIAL_ROLES)[number];

/**
 * - PENDING:  recorded (its validator instance may be deployed) but NOT yet the account's root.
 * - ACTIVE:   the current root, or an enrolled backup.
 * - REPLACED: was a root and was replaced by a rotation or a recovery. Its validator instance still exists on chain
 *             but is voided there (invalidateNonce).
 * - REVOKED:  withdrawn by the user or by Kaada.
 */
export const WALLET_CREDENTIAL_STATUSES = ["PENDING", "ACTIVE", "REPLACED", "REVOKED"] as const;
export type WalletCredentialStatus = (typeof WALLET_CREDENTIAL_STATUSES)[number];

/**
 * How much Kaada can vouch for where a DEVICE_KEY lives. Never taken from a client claim: TRUSTED_DEVICE only when a
 * server-side verifier proved a platform attestation. Passkeys are UNKNOWN here (their authenticator is not attested).
 */
export const DEVICE_SECURITY_TIERS = ["UNKNOWN", "WEB_NON_EXTRACTABLE", "TRUSTED_DEVICE"] as const;
export type DeviceSecurityTier = (typeof DEVICE_SECURITY_TIERS)[number];

export interface WalletCredential {
  id: string;
  userId: string;
  walletId: string;
  kind: WalletCredentialKind;
  role: WalletCredentialRole;
  status: WalletCredentialStatus;
  /** True for the credential that is the account's current root validator. At most one per wallet. */
  isRoot: boolean;
  /** Lower-case address of the validator instance that holds this credential. NEVER reused for another credential. */
  validatorAddress: string;
  /** The factory purpose the instance was derived with (0 PRIMARY, 1 RECOVERY, 2 BACKUP, 3 ROTATION). */
  validatorPurpose: number;
  /** The factory deploymentSalt (0x + 64 hex) the instance was derived with. */
  deploymentSalt: string;
  /** PASSKEY: the WebAuthn credential id (base64url). DEVICE_KEY: the keyId (0x + 64 hex). */
  credentialRef: string;
  /** P-256 public coordinates, 64 lower-case hex characters each (no 0x). */
  publicKeyX: string;
  publicKeyY: string;
  /** PASSKEY only: the relying party id. */
  rpId?: string;
  /** PASSKEY only: the PasskeyCredential row this mirrors, if any. */
  passkeyCredentialId?: string;
  securityTier: DeviceSecurityTier;
  label?: string;
  replacedByCredentialId?: string;
  createdAt: Date;
  activatedAt?: Date;
  replacedAt?: Date;
  revokedAt?: Date;
}

export type NewWalletCredential = Omit<
  WalletCredential,
  "createdAt" | "activatedAt" | "replacedAt" | "revokedAt" | "replacedByCredentialId"
>;

export interface WalletCredentialRepository {
  create(credential: NewWalletCredential): Promise<WalletCredential>;
  findById(id: string): Promise<WalletCredential | null>;
  /** Whether this validator instance was EVER recorded for the wallet (any status): the freshness check. */
  validatorEverUsed(walletId: string, validatorAddress: string): Promise<boolean>;
  findRoot(walletId: string): Promise<WalletCredential | null>;
  /** Newest first. */
  listForWallet(walletId: string): Promise<WalletCredential[]>;
  /**
   * Atomically: the PENDING `newId` becomes the ACTIVE root and the current root (if any) becomes REPLACED, pointing at
   * the new one. Null (and no change) unless `newId` is PENDING.
   */
  promoteToRoot(input: {
    walletId: string;
    newId: string;
    at: Date;
  }): Promise<{ promoted: WalletCredential; replaced: WalletCredential | null } | null>;
  /** A PENDING credential becomes an ACTIVE non-root credential (an enrolled backup). Null unless it is PENDING. */
  activate(id: string, at: Date): Promise<WalletCredential | null>;
  /** Records the PasskeyCredential row that mirrors this credential once the recovery made it the root. */
  linkPasskey(id: string, passkeyCredentialId: string): Promise<void>;
  /** PENDING or ACTIVE -> REVOKED. Null if it was already REPLACED or REVOKED. */
  revoke(id: string, at: Date): Promise<WalletCredential | null>;
}
