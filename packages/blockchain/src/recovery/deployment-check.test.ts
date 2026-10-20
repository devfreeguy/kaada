import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak256 } from "viem";
import type { Hex } from "viem";

import { DeploymentReadError, checkRecoveryDeployment } from "./deployment-check.js";
import type {
  DeploymentGetter,
  DeploymentReader,
  ExpectedRecoveryDeployment,
} from "./deployment-check.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const expected: ExpectedRecoveryDeployment = {
  validator: a(1),
  relayer: a(2),
  minDelaySeconds: 86_400,
  passkeyFactory: a(3),
  passkeyImplementation: a(4),
  deviceFactory: a(5),
  deviceImplementation: a(6),
};
const deviceCode: Hex = "0x6001600155";
const passkeyCode: Hex = "0x63";

/** A chain where everything matches `expected`, with a way to change single answers. */
function world(
  change: {
    code?: Record<string, Hex | undefined>;
    answers?: Record<string, string>;
    fail?: (address: string, fn: DeploymentGetter) => Error | undefined;
  } = {},
): DeploymentReader {
  const code: Record<string, Hex | undefined> = {
    [expected.validator]: "0x60",
    [expected.passkeyFactory]: "0x61",
    [expected.deviceFactory]: "0x62",
    [expected.deviceImplementation]: deviceCode,
    [expected.passkeyImplementation]: passkeyCode,
    ...change.code,
  };
  const answers: Record<string, string> = {
    [`${expected.validator}.RELAYER`]: expected.relayer,
    [`${expected.validator}.minDelay`]: "86400",
    [`${expected.passkeyFactory}.IMPLEMENTATION`]: expected.passkeyImplementation,
    [`${expected.passkeyFactory}.IMPLEMENTATION_CODEHASH`]: keccak256(passkeyCode),
    [`${expected.deviceFactory}.IMPLEMENTATION`]: expected.deviceImplementation,
    [`${expected.deviceFactory}.IMPLEMENTATION_CODEHASH`]: keccak256(deviceCode),
    ...change.answers,
  };
  return {
    getCode: (address) => {
      const found = Object.entries(code).find(([k]) => k.toLowerCase() === address.toLowerCase());
      return Promise.resolve(found?.[1]);
    },
    read: (address, fn) => {
      const failure = change.fail?.(address, fn);
      if (failure) return Promise.reject(failure);
      const found = Object.entries(answers).find(
        ([k]) => k.toLowerCase() === `${address}.${fn}`.toLowerCase(),
      );
      if (!found) return Promise.reject(new DeploymentReadError(`no ${fn}`));
      return Promise.resolve(found[1]);
    },
  };
}

const check = (reader: DeploymentReader) =>
  checkRecoveryDeployment(reader, expected, keccak256(passkeyCode));
const withPasskeyCode = world;

describe("checkRecoveryDeployment", () => {
  it("is OK when every value matches, whatever the case of the addresses", async () => {
    assert.deepEqual(await check(world()), { status: "OK" });
    const upper = world({
      answers: {
        [`${expected.validator}.RELAYER`]: expected.relayer
          .replace("0x", "0x")
          .toUpperCase()
          .replace("0X", "0x"),
      },
    });
    assert.deepEqual(await check(upper), { status: "OK" });
  });

  it("a passkey implementation whose code is not the pinned one is a mismatch naming both hashes", async () => {
    const result = await checkRecoveryDeployment(world(), expected);
    assert.ok(
      result.status === "MISMATCH" &&
        result.problems.some(
          (p) =>
            p.startsWith("passkey implementation code hash") && p.includes(keccak256(passkeyCode)),
        ),
    );
  });

  it("missing code at the passkey implementation is a mismatch", async () => {
    const result = await check(world({ code: { [expected.passkeyImplementation]: undefined } }));
    assert.ok(
      result.status === "MISMATCH" &&
        result.problems.some((p) => p.startsWith("passkey implementation: no contract code")),
    );
  });

  it("a wrong relayer names the value on chain and the value expected", async () => {
    const result = await check(
      withPasskeyCode({ answers: { [`${expected.validator}.RELAYER`]: a(99) } }),
    );
    assert.ok(
      result.status === "MISMATCH" &&
        result.problems.some(
          (p) => p.includes("RELAYER()") && p.includes(a(99)) && p.includes(expected.relayer),
        ),
    );
  });

  it("a different minimum delay is a mismatch naming both", async () => {
    const result = await check(
      withPasskeyCode({ answers: { [`${expected.validator}.minDelay`]: "60" } }),
    );
    assert.ok(
      result.status === "MISMATCH" &&
        result.problems.some(
          (p) => p.includes("minDelay()") && p.includes("60") && p.includes("86400"),
        ),
    );
  });

  it("a factory pointing at another implementation, or recording another code hash, is a mismatch", async () => {
    const result = await check(
      withPasskeyCode({
        answers: {
          [`${expected.deviceFactory}.IMPLEMENTATION`]: a(77),
          [`${expected.deviceFactory}.IMPLEMENTATION_CODEHASH`]: keccak256("0x00"),
        },
      }),
    );
    assert.ok(
      result.status === "MISMATCH" &&
        result.problems.some(
          (p) => p.includes("device-key factory IMPLEMENTATION()") && p.includes(a(77)),
        ) &&
        result.problems.some(
          (p) =>
            p.includes("device-key factory IMPLEMENTATION_CODEHASH()") &&
            p.includes(keccak256(deviceCode)),
        ),
    );
  });

  it("no code at the validator is a mismatch, and a contract that does not answer is one too", async () => {
    const none = await check(withPasskeyCode({ code: { [expected.validator]: undefined } }));
    assert.ok(
      none.status === "MISMATCH" && none.problems.some((p) => p.includes("no contract code")),
    );
    const silent = await check(
      withPasskeyCode({
        fail: (_, fn) => (fn === "RELAYER" ? new DeploymentReadError("reverted") : undefined),
      }),
    );
    assert.ok(
      silent.status === "MISMATCH" && silent.problems.some((p) => p.includes("gave no answer")),
    );
  });

  it("an unreachable chain is UNAVAILABLE, never a mismatch", async () => {
    const result = await check(withPasskeyCode({ fail: () => new Error("fetch failed") }));
    assert.deepEqual(result, { status: "UNAVAILABLE", reason: "fetch failed" });
  });
});
