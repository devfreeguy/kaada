import assert from "node:assert/strict";
import { test } from "node:test";

import { p256 } from "@noble/curves/p256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { concat, decodeEventLog, encodeFunctionData, keccak256, pad, toHex } from "viem";
import type { Abi, Address, Hex } from "viem";

import {
  DEVICE_KEY_DOMAIN_TAG,
  DEVICE_KEY_MAX_KEYS,
  P256_HALF_N,
  P256_N,
  classifyDeviceKey,
  deviceKeyDigest,
  deviceKeyInstallData,
  deviceKeyPayload,
  deviceKeySignature,
  normalizeLowS,
  parseDerSignature,
} from "./device-key.js";
import type { AttestationVerifier, DeviceKeyPoint, DeviceSigningInput } from "./device-key.js";
import { artifacts } from "./generated/artifacts.js";
import {
  ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
  ZERODEV_PASSKEY_VALIDATOR_MAINNET,
  ZERODEV_PASSKEY_VALIDATOR_RUNTIME,
} from "./generated/passkey-validator.js";
import {
  PASSKEY_PURPOSE,
  passkeyCredentialCommitment,
  passkeyInstallData,
  predictPasskeyInstance,
} from "./passkey-factory.js";
import { TestChain, describeRevert } from "./testing/evm.js";
import { SoftDeviceKey, labelledKeyId } from "./testing/device-key.js";
import { SoftPasskey } from "./testing/passkey.js";
import { World, accountAbi, batch } from "./testing/recovery-world.js";

const validatorAbi = artifacts.KaadaDeviceKeyValidator.abi as unknown as Abi;
const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const ZERO32: Hex = pad("0x", { size: 32 });
const hash = (n: number): Hex => pad(toHex(n + 1), { size: 32 });
const rootId = (validator: Address): Hex => `0x01${validator.slice(2).toLowerCase()}` as Hex;

const decodeEvents = (logs: { data: Hex; topics: Hex[] }[]) =>
  logs.flatMap((l) => {
    try {
      const e = decodeEventLog({ abi: validatorAbi, data: l.data, topics: l.topics as never });
      return [e];
    } catch {
      return [];
    }
  });

class DeviceWorld {
  readonly deployer: Address = "0x1000000000000000000000000000000000000001";
  readonly stranger: Address = "0x1000000000000000000000000000000000000002";

  private constructor(
    readonly chain: TestChain,
    readonly validator: Address,
    readonly accountA: Address,
    readonly accountB: Address,
  ) {}

  static async create(
    chainId = 11142220n,
    options: { p256Precompile?: boolean } = {},
  ): Promise<DeviceWorld> {
    const chain = await TestChain.create(chainId, options);
    const deployer: Address = "0x1000000000000000000000000000000000000001";
    const validator = await chain.deploy(
      deployer,
      validatorAbi,
      artifacts.KaadaDeviceKeyValidator.bytecode,
    );
    const accountA = await chain.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    const accountB = await chain.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    return new DeviceWorld(chain, validator, accountA, accountB);
  }

  async asAccount(account: Address, target: Address, data: Hex) {
    const r = await this.chain.call(this.stranger, account, accountAbi, "forward", [target, data]);
    if (!r.ok) return { ok: false as const, error: r.error, logs: [] as never[] };
    const [ok, ret] = r.value as [boolean, Hex];
    return ok
      ? { ok: true as const, ret, logs: r.logs }
      : { ok: false as const, error: describeRevert(validatorAbi, ret), logs: [] as never[] };
  }

  fn(name: string, args: unknown[] = []): Hex {
    return encodeFunctionData({ abi: validatorAbi, functionName: name, args });
  }

  install(account: Address, key: SoftDeviceKey, target: Address = this.validator) {
    return this.asAccount(
      account,
      target,
      this.fn("onInstall", [deviceKeyInstallData(key.point, key.keyId)]),
    );
  }

  addKey(account: Address, key: SoftDeviceKey, target: Address = this.validator) {
    return this.asAccount(
      account,
      target,
      this.fn("addKey", [key.keyId, key.point.x, key.point.y]),
    );
  }

  removeKey(account: Address, keyId: Hex, target: Address = this.validator) {
    return this.asAccount(account, target, this.fn("removeKey", [keyId]));
  }

  async setRoot(account: Address, instance: Address | null): Promise<void> {
    const value = instance ? rootId(instance) : `0x${"00".repeat(21)}`;
    const r = await this.chain.call(this.stranger, account, accountAbi, "setRootValidator", [
      value,
    ]);
    assert.ok(r.ok);
  }

  async read<T>(name: string, args: unknown[] = [], target: Address = this.validator): Promise<T> {
    const r = await this.chain.call(this.stranger, target, validatorAbi, name, args);
    if (!r.ok) throw new Error(`${name} reverted: ${r.error}`);
    return r.value as T;
  }

  userOp(signature: Hex, sender: Address) {
    return {
      sender,
      nonce: 0n,
      initCode: "0x" as Hex,
      callData: "0x" as Hex,
      accountGasLimits: ZERO32,
      preVerificationGas: 0n,
      gasFees: ZERO32,
      paymasterAndData: "0x" as Hex,
      signature,
    };
  }

  /** Kernel's call. Returns the validation data (0 valid, 1 failed) or -1n if it reverted. */
  async validate(
    account: Address,
    userOpHash: Hex,
    signature: Hex,
    target: Address = this.validator,
  ): Promise<bigint> {
    const r = await this.asAccount(
      account,
      target,
      this.fn("validateUserOp", [this.userOp(signature, account), userOpHash]),
    );
    return r.ok ? BigInt(r.ret) : -1n;
  }

  signing(account: Address, userOpHash: Hex, validator: Address = this.validator) {
    return { chainId: this.chain.chainId, validator, account, userOpHash };
  }
}

const OK = 0n;
const FAILED = 1n;

// ── the signing payload ────────────────────────────────────────────────────────────────────────

