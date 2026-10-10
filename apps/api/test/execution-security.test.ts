import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Source-level guards for Build 12: a firm quote is requested only through one guarded path, the claim
 * token is a secret everywhere it appears, and nothing in the codebase can sign, broadcast, deploy,
 * approve or submit an order. These read the code (comments removed) and fail if that changes.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = (relative: string) => join(root, relative);

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if ([".next", "node_modules", "dist", "generated"].includes(name)) return [];
    if (statSync(full).isDirectory()) return files(full);
    return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts")
      ? [full]
      : [];
  });
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const production = [
  ...files(dir("apps/api/src")),
  ...files(dir("packages/domain/src")),
  ...files(dir("packages/blockchain/src")),
  ...files(dir("apps/web/app")),
];

describe("execution security review (source scan)", () => {
  it("scans a meaningful amount of code", () => {
    assert.ok(production.length >= 150, String(production.length));
  });

  it("has no path to submit, broadcast, sign or deploy anything", () => {
    const forbidden =
      /\/v2\/rfq\/submit|\/v2\/rfq\/cancel|eth_sendRawTransaction|eth_sendUserOperation|eth_sendTransaction|sendRawTransaction|sendUserOperation|sendTransaction|writeContract|signTransaction|signMessage|signTypedData|signUserOperation|privateKey|mnemonic|seedPhrase|secretKey/;
    for (const path of production) {
      const text = code(path);
      if (path.endsWith("logger.ts")) continue; // the redaction list names key material to hide it
      assert.equal(forbidden.test(text), false, path);
    }
  });

  it("the Textile client can only price: preview and firm request, with no submit or cancel method", () => {
    const client = code(join(dir("apps/api/src/infrastructure/fx/textile"), "client.ts"));
    const paths = [...client.matchAll(/"(\/v2\/[a-z/]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(paths)].sort(), ["/v2/rfq/preview", "/v2/rfq/request"]);
    assert.equal(/\b(submit|cancel)\w*\(/i.test(client), false);
    // A firm request is never retried.
    assert.ok(/firmResponseSchema,\s*timeoutMs,\s*0,/.test(client));
  });

  it("only the firm quote service calls the firm provider, and only after an authorization", () => {
    const callers = production.filter((path) => /requestFirm\(/.test(code(path)));
    const names = callers.map((path) => path.split(/[\\/]/).slice(-1)[0]).sort();
    assert.deepEqual(names, [
      "client.ts",
      "firm-quote-service.ts",
      "firm-quote.ts",
      "textile-firm-provider.ts",
    ]);
    const service = code(join(dir("apps/api/src/core/execution"), "firm-quote-service.ts"));
    assert.ok(/authorization/.test(service) && /claim\(/.test(service));
    // Routing, the agent and the channel layer never touch it.
    for (const folder of [
      "apps/api/src/core/routing",
      "apps/api/src/core/agent",
      "apps/api/src/core/intents",
    ]) {
      for (const path of files(dir(folder))) {
        assert.equal(/FirmQuote|requestFirm|ExecutionPreparation/.test(code(path)), false, path);
      }
    }
  });

  it("reveals the claim token in exactly one place, to encrypt it", () => {
    const reveals = production.filter((path) => /\.reveal\(\)/.test(code(path)));
    assert.deepEqual(
      reveals.map((path) => path.split(/[\\/]/).slice(-1)[0]),
      ["firm-quote-service.ts"],
    );
    const service = code(join(dir("apps/api/src/core/execution"), "firm-quote-service.ts"));
    assert.ok(/cipher\.encrypt\(\s*result\.claimToken\.reveal\(\)/.test(service));
  });

  it("every mention of claimToken is the schema, the wrapper or the encryption step", () => {
    const allowed = new Set([
      "schemas.ts",
      "textile-firm-provider.ts",
      "firm-quote-service.ts",
      "firm-quote.ts",
      // These carry only the boolean `claimTokenStored`, never the token.
      "plan.ts",
      "plan-builder.ts",
      "preparation-service.ts",
    ]);
    for (const path of production) {
      const name = path.split(/[\\/]/).slice(-1)[0] ?? "";
      if (/claimToken/.test(code(path))) {
        assert.ok(allowed.has(name), `unexpected claimToken in ${path}`);
      }
    }
    // The database stores ciphertext only: there is no token column.
    const schema = readFileSync(join(dir("packages/database/prisma"), "schema.prisma"), "utf8");
    assert.equal(/claimToken/i.test(schema), false);
  });

  it("never logs or audits amounts, calldata or secrets from the firm path", () => {
    for (const name of ["firm-quote-service.ts", "preparation-service.ts"]) {
      const text = code(join(dir("apps/api/src/core/execution"), name));
      for (const call of text.match(/this\.log\([\s\S]*?\);/g) ?? []) {
        assert.equal(/token|secret|calldata|data:|signature|amount/i.test(call), false, call);
      }
      for (const call of text.match(/audit\.append\([\s\S]*?\}\);/g) ?? []) {
        assert.equal(/claim|secret|calldata|signature|amount/i.test(call), false, call);
      }
    }
    const provider = code(
      join(dir("apps/api/src/infrastructure/fx/textile"), "textile-firm-provider.ts"),
    );
    for (const call of provider.match(/this\.log\([\s\S]*?\);/g) ?? []) {
      assert.equal(
        /claim|token|signature|encodedOrder|data\.(quote|transactions)/i.test(call),
        false,
        call,
      );
    }
  });

  it("the execution code never consumes an authorization and never changes its bounds", () => {
    for (const path of files(dir("apps/api/src/core/execution"))) {
      const text = code(path);
      assert.equal(
        /\.consume\(|validateAndConsume|paymentAuthorizations\.(create|revoke)/.test(text),
        false,
        path,
      );
    }
  });

  it("the unlimited-approval and chain checks exist and read the calldata", () => {
    const inspector = code(join(dir("apps/api/src/core/execution"), "approval-inspector.ts"));
    for (const needle of [
      "APPROVAL_UNLIMITED",
      "0x095ea7b3",
      "APPROVAL_TARGET_MISMATCH",
      "TRANSACTION_CHAIN_MISMATCH",
    ]) {
      assert.ok(inspector.includes(needle), needle);
    }
  });

  it("the read-only chain adapters have no write method", () => {
    const text = code(join(dir("packages/blockchain/src/wallet"), "allowance-reader.ts"));
    assert.equal(
      /walletClient|createWalletClient|writeContract|sendTransaction|account:/.test(text),
      false,
    );
    assert.ok(/readContract/.test(text) && /getCode/.test(text));
  });

  it("the signer stays disabled", () => {
    const signer = code(join(dir("packages/blockchain/src/wallet"), "disabled-signer.ts"));
    assert.ok(/EXECUTION_NOT_ENABLED/.test(signer));
  });

  it("the page tells the truth: no claim that anything was sent, paid or received", () => {
    const preparation = code(join(dir("apps/api/src/core/execution"), "preparation-service.ts"));
    const messages = [...preparation.matchAll(/return "([^"]+)";/g)].map((m) => m[1] ?? "");
    assert.ok(messages.length >= 8);
    for (const message of messages) {
      const claim = message.replace(/Nothing was sent\./g, "");
      assert.equal(
        /\b(was sent|has been sent|paid|completed|received|delivered)\b/i.test(claim),
        false,
        message,
      );
    }
    const page = code(join(dir("apps/web/app/authorize/[token]"), "authorize-flow.tsx"));
    assert.ok(/Nothing has been sent yet/.test(page));
  });
});
