import { deviceKeyPayload, deviceProofPayload } from "@kaada/contracts";
import type { DeviceProofPurpose } from "@kaada/contracts";
import { KaadaError, rootActionFor } from "@kaada/domain";
import type {
  DeviceKeyRoot,
  PasskeyRepository,
  PasskeyRoot,
  PasskeyVerifier,
  RootChallenge,
  RootCredential,
  RootProof,
} from "@kaada/domain";
import type { Address, Hex } from "viem";

import { verifyP256 } from "./p256.js";

export const hexToBase64Url = (hex: string): string =>
  Buffer.from(hex.replace(/^0x/, ""), "hex").toString("base64url");

/** What an adapter needs to know about the account a root belongs to. */
export interface RootContext {
  /** The Kernel account address. */
  account: string;
  /** The chain id the validators actually run on (what a signed payload is bound to). */
  chainId: number;
}

/**
 * The server-side half of one root type. It describes what the client must sign and checks what comes back, and it knows
 * nothing about payments, permissions or wallets. It cannot sign: there is no method that produces a signature.
 */
export interface RootCredentialAdapter<R extends RootCredential = RootCredential> {
  readonly type: R["type"];
  /** What the client must sign to authorize the UserOperation whose hash the server fixed. */
  prepareOperationChallenge(root: R, context: RootContext, userOpHash: string): RootChallenge;
  /** Verifies the client's proof over exactly that UserOperation hash. Throws CREDENTIAL_REJECTED. */
  verifyOperationProof(
    root: R,
    context: RootContext,
    userOpHash: string,
    proof: RootProof,
  ): Promise<void>;
}

const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);

/** WebAuthn: the challenge is the userOpHash; the assertion is verified by the standard library and its counter must advance. */
export class PasskeyRootAdapter implements RootCredentialAdapter<PasskeyRoot> {
  readonly type = "PASSKEY" as const;

  constructor(
    private readonly deps: {
      verifier: PasskeyVerifier;
      passkeys: Pick<PasskeyRepository, "findByCredentialId" | "advanceCounter">;
      rpId: string;
      origin: string;
      now?: () => Date;
    },
  ) {}

  prepareOperationChallenge(
    _root: PasskeyRoot,
    _context: RootContext,
    userOpHash: string,
  ): RootChallenge {
    // No `allowCredentials` (see PinAuthenticationOptions): naming the credential can make an authenticator sign without
    // verifying the person. The server still requires UV and THIS root's own credential.
    return {
      action: rootActionFor("PASSKEY") as "ROOT_PASSKEY_REQUIRED",
      type: "PASSKEY",
      options: {
        challenge: hexToBase64Url(userOpHash),
        rpId: this.deps.rpId,
        userVerification: "required",
        timeout: 5 * 60 * 1000,
      },
    };
  }

  async verifyOperationProof(
    root: PasskeyRoot,
    _context: RootContext,
    userOpHash: string,
    proof: RootProof,
  ): Promise<void> {
    if (proof.type !== "PASSKEY") throw reject("this wallet's root is a passkey");
    const credentialId = (proof.assertion as { id?: unknown } | null)?.id;
    if (typeof credentialId !== "string" || credentialId !== root.credentialId) {
      throw reject("this is not the wallet's root passkey");
    }
    const credential = await this.deps.passkeys.findByCredentialId(credentialId);
    if (!credential || credential.revokedAt) throw reject("this credential cannot be used");
    const verified = await this.deps.verifier.verifyAuthentication({
      response: proof.assertion,
      expectedChallenge: hexToBase64Url(userOpHash),
      expectedOrigin: new URL(this.deps.origin).origin,
      expectedRpId: this.deps.rpId,
      credential,
    });
    if (!verified) throw reject("the passkey could not be verified");
    const bothZero = credential.signCount === 0 && verified.newSignCount === 0;
    if (
      !bothZero &&
      !(await this.deps.passkeys.advanceCounter(
        credential.id,
        verified.newSignCount,
        (this.deps.now ?? (() => new Date()))(),
      ))
    ) {
      throw reject("the signature counter did not advance");
    }
  }
}

/** A device key: the documented `KaadaDeviceKey/v1` payload, ECDSA P-256 over SHA-256, low-s only. */
export class DeviceKeyRootAdapter implements RootCredentialAdapter<DeviceKeyRoot> {
  readonly type = "DEVICE_KEY" as const;

  operationPayload(root: DeviceKeyRoot, context: RootContext, userOpHash: string): Hex {
    return deviceKeyPayload({
      chainId: context.chainId,
      validator: root.validatorAddress as Address,
      account: context.account as Address,
      keyId: root.keyId as Hex,
      userOpHash: userOpHash as Hex,
    });
  }

  prepareOperationChallenge(
    root: DeviceKeyRoot,
    context: RootContext,
    userOpHash: string,
  ): RootChallenge {
    return {
      action: rootActionFor("DEVICE_KEY") as "ROOT_DEVICE_KEY_REQUIRED",
      type: "DEVICE_KEY",
      keyId: root.keyId,
      payload: this.operationPayload(root, context, userOpHash),
      algorithm: "ECDSA_P256_SHA256",
      format: "KaadaDeviceKey/v1",
    };
  }

  verifyOperationProof(
    root: DeviceKeyRoot,
    context: RootContext,
    userOpHash: string,
    proof: RootProof,
  ): Promise<void> {
    if (proof.type !== "DEVICE_KEY") {
      return Promise.reject(reject("this wallet's root is a device key"));
    }
    if (proof.keyId.toLowerCase() !== root.keyId.toLowerCase()) {
      return Promise.reject(reject("this is not the wallet's root device key"));
    }
    const ok = verifyP256({
      x: root.publicKeyX,
      y: root.publicKeyY,
      message: Buffer.from(this.operationPayload(root, context, userOpHash).slice(2), "hex"),
      r: proof.r,
      s: proof.s,
    });
    return ok
      ? Promise.resolve()
      : Promise.reject(reject("the device signature could not be verified"));
  }

  /** The OFF-CHAIN proof payload (a different domain tag from the on-chain one). */
  proofPayload(
    root: DeviceKeyRoot,
    context: RootContext,
    purpose: DeviceProofPurpose,
    challenge: string,
  ): Hex {
    return deviceProofPayload({
      chainId: context.chainId,
      validator: root.validatorAddress as Address,
      account: context.account as Address,
      keyId: root.keyId as Hex,
      purpose,
      challenge: challenge as Hex,
    });
  }

  verifyProof(
    root: DeviceKeyRoot,
    context: RootContext,
    purpose: DeviceProofPurpose,
    challenge: string,
    proof: RootProof,
  ): boolean {
    if (proof.type !== "DEVICE_KEY" || proof.keyId.toLowerCase() !== root.keyId.toLowerCase()) {
      return false;
    }
    return verifyP256({
      x: root.publicKeyX,
      y: root.publicKeyY,
      message: Buffer.from(this.proofPayload(root, context, purpose, challenge).slice(2), "hex"),
      r: proof.r,
      s: proof.s,
    });
  }
}
