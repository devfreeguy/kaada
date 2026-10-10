import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/*
 * Source-level guards for the wallet boundary. They read the code (comments removed) and fail if a
 * signing primitive, a key-material name, or an email path appears where it must not.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "generated") return [];
    return statSync(path).isDirectory()
      ? files(path)
      : name.endsWith(".ts") && !name.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const dir = (relative: string) => join(root, relative);

/** Everything that implements or stores wallet state. */
const walletSources = [
  ...files(dir("packages/domain/src/wallets")),
  ...files(dir("packages/blockchain/src")),
  ...files(dir("apps/api/src/core/wallets")),
  ...files(dir("apps/api/src/infrastructure/wallet")),
  ...files(dir("apps/api/src/wallet")),
  join(dir("packages/database/src/repositories"), "wallets.ts"),
  join(dir("packages/database/src/mappers"), "wallet.ts"),
];

describe("wallet security review (source scan)", () => {
  it("scans a meaningful amount of code", () => {
    assert.ok(walletSources.length >= 20, String(walletSources.length));
  });

  it("contains no private key, mnemonic, seed or secret-key handling", () => {
    const forbidden =
      /\b(privateKey|mnemonic|seedPhrase|secretKey|privateKeyToAccount|generatePrivateKey|mnemonicToAccount|signMessage|signTransaction|signTypedData|signUserOperation|sendTransaction|writeContract)\b/;
    for (const path of walletSources) {
      assert.equal(forbidden.test(code(path)), false, path);
    }
  });

  it("defines no arbitrary signing function: the only signer entry point is signValidatedExecution", () => {
    const ports = code(join(dir("packages/domain/src/wallets"), "ports.ts"));
    const signerBlock = /interface ExecutionSigner \{([\s\S]*?)\n\}/.exec(ports)?.[1] ?? "";
    const methods = [...signerBlock.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]);
    assert.deepEqual(methods, ["signValidatedExecution"]);
    for (const path of walletSources) {
      assert.equal(
        /\bsign\s*\(|\bsign\s*:\s*\(/.test(code(path)),
        false,
        `${path} defines or calls a raw sign()`,
      );
    }
  });

  it("stores no secret-like column in the wallet tables", () => {
    const schema = readFileSync(join(dir("packages/database/prisma"), "schema.prisma"), "utf8");
    for (const model of [
      "Wallet",
      "PasskeyCredential",
      "PasskeyChallenge",
      "DelegatedPermission",
    ]) {
      const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
      assert.ok(body.length > 0, model);
      const columns = [...body.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1] ?? "");
      for (const column of columns) {
        assert.equal(
          /private|mnemonic|seed|secret|encrypted|pin|password|cipher|wrapped/i.test(column),
          false,
          `${model}.${column}`,
        );
      }
    }
  });

  it("keeps wallet code free of email, OTP and PIN paths: recovery by email cannot authorise spending", () => {
    for (const path of walletSources) {
      assert.equal(
        /\b(email|otp|oneTimePassword|sendMail|nodemailer|pin|totp)\b/i.test(code(path)),
        false,
        path,
      );
    }
  });

  it("does no Number-based money conversion in wallet code", () => {
    const forbidden = [
      /\bparseFloat\b/,
      /\bNumber\s*\(/,
      /\bMath\.(round|floor|ceil|trunc)\b/,
      /\btoFixed\b/,
    ];
    for (const path of walletSources.filter((p) => !p.includes("simplewebauthn-verifier"))) {
      for (const pattern of forbidden)
        assert.equal(pattern.test(code(path)), false, `${path} ${String(pattern)}`);
    }
  });
});

describe("the agent cannot reach a signer", () => {
  const agentSources = [
    ...files(dir("apps/api/src/core/agent")),
    ...files(dir("apps/api/src/core/intents")),
    ...files(dir("apps/api/src/core/conversations")),
    ...files(dir("apps/api/src/core/responses")),
    ...files(dir("apps/api/src/core/routing")),
    ...files(dir("apps/api/src/core/assets")),
    ...files(dir("apps/api/src/core/recipients")),
  ];

  it("imports no wallet, signer, key or chain package", () => {
    assert.ok(agentSources.length >= 15);
    for (const path of agentSources) {
      const text = code(path);
      assert.equal(
        /@kaada\/blockchain|core\/wallets|\.\.\/wallets|wallets\/|ExecutionSigner|PasskeyService|WalletService|viem|@zerodev/.test(
          text,
        ),
        false,
        path,
      );
      assert.equal(
        /privateKey|mnemonic|signMessage|signTransaction|sessionKey/i.test(text),
        false,
        path,
      );
    }
  });

  it("AgentService takes no wallet or signer dependency", () => {
    const service = code(join(dir("apps/api/src/core/agent"), "agent-service.ts"));
    const deps = /interface AgentServiceDeps \{([\s\S]*?)\n\}/.exec(service)?.[1] ?? "";
    assert.ok(deps.length > 0);
    assert.equal(/wallet|signer|key|passkey|permission/i.test(deps), false, deps);
  });
});
