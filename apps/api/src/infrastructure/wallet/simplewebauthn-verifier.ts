import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { PasskeyVerifier, VerifiedRegistration } from "@kaada/domain";

/*
 * WebAuthn verification through @simplewebauthn/server, the standard library for it. Kaada never
 * parses CBOR or checks a signature by hand. Only the PUBLIC key leaves a registration; the private
 * key never exists outside the user's authenticator.
 *
 * Only ES256 (COSE alg -7, P-256) passkeys are accepted: that is what the on-chain passkey validator
 * (and Celo's P-256 precompile) verify.
 */

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const EC2 = 2;
const ES256 = -7;
const P256 = 1;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** The 32-byte P-256 coordinates of a COSE public key, or null if it is not an ES256 key. */
export function coseToCoordinates(publicKey: Uint8Array): { x: string; y: string } | null {
  const key = isoCBOR.decodeFirst<Map<number, unknown>>(new Uint8Array(publicKey));
  const x = key.get(COSE_X);
  const y = key.get(COSE_Y);
  if (
    key.get(COSE_KTY) !== EC2 ||
    key.get(COSE_ALG) !== ES256 ||
    key.get(COSE_CRV) !== P256 ||
    !(x instanceof Uint8Array) ||
    !(y instanceof Uint8Array) ||
    x.length !== 32 ||
    y.length !== 32
  ) {
    return null;
  }
  return { x: toHex(x), y: toHex(y) };
}

/** Rebuilds the COSE key a stored credential was registered with, for assertion verification. */
export function coordinatesToCose(x: string, y: string): Uint8Array {
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [COSE_KTY, EC2],
      [COSE_ALG, ES256],
      [COSE_CRV, P256],
      [COSE_X, fromHex(x)],
      [COSE_Y, fromHex(y)],
    ]),
  );
}

export class SimpleWebAuthnVerifier implements PasskeyVerifier {
  async verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<VerifiedRegistration | null> {
    try {
      const result = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
        // A passkey is a strong credential only if the user was verified (biometric or device PIN).
        requireUserVerification: true,
      });
      if (!result.verified) return null;
      const { credential } = result.registrationInfo;
      const coordinates = coseToCoordinates(credential.publicKey);
      if (!coordinates) return null;
      return {
        credentialId: credential.id,
        publicKeyX: coordinates.x,
        publicKeyY: coordinates.y,
        signCount: credential.counter,
      };
    } catch {
      return null;
    }
  }

  async verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: { credentialId: string; publicKeyX: string; publicKeyY: string; signCount: number };
  }): Promise<{ newSignCount: number } | null> {
    try {
      const result = await verifyAuthenticationResponse({
        response: input.response as AuthenticationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
        requireUserVerification: true,
        credential: {
          id: input.credential.credentialId,
          publicKey: new Uint8Array(
            coordinatesToCose(input.credential.publicKeyX, input.credential.publicKeyY),
          ),
          counter: input.credential.signCount,
        },
      });
      return result.verified ? { newSignCount: result.authenticationInfo.newCounter } : null;
    } catch {
      return null;
    }
  }
}
