import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";

import { SoftDeviceKey } from "./testing/device-key.js";
import { SoftPasskey } from "./testing/passkey.js";
import { World, batch } from "./testing/recovery-world.js";
import { recoveryCommitment } from "./recovery.js";
import {
  base64urlToBytes,
  buildRecoveryRoot,
  newRootInstallData,
  recoveryBatchCallData,
  recoveryCommitmentHash,
  recoveryDeploymentSalt,
  toFactoryCredential,
} from "./recovery-root.js";
import type { NewRootCredential, ValidatorDeployments } from "./recovery-root.js";

const deployments: ValidatorDeployments = {
  passkey: {
    factory: "0x1000000000000000000000000000000000000f01",
    implementation: "0x1000000000000000000000000000000000000a01",
  },
  device: {
    factory: "0x1000000000000000000000000000000000000f02",
    implementation: "0x1000000000000000000000000000000000000a02",
  },
};
const ACCOUNT: Address = "0x2222222222222222222222222222222222222222";

const passkeyCredential = (): NewRootCredential => {
  const key = new SoftPasskey();
  const id = Buffer.from(key.credentialId).toString("base64url");
  return {
    kind: "PASSKEY",
    credentialId: id,
    publicKeyX: key.credential.x.toString(16).padStart(64, "0"),
    publicKeyY: key.credential.y.toString(16).padStart(64, "0"),
  };
};
const deviceCredential = (): NewRootCredential => {
  const key = new SoftDeviceKey();
  return {
    kind: "DEVICE_KEY",
    keyId: key.keyId,
    publicKeyX: key.point.x.toString(16).padStart(64, "0"),
    publicKeyY: key.point.y.toString(16).padStart(64, "0"),
  };
};

test("base64url decoding matches Buffer (so the browser and the server agree)", () => {
  for (let i = 0; i < 50; i++) {
    const bytes = new Uint8Array(1 + i).map((_, j) => (j * 31 + i) & 0xff);
    const text = Buffer.from(bytes).toString("base64url");
    assert.deepEqual(Buffer.from(base64urlToBytes(text)), Buffer.from(bytes));
  }
});

test("the passkey credential id hash is keccak256 of the credential id bytes", () => {
  const credential = passkeyCredential();
  assert.equal(credential.kind, "PASSKEY");
  if (credential.kind !== "PASSKEY") return;
  const factory = toFactoryCredential(credential);
  assert.equal(
    factory.authenticatorIdHash,
    keccak256(toHex(Buffer.from(credential.credentialId, "base64url"))),
  );
});

test("a rebuilt recovery root is deterministic and bound to the kind, account, credential and salt", () => {
  const salt = recoveryDeploymentSalt("attempt-1");
  for (const credential of [passkeyCredential(), deviceCredential()]) {
    const a = buildRecoveryRoot({
      deployments,
      account: ACCOUNT,
      credential,
      deploymentSalt: salt,
    });
    const b = buildRecoveryRoot({
      deployments,
      account: ACCOUNT,
      credential,
      deploymentSalt: salt,
    });
    assert.deepEqual(a, b);
    assert.equal(a.root.hook, "0x0000000000000000000000000000000000000000");
    assert.equal(a.root.hookData, "0x");
    assert.equal(a.root.validatorData, newRootInstallData(credential));
    assert.equal((a.root.validatorData.length - 2) / 2, 96, "install data is 96 bytes");
    const other = buildRecoveryRoot({
      deployments,
      account: ACCOUNT,
      credential,
      deploymentSalt: recoveryDeploymentSalt("attempt-2"),
    });
    assert.notEqual(other.instance, a.instance, "a new attempt gets a fresh instance");
    assert.notEqual(
      buildRecoveryRoot({
        deployments,
        account: "0x3333333333333333333333333333333333333333",
        credential,
        deploymentSalt: salt,
      }).instance,
      a.instance,
    );
    assert.notEqual(
      recoveryCommitmentHash(ACCOUNT, a.root),
      recoveryCommitmentHash(ACCOUNT, other.root),
    );
  }
  const p = buildRecoveryRoot({
    deployments,
    account: ACCOUNT,
    credential: passkeyCredential(),
    deploymentSalt: salt,
  });
  const d = buildRecoveryRoot({
    deployments,
    account: ACCOUNT,
    credential: deviceCredential(),
    deploymentSalt: salt,
  });
  assert.notEqual(p.instance, d.instance);
});

test("the commitment hash is the one the contract stores, and the batch is the one the contract accepts", async () => {
  const world = await World.create({ contract: "ShortDelayRecoveryValidator" });
  assert.ok((await world.install({ delay: 10 })).ok);
  const built = buildRecoveryRoot({
    deployments,
    account: world.account,
    credential: deviceCredential(),
    deploymentSalt: recoveryDeploymentSalt("attempt-x"),
  });
  // a stand-in contract at the predicted address so the validator accepts the root (it needs code)
  await world.chain.setCode(built.instance, "0x00");
  const root = world.root({
    rootId: `0x01${built.instance.slice(2).toLowerCase()}` as Hex,
    validatorData: built.root.validatorData,
  });
  assert.ok((await world.initiate(root)).ok);
  // The stored commitment equals the shared helper
  const stored = await world
    .read<Hex>("commitmentOf", [world.account, world.commitment(root)])
    .catch(() => undefined);
  if (stored) assert.equal(stored, recoveryCommitmentHash(world.account, built.root));
  assert.equal(
    (await world.pending()).commitment,
    recoveryCommitmentHash(world.account, built.root),
  );
  world.chain.warp(11);
  const nonce = await world.currentNonce();
  const mine = recoveryBatchCallData({
    account: world.account,
    root: built.root,
    currentNonce: nonce,
  });
  assert.equal(mine, batch(world.exactCalls(root, nonce)));
  const outcome = await world.validate(mine);
  assert.ok(outcome.ok, outcome.error);
  assert.equal(recoveryCommitment(built.root).rootId, root.rootId);
});
