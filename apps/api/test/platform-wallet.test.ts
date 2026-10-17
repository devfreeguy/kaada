import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createPlatformWallet } from "../src/platform/platform.module.js";

/*
 * Kaada's platform / agent wallet at the application edge: built at startup from a key FILE and checked against the public address,
 * never reachable by a client, never part of a user's payment path.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kaada-platform-api-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (content: string) => {
  const path = join(dir, `p${n++}.key`);
  writeFileSync(path, content, { mode: 0o400 });
  return path;
};
const configFor = (keyFile: string, address: string) =>
  ({ platformWallet: { keyFile, address }, wallet: { rpcUrl: "http://127.0.0.1:1" } }) as never;

describe("platform wallet startup", () => {
  it("no platform wallet configured (development) gives none; it never invents one", () => {
    assert.equal(
      createPlatformWallet({ wallet: { rpcUrl: "x" } } as never, () => undefined),
      null,
    );
  });

  it("a valid key file with the matching address starts, logging only the public address", () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const lines: string[] = [];
    const wallet = createPlatformWallet(configFor(file(key), address.toLowerCase()), (m) =>
      lines.push(m),
    );
    assert.equal(wallet?.address, address);
    assert.deepEqual(lines, [`platform wallet ${address}`]);
    assert.equal(lines.join("\n").includes(key.slice(2)), false);
  });

  it("a mismatching address, a missing file and a malformed key each stop startup, with no key in the error", () => {
    const key = generatePrivateKey();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const logged: string[] = [];
    const failures: Error[] = [];
    for (const config of [
      configFor(file(key), other),
      configFor(join(dir, "absent.key"), other),
      configFor(file("0xnot-a-key-secret-looking-0123456789"), other),
      configFor(file(`0x${"ab".repeat(31)}`), other),
    ]) {
      try {
        createPlatformWallet(config, (m) => logged.push(m));
        assert.fail("expected startup to fail");
      } catch (error) {
        failures.push(error as Error);
      }
    }
    assert.equal(failures.length, 4);
    for (const error of failures) {
      assert.equal(error.message.includes(key.slice(2)), false);
      assert.equal(error.message.includes("secret-looking"), false);
    }
    assert.deepEqual(logged, []);
  });
});

describe("the platform wallet stays server-side and out of user payments", () => {
  const SKIP = /node_modules|[\\/]dist[\\/]|[\\/]\.next[\\/]|[\\/]\.turbo[\\/]|[\\/]generated[\\/]/;
  function walk(path: string, out: string[] = []): string[] {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (SKIP.test(full)) continue;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mjs|js|json)$/.test(full) && !/\.test\./.test(full)) out.push(full);
    }
    return out;
  }
  const mentions = (files: string[], pattern: RegExp) =>
    files
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replaceAll("\\", "/"));
  const TOUCHES = /PlatformWallet|PLATFORM_WALLET|platform-wallet|platform\.tokens/;

  it("nothing on the web side reads or exposes it", () => {
    assert.deepEqual(
      mentions(walk(join(root, "apps/web")), /PLATFORM_WALLET|platform-agent|PlatformWallet/),
      [],
    );
  });

  it("no controller or HTTP schema returns or accepts it", () => {
    const http = walk(join(root, "apps/api/src")).filter((f) => /controller|\.schema\./.test(f));
    assert.deepEqual(mentions(http, TOUCHES), []);
  });

  it("only the platform module touches it in the API", () => {
    assert.deepEqual(mentions(walk(join(root, "apps/api/src")), TOUCHES).sort(), [
      "apps/api/src/platform/platform.module.ts",
      "apps/api/src/platform/platform.tokens.ts",
    ]);
  });

  it("normal user execution, wallets, authorization and recovery never use the platform wallet", () => {
    const paths = [
      "apps/api/src/execution",
      "apps/api/src/core/execution",
      "apps/api/src/core/wallets",
      "apps/api/src/wallet",
      "apps/api/src/authorization",
      "apps/api/src/core/authorization",
      "apps/api/src/recovery",
      "apps/api/src/core/recovery",
      "packages/blockchain/src/execution",
      "packages/blockchain/src/wallet",
      "packages/blockchain/src/recovery",
    ].flatMap((p) => walk(join(root, p)));
    assert.ok(paths.length > 20);
    assert.deepEqual(mentions(paths, TOUCHES), []);
  });

  it("the key is mounted read-only as one file, kept out of git and the image, and the config carries no private key", () => {
    const compose = readFileSync(join(root, "deploy/compose.yml"), "utf8");
    assert.match(
      compose,
      /^\s*-\s*\/opt\/apps\/kaada\/secrets\/platform-agent\.key:\/run\/secrets\/platform-agent.key:ro\s*$/m,
    );
    assert.equal(/\/opt\/apps\/kaada\/secrets:/.test(compose), false);
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    for (const pattern of ["*.key", "*.pem", "secrets/"])
      assert.ok(gitignore.includes(pattern), pattern);
    const example = readFileSync(join(root, "deploy/.env.example"), "utf8");
    assert.match(example, /^PLATFORM_WALLET_KEY_FILE=\/run\/secrets\/platform-agent.key$/m);
    assert.match(example, /^PLATFORM_WALLET_ADDRESS=/m);
    assert.equal(/PLATFORM_WALLET_(PRIVATE|SECRET)/.test(example + compose), false);
  });
});
