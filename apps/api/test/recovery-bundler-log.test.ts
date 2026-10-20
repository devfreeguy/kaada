import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { deriveRecoveryKey, generateRecoveryCode } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import type { Address } from "viem";

import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";

/*
 * When the bundler refuses the arming operation, the log says why (its JSON-RPC code, the AA code, its short message) at error level,
 * and never carries the signature the person's root produced. The person's answer does not change.
 */

async function armedAttemptShared() {
  const world = createRecoveryWorld();
  const user = await world.createUser({ armed: false, authenticator: true });
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  world.context.log = (level, event, fields) => {
    logs.push({ level, event, fields: fields ?? {} });
  };
  const verifier = deriveRecoveryKey(generateRecoveryCode(), {
    chainId: world.chain.chainId,
    account: user.account as Address,
  }).address;
  const arm = await world.configuration.prepare({
    userId: user.userId,
    recoveryAddress: verifier,
  });
  const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
  const material = world.rootSigns(root.credentialRef, arm.signing.challenge);
  return { world, user, arm, material, logs };
}

describe("a bundler refusing the arming operation", () => {
  async function armedAttempt() {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    world.context.log = (level, event, fields) => {
      logs.push({ level, event, fields: fields ?? {} });
    };
    const verifier = deriveRecoveryKey(generateRecoveryCode(), {
      chainId: world.chain.chainId,
      account: user.account as Address,
    }).address;
    const arm = await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier,
    });
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const material = world.rootSigns(root.credentialRef, arm.signing.challenge);
    return { world, user, arm, material, logs };
  }

  it("is logged with the bundler's own code and reason, and the answer stays BUNDLER_REJECTED", async () => {
    const { world, user, arm, material, logs } = await armedAttempt();
    world.chain.submitOperation = () =>
      Promise.reject(
        new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
          details: { rpc: "AA21 didn't pay prefund", rpcCode: -32500, aaCode: "AA21" },
        }),
      );
    await expectKaada(
      world.configuration.submit({
        userId: user.userId,
        configurationId: arm.configurationId,
        material,
      }),
      "BUNDLER_REJECTED",
    );
    const logged = logs.find((l) => l.event === "recovery.bundler_rejected");
    assert.ok(logged, "the refusal was logged");
    assert.equal(logged.level, "error");
    assert.equal(logged.fields["where"], "arming");
    assert.equal(logged.fields["rpcCode"], -32500);
    assert.equal(logged.fields["aaCode"], "AA21");
    assert.equal(logged.fields["rpc"], "AA21 didn't pay prefund");
  });

  it("never puts the signature, the operation or a key in the log", async () => {
    const { world, user, arm, material, logs } = await armedAttempt();
    const signature = world.chain.encodeRootSignature({ kind: "DEVICE_KEY", material });
    world.chain.submitOperation = () =>
      Promise.reject(
        new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
          details: { rpc: "AA24 signature error", rpcCode: -32500, aaCode: "AA24" },
        }),
      );
    await expectKaada(
      world.configuration.submit({
        userId: user.userId,
        configurationId: arm.configurationId,
        material,
      }),
      "BUNDLER_REJECTED",
    );
    const text = JSON.stringify(logs);
    assert.ok(text.includes("AA24"));
    assert.equal(text.includes(signature), false, "no signature");
    assert.equal(text.includes(JSON.stringify(material)), false, "no signing material");
    assert.equal(
      /callData|preparedOperation|userOpHash|"signature"|privateKey/i.test(text),
      false,
      text,
    );
  });

  it("other failures of the same call are not reported as a bundler refusal", async () => {
    const { world, user, arm, material, logs } = await armedAttempt();
    world.chain.submitOperation = () =>
      Promise.reject(new KaadaError("BUNDLER_UNAVAILABLE", "the bundler did not answer"));
    await expectKaada(
      world.configuration.submit({
        userId: user.userId,
        configurationId: arm.configurationId,
        material,
      }),
      "BUNDLER_UNAVAILABLE",
    );
    assert.equal(
      logs.some((l) => l.event === "recovery.bundler_rejected"),
      false,
    );
  });
});

// ── every BUNDLER_REJECTED leaves a line, whatever shape the error has ───────────────────────────

