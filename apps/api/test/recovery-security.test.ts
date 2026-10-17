import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The recovery relayer (it only pays gas) is the one signer location in the recovery adapter besides the Kernel adapter. There is
 * no attestor, no KMS signer and no registry any more. The broad wallet/execution scans exempt the relayer; this scan holds it to
 * narrow, explicit rules, and holds the authenticator-app (TOTP) code to its own: no logging, no plaintext at rest.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "packages/blockchain/src/recovery");

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const sources = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
const keyFile = code(join(dir, "key-file.ts"));
const chain = code(join(dir, "viem-chain.ts"));
const deployer = code(join(dir, "validator-deployer.ts"));

describe("recovery signer boundary (source scan)", () => {
  it("scans the recovery adapter files: no attestor or signer-service file exists", () => {
    assert.deepEqual(sources.sort(), [
      "index.ts",
      "key-file.ts",
      "validator-deployer.ts",
      "viem-chain.ts",
    ]);
  });

  it("nothing in the recovery adapter mentions an attestor, a veto, a registry or a KMS", () => {
    for (const name of sources) {
      assert.equal(/attestor|veto|registry|\bkms\b/i.test(code(join(dir, name))), false, name);
    }
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

  it("the relayer key is read from outside the repository and nothing generates a key", () => {
    assert.ok(/must be stored outside the repository/.test(keyFile));
    assert.equal(/generatePrivateKey/.test(keyFile + chain + deployer), false);
  });

  it("the relayer only pays gas and relays: it never signs typed data or messages", () => {
    assert.equal(/signTypedData|signMessage/.test(chain), false);
    assert.equal((chain.match(/privateKeyToAccount\(/g) ?? []).length, 1);
  });

  it("the clone deployer only calls the factory's deploy, paid by the relayer", () => {
    assert.equal((deployer.match(/writeContract\(/g) ?? []).length, 1);
    assert.ok(/functionName:\s*"deploy"/.test(deployer));
    assert.equal(
      /sendTransaction|signTypedData|signMessage|signUserOperation/.test(deployer),
      false,
    );
    assert.equal((deployer.match(/privateKeyToAccount\(/g) ?? []).length, 1);
    assert.equal(/generatePrivateKey/.test(deployer), false);
  });

  it("uses Number only for on-chain counters, never for money", () => {
    for (const m of chain.matchAll(/Number\(([^)]*)\)/g)) {
      assert.ok(/nonce|current|config\[1\]|pending\[1\]/.test(m[1] ?? ""), m[0]);
    }
    assert.equal(/parseFloat|toFixed|Math\.(round|floor|ceil)/.test(chain), false);
  });
});

describe("the authenticator-app factor (source scan)", () => {
  const coreDir = join(root, "apps/api/src/core/recovery");
  const totpPrimitive = code(join(coreDir, "totp.ts"));
  const totpService = code(join(coreDir, "recovery-totp.ts"));
  const flow = code(join(coreDir, "recovery-flow.ts"));

  it("the primitive is pure RFC 6238 over node:crypto: no storage, network, logging or randomness other than the CSPRNG", () => {
    assert.equal(
      /fetch\(|console\.|process\.env|Math\.random|readFile|writeFile/.test(totpPrimitive),
      false,
    );
    assert.ok(/randomBytes\(TOTP_SECRET_BYTES\)/.test(totpPrimitive));
    assert.ok(/timingSafeEqual/.test(totpPrimitive));
  });

  it("the service stores only ciphertext and never logs, audits or returns a secret or a code afterwards", () => {
    assert.equal(/console\.|log\(/.test(totpService), false);
    assert.ok(/cipher\.encrypt\(/.test(totpService));
    assert.ok(/encryptedSecret: ciphertext/.test(totpService));
    // The plaintext secret is never what gets stored.
    assert.equal(/encryptedSecret:\s*secret\b/.test(totpService), false);
    // No audit record carries data at all for the authenticator events.
    for (const m of totpService.matchAll(/audit\.append\(\{[\s\S]*?\}\)/g)) {
      assert.equal(/\bdata:/.test(m[0]), false);
    }
  });

  it("the recovery flow never logs a code or a signature", () => {
    assert.equal(/ctx\.log\([^)]*(authenticatorCode|recoverySignature|code)/.test(flow), false);
  });
});

describe("the web device key (source scan)", () => {
  const web = code(join(root, "apps/web/app/lib/device-key.ts"));
  const proof = code(join(root, "apps/web/app/lib/root-proof.ts"));

  it("generates a non-extractable key and never exports the private half", () => {
    assert.ok(/generateKey\(ECDSA, false,/.test(web));
    assert.equal(/extractable:\s*true/.test(web), false);
    // Only the public key is ever exported (raw); no pkcs8 or jwk export exists in the client.
    assert.equal(/exportKey\(\s*["'](pkcs8|jwk)["']/.test(web + proof), false);
    assert.equal((web.match(/exportKey\(/g) ?? []).length, 1);
    assert.ok(/exportKey\("raw", pair\.publicKey\)/.test(web));
  });

  it("keeps the key only in IndexedDB as an opaque CryptoKey: never in web storage, a cookie, a URL or a log", () => {
    for (const text of [web, proof]) {
      assert.equal(/localStorage|sessionStorage|document\.cookie|console\./.test(text), false);
    }
    assert.ok(/indexedDB\.open/.test(web));
  });

  it("the setup page passes the opaque key only to signDevicePayload and saveDeviceKey, never into a request", () => {
    const setup = code(join(root, "apps/web/app/setup/[token]/setup-flow.tsx"));
    const uses = [...setup.matchAll(/privateKey/g)].length;
    // generate -> sign (1) -> save (1): the key object appears exactly in those three places.
    assert.ok(uses <= 3, String(uses));
    assert.ok(/signDevicePayload\(key\.privateKey/.test(setup));
    assert.ok(/saveDeviceKey\(challenge\.keyId, key\.privateKey\)/.test(setup));
    assert.equal(/JSON\.stringify\([^)]*privateKey/.test(setup), false);
  });

  it("signs only a payload it is handed, with ECDSA P-256 over SHA-256, and normalises to low-s", () => {
    assert.equal((web.match(/subtle\.sign\(/g) ?? []).length, 1);
    assert.ok(/name:\s*"ECDSA",\s*hash:\s*"SHA-256"/.test(web));
    assert.ok(/P256_HALF_N/.test(web));
  });
});

describe("the browser Recovery Code (source scan)", () => {
  const web = code(join(root, "apps/web/app/lib/recovery-code.ts"));
  const newRoot = code(join(root, "apps/web/app/lib/new-root.ts"));

  it("derives and signs on the device only: no network, storage, logging or export of the key", () => {
    assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(web), false);
    assert.equal(
      /localStorage|sessionStorage|indexedDB|document\.cookie|console\./.test(web),
      false,
    );
    assert.equal(/export (async )?function \w+\([^)]*\)[^{]*:\s*Promise<string>/.test(web), false);
  });

  it("signs exactly one kind of message, the typed Initiate, and checks chain and account first", () => {
    assert.equal((web.match(/\.signTypedData\(/g) ?? []).length, 1);
    assert.ok(/primaryType:\s*"Initiate"/.test(web));
    assert.ok(/another chain/.test(web) && /another account/.test(web));
    assert.equal(/signMessage|signTransaction/.test(web), false);
  });

  it("a new device key is only filed and used to sign, never sent or serialised", () => {
    assert.equal(/JSON\.stringify|fetch\(/.test(newRoot), false);
    assert.ok(/saveDeviceKey\(keyId, key\.privateKey\)/.test(newRoot));
    assert.ok(/signDevicePayload\(key\.privateKey/.test(newRoot));
  });

  it("the Recovery Code never reaches a request body", () => {
    for (const file of [
      "apps/web/app/recovery/recovery-flow.tsx",
      "apps/web/app/components/recovery-code-creator.tsx",
    ]) {
      const text = code(join(root, file));
      // Bodies carry the derived ADDRESS or a signature; the typed code and its canonical form never do.
      assert.equal(
        /body:\s*\{[^}]*(recoveryCode|canonical)/.test(text.replace(/emailCode/g, "")),
        false,
        file,
      );
    }
  });
});
