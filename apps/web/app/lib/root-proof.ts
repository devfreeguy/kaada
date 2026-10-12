import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import { loadDeviceKey, signDevicePayload } from "./device-key";

/**
 * What the server asks the person's ROOT to sign. The server decides the type from the wallet's root; this page never guesses.
 * `action` is the structured next step: ROOT_PASSKEY_REQUIRED shows the passkey prompt, ROOT_DEVICE_KEY_REQUIRED signs with the
 * device key held by this browser.
 */
export type RootChallenge =
  | {
      action: "ROOT_PASSKEY_REQUIRED";
      type: "PASSKEY";
      options: PublicKeyCredentialRequestOptionsJSON;
    }
  | {
      action: "ROOT_DEVICE_KEY_REQUIRED";
      type: "DEVICE_KEY";
      keyId: string;
      payload: string;
      challenge?: string;
    };

/** The proof the server verifies. Its shape matches the server's `RootProof`. */
export type RootProof =
  | { type: "PASSKEY"; assertion: unknown }
  | { type: "DEVICE_KEY"; keyId: string; r: string; s: string; challenge?: string };

export class DeviceKeyMissingError extends Error {
  constructor() {
    super("this browser does not hold the wallet's device key");
    this.name = "DeviceKeyMissingError";
  }
}

/** Produces the root's proof for a challenge: a passkey assertion, or a device-key signature over exactly the payload. */
export async function proveRoot(challenge: RootChallenge): Promise<RootProof> {
  if (challenge.type === "PASSKEY") {
    const assertion = await startAuthentication({ optionsJSON: challenge.options });
    return { type: "PASSKEY", assertion };
  }
  const key = await loadDeviceKey(challenge.keyId);
  if (!key) throw new DeviceKeyMissingError();
  const { r, s } = await signDevicePayload(key, challenge.payload);
  return {
    type: "DEVICE_KEY",
    keyId: challenge.keyId,
    r,
    s,
    ...(challenge.challenge && { challenge: challenge.challenge }),
  };
}