test("the signing payload is exactly 153 bytes with the documented layout, and TypeScript == contract", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  const input = { ...w.signing(w.accountA, hash(1)), keyId: key.keyId };
  const ts = deviceKeyPayload(input);
  assert.equal((ts.length - 2) / 2, 17 + 32 + 20 + 20 + 32 + 32);
  assert.equal(ts.slice(0, 2 + 34), `0x${Buffer.from(DEVICE_KEY_DOMAIN_TAG).toString("hex")}`);
  assert.equal(DEVICE_KEY_DOMAIN_TAG, "KaadaDeviceKey/v1");
  const onChain = await w.read<Hex>("signingPayload", [w.accountA, key.keyId, hash(1)]);
  assert.equal(onChain.toLowerCase(), ts.toLowerCase());
  assert.equal(
    await w.read<Hex>("signingDigest", [w.accountA, key.keyId, hash(1)]),
    deviceKeyDigest(input),
  );
  assert.equal(
    await w.read<Hex>("DOMAIN_TAG"),
    `0x${Buffer.from(DEVICE_KEY_DOMAIN_TAG).toString("hex")}`,
  );
  assert.equal(await w.read<bigint>("VERSION"), 1n);
});

test("fuzz: the payload and digest match for 100 random inputs (and every field changes the digest)", async () => {
  const w = await DeviceWorld.create();
  for (let i = 0; i < 100; i++) {
    const account: Address = `0x${keccak256(toHex(`a${i}`)).slice(26)}`;
    const keyId = keccak256(toHex(`k${i}`));
    const userOpHash = keccak256(toHex(`h${i}`));
    const input = { chainId: w.chain.chainId, validator: w.validator, account, keyId, userOpHash };
    assert.equal(
      await w.read<Hex>("signingDigest", [account, keyId, userOpHash]),
      deviceKeyDigest(input),
    );
    const variants: DeviceSigningInput[] = [
      { ...input, chainId: input.chainId + 1n },
      { ...input, validator: `0x${keccak256(toHex(`v${i}`)).slice(26)}` },
      { ...input, account: `0x${keccak256(toHex(`b${i}`)).slice(26)}` },
      { ...input, keyId: keccak256(keyId) },
      { ...input, userOpHash: keccak256(userOpHash) },
    ];
    for (const v of variants) assert.notEqual(deviceKeyDigest(v), deviceKeyDigest(input));
  }
});

// ── install and keys ───────────────────────────────────────────────────────────────────────────

test("onInstall enrols the first key, emits Installed, exposes reads, and refuses a second install", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  assert.equal(await w.read<boolean>("isInitialized", [w.accountA]), false);
  const r = await w.install(w.accountA, key);
  assert.ok(r.ok, r.ok ? "" : r.error);
  const events = decodeEvents(r.logs);
  assert.equal(events[0]?.eventName, "Installed");
  assert.equal(await w.read<boolean>("isInitialized", [w.accountA]), true);
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), 1n);
  assert.equal(await w.read<boolean>("keyExists", [w.accountA, key.keyId]), true);
  assert.deepEqual(await w.read<[bigint, bigint]>("keyOf", [w.accountA, key.keyId]), [
    key.point.x,
    key.point.y,
  ]);
  assert.deepEqual(await w.read<Hex[]>("keyIds", [w.accountA]), [key.keyId]);
  assert.equal(await w.read<boolean>("isModuleType", [1n]), true);
  assert.equal(await w.read<boolean>("isModuleType", [2n]), false);
  // other accounts see nothing
  assert.equal(await w.read<boolean>("isInitialized", [w.accountB]), false);

  const again = await w.install(w.accountA, new SoftDeviceKey());
  assert.equal(again.ok, false);
  assert.equal(again.ok ? "" : again.error, "AlreadyInitialized");
});

test("bad install data, zero or non-curve points and zero key ids are rejected", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  const good = deviceKeyInstallData(key.point, key.keyId);
  const reject = async (name: string, data: Hex, expected: string) => {
    const r = await w.asAccount(w.accountA, w.validator, w.fn("onInstall", [data]));
    assert.equal(r.ok, false, name);
    assert.equal(r.ok ? "" : r.error, expected, name);
  };
  await reject("empty", "0x", "BadInstallData");
  await reject("short", good.slice(0, good.length - 2) as Hex, "BadInstallData");
  await reject("long", `${good}00` as Hex, "BadInstallData");
  await reject("zero keyId", deviceKeyInstallData(key.point, ZERO32), "InvalidKeyId");
  await reject(
    "zero x",
    deviceKeyInstallData({ ...key.point, x: 0n }, key.keyId),
    "InvalidPublicKey",
  );
  await reject(
    "zero y",
    deviceKeyInstallData({ ...key.point, y: 0n }, key.keyId),
    "InvalidPublicKey",
  );
  await reject("both zero", deviceKeyInstallData({ x: 0n, y: 0n }, key.keyId), "InvalidPublicKey");
  await reject(
    "off curve",
    deviceKeyInstallData({ x: key.point.x, y: key.point.y + 1n }, key.keyId),
    "InvalidPublicKey",
  );
  await reject(
    "x == p",
    deviceKeyInstallData(
      { x: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, y: key.point.y },
      key.keyId,
    ),
    "InvalidPublicKey",
  );
  await reject(
    "x = 2^256-1",
    deviceKeyInstallData({ x: 2n ** 256n - 1n, y: key.point.y }, key.keyId),
    "InvalidPublicKey",
  );
  await reject(
    "y = 2^256-1",
    deviceKeyInstallData({ x: key.point.x, y: 2n ** 256n - 1n }, key.keyId),
    "InvalidPublicKey",
  );
  const k1 = secp256k1.ProjectivePoint.fromPrivateKey(
    secp256k1.utils.randomPrivateKey(),
  ).toAffine();
  await reject(
    "a secp256k1 point",
    deviceKeyInstallData({ x: k1.x, y: k1.y }, key.keyId),
    "InvalidPublicKey",
  );
  assert.equal(await w.read<boolean>("isInitialized", [w.accountA]), false);
});

test("fuzz: random off-curve points are rejected and random on-curve points accepted", async () => {
  const w = await DeviceWorld.create();
  let accepted = 0;
  for (let i = 0; i < 60; i++) {
    const real = new SoftDeviceKey();
    const account = await w.chain.deploy(w.deployer, accountAbi, artifacts.MockAccount.bytecode);
    const bad: DeviceKeyPoint[] = [
      { x: real.point.x, y: real.point.y ^ (1n << BigInt(i % 200)) },
      { x: real.point.x ^ (1n << BigInt(i % 200)), y: real.point.y },
      { x: BigInt(keccak256(toHex(`rx${i}`))), y: BigInt(keccak256(toHex(`ry${i}`))) },
    ];
    for (const point of bad) {
      const r = await w.asAccount(
        account,
        w.validator,
        w.fn("onInstall", [deviceKeyInstallData(point, real.keyId)]),
      );
      assert.equal(r.ok, false, `off-curve point accepted at ${i}`);
    }
    const good = await w.install(account, real);
    assert.ok(good.ok);
    accepted++;
  }
  assert.equal(accepted, 60);
});

