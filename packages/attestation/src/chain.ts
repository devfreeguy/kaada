import { X509Certificate, createHash } from "node:crypto";

import { Certificate } from "@peculiar/asn1-x509";
import { AsnConvert } from "@peculiar/asn1-schema";

import type { TrustAnchor } from "./roots.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export type ChainRejection =
  | "CHAIN_MALFORMED"
  | "CHAIN_TOO_LONG"
  | "CHAIN_BAD_SIGNATURE"
  | "CHAIN_NOT_CA"
  | "CHAIN_EXPIRED"
  | "CHAIN_UNTRUSTED_ROOT";

export type ChainResult =
  | {
      ok: true;
      /** Leaf first. The trust anchor itself is not in this list unless the chain carried it. */
      certificates: X509Certificate[];
      anchor: TrustAnchor;
    }
  | { ok: false; code: ChainRejection };

/**
 * Verifies a certificate chain against PINNED trust anchors only. Nothing in the evidence can add a root: a chain whose last
 * certificate is not (or is not issued by) a pinned anchor is untrusted, however well it is formed (a self-signed fake chain
 * included). Every signature is checked, every issuer must be a CA, and every certificate must be valid at `now`.
 */
export function verifyCertificateChain(input: {
  chain: readonly Uint8Array[];
  anchors: readonly TrustAnchor[];
  now: Date;
  maxLength?: number;
}): ChainResult {
  const max = input.maxLength ?? 6;
  if (input.chain.length === 0) return { ok: false, code: "CHAIN_MALFORMED" };
  if (input.chain.length > max) return { ok: false, code: "CHAIN_TOO_LONG" };
  let certificates: X509Certificate[];
  try {
    certificates = input.chain.map((der) => new X509Certificate(Buffer.from(der)));
  } catch {
    return { ok: false, code: "CHAIN_MALFORMED" };
  }
  const seen = new Set(certificates.map((c) => c.fingerprint256));
  if (seen.size !== certificates.length) return { ok: false, code: "CHAIN_MALFORMED" };

  const now = input.now.getTime();
  const anchorCerts = input.anchors.map((anchor) => ({
    anchor,
    cert: new X509Certificate(anchor.pem),
  }));
  for (const cert of [...certificates, ...anchorCerts.map((a) => a.cert)]) {
    if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime()) {
      // An anchor that has expired simply cannot anchor anything; a chain certificate that expired is a refusal.
      if (certificates.includes(cert)) return { ok: false, code: "CHAIN_EXPIRED" };
    }
  }

  for (let i = 0; i < certificates.length - 1; i += 1) {
    const cert = certificates[i];
    const issuer = certificates[i + 1];
    if (!cert || !issuer) return { ok: false, code: "CHAIN_MALFORMED" };
    if (!issuer.ca) return { ok: false, code: "CHAIN_NOT_CA" };
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
      return { ok: false, code: "CHAIN_BAD_SIGNATURE" };
    }
  }

  const last = certificates[certificates.length - 1];
  if (!last) return { ok: false, code: "CHAIN_MALFORMED" };
  for (const { anchor, cert } of anchorCerts) {
    if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime()) continue;
    // The chain carried the anchor itself: it must be byte-for-byte the pinned certificate.
    if (sha256Hex(last.raw) === anchor.sha256) return { ok: true, certificates, anchor };
    // Or its last certificate is issued by the anchor (and signed by it).
    if (cert.ca && last.checkIssued(cert) && last.verify(cert.publicKey)) {
      return { ok: true, certificates, anchor };
    }
  }
  return { ok: false, code: "CHAIN_UNTRUSTED_ROOT" };
}

/** The raw value of an X.509 extension by OID, or undefined. Duplicated extensions are refused by returning null. */
export function extensionValue(
  certificate: X509Certificate,
  oid: string,
): Uint8Array | undefined | null {
  const parsed = AsnConvert.parse(certificate.raw, Certificate);
  const matches = (parsed.tbsCertificate.extensions ?? []).filter((e) => e.extnID === oid);
  if (matches.length > 1) return null;
  const found = matches[0];
  return found ? new Uint8Array(found.extnValue.buffer) : undefined;
}
