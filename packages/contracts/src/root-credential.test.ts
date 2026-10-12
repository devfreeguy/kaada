import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address, Hex } from "viem";

import { deviceKeyPayload } from "./device-key.js";
import {
  DEVICE_PROOF_DOMAIN_TAG,
  buildPrimaryRoot,
  deviceProofPayload,
  primaryRootDeploymentSalt,
} from "./root-credential.js";
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
const device = (n: number): NewRootCredential => ({
  kind: "DEVICE_KEY",
  keyId: `0x${n.toString(16).padStart(64, "0")}`,
  publicKeyX: n.toString(16).padStart(64, "1"),
  publicKeyY: n.toString(16).padStart(64, "2"),
});
const hex32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const ACCOUNT: Address = "0x2222222222222222222222222222222222222222";
const VALIDATOR: Address = "0x3333333333333333333333333333333333333333";

test("a primary root is deterministic for one owner and one key, and distinct for another owner or key", () => {
  const salt = primaryRootDeploymentSalt("user-1");
  const a = buildPrimaryRoot({ deployments, credential: device(1), deploymentSalt: salt });
  const again = buildPrimaryRoot({ deployments, credential: device(1), deploymentSalt: salt });
  assert.equal(a.instance, again.instance);
  assert.notEqual(
    a.instance,
    buildPrimaryRoot({
      deployments,
      credential: device(1),
      deploymentSalt: primaryRootDeploymentSalt("user-2"),
    }).instance,
    "the same key for another owner gets another instance",
  );
  assert.notEqual(
    a.instance,
    buildPrimaryRoot({ deployments, credential: device(2), deploymentSalt: salt }).instance,
  );
  assert.equal(a.purpose, 0);
  assert.equal(a.validatorData.length, 2 + 96 * 2);
});

test("passkey and device roots come from different factories", () => {
  const salt = primaryRootDeploymentSalt("user-1");
  const passkey: NewRootCredential = {
    kind: "PASSKEY",
    credentialId: "AQID",
    publicKeyX: device(1).publicKeyX,
    publicKeyY: device(1).publicKeyY,
  };
  assert.equal(
    buildPrimaryRoot({ deployments, credential: passkey, deploymentSalt: salt }).factory,
    deployments.passkey.factory,
  );
  assert.equal(
    buildPrimaryRoot({ deployments, credential: device(1), deploymentSalt: salt }).factory,
    deployments.device.factory,
  );
});

test("the off-chain proof can never be a UserOperation signature payload, and purposes do not mix", () => {
  const base = {
    chainId: 11142220,
    validator: VALIDATOR,
    account: ACCOUNT,
    keyId: hex32("ab"),
    challenge: hex32("cd"),
  };
  const proof = deviceProofPayload({ ...base, purpose: "PIN_ENROLLMENT" });
  assert.equal(Buffer.from(proof.slice(2, 36), "hex").toString(), DEVICE_PROOF_DOMAIN_TAG);
  assert.equal((proof.length - 2) / 2, 17 + 32 + 20 + 20 + 32 + 32 + 32);
  const onChain = deviceKeyPayload({
    chainId: base.chainId,
    validator: base.validator,
    account: base.account,
    keyId: base.keyId,
    userOpHash: base.challenge,
  });
  assert.notEqual(proof.slice(0, 36), onChain.slice(0, 36));
  assert.notEqual(proof, deviceProofPayload({ ...base, purpose: "ROOT_ENROLLMENT" }));
});

test("rootChangeCalls are exactly changeRootValidator then invalidateNonce(currentNonce + 1), both to the account", async () => {
  const { decodeFunctionData, parseAbi, zeroAddress } = await import("viem");
  const { rootChangeCalls, recoveryBatchCallData } = await import("./recovery-root.js");
  const abi = parseAbi([
    "function changeRootValidator(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData)",
    "function invalidateNonce(uint32 nonce)",
    "function execute(bytes32 execMode, bytes executionCalldata)",
  ]);
  const root = {
    validator: VALIDATOR,
    hook: zeroAddress,
    validatorData: "0x1234" as Hex,
    hookData: "0x" as Hex,
  };
  const calls = rootChangeCalls({ account: ACCOUNT, root, currentNonce: 6 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.target === ACCOUNT && call.value === 0n));
  const [first, second] = calls.map((call) => decodeFunctionData({ abi, data: call.callData }));
  assert.equal(first?.functionName, "changeRootValidator");
  assert.equal(String(first?.args?.[0]).toLowerCase(), `0x01${VALIDATOR.slice(2).toLowerCase()}`);
  assert.equal(second?.functionName, "invalidateNonce");
  assert.equal(second?.args?.[0], 7);
  // The recovery batch is the same two calls wrapped in one batch execute: nothing else.
  const batch = decodeFunctionData({
    abi,
    data: recoveryBatchCallData({ account: ACCOUNT, root, currentNonce: 6 }),
  });
  assert.equal(batch.functionName, "execute");
});

test("validatorLaneInstallCalls install the lane under the current nonce, then grant execute and nothing more", async () => {
  const { decodeFunctionData, parseAbi, toFunctionSelector } = await import("viem");
  const { validatorLaneInstallCalls } = await import("./recovery-root.js");
  const abi = parseAbi([
    "function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData)",
    "function grantAccess(bytes21 vId, bytes4 selector, bool allow)",
  ]);
  const calls = validatorLaneInstallCalls({
    account: ACCOUNT,
    validator: VALIDATOR,
    validatorData: "0xabcd",
    currentNonce: 4,
  });
  assert.equal(calls.length, 2);
  const [install, grant] = calls.map((call) => decodeFunctionData({ abi, data: call.data }));
  const lane = `0x01${VALIDATOR.slice(2).toLowerCase()}`;
  assert.equal(install?.functionName, "installValidations");
  assert.deepEqual(
    (install?.args?.[0] as string[]).map((id) => id.toLowerCase()),
    [lane],
  );
  assert.equal((install?.args?.[1] as unknown as { nonce: number }[])[0]?.nonce, 4);
  assert.equal(grant?.functionName, "grantAccess");
  assert.equal(String(grant?.args?.[0]).toLowerCase(), lane);
  assert.equal(grant?.args?.[1], toFunctionSelector("execute(bytes32,bytes)"));
  assert.equal(grant?.args?.[2], true);
});
