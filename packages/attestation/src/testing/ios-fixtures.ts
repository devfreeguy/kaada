import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";

import { encodeCBOR } from "@levischuck/tiny-cbor";
import * as x509 from "@peculiar/x509";

import { iosClientDataHash } from "../ios.js";
import type { TestAuthority } from "./android-fixtures.js";

// TEST ONLY: App Attest-shaped objects under a private test CA.

x509.cryptoProvider.set(webcrypto as never);
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const NONCE_OID = "1.2.840.113635.100.8.2";

export interface AppAttestFixtureOptions {
  appId: string;
  challenge: Uint8Array;
  point: { x: string; y: string };
  development?: boolean;
  counter?: number;
  /** Nonce computed over a different challenge. */
  nonceChallenge?: Uint8Array;
  /** Report a keyId for a different key. */
  wrongKeyId?: boolean;
  fmt?: string;
}

export async function createAppAttestObject(
  authority: TestAuthority,
  options: AppAttestFixtureOptions,
  now: Date,
): Promise<{ attestationObject: string; keyId: string }> {
  const key = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", key.publicKey));
  const keyHash = createHash("sha256").update(raw).digest();

  const header = Buffer.alloc(37);
  createHash("sha256").update(options.appId, "utf8").digest().copy(header, 0);
  header.writeUInt32BE(options.counter ?? 0, 33);
  const aaguid = options.development
    ? Buffer.from("appattestdevelop", "latin1")
    : Buffer.from("appattest\0\0\0\0\0\0\0", "latin1");
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(keyHash.length);
  const authData = Buffer.concat([header, aaguid, idLength, keyHash]);

  const nonce = createHash("sha256")
    .update(authData)
    .update(iosClientDataHash(options.nonceChallenge ?? options.challenge, options.point))
    .digest();
  const extensionValue = Buffer.concat([Buffer.from("3024a1220420", "hex"), nonce]);
  const credential = await x509.X509CertificateGenerator.create({
    serialNumber: "0b",
    subject: "CN=App Attest Credential",
    issuer: authority.intermediate.subject,
    notBefore: new Date(now.getTime() - 3_600_000),
    notAfter: new Date(now.getTime() + 86_400_000),
    publicKey: key.publicKey,
    signingKey: authority.intermediateKey.privateKey,
    signingAlgorithm: SIGN,
    extensions: [new x509.Extension(NONCE_OID, false, extensionValue)],
  });

  const object = encodeCBOR(
    new Map<string, unknown>([
      ["fmt", options.fmt ?? "apple-appattest"],
      [
        "attStmt",
        new Map<string, unknown>([
          [
            "x5c",
            [new Uint8Array(credential.rawData), new Uint8Array(authority.intermediate.rawData)],
          ],
          ["receipt", new Uint8Array([1, 2, 3])],
        ]),
      ],
      ["authData", new Uint8Array(authData)],
    ]) as never,
  );
  const reportedKeyId = options.wrongKeyId
    ? createHash("sha256").update("other").digest()
    : keyHash;
  return {
    attestationObject: Buffer.from(object).toString("base64"),
    keyId: reportedKeyId.toString("base64"),
  };
}
