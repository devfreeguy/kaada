import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The recovery attestor and relayer are the one sanctioned signer location besides the Kernel adapter.
 * The broad wallet/execution scans exempt them; this scan holds them to narrow, explicit rules instead.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "packages/blockchain/src/recovery");

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const sources = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
const attestor = code(join(dir, "attestor.ts"));
const chain = code(join(dir, "viem-chain.ts"));

describe("recovery signer boundary (source scan)", () => {
  it("scans the recovery adapter files", () => {
    assert.deepEqual(sources.sort(), ["attestor.ts", "index.ts", "viem-chain.ts"]);
  });

  it("no recovery file handles a mnemonic, seed or raw signing", () => {
    for (const name of sources) {
      const text = code(join(dir, name));
      assert.equal(
        /\b(mnemonic|seedPhrase|secretKey|signMessage|signTransaction|generatePrivateKey|mnemonicToAccount)\b/.test(
          text,
        ),
        false,
        name,
      );
    }
  });

  it("the attestor signs only the typed Initiate message and sends only attestorCancel", () => {
    assert.equal((attestor.match(/\.signTypedData\(/g) ?? []).length, 1);
    assert.ok(/primaryType:\s*"Initiate"/.test(attestor));
    assert.equal((attestor.match(/writeContract\(/g) ?? []).length, 1);
    assert.ok(/functionName:\s*"attestorCancel"/.test(attestor));
    assert.equal(/sendTransaction|signUserOperation|sendUserOperation/.test(attestor), false);
  });

  it("the attestor key is read from outside the repository and nothing generates a key", () => {
    assert.ok(/must be stored outside the repository/.test(attestor));
    assert.equal(/generatePrivateKey/.test(attestor + chain), false);
  });

  it("the relayer only pays gas and relays: it never signs typed data or messages", () => {
    assert.equal(/signTypedData|signMessage/.test(chain), false);
    assert.equal((chain.match(/privateKeyToAccount\(/g) ?? []).length, 1);
  });

  it("uses Number only for on-chain counters, never for money", () => {
    for (const m of chain.matchAll(/Number\(([^)]*)\)/g)) {
      assert.ok(/nonce|current|config\[1\]|pending\[1\]/.test(m[1] ?? ""), m[0]);
    }
    assert.equal(/parseFloat|toFixed|Math\.(round|floor|ceil)/.test(attestor + chain), false);
  });
});