test("addKey: adds a second key, emits KeyAdded; duplicate keyId and duplicate public point are rejected", async () => {
  const w = await DeviceWorld.create();
  const k1 = new SoftDeviceKey();
  const k2 = new SoftDeviceKey();
  await w.install(w.accountA, k1);
  const added = await w.addKey(w.accountA, k2);
  assert.ok(added.ok);
  assert.equal(decodeEvents(added.logs)[0]?.eventName, "KeyAdded");
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), 2n);

  const dupId = await w.asAccount(
    w.accountA,
    w.validator,
    w.fn("addKey", [k2.keyId, k1.point.x, k1.point.y]),
  );
  assert.equal(dupId.ok ? "" : dupId.error, "KeyIdInUse");
  const dupPoint = await w.asAccount(
    w.accountA,
    w.validator,
    w.fn("addKey", [labelledKeyId("other"), k2.point.x, k2.point.y]),
  );
  assert.equal(dupPoint.ok ? "" : dupPoint.error, "PublicKeyInUse");
  const zeroId = await w.asAccount(
    w.accountA,
    w.validator,
    w.fn("addKey", [ZERO32, new SoftDeviceKey().point.x, 1n]),
  );
  assert.equal(zeroId.ok ? "" : zeroId.error, "InvalidKeyId");
  const offCurve = await w.asAccount(
    w.accountA,
    w.validator,
    w.fn("addKey", [labelledKeyId("x"), 5n, 5n]),
  );
  assert.equal(offCurve.ok ? "" : offCurve.error, "InvalidPublicKey");
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), 2n);
});

test("at most MAX_KEYS keys per account", async () => {
  const w = await DeviceWorld.create();
  const first = new SoftDeviceKey();
  await w.install(w.accountA, first);
  for (let i = 1; i < DEVICE_KEY_MAX_KEYS; i++)
    assert.ok((await w.addKey(w.accountA, new SoftDeviceKey())).ok, `key ${i}`);
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), BigInt(DEVICE_KEY_MAX_KEYS));
  assert.equal(await w.read<bigint>("MAX_KEYS"), BigInt(DEVICE_KEY_MAX_KEYS));
  const over = await w.addKey(w.accountA, new SoftDeviceKey());
  assert.equal(over.ok ? "" : over.error, "TooManyKeys");
  // removing one makes room again
  assert.ok((await w.removeKey(w.accountA, first.keyId)).ok);
  assert.ok((await w.addKey(w.accountA, new SoftDeviceKey())).ok);
});

// ── validation: the accept path and every rejection ────────────────────────────────────────────

test("a valid device signature validates; the same message fails for every wrong ingredient", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  const other = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const good = key.sign(w.signing(w.accountA, hash(1)));
  assert.equal(await w.validate(w.accountA, hash(1), good), OK);

  // wrong key: another key signs under the first key id, and the first key id is not enrolled for a stranger key
  const forged = concat([
    key.keyId,
    `0x${other.sign(w.signing(w.accountA, hash(1))).slice(2 + 64)}`,
  ]);
  assert.equal(await w.validate(w.accountA, hash(1), forged), FAILED, "other key under this keyId");
  assert.equal(
    await w.validate(w.accountA, hash(1), other.sign(w.signing(w.accountA, hash(1)))),
    FAILED,
    "unenrolled key id",
  );
  // wrong userOpHash
  assert.equal(await w.validate(w.accountA, hash(2), good), FAILED, "wrong userOpHash");
  // signed for another validator address
  assert.equal(
    await w.validate(
      w.accountA,
      hash(1),
      key.sign(w.signing(w.accountA, hash(1), "0x2000000000000000000000000000000000000002")),
    ),
    FAILED,
    "wrong validator",
  );
  // signed for another account
  assert.equal(
    await w.validate(w.accountA, hash(1), key.sign(w.signing(w.accountB, hash(1)))),
    FAILED,
    "signed for another account",
  );
  // signed for another chain
  assert.equal(
    await w.validate(
      w.accountA,
      hash(1),
      key.sign({ ...w.signing(w.accountA, hash(1)), chainId: 1n }),
    ),
    FAILED,
    "signed for another chain",
  );
});

test("replay across accounts: the same key enrolled on two accounts, a signature for one fails on the other", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  await w.install(w.accountB, key);
  const forA = key.sign(w.signing(w.accountA, hash(3)));
  assert.equal(await w.validate(w.accountA, hash(3), forA), OK);
  assert.equal(await w.validate(w.accountB, hash(3), forA), FAILED);
  const forB = key.sign(w.signing(w.accountB, hash(3)));
  assert.equal(await w.validate(w.accountB, hash(3), forB), OK);
  assert.equal(await w.validate(w.accountA, hash(3), forB), FAILED);
});

test("replay across chains: the same validator address and account on another chain id rejects the signature", async () => {
  const one = await DeviceWorld.create(11142220n);
  const two = await DeviceWorld.create(42220n);
  assert.equal(one.validator, two.validator, "same deployment order gives the same addresses");
  assert.equal(one.accountA, two.accountA);
  const key = new SoftDeviceKey();
  await one.install(one.accountA, key);
  await two.install(two.accountA, key);
  const onOne = key.sign(one.signing(one.accountA, hash(4)));
  assert.equal(await one.validate(one.accountA, hash(4), onOne), OK);
  assert.equal(
    await two.validate(two.accountA, hash(4), onOne),
    FAILED,
    "replay on the other chain",
  );
  assert.equal(
    await two.validate(two.accountA, hash(4), key.sign(two.signing(two.accountA, hash(4)))),
    OK,
  );
});

test("high-s signatures are rejected even though the math is valid; the low-s twin passes", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const input = w.signing(w.accountA, hash(5));
  assert.equal(await w.validate(w.accountA, hash(5), key.sign(input)), OK);
  const high = key.signHighS(input);
  assert.equal(await w.validate(w.accountA, hash(5), high), FAILED);
  // the helper refuses to build a high-s signature
  const s = BigInt(`0x${high.slice(2 + 128)}`);
  assert.ok(s > P256_HALF_N);
  assert.throws(() => deviceKeySignature(key.keyId, 1n, s));
  assert.equal(normalizeLowS(s) <= P256_HALF_N, true);
  assert.equal(normalizeLowS(normalizeLowS(s)), normalizeLowS(s));
});

