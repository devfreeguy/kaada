import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAbiParameters } from "viem";

import { createMoney } from "@kaada/domain";
import type { PermissionScope } from "@kaada/domain";

import {
  createZeroDevKernelAdapter,
  encodePasskeyAssertion,
  policiesForScope,
} from "./zerodev-kernel-adapter.js";

/*
 * Offline checks of the parts of the adapter that need no network: the assertion encoding and the
 * on-chain restrictions built from a plan scope. Nothing here reaches a bundler or a chain.
 */

const addr = (byte: string) => `0x${byte.repeat(20)}`;
const scope: PermissionScope = {
  chainId: 42220,
  allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
  allowedContracts: [addr("11"), addr("44"), addr("22")],
  allowedAssetIds: ["a", "b"],
  perTransactionLimit: createMoney("92306281", "a"),
  payout: {
    assetId: "b",
    tokenAddress: addr("22"),
    recipient: addr("77"),
    limit: createMoney("500", "b"),
  },
  approval: { tokenAddress: addr("11"), spender: addr("33"), limit: createMoney("92200000", "a") },
  swapTarget: addr("44"),
  swapSelector: "0xa1b2c3d4",
  validFrom: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-01T00:15:00Z"),
};

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const der = (r: Buffer, s: Buffer) =>
  Buffer.concat([
    Buffer.from([0x30, 4 + r.length + s.length, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ]);

describe("passkey assertion encoding", () => {
  it("encodes authenticator data, client data, type location and r, s for the validator", () => {
    const r = Buffer.alloc(32, 1);
    const s = Buffer.alloc(32, 2);
    s[0] = 0x10; // a low s, so no normalization applies
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: "abc",
      origin: "https://x",
    });
    const encoded = encodePasskeyAssertion({
      id: "credential-0",
      response: {
        authenticatorData: b64url(Buffer.alloc(37, 5)),
        clientDataJSON: b64url(Buffer.from(clientData)),
        signature: b64url(der(r, s)),
      },
    });
    const [authData, json, typeLocation, outR, outS] = decodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
      ],
      encoded,
    );
    assert.equal(authData.length, 2 + 37 * 2);
    assert.equal(json, clientData);
    assert.ok(typeLocation > 0n);
    assert.equal(outR, BigInt(`0x${r.toString("hex")}`));
    assert.equal(outS, BigInt(`0x${s.toString("hex")}`));
  });

  it("refuses a malformed assertion", () => {
    assert.throws(() => encodePasskeyAssertion({ response: {} }));
    assert.throws(() => encodePasskeyAssertion(null));
  });
});

describe("permission policies", () => {
  it("builds one call policy and one timestamp policy from the scope", () => {
    const policies = policiesForScope(scope);
    assert.deepEqual(
      policies.map((p) => p.policyParams.type),
      ["call", "timestamp"],
    );
  });

  it("pins the approve spender, the transfer recipient and their ceilings in the call data", () => {
    const [call] = policiesForScope(scope);
    const data = call?.getPolicyData().toLowerCase() ?? "";
    for (const needle of [
      "095ea7b3", // approve
      "a9059cbb", // transfer
      "33".repeat(20), // the approve spender
      "77".repeat(20), // the payout recipient
      "44".repeat(20), // the swap target
      "a1b2c3d4", // the one selector allowed on it (an omitted selector is NOT a wildcard)
    ]) {
      assert.ok(data.includes(needle), needle);
    }
  });

  it("omits the approval rule when no approval is needed", () => {
    const { approval: _approval, ...without } = scope;
    const [call] = policiesForScope(without);
    assert.equal(call?.getPolicyData().toLowerCase().includes("095ea7b3"), false);
  });
});

describe("the adapter object", () => {
  it("has no method that signs bytes, a transaction or an arbitrary user operation", () => {
    const adapter = createZeroDevKernelAdapter({ bundlerUrl: "https://bundler.invalid" });
    assert.deepEqual(Object.keys(adapter).sort(), [
      "getTransactionReceipt",
      "getUserOperationReceipt",
      "isDeployed",
      "isPermissionInstalled",
      "nativeBalance",
      "prepareRootOperation",
      "sendDelegatedCalls",
      "sendRootOperation",
    ]);
  });
});
