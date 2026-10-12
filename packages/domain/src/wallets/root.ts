/*
 * The wallet's ROOT, independent of how it signs. Business logic names a `RootType`; only the adapters for that type know
 * whether a signature is a WebAuthn assertion or a raw P-256 signature. Everything here is PUBLIC data: a root's private
 * key lives in the person's authenticator or device keystore and is never seen, stored or derivable by Kaada.
 */

/** PASSKEY = a WebAuthn credential; DEVICE_KEY = a raw P-256 key held by the device (KaadaDeviceKeyValidator). */
export const ROOT_TYPES = ["PASSKEY", "DEVICE_KEY"] as const;
export type RootType = (typeof ROOT_TYPES)[number];

export interface PasskeyRoot {
  type: "PASSKEY";
  /** The WebAuthn credential id (base64url). */
  credentialId: string;
  /** P-256 public coordinates, 64 lower-case hex characters each (no 0x). */
  publicKeyX: string;
  publicKeyY: string;
  rpId: string;
  /**
   * The validator instance that holds this credential. Absent for a wallet created with the stack's shared passkey
   * validator; present (a clone) for a root created by a rotation or a recovery.
   */
  validatorAddress?: string;
}

export interface DeviceKeyRoot {
  type: "DEVICE_KEY";
  /** The validator keyId (0x + 64 hex). */
  keyId: string;
  publicKeyX: string;
  publicKeyY: string;
  /** The KaadaDeviceKeyValidator clone that holds this key. Never shared with another credential or another wallet. */
  validatorAddress: string;
  /** The factory purpose and deployment salt the clone was derived with. */
  purpose: number;
  deploymentSalt: string;
}

export type RootCredential = PasskeyRoot | DeviceKeyRoot;

/**
 * What a root signer hands back for a challenge the server fixed. The server never produces this; it only verifies it and
 * encodes it for the validator. There is no "sign these bytes" anywhere on the server.
 */
export type RootProof =
  | { type: "PASSKEY"; assertion: unknown }
  | {
      type: "DEVICE_KEY";
      keyId: string;
      /** The ECDSA P-256 signature as two 32-byte big-endian integers, 64 lower-case hex characters each (no 0x). */
      r: string;
      s: string;
      /** OFF-CHAIN proofs only: the server-issued nonce the signature covers, echoed back so the server can find it. */
      challenge?: string;
    };

/** What the client is told to do next. The client picks the signer UX from this, never from its own guess. */
export const CLIENT_ACTIONS = [
  "ROOT_PASSKEY_REQUIRED",
  "ROOT_DEVICE_KEY_REQUIRED",
  "PIN_REQUIRED",
  "PAYMENT_READY",
] as const;
export type ClientAction = (typeof CLIENT_ACTIONS)[number];

export const rootActionFor = (
  type: RootType,
): "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED" =>
  type === "PASSKEY" ? "ROOT_PASSKEY_REQUIRED" : "ROOT_DEVICE_KEY_REQUIRED";

/** What a client must sign, as the server describes it. The shape depends only on the root type. */
export type RootChallenge =
  | {
      action: "ROOT_PASSKEY_REQUIRED";
      type: "PASSKEY";
      /** The WebAuthn request options (JSON form `navigator.credentials.get` takes). */
      options: {
        challenge: string;
        rpId: string;
        userVerification: "required";
        timeout: number;
      };
    }
  | {
      action: "ROOT_DEVICE_KEY_REQUIRED";
      type: "DEVICE_KEY";
      keyId: string;
      /**
       * The exact bytes (0x hex) the device key signs with ECDSA P-256 / SHA-256: the documented payload, domain-separated
       * (`KaadaDeviceKey/v1` for a UserOperation, `KaadaRootProof/v1` for an off-chain proof).
       */
      payload: string;
      algorithm: "ECDSA_P256_SHA256";
      format: "KaadaDeviceKey/v1" | "KaadaRootProof/v1";
      /** OFF-CHAIN proofs only: the nonce to send back with the signature. */
      challenge?: string;
    };
