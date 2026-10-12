import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { P256_HALF_N, deviceKeyInstallData } from "@kaada/contracts";
import type { DeviceKeyRoot } from "@kaada/domain";

import { encodeDeviceProof } from "../execution/zerodev-kernel-adapter.js";
import { deviceKeyStubSignature, toDeviceKeyValidator } from "./root-validator.js";

const root: DeviceKeyRoot = {
  type: "DEVICE_KEY",
  keyId: `0x${"ab".repeat(32)}`,
  publicKeyX: "11".repeat(32),
  publicKeyY: "22".repeat(32),
  validatorAddress: `0x${"cd".repeat(20)}`,
  purpose: 0,
  deploymentSalt: `0x${"00".repeat(32)}`,
};
const hex64 = (n: bigint) => n.toString(16).padStart(64, "0");

describe("the device-key Kernel validator plugin", () => {
  const plugin = toDeviceKeyValidator(root);

  it("is the validator instance, installed with the key's public data", async () => {
    assert.equal(plugin.address, root.validatorAddress);
    assert.equal(plugin.getIdentifier(), root.validatorAddress);
    assert.equal(
      await plugin.getEnableData(),
      deviceKeyInstallData(
        { x: BigInt(`0x${root.publicKeyX}`), y: BigInt(`0x${root.publicKeyY}`) },
        root.keyId as `0x${string}`,
      ),
    );
    assert.equal(await plugin.getNonceKey(), 0n);
  });

  it("has no signing member of any kind: it can only be handed a signature from outside", () => {
    const names = Object.keys(plugin);
    for (const forbidden of [
      "signMessage",
      "signTypedData",
      "signTransaction",
      "signUserOperation",
      "sign",
      "privateKey",
    ]) {
      assert.equal(names.includes(forbidden), false, forbidden);
    }
  });

  it("estimates gas with a stub of the right shape: keyId, r, s (96 bytes) with a low s", async () => {
    const stub = await plugin.getStubSignature();
    assert.equal((stub.length - 2) / 2, 96);
    assert.equal(stub, deviceKeyStubSignature(root.keyId as `0x${string}`));
    assert.equal(stub.slice(2, 66), "ab".repeat(32));
    assert.ok(BigInt(`0x${stub.slice(2 + 128)}`) <= P256_HALF_N);
  });
});

describe("a device proof as the operation signature", () => {
  const keyId = root.keyId;

  it("is keyId || r || s, exactly 96 bytes", () => {
    const signature = encodeDeviceProof({ keyId, r: hex64(5n), s: hex64(7n) });
    assert.equal((signature.length - 2) / 2, 96);
    assert.equal(signature.slice(2, 66), "ab".repeat(32));
    assert.equal(signature.slice(66, 130), hex64(5n));
    assert.equal(signature.slice(130), hex64(7n));
  });

  it("refuses a high-s signature, a zero part and anything malformed (it could never validate)", () => {
    assert.throws(
      () => encodeDeviceProof({ keyId, r: hex64(5n), s: hex64(P256_HALF_N + 1n) }),
      /low-s/,
    );
    assert.throws(() => encodeDeviceProof({ keyId, r: hex64(0n), s: hex64(7n) }), /malformed/);
    assert.throws(() => encodeDeviceProof({ keyId, r: hex64(5n), s: hex64(0n) }), /malformed/);
    assert.throws(() => encodeDeviceProof({ keyId, r: "12", s: hex64(7n) }), /malformed/);
    assert.throws(
      () => encodeDeviceProof({ keyId, r: "zz".repeat(32), s: hex64(7n) }),
      /malformed/,
    );
  });
});