describe("every BUNDLER_REJECTED is logged, whatever shape it arrives in", () => {
  type Thrown = (signature: string) => unknown;

  async function submitting(thrown: Thrown) {
    const { world, user, arm, material, logs } = await armedAttemptShared();
    const signature = world.chain.encodeRootSignature({ kind: "DEVICE_KEY", material });
    world.chain.submitOperation = () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is to throw things of every shape
      return Promise.reject(thrown(signature));
    };
    const outcome = await world.configuration
      .submit({ userId: user.userId, configurationId: arm.configurationId, material })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const logged = logs.filter((l) => l.event === "recovery.bundler_rejected");
    return { outcome, logged, text: JSON.stringify(logs), signature };
  }

  const rejected = (details?: Record<string, unknown>, cause?: unknown) =>
    new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
      ...(details && { details }),
      ...(cause !== undefined && { cause }),
    });

  it("the reason in a cause: found", async () => {
    const r = await submitting(() => rejected({}, new Error("AA21 didn't pay prefund")));
    assert.equal(r.logged.length, 1);
    assert.equal(r.logged[0]?.fields["aaCode"], "AA21");
    assert.match(String(r.logged[0]?.fields["rpc"]), /prefund/);
  });

  it("the reason in a details field the chain adapter does not name rpc: found", async () => {
    const r = await submitting(() =>
      rejected({ rpcData: "AA24 signature error", rpcCode: -32500 }),
    );
    assert.equal(r.logged.length, 1);
    assert.equal(r.logged[0]?.fields["aaCode"], "AA24");
    assert.equal(r.logged[0]?.fields["rpcCode"], -32500);
  });

  it("a reason buried in a chain of causes (a viem-style error with details) is found", async () => {
    const inner = Object.assign(new Error("HTTP request failed"), {
      shortMessage: "RPC Request failed",
      details: "AA25 invalid account nonce",
    });
    const r = await submitting(() =>
      rejected(undefined, new Error("outer", { cause: new Error("mid", { cause: inner }) })),
    );
    assert.equal(r.logged.length, 1);
    assert.equal(r.logged[0]?.fields["aaCode"], "AA25");
  });

  it("an error with no reason anywhere is STILL logged, saying so and naming the error class", async () => {
    const r = await submitting(() => rejected());
    assert.equal(r.logged.length, 1, "the event can never be silent");
    assert.equal(r.logged[0]?.level, "error");
    assert.equal(r.logged[0]?.fields["errorClass"], "KaadaError");
    assert.equal(r.logged[0]?.fields["note"], "reason not available");
    assert.equal("aaCode" in (r.logged[0]?.fields ?? {}), false);
  });

  it("an error that only LOOKS like one (the same code, a different class) is logged too", async () => {
    const r = await submitting(() =>
      Object.assign(new Error("refused"), { code: "BUNDLER_REJECTED" }),
    );
    assert.equal(r.logged.length, 1);
    assert.equal(r.logged[0]?.fields["errorClass"], "Error");
  });

  it("hex in a nested reason is redacted, and no signature, key or operation is logged", async () => {
    const r = await submitting((signature) =>
      rejected({}, new Error(`AA24 signature error ${signature} callData 0x${"ef".repeat(100)}`)),
    );
    assert.equal(r.logged[0]?.fields["aaCode"], "AA24");
    assert.equal(r.text.includes(r.signature), false);
    assert.equal(r.text.includes("efef"), false);
    assert.match(r.text, /hex omitted/);
  });

  it("the person's answer is the same error as before in every case", async () => {
    for (const make of [() => rejected(), () => rejected({ rpc: "x" }, new Error("AA21"))]) {
      const r = await submitting(make);
      assert.ok(r.outcome instanceof KaadaError);
      assert.equal(r.outcome.code, "BUNDLER_REJECTED");
    }
  });
});

describe("the production wiring gives the recovery runtime a real logger", () => {
  it("passes `log` to createRecoveryRuntime, so no recovery event is swallowed by the default no-op", () => {
    const source = readFileSync(
      new URL("../src/recovery/recovery.module.ts", import.meta.url),
      "utf8",
    );
    const call = /createRecoveryRuntime\(\{([\s\S]*?)\n {8}\}\);/.exec(source)?.[1] ?? "";
    assert.match(call, /\blog:/, "createRecoveryRuntime is called without a logger");
  });
});