test("malformed signatures: length, zero or out-of-range r and s, unknown key id", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const good = key.sign(w.signing(w.accountA, hash(6)));
  const r = `0x${good.slice(2 + 64, 2 + 128)}`;
  const s = `0x${good.slice(2 + 128)}`;
  const word = (n: bigint) => pad(toHex(n), { size: 32 });
  const cases: [string, Hex][] = [
    ["empty", "0x"],
    ["95 bytes", good.slice(0, good.length - 2) as Hex],
    ["97 bytes", `${good}00` as Hex],
    ["128 bytes (passkey-sized)", `${good}${"00".repeat(32)}` as Hex],
    ["r = 0", concat([key.keyId, word(0n), s as Hex])],
    ["s = 0", concat([key.keyId, r as Hex, word(0n)])],
    ["r = n", concat([key.keyId, word(P256_N), s as Hex])],
    ["r > n", concat([key.keyId, word(P256_N + 1n), s as Hex])],
    ["r = 2^256-1", concat([key.keyId, word(2n ** 256n - 1n), s as Hex])],
    ["s = n", concat([key.keyId, r as Hex, word(P256_N)])],
    ["s = n/2 + 1", concat([key.keyId, r as Hex, word(P256_HALF_N + 1n)])],
    ["s = 2^256-1", concat([key.keyId, r as Hex, word(2n ** 256n - 1n)])],
    ["zero key id", concat([ZERO32, r as Hex, s as Hex])],
    ["unknown key id", concat([hash(99), r as Hex, s as Hex])],
  ];
  for (const [name, signature] of cases) {
    assert.equal(await w.validate(w.accountA, hash(6), signature), FAILED, name);
  }
  assert.equal(await w.validate(w.accountA, hash(6), good), OK);
});

test("a passkey-style ABI-encoded signature is not a device signature", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const passkey = new SoftPasskey();
  assert.equal(await w.validate(w.accountA, hash(7), passkey.sign(hash(7))), FAILED);
});

test("fuzz: any single-byte or single-bit change of a valid signature is rejected", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const good = key.sign(w.signing(w.accountA, hash(8)));
  const bytes = Buffer.from(good.slice(2), "hex");
  assert.equal(await w.validate(w.accountA, hash(8), good), OK);
  // every byte position of keyId || r || s (96) with a bit flip
  for (let i = 0; i < bytes.length; i++) {
    const mutated = Buffer.from(bytes);
    mutated[i] = mutated[i]! ^ (1 << (i % 8));
    assert.equal(
      await w.validate(w.accountA, hash(8), `0x${mutated.toString("hex")}`),
      FAILED,
      `byte ${i}`,
    );
  }
  // random multi-byte mutations
  for (let i = 0; i < 40; i++) {
    const mutated = Buffer.from(bytes);
    for (let j = 0; j < 1 + (i % 4); j++)
      mutated[(i * 7 + j * 13) % 96] = (mutated[(i * 7 + j * 13) % 96]! + 1 + j) & 0xff;
    if (mutated.equals(bytes)) continue;
    assert.equal(await w.validate(w.accountA, hash(8), `0x${mutated.toString("hex")}`), FAILED);
  }
});

test("fuzz: 40 random keys sign random hashes; wrong hash never validates", async () => {
  const w = await DeviceWorld.create();
  for (let i = 0; i < 40; i++) {
    const key = new SoftDeviceKey();
    const account = await w.chain.deploy(w.deployer, accountAbi, artifacts.MockAccount.bytecode);
    await w.install(account, key);
    const h = keccak256(toHex(`op${i}`));
    assert.equal(await w.validate(account, h, key.sign(w.signing(account, h))), OK, `valid ${i}`);
    assert.equal(
      await w.validate(account, keccak256(h), key.sign(w.signing(account, h))),
      FAILED,
      `wrong hash ${i}`,
    );
  }
});

test("without the RIP-7212 precompile every signature fails closed (no software fallback)", async () => {
  const w = await DeviceWorld.create(11142220n, { p256Precompile: false });
  const key = new SoftDeviceKey();
  assert.ok((await w.install(w.accountA, key)).ok);
  assert.equal(
    await w.validate(w.accountA, hash(9), key.sign(w.signing(w.accountA, hash(9)))),
    FAILED,
  );
});

test("an unenrolled account (or a stranger) cannot validate", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  await w.install(w.accountA, key);
  assert.equal(
    await w.validate(w.accountB, hash(1), key.sign(w.signing(w.accountB, hash(1)))),
    FAILED,
  );
  const direct = await w.chain.call(w.stranger, w.validator, validatorAbi, "validateUserOp", [
    w.userOp(key.sign(w.signing(w.stranger, hash(1))), w.stranger),
    hash(1),
  ]);
  assert.ok(direct.ok);
  assert.equal(direct.ok ? BigInt(direct.value as bigint) : 9n, FAILED);
});

// ── removal, revocation and final-key protection ───────────────────────────────────────────────

test("a removed key fails, the remaining key works, and the removed point can be re-enrolled under a new id", async () => {
  const w = await DeviceWorld.create();
  const k1 = new SoftDeviceKey();
  const k2 = new SoftDeviceKey();
  await w.install(w.accountA, k1);
  await w.addKey(w.accountA, k2);
  assert.equal(await w.validate(w.accountA, hash(1), k2.sign(w.signing(w.accountA, hash(1)))), OK);
  const removed = await w.removeKey(w.accountA, k2.keyId);
  assert.ok(removed.ok);
  assert.equal(decodeEvents(removed.logs)[0]?.eventName, "KeyRemoved");
  assert.equal(await w.read<boolean>("keyExists", [w.accountA, k2.keyId]), false);
  assert.equal(
    await w.validate(w.accountA, hash(1), k2.sign(w.signing(w.accountA, hash(1)))),
    FAILED,
    "revoked key",
  );
  assert.equal(await w.validate(w.accountA, hash(1), k1.sign(w.signing(w.accountA, hash(1)))), OK);
  const gone = await w.removeKey(w.accountA, k2.keyId);
  assert.equal(gone.ok ? "" : gone.error, "UnknownKey");
  const reenrol = await w.asAccount(
    w.accountA,
    w.validator,
    w.fn("addKey", [labelledKeyId("again"), k2.point.x, k2.point.y]),
  );
  assert.ok(reenrol.ok, "the point is free again");
});

