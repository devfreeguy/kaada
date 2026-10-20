import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveRecoveryKey, generateRecoveryCode } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import type { Address } from "viem";

import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";

/*
 * When the bundler refuses the arming operation, the log says why (its JSON-RPC code, the AA code, its short message) at error level,
 * and never carries the signature the person's root produced. The person's answer does not change.
 */

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
