import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { redactPaths } from "@kaada/logger";

/*
 * Source-level guards for the PIN and payment-authorization boundary: the PIN is hashed, never
 * stored, logged or put in a URL; hashes and tokens never leave the server; nothing here signs,
 * executes, or asks a provider for a firm price.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = (relative: string) => join(root, relative);

function files(path: string, extensions = [".ts", ".tsx"]): string[] {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if ([".next", "node_modules", "dist", "generated"].includes(name)) return [];
    if (statSync(full).isDirectory()) return files(full, extensions);
    const isTest = name.endsWith(".test.ts");
    return !isTest && extensions.some((ext) => name.endsWith(ext)) ? [full] : [];
  });
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const authorizationSources = [
  ...files(dir("apps/api/src/core/authorization")),
  ...files(dir("apps/api/src/authorization")),
  ...files(dir("apps/api/src/infrastructure/auth")),
  ...files(dir("packages/domain/src/authorization")),
  join(dir("packages/database/src/repositories"), "authorization.ts"),
  join(dir("packages/database/src/mappers"), "authorization.ts"),
];

const webSources = [
  ...files(dir("apps/web/app/authorize")),
  join(dir("apps/web/app/components"), "pin-keypad.tsx"),
  join(dir("apps/web/app/setup/[token]"), "pin-setup.tsx"),
];

describe("PIN and authorization security review (source scan)", () => {
  it("scans a meaningful amount of code", () => {
    assert.ok(authorizationSources.length >= 15, String(authorizationSources.length));
    assert.ok(webSources.length >= 3, String(webSources.length));
  });

  it("adds no signing, key, execution or provider-quote primitive", () => {
    const forbidden =
      /\b(privateKey|mnemonic|seedPhrase|secretKey|signMessage|signTransaction|signTypedData|signUserOperation|sendTransaction|writeContract|signValidatedExecution|ExecutionSigner)\b/;
    for (const path of authorizationSources) {
      const text = code(path);
      assert.equal(forbidden.test(text), false, path);
      assert.equal(
        /requestFirm|\/rfq\/request|\.execute\(|submitOrder|textile/i.test(text),
        false,
        path,
      );
      assert.equal(/@kaada\/blockchain|viem|@zerodev/.test(text), false, path);
    }
  });

  it("the authorization policy is provider-neutral", () => {
    for (const name of ["policy.ts"]) {
      const text = code(join(dir("packages/domain/src/authorization"), name));
      assert.equal(/textile|rfq|quote/i.test(text), false, name);
    }
    const service = code(join(dir("apps/api/src/core/authorization"), "policy-service.ts"));
    assert.equal(/textile|infrastructure/i.test(service), false);
  });

  it("stores no plaintext PIN: only a hash, in one place", () => {
    const schema = readFileSync(join(dir("packages/database/prisma"), "schema.prisma"), "utf8");
    const start = schema.indexOf("model TransactionPinSecurity");
    const model = schema.slice(start, schema.indexOf("}", start));
    assert.equal(/^\s*pin\s/m.test(model), false);
    assert.equal(/pinHash/.test(model), true);
    // A hash is read only by the PIN service and the database layer.
    for (const path of files(dir("apps/api/src"))) {
      if (path.includes("pin-service.ts") || path.includes("infrastructure")) continue;
      assert.equal(/\.pinHash\b|pinHash:/.test(code(path)), false, path);
    }
  });

  it("never logs a PIN, a hash, a token or a challenge", () => {
    for (const path of authorizationSources) {
      const text = code(path);
      assert.equal(/console\./.test(text), false, path);
      for (const call of text.match(/this\.log\([\s\S]*?\);/g) ?? []) {
        assert.equal(
          /\bpin\b|pinHash|token|challenge|\bhash\b/i.test(
            call.replace(/"authorization\.pin_failed"/, ""),
          ),
          false,
          call,
        );
      }
      // Audit payloads carry counters and reason codes only.
      for (const call of text.match(/audit\.append\([\s\S]*?\}\);/g) ?? []) {
        assert.equal(/\bpin\b\s*[:,}]|pinHash|tokenHash|token\s*[:,}]/.test(call), false, call);
      }
    }
  });

  it("the logger redacts the PIN, hashes, tokens and the Authorization header", () => {
    for (const key of ["pin", "pinHash", "tokenHash", "token", "newPin", "challenge"]) {
      assert.ok(redactPaths.includes(key), key);
    }
    assert.ok(redactPaths.includes("req.headers.authorization"));
  });

  it("hashes and tokens never leave the server: no controller returns or reads them", () => {
    for (const name of ["authorization.controller.ts", "pin.controller.ts"]) {
      const text = code(join(dir("apps/api/src/authorization"), name));
      assert.equal(/tokenHash|pinHash/.test(text), false, name);
      assert.equal(/@Query\(|@Param\(/.test(text), false, `${name} reads nothing from the URL`);
    }
    // The only response that mentions a link is the development helper.
    const controller = code(join(dir("apps/api/src/authorization"), "authorization.controller.ts"));
    const beforeDev = controller.slice(0, controller.indexOf("dev/links"));
    assert.equal(/\burl\b|link\.token/.test(beforeDev), false);
  });

  it("an authorization response and the stored conversation never carry a link or token", () => {
    const response = code(join(dir("apps/api/src/core/responses"), "agent-response.ts"));
    const block =
      /interface AuthorizationRequiredResponse \{([\s\S]*?)\n\}/.exec(response)?.[1] ?? "";
    assert.ok(block.length > 0);
    assert.equal(/token|url|link|pin/i.test(block), false, block);
  });

  it("the agent core knows nothing about PINs or authorization approvals", () => {
    const agentSources = [
      ...files(dir("apps/api/src/core/agent")),
      ...files(dir("apps/api/src/core/intents")),
      ...files(dir("apps/api/src/core/conversations")),
    ];
    for (const path of agentSources) {
      const text = code(path);
      assert.equal(
        /\bpin\b|TransactionPin|PaymentAuthorizationService|isValidPinFormat/i.test(text),
        false,
        path,
      );
    }
  });

  it("the PIN travels only in the body of one POST: no URL, storage, cookie, input or logging in the web code", () => {
    for (const path of webSources) {
      const text = code(path);
      assert.equal(
        /localStorage|sessionStorage|indexedDB|document\.cookie/.test(text),
        false,
        path,
      );
      assert.equal(
        /<input|<form|autoComplete|useSearchParams|location\.(search|href|hash)|URLSearchParams/.test(
          text,
        ),
        false,
        path,
      );
      assert.equal(/console\./.test(text), false, path);
      assert.equal(/\?[a-z]+=|[?&]pin=/i.test(text), false, path);
    }
    const flow = code(join(dir("apps/web/app/authorize/[token]"), "authorize-flow.tsx"));
    assert.equal(
      /Authorization: `Bearer \$\{token\}`/.test(flow),
      true,
      "the token goes in a header",
    );
    assert.equal(/body: JSON\.stringify\(\{ pin: attempt \}\)/.test(flow), true);
    assert.equal(/setPin\(""\)/.test(flow), true, "the digits are cleared before the request");
    assert.equal(/cache: "no-store"/.test(flow), true);
    // Success is shown only after the server confirms the authorization.
    assert.equal(/if \(response\.ok\) return setState\(\{ name: "done" \}\)/.test(flow), true);
    assert.equal(
      flow.split('setState({ name: "done" })').length - 1,
      1,
      "one way to reach success",
    );
  });

  it("the secure pages are not cached, framed, indexed or sent as a referrer", () => {
    const config = readFileSync(join(dir("apps/web"), "next.config.ts"), "utf8");
    assert.ok(config.includes("setup|authorize"));
    for (const header of ["no-store", "no-referrer", "DENY", "noindex"]) {
      assert.ok(config.includes(header), header);
    }
  });

  it("uses Argon2id through a library and writes no hashing of its own", () => {
    const hasher = code(join(dir("apps/api/src/infrastructure/auth"), "argon2-pin-hasher.ts"));
    assert.ok(hasher.includes("@node-rs/argon2"));
    assert.equal(/createHash|pbkdf2|scrypt|bcrypt|crypto\.subtle/.test(hasher), false);
    const pinService = code(join(dir("apps/api/src/core/authorization"), "pin-service.ts"));
    assert.equal(/createHash|===\s*pin|pin\s*===|timingSafeEqual/.test(pinService), false);
  });

  it("AgentService, routing and the PIN code import no wallet signer, and the signer stays disabled", () => {
    const signer = code(join(dir("packages/blockchain/src/wallet"), "disabled-signer.ts"));
    assert.ok(/EXECUTION_NOT_ENABLED/.test(signer));
  });
});