test("final-key protection: while the validator is the root the last key cannot be removed or uninstalled", async () => {
  const w = await DeviceWorld.create();
  const k1 = new SoftDeviceKey();
  const k2 = new SoftDeviceKey();
  await w.install(w.accountA, k1);
  await w.addKey(w.accountA, k2);
  await w.setRoot(w.accountA, w.validator);

  assert.ok((await w.removeKey(w.accountA, k2.keyId)).ok, "one of two can go");
  const last = await w.removeKey(w.accountA, k1.keyId);
  assert.equal(last.ok ? "" : last.error, "CannotRemoveFinalKey");
  const unins = await w.asAccount(w.accountA, w.validator, w.fn("onUninstall", ["0x"]));
  assert.equal(unins.ok ? "" : unins.error, "CannotUninstallWhileRoot");
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), 1n);
  assert.equal(await w.validate(w.accountA, hash(1), k1.sign(w.signing(w.accountA, hash(1)))), OK);

  // the batch order that replaces the root FIRST makes the removal legitimate
  await w.setRoot(w.accountA, "0x3000000000000000000000000000000000000003");
  assert.ok((await w.removeKey(w.accountA, k1.keyId)).ok, "no longer the root");
  assert.equal(await w.read<boolean>("isInitialized", [w.accountA]), false);
});

test("a validator that is not the root may lose its last key; onUninstall clears everything", async () => {
  const w = await DeviceWorld.create();
  const k1 = new SoftDeviceKey();
  const k2 = new SoftDeviceKey();
  await w.install(w.accountA, k1);
  await w.addKey(w.accountA, k2);
  await w.setRoot(w.accountA, "0x3000000000000000000000000000000000000003");
  assert.ok((await w.asAccount(w.accountA, w.validator, w.fn("onUninstall", ["0x"]))).ok);
  assert.equal(await w.read<bigint>("keyCount", [w.accountA]), 0n);
  assert.equal(
    await w.validate(w.accountA, hash(1), k1.sign(w.signing(w.accountA, hash(1)))),
    FAILED,
  );
  assert.equal(await w.read<boolean>("keyExists", [w.accountA, k2.keyId]), false);
  // and a fresh install works again
  assert.ok((await w.install(w.accountA, k2)).ok);
  const twice = await w.asAccount(w.accountB, w.validator, w.fn("onUninstall", ["0x"]));
  assert.equal(twice.ok ? "" : twice.error, "NotInitialized");
});

test("unauthorized administration: outsiders can only touch their own (empty) entry, never an account's keys", async () => {
  const w = await DeviceWorld.create();
  const key = new SoftDeviceKey();
  const attacker = new SoftDeviceKey();
  await w.install(w.accountA, key);
  const direct = (name: string, args: unknown[]) =>
    w.chain.call(w.stranger, w.validator, validatorAbi, name, args);
  const add = await direct("addKey", [attacker.keyId, attacker.point.x, attacker.point.y]);
  assert.ok(!add.ok && add.error === "NotInitialized");
  const remove = await direct("removeKey", [key.keyId]);
  assert.ok(!remove.ok && remove.error === "NotInitialized");
  const unins = await direct("onUninstall", ["0x"]);
  assert.ok(!unins.ok && unins.error === "NotInitialized");
  // an attacker that installs for ITSELF creates an entry under its own address only
  const own = await direct("onInstall", [deviceKeyInstallData(attacker.point, attacker.keyId)]);
  assert.ok(own.ok);
  assert.deepEqual(await w.read<Hex[]>("keyIds", [w.accountA]), [key.keyId]);
  assert.equal(await w.read<boolean>("keyExists", [w.stranger, key.keyId]), false);
  // account B (another account) cannot remove account A's key either
  await w.install(w.accountB, new SoftDeviceKey());
  const cross = await w.removeKey(w.accountB, key.keyId);
  assert.equal(cross.ok ? "" : cross.error, "UnknownKey");
  assert.equal(await w.validate(w.accountA, hash(1), key.sign(w.signing(w.accountA, hash(1)))), OK);
});

test("fuzz: 40 random add/remove sequences match a model; signatures follow membership", async () => {
  const w = await DeviceWorld.create();
  for (let run = 0; run < 12; run++) {
    const account = await w.chain.deploy(w.deployer, accountAbi, artifacts.MockAccount.bytecode);
    const pool = Array.from({ length: 6 }, () => new SoftDeviceKey());
    const model = new Set<number>();
    const first = run % pool.length;
    assert.ok((await w.install(account, pool[first]!)).ok);
    model.add(first);
    await w.setRoot(account, w.validator);
    for (let step = 0; step < 24; step++) {
      const index = (run * 5 + step * 3 + (step % 4)) % pool.length;
      const key = pool[index]!;
      if ((run + step) % 2 === 0) {
        const r = await w.addKey(account, key);
        assert.equal(r.ok, !model.has(index), `add run ${run} step ${step}`);
        if (r.ok) model.add(index);
      } else {
        const r = await w.removeKey(account, key.keyId);
        const expected = model.has(index) && model.size > 1;
        assert.equal(r.ok, expected, `remove run ${run} step ${step}`);
        if (r.ok) model.delete(index);
      }
      assert.equal(await w.read<bigint>("keyCount", [account]), BigInt(model.size));
      assert.ok(model.size >= 1, "the final key is never removed while root");
    }
    for (const [index, key] of pool.entries()) {
      const outcome = await w.validate(account, hash(run), key.sign(w.signing(account, hash(run))));
      assert.equal(outcome, model.has(index) ? OK : FAILED, `membership run ${run} key ${index}`);
      assert.equal(await w.read<boolean>("keyExists", [account, key.keyId]), model.has(index));
    }
    assert.equal((await w.read<Hex[]>("keyIds", [account])).length, model.size);
  }
});

// ── clones (fresh instances) ───────────────────────────────────────────────────────────────────

