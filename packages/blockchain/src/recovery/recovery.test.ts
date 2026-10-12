import assert from "node:assert/strict";
import { test } from "node:test";

import { recoveryCommitmentHash, recoveryDomain, recoveryInitiateTypes } from "@kaada/contracts";
import { isKaadaError } from "@kaada/domain";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { KeyAttestor, readKeyFileOutsideRepo } from "./attestor.js";
import { ViemRecoveryChain } from "./viem-chain.js";

const validator = "0x00000000000000000000000000000000000000c1" as const;
const deployments = {
  passkey: {
    factory: "0x00000000000000000000000000000000000000f1",
    implementation: "0x00000000000000000000000000000000000000a1",
  },
  device: {
    factory: "0x00000000000000000000000000000000000000f2",
    implementation: "0x00000000000000000000000000000000000000a2",
  },
} as const;

const chain = () =>
  new ViemRecoveryChain({
    chain: celoSepolia,
    rpcUrl: "http://127.0.0.1:1",
    bundlerUrl: "http://127.0.0.1:1",
    recoveryValidator: validator,
    deployments,
    relayerKey: generatePrivateKey(),
    p256Precompile: true,
  });

const account = "0x2222222222222222222222222222222222222222";
const device = {
  kind: "DEVICE_KEY" as const,
  keyId: `0x${"ab".repeat(32)}`,
  publicKeyX: "11".repeat(32),
  publicKeyY: "22".repeat(32),
};

test("proposeRoot is deterministic, per attempt, and its commitment is the one the contract stores", () => {
  const c = chain();
  const a = c.proposeRoot({ account, credential: device, attemptId: "attempt-1" });
  assert.deepEqual(c.proposeRoot({ account, credential: device, attemptId: "attempt-1" }), a);
  assert.notEqual(
    c.proposeRoot({ account, credential: device, attemptId: "attempt-2" }).validator,
    a.validator,
  );
  assert.equal(a.rootId, `0x01${a.validator.slice(2)}`);
  assert.equal(a.hook, "0x0000000000000000000000000000000000000000");
  assert.equal(a.hookData, "0x");
  assert.equal(
    a.commitmentHash,
    recoveryCommitmentHash(getAddress(account), {
      validator: getAddress(a.validator),
      hook: getAddress(a.hook),
      validatorData: a.validatorData as Hex,
      hookData: "0x",
    }),
  );
});

