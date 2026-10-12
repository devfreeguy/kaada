import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

import { generateDeviceKey, saveDeviceKey, signDevicePayload } from "./device-key";

const base64url = (text: string): string =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The server's WebAuthn registration challenge for a NEW passkey, turned into creation options and registered on this device. */
export async function registerPasskey(options: {
  challenge: string;
  rpId: string;
  userId: string;
  userName: string;
}): Promise<unknown> {
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON = {
    rp: { id: options.rpId, name: "Kaada" },
    user: { id: base64url(options.userId), name: options.userName, displayName: options.userName },
    challenge: options.challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestation: "none",
    timeout: 120_000,
  };
  return startRegistration({ optionsJSON });
}

export interface NewDeviceKey {
  publicKeyX: string;
  publicKeyY: string;
  /** Persists the private key under the id the SERVER derived, once the server has accepted the public key. */
  keep(keyId: string): Promise<void>;
  /** Signs the server's enrolment payload (proof that this device holds the key). */
  prove(payload: string): Promise<{ r: string; s: string }>;
}

/** A fresh non-extractable device key. Kaada gets the public half and signatures only; nothing is stored until `keep`. */
export async function newDeviceKey(): Promise<NewDeviceKey> {
  const key = await generateDeviceKey();
  return {
    publicKeyX: key.publicKeyX,
    publicKeyY: key.publicKeyY,
    keep: (keyId) => saveDeviceKey(keyId, key.privateKey),
    prove: (payload) => signDevicePayload(key.privateKey, payload),
  };
}
