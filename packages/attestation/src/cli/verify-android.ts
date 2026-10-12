import { readFileSync } from "node:fs";

import { DEFAULT_ANDROID_POLICY, verifyAndroidKeyAttestation } from "../android.js";

// Feeds a real device's attestation through the production verifier (Google roots, no revocation source).
// Usage: pnpm verify:android <evidence.json> [package=signatureDigestHex ...]
// evidence.json: { "chain": ["<base64 DER>", ...], "challenge": "<hex>", "publicKey": { "x": "<hex>", "y": "<hex>" } }
const [file, ...apps] = process.argv.slice(2);
if (!file) {
  console.error("usage: verify:android <evidence.json> [package=signatureDigestHex ...]");
  process.exit(2);
}
const evidence = JSON.parse(readFileSync(file, "utf8")) as {
  chain: string[];
  challenge: string;
  publicKey: { x: string; y: string };
};
const applications = apps.map((entry) => {
  const [packageName = "", digest = ""] = entry.split("=");
  return { packageName, signatureDigests: [digest.toLowerCase()] };
});
const result = await verifyAndroidKeyAttestation({
  certificateChain: evidence.chain,
  challenge: new Uint8Array(Buffer.from(evidence.challenge, "hex")),
  publicKey: evidence.publicKey,
  policy: { ...DEFAULT_ANDROID_POLICY, applications },
  now: new Date(),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.verdict === "VERIFIED" ? 0 : 1);
