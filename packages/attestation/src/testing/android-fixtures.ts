import "reflect-metadata";
import { webcrypto } from "node:crypto";

import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  AttestationApplicationId,
  AttestationPackageInfo,
  AuthorizationList,
  IntegerSet,
  KeyDescription,
  RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from "@peculiar/asn1-android";
import * as x509 from "@peculiar/x509";

import type { TrustAnchor } from "../roots.js";
import { sha256Hex } from "../chain.js";

// TEST ONLY. Builds Android-shaped attestation chains under a private test CA. The production verifier never accepts this CA:
// it is injected as a trust anchor by tests, and the pinned Google roots are untouched.

x509.cryptoProvider.set(webcrypto as never);

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export interface TestAuthority {
  anchor: TrustAnchor;
  rootKey: webcrypto.CryptoKeyPair;
  intermediate: x509.X509Certificate;
  intermediateKey: webcrypto.CryptoKeyPair;
  root: x509.X509Certificate;
}

export interface FixtureOptions {
  challenge: Uint8Array;
  /** Default TEE. */
  level?: "STRONGBOX" | "TEE" | "SOFTWARE";
  attestationLevel?: "STRONGBOX" | "TEE" | "SOFTWARE";
  attestationVersion?: number;
  purposes?: number[];
  algorithm?: number;
  ecCurve?: number;
  digest?: number[];
  origin?: number;
  /** Which list carries the key properties. Default "tee". */
  propertiesIn?: "tee" | "software";
  bootState?: VerifiedBootState;
  deviceLocked?: boolean;
  noRootOfTrust?: boolean;
  creationDateTime?: number;
  packageNames?: string[];
  signatureDigests?: string[];
  omitApplicationId?: boolean;
  omitKeyDescription?: boolean;
  /** Leaf serial number (hex). */
  serial?: string;
  notBefore?: Date;
  notAfter?: Date;
}

const levelOf = (level: "STRONGBOX" | "TEE" | "SOFTWARE"): SecurityLevel =>
  level === "STRONGBOX"
    ? SecurityLevel.strongBox
    : level === "TEE"
      ? SecurityLevel.trustedEnvironment
      : SecurityLevel.software;

export const TEST_APP = {
  packageName: "app.kaada.wallet",
  signatureDigest: "ab".repeat(32),
} as const;

const generate = (): Promise<webcrypto.CryptoKeyPair> =>
  webcrypto.subtle.generateKey(EC, true, ["sign", "verify"]);

export async function createTestAuthority(now: Date): Promise<TestAuthority> {
  const rootKey = await generate();
  const intermediateKey = await generate();
  const notBefore = new Date(now.getTime() - 86_400_000);
  const notAfter = new Date(now.getTime() + 365 * 86_400_000);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test Attestation Root",
    notBefore,
    notAfter,
    keys: rootKey,
    signingAlgorithm: SIGN,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test Attestation Intermediate",
    issuer: root.subject,
    notBefore,
    notAfter,
    publicKey: intermediateKey.publicKey,
    signingKey: rootKey.privateKey,
    signingAlgorithm: SIGN,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  return {
    root,
    rootKey,
    intermediate,
    intermediateKey,
    anchor: {
      name: "test root",
      sha256: sha256Hex(new Uint8Array(root.rawData)),
      pem: root.toString("pem"),
    },
  };
}

export function keyDescription(options: FixtureOptions): Uint8Array {
  const applicationId = new AttestationApplicationId({
    packageInfos: (options.packageNames ?? [TEST_APP.packageName]).map(
      (name) =>
        new AttestationPackageInfo({
          packageName: new OctetString(Buffer.from(name, "utf8")),
          version: 1,
        }),
    ),
    signatureDigests: (options.signatureDigests ?? [TEST_APP.signatureDigest]).map(
      (d) => new OctetString(Buffer.from(d, "hex")),
    ),
  });
  const properties = new AuthorizationList({
    purpose: new IntegerSet(options.purposes ?? [2]),
    algorithm: options.algorithm ?? 3,
    keySize: 256,
    digest: new IntegerSet(options.digest ?? [4]),
    ecCurve: options.ecCurve ?? 1,
    origin: options.origin ?? 0,
    ...(options.noRootOfTrust
      ? {}
      : {
          rootOfTrust: new RootOfTrust({
            verifiedBootKey: new OctetString(new Uint8Array(32)),
            deviceLocked: options.deviceLocked ?? true,
            verifiedBootState: options.bootState ?? VerifiedBootState.verified,
            verifiedBootHash: new OctetString(new Uint8Array(32)),
          }),
        }),
    osPatchLevel: 202609,
    ...(options.creationDateTime !== undefined
      ? { creationDateTime: options.creationDateTime }
      : {}),
  });
  const tee = options.propertiesIn === "software" ? new AuthorizationList({}) : properties;
  const software = new AuthorizationList({
    ...(options.propertiesIn === "software" ? properties : {}),
    ...(options.omitApplicationId
      ? {}
      : { attestationApplicationId: new OctetString(AsnConvert.serialize(applicationId)) }),
  });
  const level = options.level ?? "TEE";
  const description = new KeyDescription({
    attestationVersion: options.attestationVersion ?? 4,
    attestationSecurityLevel: levelOf(options.attestationLevel ?? level),
    keymasterVersion: 4,
    keymasterSecurityLevel: levelOf(level),
    attestationChallenge: new OctetString(options.challenge),
    uniqueId: new OctetString(new Uint8Array(0)),
    softwareEnforced: software,
    teeEnforced: tee,
  });
  return new Uint8Array(AsnConvert.serialize(description));
}

/** Base64 DER chain, leaf first, for the given key under the test authority. */
export async function createAttestationChain(
  authority: TestAuthority,
  leafPublicKey: webcrypto.CryptoKey,
  options: FixtureOptions,
  now: Date,
): Promise<string[]> {
  const extensions: x509.Extension[] = [new x509.BasicConstraintsExtension(false, undefined, true)];
  if (!options.omitKeyDescription) {
    extensions.push(new x509.Extension(id_ce_keyDescription, false, keyDescription(options)));
  }
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: options.serial ?? "0a",
    subject: "CN=Android Keystore Key",
    issuer: authority.intermediate.subject,
    notBefore: options.notBefore ?? new Date(now.getTime() - 3_600_000),
    notAfter: options.notAfter ?? new Date(now.getTime() + 30 * 86_400_000),
    publicKey: leafPublicKey,
    signingKey: authority.intermediateKey.privateKey,
    signingAlgorithm: SIGN,
    extensions,
  });
  return [leaf, authority.intermediate, authority.root].map((c) =>
    Buffer.from(c.rawData).toString("base64"),
  );
}

/** A fresh P-256 device key, as the point the server stores. */
export async function createDeviceKey(): Promise<{
  key: webcrypto.CryptoKeyPair;
  point: { x: string; y: string };
}> {
  const key = await generate();
  const jwk = await webcrypto.subtle.exportKey("jwk", key.publicKey);
  return {
    key,
    point: {
      x: Buffer.from(jwk.x ?? "", "base64url").toString("hex"),
      y: Buffer.from(jwk.y ?? "", "base64url").toString("hex"),
    },
  };
}