test("the typed message round-trips through signing and recovery, and a high-s twin is refused", async () => {
  const c = chain();
  const root = c.proposeRoot({ account, credential: device, attemptId: "attempt-1" });
  const message = c.typedMessage({ account, root, nonce: "3", deadline: "1900000000" });
  assert.equal(message.chainId, celoSepolia.id);
  assert.equal(message.verifyingContract, validator);
  const key = generatePrivateKey();
  const data = c.typedData(message);
  assert.equal(data.primaryType, "Initiate");
  assert.equal(data.domain.name, "KaadaRecovery");
  const signature = await privateKeyToAccount(key).signTypedData({
    domain: recoveryDomain(message.chainId, getAddress(message.verifyingContract)),
    types: recoveryInitiateTypes,
    primaryType: "Initiate",
    message: {
      account: getAddress(message.account),
      nonce: 3n,
      rootId: message.rootId as Hex,
      hook: getAddress(message.hook),
      validatorDataHash: message.validatorDataHash as Hex,
      hookDataHash: message.hookDataHash as Hex,
      deadline: 1900000000n,
    },
  });
  const expected = privateKeyToAccount(key).address.toLowerCase();
  assert.equal(await c.recoverInitiateSigner(message, signature), expected);
  // the malleable twin (same signer, high s) must not be accepted
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const flipped = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${signature.endsWith("1b") ? "1c" : "1b"}`;
  assert.equal(await c.recoverInitiateSigner(message, flipped), null);
  assert.equal(await c.recoverInitiateSigner(message, "0x1234"), null);
  assert.notEqual(await c.recoverInitiateSigner({ ...message, nonce: "4" }, signature), expected);
});

test("a device-key signature must be exactly keyId||r||s and low-s", () => {
  const c = chain();
  const good = `0x${"ab".repeat(32)}${"01".repeat(32)}${"00".repeat(31)}01`;
  assert.equal(c.encodeRootSignature({ kind: "DEVICE_KEY", material: good }), good);
  assert.equal(c.encodeRootSignature({ kind: "DEVICE_KEY", material: { signature: good } }), good);
  for (const bad of [
    "0x",
    `${good}00`,
    good.slice(0, -2),
    12,
    null,
    `0x${"zz".repeat(96)}`,
    `0x${"ab".repeat(32)}${"01".repeat(32)}${"ff".repeat(32)}`,
  ]) {
    assert.throws(
      () => c.encodeRootSignature({ kind: "DEVICE_KEY", material: bad }),
      (error) => isKaadaError(error, "CREDENTIAL_REJECTED"),
    );
  }
});

test("a passkey assertion must be a well-formed WebAuthn response", () => {
  const c = chain();
  assert.throws(
    () => c.encodeRootSignature({ kind: "PASSKEY", material: { response: {} } }),
    (error) => isKaadaError(error, "CREDENTIAL_REJECTED"),
  );
});

test("lane ids: a validator lane is 0x01||address, a permission lane is 0x02||id right-padded to 21 bytes", () => {
  const c = chain();
  assert.equal(
    c.validatorLaneId("0x00000000000000000000000000000000000000AB"),
    `0x01${"00".repeat(19)}ab`,
  );
  const lane = c.permissionLaneId("0xabcdef01");
  assert.equal(lane, `0x02abcdef01${"00".repeat(16)}`);
  assert.equal((lane.length - 2) / 2, 21);
});

test("the calls the root signs are fixed shapes: cancel, and arm (install + grant, or the two setters)", () => {
  const c = chain();
  const [cancel] = c.cancelCalls();
  assert.equal(cancel?.to, validator);
  assert.equal(
    decodeFunctionData({ abi: parseAbi(["function cancel()"]), data: cancel?.data as Hex })
      .functionName,
    "cancel",
  );
  const verifier = "0x00000000000000000000000000000000000000f9";
  const fresh = c.armCalls({
    account,
    recoveryAddress: verifier,
    delaySeconds: 259200,
    currentNonce: 2,
    alreadyConfigured: false,
  });
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((call) => call.to.toLowerCase() === account));
  const update = c.armCalls({
    account,
    recoveryAddress: verifier,
    delaySeconds: 259200,
    currentNonce: 2,
    alreadyConfigured: true,
  });
  const setters = parseAbi(["function setRecoveryKey(address)", "function setDelay(uint32)"]);
  assert.deepEqual(
    update.map((call) => decodeFunctionData({ abi: setters, data: call.data as Hex }).functionName),
    ["setRecoveryKey", "setDelay"],
  );
});

const vetoHash: Hex = `0x${"11".repeat(32)}`;

test("the attestor signs only the typed Initiate of its own chain and validator, and exposes nothing else", async () => {
  const c = chain();
  const key = generatePrivateKey();
  const attestor = new KeyAttestor({
    privateKey: key,
    chainId: celoSepolia.id,
    recoveryValidator: validator,
    sendVeto: () => Promise.resolve(vetoHash),
  });
  const root = c.proposeRoot({ account, credential: device, attemptId: "attempt-1" });
  const message = c.typedMessage({ account, root, nonce: "0", deadline: "1900000000" });
  const signature = await attestor.signInitiate(message);
  assert.equal(await c.recoverInitiateSigner(message, signature), await attestor.address());
  await assert.rejects(() => attestor.signInitiate({ ...message, chainId: 1 }));
  await assert.rejects(() =>
    attestor.signInitiate({
      ...message,
      verifyingContract: "0x00000000000000000000000000000000000000dd",
    }),
  );
  assert.deepEqual(Object.getOwnPropertyNames(KeyAttestor.prototype).sort(), [
    "address",
    "constructor",
    "signInitiate",
    "veto",
  ]);
  assert.equal(
    (await attestor.veto({ recoveryValidator: validator, account })).txHash,
    `0x${"11".repeat(32)}`,
  );
});

test("a key file inside the repository is refused", () => {
  assert.throws(
    () => readKeyFileOutsideRepo("./inside-the-repo.key", process.cwd()),
    /outside the repository/,
  );
});