async function withFactory(w: DeviceWorld) {
  const codehash = keccak256(await w.chain.getCode(w.validator));
  const factory = await w.chain.deploy(
    w.deployer,
    factoryAbi,
    artifacts.KaadaPasskeyValidatorFactory.bytecode,
    [w.validator, codehash],
  );
  const clone = async (scope: Address, purpose: number, key: SoftDeviceKey, salt: Hex = ZERO32) => {
    const commitment = passkeyCredentialCommitment({
      x: key.point.x,
      y: key.point.y,
      authenticatorIdHash: key.keyId,
    });
    const r = await w.chain.call(w.stranger, factory, factoryAbi, "deploy", [
      scope,
      purpose,
      commitment,
      salt,
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    return (r.value as [Address, boolean])[0];
  };
  return {
    factory,
    clone,
    commitment: (key: SoftDeviceKey) =>
      passkeyCredentialCommitment({
        x: key.point.x,
        y: key.point.y,
        authenticatorIdHash: key.keyId,
      }),
  };
}

test("behind an EIP-1167 clone: the domain uses the CLONE address, state is per clone, the root check uses the clone", async () => {
  const w = await DeviceWorld.create();
  const { clone, commitment, factory } = await withFactory(w);
  const key = new SoftDeviceKey();
  // the factory commitment accepts device install data (same 96-byte shape)
  const viaFactory = await w.chain.call(w.stranger, factory, factoryAbi, "credentialCommitment", [
    deviceKeyInstallData(key.point, key.keyId),
  ]);
  assert.ok(viaFactory.ok && viaFactory.value === commitment(key));

  const c1 = await clone(w.accountA, PASSKEY_PURPOSE.PRIMARY, key);
  const c2 = await clone(w.accountA, PASSKEY_PURPOSE.ROTATION, key);
  assert.notEqual(c1, c2);
  assert.ok((await w.install(w.accountA, key, c1)).ok);
  assert.equal(await w.read<boolean>("isInitialized", [w.accountA], c1), true);
  assert.equal(
    await w.read<boolean>("isInitialized", [w.accountA], c2),
    false,
    "another clone is untouched",
  );
  assert.equal(
    await w.read<boolean>("isInitialized", [w.accountA], w.validator),
    false,
    "so is the implementation",
  );

  const forClone = key.sign(w.signing(w.accountA, hash(1), c1));
  assert.equal(await w.validate(w.accountA, hash(1), forClone, c1), OK);
  assert.equal(
    await w.validate(w.accountA, hash(1), forClone, w.validator),
    FAILED,
    "not valid on the implementation",
  );
  assert.ok((await w.install(w.accountA, key, c2)).ok);
  assert.equal(
    await w.validate(w.accountA, hash(1), forClone, c2),
    FAILED,
    "not valid on a sibling clone",
  );
  assert.equal(await w.read<bigint>("MAX_KEYS", [], c1), 16n);

  // final-key protection keys off the clone address
  await w.setRoot(w.accountA, c1);
  const last = await w.removeKey(w.accountA, key.keyId, c1);
  assert.equal(last.ok ? "" : last.error, "CannotRemoveFinalKey");
  assert.ok(
    (await w.removeKey(w.accountA, key.keyId, c2)).ok,
    "c2 is not the root, so it may lose its key",
  );
});

test("a root can never be silently reused: a used clone is initialized, a fresh one is available through the factory", async () => {
  const w = await DeviceWorld.create();
  const { clone } = await withFactory(w);
  const oldKey = new SoftDeviceKey();
  const newKey = new SoftDeviceKey();
  const used = await clone(w.accountA, PASSKEY_PURPOSE.PRIMARY, oldKey);
  await w.install(w.accountA, oldKey, used);
  const again = await w.install(w.accountA, newKey, used);
  assert.equal(again.ok ? "" : again.error, "AlreadyInitialized");
  const fresh = await clone(w.accountA, PASSKEY_PURPOSE.RECOVERY, newKey);
  assert.ok((await w.install(w.accountA, newKey, fresh)).ok);
  assert.equal(
    await w.validate(
      w.accountA,
      hash(1),
      newKey.sign(w.signing(w.accountA, hash(1), fresh)),
      fresh,
    ),
    OK,
  );
  assert.equal(
    await w.validate(
      w.accountA,
      hash(1),
      oldKey.sign(w.signing(w.accountA, hash(1), fresh)),
      fresh,
    ),
    FAILED,
  );
});

// ── recovery integration (in-process) ──────────────────────────────────────────────────────────

type RootKey = { kind: "device"; key: SoftDeviceKey } | { kind: "passkey"; key: SoftPasskey };

/** One in-process recovery from `from` to `to`, each as a fresh, never-used clone, scoped to the account. */
async function recoveryScenario(from: RootKey, to: RootKey): Promise<void> {
  const world = await World.create({ contract: "ShortDelayRecoveryValidator" });
  const chain = world.chain;
  const account = world.account;
  await chain.setCode(ZERODEV_PASSKEY_VALIDATOR_MAINNET, ZERODEV_PASSKEY_VALIDATOR_RUNTIME);
  const deviceImpl = await chain.deploy(
    world.deployer,
    validatorAbi,
    artifacts.KaadaDeviceKeyValidator.bytecode,
  );
  const factories = {
    device: await chain.deploy(
      world.deployer,
      factoryAbi,
      artifacts.KaadaPasskeyValidatorFactory.bytecode,
      [deviceImpl, keccak256(await chain.getCode(deviceImpl))],
    ),
    passkey: await chain.deploy(
      world.deployer,
      factoryAbi,
      artifacts.KaadaPasskeyValidatorFactory.bytecode,
      [ZERODEV_PASSKEY_VALIDATOR_MAINNET, ZERODEV_PASSKEY_VALIDATOR_CODEHASH],
    ),
  };
  const impls = { device: deviceImpl, passkey: ZERODEV_PASSKEY_VALIDATOR_MAINNET } as const;
  const credentialOf = (r: RootKey) =>
    r.kind === "device"
      ? { x: r.key.point.x, y: r.key.point.y, authenticatorIdHash: r.key.keyId }
      : r.key.credential;
  const installData = (r: RootKey) =>
    r.kind === "device"
      ? deviceKeyInstallData(r.key.point, r.key.keyId)
      : passkeyInstallData(r.key.credential);
  const instanceFor = (r: RootKey, purpose: 0 | 1) => {
    const input = { scope: account, purpose, credential: credentialOf(r) } as const;
    return {
      address: predictPasskeyInstance(factories[r.kind], impls[r.kind], input),
      deploy: async () => {
        const out = await chain.call(world.stranger, factories[r.kind], factoryAbi, "deploy", [
          account,
          purpose,
          passkeyCredentialCommitment(credentialOf(r)),
          ZERO32,
        ]);
        assert.ok(out.ok, out.ok ? "" : out.error);
      },
    };
  };
  const asAccount = (target: Address, data: Hex) =>
    chain.call(world.stranger, account, accountAbi, "forward", [target, data]);
  const signFor = (r: RootKey, instance: Address, userOpHash: Hex): Hex =>
    r.kind === "device"
      ? r.key.sign({ chainId: chain.chainId, validator: instance, account, userOpHash })
      : r.key.sign(userOpHash);
  const validate = async (instance: Address, signature: Hex, userOpHash: Hex): Promise<bigint> => {
    const abi = validatorAbi; // both validators share validateUserOp's ABI
    const out = await asAccount(
      instance,
      encodeFunctionData({
        abi,
        functionName: "validateUserOp",
        args: [
          {
            sender: account,
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            accountGasLimits: ZERO32,
            preVerificationGas: 0n,
            gasFees: ZERO32,
            paymasterAndData: "0x",
            signature,
          },
          userOpHash,
        ],
      }),
    );
    const [ok, ret] = out.ok ? (out.value as [boolean, Hex]) : [false, "0x" as Hex];
    return ok ? BigInt(ret) : -1n;
  };

  // the account's current root: a primary clone for the SOURCE credential
  const source = instanceFor(from, 0);
  await source.deploy();
  const installed = await asAccount(
    source.address,
    encodeFunctionData({ abi: validatorAbi, functionName: "onInstall", args: [installData(from)] }),
  );
  assert.ok(installed.ok && (installed.value as [boolean])[0], "source root installed");
  assert.equal(
    await validate(source.address, signFor(from, source.address, hash(30)), hash(30)),
    OK,
    "source root works",
  );

  // recovery: commit to the PREDICTED clone of the target credential and its exact install data
  assert.ok((await world.install({ delay: 10 })).ok);
  const target = instanceFor(to, 1);
  const committed = world.root({ rootId: rootId(target.address), validatorData: installData(to) });
  assert.equal(
    (await world.initiate(committed)).ok,
    false,
    "a clone with no code cannot be committed",
  );
  await target.deploy();
  assert.ok((await world.initiate(committed)).ok);
  world.chain.warp(11);
  const nonce = await world.currentNonce();
  // every committed parameter matters: the validator data of ANOTHER key, another validator, another hook
  const otherData =
    to.kind === "device"
      ? deviceKeyInstallData(new SoftDeviceKey().point, labelledKeyId("x"))
      : passkeyInstallData(new SoftPasskey().credential);
  assert.equal(
    (
      await world.validate(
        batch(world.exactCalls({ ...committed, validatorData: otherData }, nonce)),
      )
    ).ok,
    false,
    "other install data",
  );
  assert.equal(
    (
      await world.validate(
        batch(world.exactCalls({ ...committed, rootId: rootId(source.address) }, nonce)),
      )
    ).ok,
    false,
    "other validator",
  );
  assert.equal(
    (
      await world.validate(
        batch(
          world.exactCalls(
            { ...committed, hook: "0x4000000000000000000000000000000000000004" },
            nonce,
          ),
        ),
      )
    ).ok,
    false,
    "other hook",
  );
  const done = await world.validate(batch(world.exactCalls(committed, nonce)));
  assert.ok(done.ok, done.error);

  // what Kernel then does with the committed data on the committed clone
  const reinstall = await asAccount(
    target.address,
    encodeFunctionData({ abi: validatorAbi, functionName: "onInstall", args: [installData(to)] }),
  );
  assert.ok(reinstall.ok && (reinstall.value as [boolean])[0], "target root installed");
  assert.equal(
    await validate(target.address, signFor(to, target.address, hash(31)), hash(31)),
    OK,
    "the recovered credential signs",
  );
  assert.notEqual(
    await validate(target.address, signFor(from, target.address, hash(32)), hash(32)),
    OK,
    "the old credential does not sign on the new root",
  );
  assert.notEqual(target.address, source.address);
}

test("recovery: passkey root -> device-key root", async () => {
  await recoveryScenario(
    { kind: "passkey", key: new SoftPasskey() },
    { kind: "device", key: new SoftDeviceKey() },
  );
});
test("recovery: device-key root -> passkey root", async () => {
  await recoveryScenario(
    { kind: "device", key: new SoftDeviceKey() },
    { kind: "passkey", key: new SoftPasskey() },
  );
});
test("recovery: device-key root -> a different device-key root", async () => {
  await recoveryScenario(
    { kind: "device", key: new SoftDeviceKey() },
    { kind: "device", key: new SoftDeviceKey() },
  );
});

// ── tiers (off-chain policy) ───────────────────────────────────────────────────────────────────

const point: DeviceKeyPoint = { x: 1n, y: 2n };
const hardware: AttestationVerifier = {
  verify: () =>
    Promise.resolve({ publicKeyMatches: true, hardwareBacked: true, challengeMatches: true }),
};

test("tier: a client claim never upgrades; only a verified attestation does; web is capped", async () => {
  const evidence = { platform: "ios" as const, payload: "opaque", challenge: hash(1) };
  assert.equal(await classifyDeviceKey({ channel: "native-ios", point }), "unknown");
  assert.equal(
    await classifyDeviceKey({ channel: "native-ios", point, evidence }),
    "unknown",
    "evidence without a verifier",
  );
  assert.equal(
    await classifyDeviceKey({ channel: "native-ios", point, evidence, verifier: hardware }),
    "trusted-device",
  );
  assert.equal(await classifyDeviceKey({ channel: "web", point }), "web-non-extractable");
  // a web enrolment cannot become trusted, even with evidence and a permissive verifier
  assert.equal(
    await classifyDeviceKey({ channel: "web", point, evidence, verifier: hardware }),
    "web-non-extractable",
  );
  assert.equal(
    await classifyDeviceKey({ channel: "unknown", point, evidence, verifier: hardware }),
    "unknown",
  );
  // platform mismatch
  assert.equal(
    await classifyDeviceKey({ channel: "native-android", point, evidence, verifier: hardware }),
    "unknown",
  );
  // every failing verifier outcome downgrades
  const failing: AttestationVerifier[] = [
    { verify: () => Promise.resolve(null) },
    {
      verify: () =>
        Promise.resolve({
          publicKeyMatches: false,
          hardwareBacked: true,
          challengeMatches: true,
        }),
    },
    {
      verify: () =>
        Promise.resolve({
          publicKeyMatches: true,
          hardwareBacked: false,
          challengeMatches: true,
        }),
    },
    {
      verify: () =>
        Promise.resolve({
          publicKeyMatches: true,
          hardwareBacked: true,
          challengeMatches: false,
        }),
    },
    {
      verify: () => Promise.reject(new Error("boom")),
    },
  ];
  for (const verifier of failing) {
    assert.equal(
      await classifyDeviceKey({ channel: "native-ios", point, evidence, verifier }),
      "unknown",
    );
  }
});

test("platform signatures: DER parsing and low-s normalisation", () => {
  const key = p256.utils.randomPrivateKey();
  for (let i = 0; i < 50; i++) {
    const digest = keccak256(toHex(`m${i}`));
    const signature = p256.sign(Buffer.from(digest.slice(2), "hex"), key, { lowS: false });
    const parsed = parseDerSignature(signature.toDERRawBytes());
    assert.equal(parsed.r, signature.r);
    assert.equal(parsed.s, signature.s);
    const low = normalizeLowS(parsed.s);
    assert.ok(low <= P256_HALF_N);
    assert.ok(low === parsed.s || low === P256_N - parsed.s);
  }
  for (const bad of [
    new Uint8Array(),
    new Uint8Array([0x30, 0x00]),
    new Uint8Array([0x31, 0x06, 2, 1, 1, 2, 1, 1]),
    new Uint8Array([0x30, 0x07, 2, 1, 1, 2, 1, 1, 0]),
  ]) {
    assert.throws(() => parseDerSignature(bad));
  }
});

// ── structure, size, gas ───────────────────────────────────────────────────────────────────────

test("the validator has no CALL, DELEGATECALL, CALLCODE, CREATE or SELFDESTRUCT (only STATICCALL), and no payable admin", () => {
  const full = Buffer.from(artifacts.KaadaDeviceKeyValidator.deployedBytecode.slice(2), "hex");
  const code = full.subarray(0, full.length - 2 - full.readUInt16BE(full.length - 2));
  const ops = new Set<number>();
  for (let i = 0; i < code.length;) {
    const op = code[i]!;
    ops.add(op);
    i += op >= 0x60 && op <= 0x7f ? 2 + (op - 0x60) : 1;
  }
  for (const [name, op] of Object.entries({
    CALL: 0xf1,
    CALLCODE: 0xf2,
    DELEGATECALL: 0xf4,
    CREATE: 0xf0,
    CREATE2: 0xf5,
    SELFDESTRUCT: 0xff,
  })) {
    assert.ok(!ops.has(op), `${name} present`);
  }
  assert.ok(ops.has(0xfa), "STATICCALL (the precompile and the root check)");
  const fns = (
    artifacts.KaadaDeviceKeyValidator.abi as readonly {
      type: string;
      name?: string;
      stateMutability?: string;
    }[]
  ).filter((e) => e.type === "function");
  const payable = fns.filter((f) => f.stateMutability === "payable").map((f) => f.name);
  assert.deepEqual(
    payable,
    ["validateUserOp"],
    "only the 4337 hook is payable (its ABI), nothing administrative",
  );
  const names = fns.map((f) => f.name).sort();
  assert.ok(
    !names.some((n) => /owner|admin|upgrade|^set|transfer|withdraw|^initialize/i.test(n ?? "")),
    names.join(","),
  );
});

test("gas and size notes", async () => {
  const w = await DeviceWorld.create();
  const k1 = new SoftDeviceKey();
  const k2 = new SoftDeviceKey();
  const install = await w.install(w.accountA, k1);
  const add = await w.addKey(w.accountA, k2);
  await w.setRoot(w.accountA, "0x3000000000000000000000000000000000000003");
  const remove = await w.removeKey(w.accountA, k2.keyId);
  assert.ok(install.ok && add.ok && remove.ok);
  const w2 = await DeviceWorld.create();
  const rawGas = async (data: Hex, account: Address) => {
    const r = await w2.chain.call(w2.stranger, account, accountAbi, "forward", [
      w2.validator,
      data,
    ]);
    assert.ok(r.ok && (r.value as [boolean])[0], "inner call succeeded");
    return r.gasUsed;
  };
  const k3 = new SoftDeviceKey();
  const installGas = await rawGas(
    w2.fn("onInstall", [deviceKeyInstallData(k3.point, k3.keyId)]),
    w2.accountA,
  );
  const k4 = new SoftDeviceKey();
  const addGas = await rawGas(w2.fn("addKey", [k4.keyId, k4.point.x, k4.point.y]), w2.accountA);
  const validate = await w2.chain.call(w2.stranger, w2.accountA, accountAbi, "forward", [
    w2.validator,
    w2.fn("validateUserOp", [
      w2.userOp(k3.sign(w2.signing(w2.accountA, hash(1))), w2.accountA),
      hash(1),
    ]),
  ]);
  assert.ok(validate.ok && (validate.value as [boolean, Hex])[0]);
  const removeGas = await rawGas(w2.fn("removeKey", [k4.keyId]), w2.accountA);
  const size = (artifacts.KaadaDeviceKeyValidator.deployedBytecode.length - 2) / 2;
  console.log(
    `[gas] device validator runtime ${size} B | onInstall ${installGas} | addKey ${addGas} | removeKey ${removeGas} | validateUserOp ${validate.gasUsed} (execution gas, includes the 3450 precompile)`,
  );
  assert.ok(size < 8192);
  assert.ok(validate.gasUsed < 120_000n);
});

test("isOnP256Curve agrees with the validator on valid and invalid points", async () => {
  const { isOnP256Curve } = await import("./device-key.js");
  for (let i = 0; i < 20; i++) {
    const key = new SoftDeviceKey();
    assert.equal(isOnP256Curve(key.point), true);
    assert.equal(isOnP256Curve({ x: key.point.x, y: key.point.y + 1n }), false);
    assert.equal(isOnP256Curve({ x: key.point.x + 1n, y: key.point.y }), false);
  }
  assert.equal(isOnP256Curve({ x: 0n, y: 1n }), false);
  assert.equal(isOnP256Curve({ x: 1n, y: 0n }), false);
  assert.equal(isOnP256Curve({ x: 2n ** 256n - 1n, y: 5n }), false);
});
