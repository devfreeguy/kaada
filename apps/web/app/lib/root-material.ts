import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import { loadDeviceKey, signDevicePayload } from "./device-key";
import { DeviceKeyMissingError } from "./root-proof";

/** What the server asks the CURRENT root to sign for a recovery cancel, a Recovery Code arming or a signing proof. */
export interface RootSigningRequest {
  challenge: string;
  rootKind: "PASSKEY" | "DEVICE_KEY";
  passkey?: { challenge: string; rpId: string; userVerification: "required" };
  device?: { keyId: string; payload: string };
}

/**
 * The root's signature material: a passkey assertion (an object) or the device signature `keyId || r || s` (hex). The server
 * built the exact thing to sign; this only asks this device's passkey or key to sign it.
 */
export async function signRootRequest(request: RootSigningRequest): Promise<unknown> {
  if (request.rootKind === "PASSKEY") {
    if (!request.passkey) throw new Error("malformed request");
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
      challenge: request.passkey.challenge,
      rpId: request.passkey.rpId,
      userVerification: request.passkey.userVerification,
    };
    return startAuthentication({ optionsJSON });
  }
  if (!request.device) throw new Error("malformed request");
  const key = await loadDeviceKey(request.device.keyId);
  if (!key) throw new DeviceKeyMissingError();
  const { r, s } = await signDevicePayload(key, request.device.payload);
  return `0x${request.device.keyId.replace(/^0x/, "")}${r}${s}`;
}
