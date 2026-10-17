// Prints the PUBLIC address of a Kaada platform key file, and nothing else. Never prints the key.
//
// On the server (the image already contains viem; mount the key read-only exactly as compose.yml does):
//   docker run --rm -i \
//     -v /opt/apps/kaada/secrets/platform-agent.key:/run/secrets/kaada-platform-agent.key:ro \
//     --entrypoint node ghcr.io/<owner>/<repo>-api:<tag> --input-type=module - \
//     < deploy/scripts/platform-address.mjs
// or, with Node + viem installed:  node deploy/scripts/platform-address.mjs /path/to/platform-agent.key
import { readFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

const path = process.argv[2] ?? "/run/secrets/kaada-platform-agent.key";
let text;
try {
  text = readFileSync(path, "utf8").trim();
} catch {
  console.error(`cannot read ${path}`);
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
  console.error("the file must hold exactly one 0x-prefixed 32-byte hex private key");
  process.exit(1);
}
try {
  console.log(privateKeyToAccount(text).address);
} catch {
  console.error("not a valid secp256k1 private key");
  process.exit(1);
}
