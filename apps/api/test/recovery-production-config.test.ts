import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  assertRelayerMatchesDeployment,
  createRecoveryChain,
} from "../src/recovery/recovery.runtime.js";

/*
 * The production recovery relayer setup: a key FILE (read-only mount), validated at startup against the address the validator was
 * deployed with, never in an image, an environment variable, a log or an error.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const dir = mkdtempSync(join(tmpdir(), "kaada-relayer-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
};

const chainFor = (relayerKeyFile: string) =>
  createRecoveryChain({
    chain: celoSepolia,
    rpcUrl: "http://127.0.0.1:1",
    bundlerUrl: "http://127.0.0.1:1",
    recoveryValidator: "0x00000000000000000000000000000000000000c1",
    deployments: {
      passkey: {
        factory: "0x00000000000000000000000000000000000000f1",
        implementation: "0x00000000000000000000000000000000000000a1",
      },
      device: {
        factory: "0x00000000000000000000000000000000000000f2",
        implementation: "0x00000000000000000000000000000000000000a2",
      },
    },
    relayerKeyFile,
    p256Precompile: true,
    gasTopUpMaxWei: 0n,
  });

describe("the relayer key file", () => {
  it("a valid 0x-prefixed 32-byte key (with the file's trailing newline) derives its address", () => {
    const key = generatePrivateKey();
    const chain = chainFor(write("ok.key", `${key}\n`));
    assert.equal(chain.relayerAddress, privateKeyToAccount(key).address.toLowerCase());
  });

  it("a missing file fails startup, and the error does not contain a key", () => {
    assert.throws(
      () => chainFor(join(dir, "does-not-exist.key")),
      (error: Error) =>
        /RECOVERY_RELAYER_KEY_FILE: cannot read the key file: file not found/.test(error.message) &&
        !/0x[0-9a-f]{64}/i.test(error.message),
    );
  });

  it("a malformed key fails startup without echoing what the file held", () => {
    let n = 0;
    const secret = "0xnot-a-key-but-secret-looking-text-0123456789";
    for (const bad of [
      secret,
      "",
      `0x${"ab".repeat(31)}`, // 31 bytes
      `0x${"ab".repeat(33)}`, // 33 bytes
      "ab".repeat(32), // no 0x prefix
      `0x${"zz".repeat(32)}`,
    ]) {
      assert.throws(
        () => chainFor(write(`bad-${n++}.key`, bad)),
        (error: Error) =>
          /32-byte/.test(error.message) && !error.message.includes(bad.slice(2, 20) || "\u0000"),
        JSON.stringify(bad.slice(0, 12)),
      );
    }
  });

  it("two keys in one file are refused: exactly one key and nothing else", () => {
    const two = `${generatePrivateKey()}\n${generatePrivateKey()}\n`;
    assert.throws(() => chainFor(write("two.key", two)), /32-byte/);
  });

  it("a key file inside the repository is refused", () => {
    assert.throws(() => chainFor(join(root, "apps/api/package.json")), /outside the repository/);
  });

  it("the adapter keeps no copy of the key: serialising it leaks nothing", () => {
    const key = generatePrivateKey();
    const chain = chainFor(write("leak.key", key));
    const everything = JSON.stringify(chain, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    assert.equal(everything.toLowerCase().includes(key.slice(2).toLowerCase()), false);
  });
});

describe("the relayer address must match the deployment", () => {
  it("a matching address (any letter case) starts", () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    assert.doesNotThrow(() => assertRelayerMatchesDeployment(address.toLowerCase(), address));
  });

  it("a different address refuses to start, naming only the two PUBLIC addresses", () => {
    const key = generatePrivateKey();
    const derived = privateKeyToAccount(key).address;
    const deployed = privateKeyToAccount(generatePrivateKey()).address;
    assert.throws(
      () => assertRelayerMatchesDeployment(derived, deployed),
      (error: Error) =>
        error.message.includes(derived.toLowerCase()) &&
        error.message.includes(deployed.toLowerCase()) &&
        !error.message.includes(key.slice(2)),
    );
  });
});

describe("the production deployment files", () => {
  const compose = read("deploy/compose.yml");

  it("compose mounts exactly the three secret files, individually and read-only, at the paths the env names", () => {
    const mounts = [...compose.matchAll(/^\s*-\s*(\/\S+:\/\S+)\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(mounts, [
      "/opt/apps/kaada/secrets/recovery-relayer.key:/run/secrets/recovery-relayer.key:ro",
      "/opt/apps/kaada/secrets/platform-agent.key:/run/secrets/platform-agent.key:ro",
      "/opt/apps/kaada/secrets/recovery-smtp-password:/run/secrets/recovery-smtp-password:ro",
    ]);
    // every mount is read-only, and no mount takes the secrets DIRECTORY (or /run/secrets itself) as its source or target
    assert.ok(mounts.every((m) => m?.endsWith(":ro")));
    assert.equal(/\/opt\/apps\/kaada\/secrets\/?:/.test(compose), false);
    assert.equal(/:\/run\/secrets\/?(:|\s)/.test(compose), false);
    // the existing hardening is intact
    for (const kept of [
      /^\s*init: true$/m,
      /no-new-privileges:true/,
      /cap_drop:\s*\n\s*-\s*ALL/,
      /"127\.0\.0\.1:3005:3005"/,
      /max-size: "10m"/,
      /max-file: "5"/,
    ])
      assert.match(compose, kept);
    // the key is never an environment variable
    assert.match(
      read("deploy/.env.example"),
      /^PLATFORM_WALLET_KEY_FILE=\/run\/secrets\/platform-agent\.key$/m,
    );
    assert.match(
      read("deploy/.env.example"),
      /^RECOVERY_SMTP_PASSWORD_FILE=\/run\/secrets\/recovery-smtp-password$/m,
    );
    assert.equal(/RELAYER_KEY\b|RELAYER_PRIVATE|PRIVATE_KEY/i.test(compose), false);
    assert.match(
      read("deploy/.env.example"),
      /^RECOVERY_RELAYER_KEY_FILE=\/run\/secrets\/recovery-relayer.key$/m,
    );
  });

  it("the image never contains a key: nothing is copied from a secrets path, and key files stay out of the build context", () => {
    const dockerfile = read("Dockerfile");
    assert.equal(/COPY[^\n]*(secrets|\.key|\.pem)/i.test(dockerfile), false);
    assert.equal(/ENV[^\n]*(KEY|SECRET)/i.test(dockerfile), false);
    const ignore = read(".dockerignore");
    for (const pattern of ["**/*.key", "**/*.pem", "secrets", ".env"]) {
      assert.ok(ignore.split("\n").includes(pattern), `.dockerignore lacks ${pattern}`);
    }
  });

  it("the production env example names the required recovery settings and no attestor or KMS", () => {
    const text = read("deploy/.env.example");
    for (const required of [
      /^RECOVERY_ENABLED=true$/m,
      /^RECOVERY_NETWORK=celo-mainnet$/m,
      /^RECOVERY_RELAYER_KEY_FILE=/m,
      /^RECOVERY_CHALLENGE_SECRET=/m,
      /^RECOVERY_TOTP_SECRET_KEY=/m,
      /^RECOVERY_TOTP_SECRET_KEY_VERSION=1$/m,
      /^RECOVERY_SMTP_HOST=/m,
      /^RECOVERY_SMTP_PORT=587$/m,
      /^RECOVERY_SMTP_USER=/m,
      /^RECOVERY_SMTP_PASSWORD_FILE=\/run\/secrets\/recovery-smtp-password$/m,
      /^RECOVERY_SMTP_SECURITY=starttls$/m,
      /^RECOVERY_EMAIL_FROM=Kaada Security <security@kaada\.xyz>$/m,
      /^RECOVERY_GAS_TOPUP_MAX_WEI=0$/m,
    ]) {
      assert.match(text, required);
    }
    for (const file of [
      "deploy/.env.example",
      ".env.example",
      "deploy/README.md",
      "deploy/compose.yml",
    ]) {
      assert.equal(/attestor|KMS_KEY|recovery-attestor/i.test(read(file)), false, file);
    }
  });

  it("the relayer role is described as a submitter with no authority, never as an attestor or guardian", () => {
    const text = read("deploy/.env.example") + read("deploy/README.md");
    assert.match(text, /does not have/i);
    assert.match(text, /cannot forge or cancel/i);
    assert.equal(/guardian/i.test(text), false);
  });
});
