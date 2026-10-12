import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeEventLog, encodeFunctionData, keccak256, pad, parseAbi, toHex } from "viem";
import type { Abi, Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { artifacts } from "./generated/artifacts.js";
import {
  ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
  ZERODEV_PASSKEY_VALIDATOR_MAINNET,
  ZERODEV_PASSKEY_VALIDATOR_RUNTIME,
} from "./generated/passkey-validator.js";
import {
  PASSKEY_PURPOSE,
  eip1167InitCode,
  passkeyCredentialCommitment,
  passkeyInstallData,
  passkeyInstanceSalt,
  predictPasskeyInstance,
} from "./passkey-factory.js";
import type { PasskeyCredential, PasskeyPurpose } from "./passkey-factory.js";
import { TestChain, describeRevert } from "./testing/evm.js";
import { SoftPasskey } from "./testing/passkey.js";
import { World, accountAbi, batch } from "./testing/recovery-world.js";

const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const validatorAbi = parseAbi([
  "function onInstall(bytes data)",
  "function onUninstall(bytes data)",
  "function isInitialized(address account) view returns (bool)",
  "function isModuleType(uint256 id) view returns (bool)",
  "function validateUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, bytes32 userOpHash) payable returns (uint256)",
  "error AlreadyInitialized(address smartAccount)",
]);

const ZERO_SALT: Hex = pad("0x", { size: 32 });
const STATUS = { NOT_DEPLOYED: 0, DEPLOYED_UNUSED: 1, INITIALIZED_FOR_ACCOUNT: 2 } as const;

class FactoryWorld {
  readonly deployer: Address = "0x1000000000000000000000000000000000000001";
  readonly stranger: Address = "0x1000000000000000000000000000000000000002";
  readonly attacker: Address = "0x1000000000000000000000000000000000000bad";
  readonly implementation = ZERODEV_PASSKEY_VALIDATOR_MAINNET;

  private constructor(
    readonly chain: TestChain,
    readonly factory: Address,
    readonly accountA: Address,
    readonly accountB: Address,
  ) {}

  static async create(chain?: TestChain): Promise<FactoryWorld> {
    const c = chain ?? (await TestChain.create(11142220n));
    const deployer: Address = "0x1000000000000000000000000000000000000001";
    await c.setCode(ZERODEV_PASSKEY_VALIDATOR_MAINNET, ZERODEV_PASSKEY_VALIDATOR_RUNTIME);
    const factory = await c.deploy(
      deployer,
      factoryAbi,
      artifacts.KaadaPasskeyValidatorFactory.bytecode,
      [ZERODEV_PASSKEY_VALIDATOR_MAINNET, ZERODEV_PASSKEY_VALIDATOR_CODEHASH],
    );
    const accountA = await c.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    const accountB = await c.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    return new FactoryWorld(c, factory, accountA, accountB);
  }

  input(account: Address, credential: PasskeyCredential, purpose: PasskeyPurpose = 0, salt?: Hex) {
    return { scope: account, purpose, credential, ...(salt ? { deploymentSalt: salt } : {}) };
  }

  predict(
    account: Address,
    credential: PasskeyCredential,
    purpose: PasskeyPurpose = 0,
    salt?: Hex,
  ) {
    return predictPasskeyInstance(
      this.factory,
      this.implementation,
      this.input(account, credential, purpose, salt),
    );
  }

  args(account: Address, credential: PasskeyCredential, purpose: PasskeyPurpose = 0, salt?: Hex) {
    return [
      account,
      purpose,
      passkeyCredentialCommitment(credential),
      salt ?? ZERO_SALT,
    ] as unknown[];
  }

  async deploy(
    account: Address,
    credential: PasskeyCredential,
    purpose: PasskeyPurpose = 0,
    salt?: Hex,
    sender: Address = this.stranger,
  ) {
    return this.chain.call(
      sender,
      this.factory,
      factoryAbi,
      "deploy",
      this.args(account, credential, purpose, salt),
    );
  }

  async view<T>(name: string, args: unknown[]): Promise<T> {
    const r = await this.chain.call(this.stranger, this.factory, factoryAbi, name, args);
    if (!r.ok) throw new Error(`${name} reverted: ${r.error}`);
    return r.value as T;
  }

  /** `account` (a MockAccount) calls `target` as itself, like Kernel does. */
  async asAccount(account: Address, target: Address, data: Hex) {
    const r = await this.chain.call(this.stranger, account, accountAbi, "forward", [target, data]);
    if (!r.ok) return { ok: false as const, error: r.error };
    const [ok, ret] = r.value as [boolean, Hex];
    return ok
      ? { ok: true as const, ret }
      : { ok: false as const, error: describeRevert(validatorAbi, ret), ret };
  }

  async install(account: Address, instance: Address, credential: PasskeyCredential) {
    return this.asAccount(
      account,
      instance,
      encodeFunctionData({
        abi: validatorAbi,
        functionName: "onInstall",
        args: [passkeyInstallData(credential)],
      }),
    );
  }

  /** Kernel's call: validateUserOp with msg.sender == account. Returns the validation data (0 = valid). */
  async validate(account: Address, instance: Address, hash: Hex, signature: Hex): Promise<bigint> {
    const r = await this.asAccount(
      account,
      instance,
      encodeFunctionData({
        abi: validatorAbi,
        functionName: "validateUserOp",
        args: [
          {
            sender: account,
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            accountGasLimits: ZERO_SALT,
            preVerificationGas: 0n,
            gasFees: ZERO_SALT,
            paymasterAndData: "0x",
            signature,
          },
          hash,
        ],
      }),
    );
    if (!r.ok) return -1n;
    return BigInt(r.ret);
  }

  async isInitialized(instance: Address, account: Address): Promise<boolean> {
    const r = await this.chain.call(this.stranger, instance, validatorAbi, "isInitialized", [
      account,
    ]);
    if (!r.ok) throw new Error(`isInitialized reverted: ${r.error}`);
    return r.value as boolean;
  }
}

const describeOutcome = (r: unknown): string =>
  JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const hash = (n: number): Hex => pad(toHex(n + 1), { size: 32 });

// ── fixture integrity ──────────────────────────────────────────────────────────────────────────

test("the verified ZeroDev passkey validator runtime is pinned by code hash", () => {
  assert.equal(keccak256(ZERODEV_PASSKEY_VALIDATOR_RUNTIME), ZERODEV_PASSKEY_VALIDATOR_CODEHASH);
});

test("the implementation has no SELFDESTRUCT, DELEGATECALL, CALLCODE, CALL, CREATE or ADDRESS opcode", () => {
  const code = Buffer.from(ZERODEV_PASSKEY_VALIDATOR_RUNTIME.slice(2), "hex");
  const found = new Set<number>();
  for (let i = 0; i < code.length;) {
    const op = code[i]!;
    found.add(op);
    i += op >= 0x60 && op <= 0x7f ? 2 + (op - 0x60) : 1;
  }
  for (const [name, op] of Object.entries({
    SELFDESTRUCT: 0xff,
    DELEGATECALL: 0xf4,
    CALLCODE: 0xf2,
    CALL: 0xf1,
    CREATE: 0xf0,
    CREATE2: 0xf5,
    ADDRESS: 0x30,
    CODECOPY: 0x39,
  })) {
    assert.ok(!found.has(op), `${name} present in the passkey validator`);
  }
});

// ── deterministic addressing ───────────────────────────────────────────────────────────────────

test("predicted address == deployed address, emitted in the event, runtime is the 45-byte EIP-1167 proxy", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const predicted = w.predict(w.accountA, key.credential);
  assert.equal(await w.chain.getCode(predicted), "0x", "nothing there before");
  const result = await w.deploy(w.accountA, key.credential);
  assert.ok(result.ok, result.ok ? "" : result.error);
  const [instance, created] = result.ok ? (result.value as [Address, boolean]) : ["0x", false];
  assert.equal(instance.toLowerCase(), predicted.toLowerCase());
  assert.equal(created, true);
  assert.equal(
    (await w.view<Address>("predictInstance", w.args(w.accountA, key.credential))).toLowerCase(),
    predicted.toLowerCase(),
  );
  assert.equal(
    await w.chain.getCode(predicted),
    `0x363d3d373d3d3d363d73${ZERODEV_PASSKEY_VALIDATOR_MAINNET.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`,
  );
  const event = result.ok
    ? result.logs
        .map((l) => {
          try {
            return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics as never });
          } catch {
            return undefined;
          }
        })
        .find((e) => e?.eventName === "InstanceDeployed")
    : undefined;
  assert.ok(event, "InstanceDeployed emitted");
  const args = event.args as unknown as {
    instance: Address;
    scope: Address;
    purpose: number;
    credentialCommitment: Hex;
    deploymentSalt: Hex;
  };
  assert.equal(args.instance.toLowerCase(), predicted.toLowerCase());
  assert.equal(args.scope.toLowerCase(), w.accountA.toLowerCase());
  assert.equal(args.purpose, 0);
  assert.equal(args.credentialCommitment, passkeyCredentialCommitment(key.credential));
  assert.equal(eip1167InitCode(w.implementation).length, 2 + 2 * 55);
});

test("deploying again is idempotent: same address, created=false, no second event", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const first = await w.deploy(w.accountA, key.credential);
  const second = await w.deploy(w.accountB, key.credential, 0, undefined, w.attacker);
  assert.ok(first.ok && second.ok);
  const again = await w.deploy(w.accountA, key.credential, 0, undefined, w.attacker);
  assert.ok(again.ok);
  if (again.ok) {
    assert.deepEqual((again.value as [Address, boolean])[1], false);
    assert.equal(
      (again.value as [Address, boolean])[0],
      ((first.ok ? first.value : []) as Address[])[0],
    );
    assert.equal(again.logs.length, 0);
  }
  // account B's instance is a different one
  if (first.ok && second.ok)
    assert.notEqual((first.value as [Address])[0], (second.value as [Address])[0]);
});

test("every input changes the address: credential, account, purpose, deployment salt, factory, implementation", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const other = new SoftPasskey();
  const base = w.predict(w.accountA, key.credential);
  const seen = new Map<string, string>([[base.toLowerCase(), "base"]]);
  const record = (name: string, address: Address) => {
    assert.ok(
      !seen.has(address.toLowerCase()),
      `${name} collides with ${seen.get(address.toLowerCase())}`,
    );
    seen.set(address.toLowerCase(), name);
  };
  record("other credential", w.predict(w.accountA, other.credential));
  record("other account", w.predict(w.accountB, key.credential));
  for (const purpose of [1, 2, 3] as const)
    record(`purpose ${purpose}`, w.predict(w.accountA, key.credential, purpose));
  record("salt 1", w.predict(w.accountA, key.credential, 0, pad("0x01", { size: 32 })));
  record("salt 2", w.predict(w.accountA, key.credential, 0, pad("0x02", { size: 32 })));
  record("x changed", w.predict(w.accountA, { ...key.credential, x: key.credential.x + 1n }));
  record("y changed", w.predict(w.accountA, { ...key.credential, y: key.credential.y + 1n }));
  record(
    "authenticator id changed",
    w.predict(w.accountA, { ...key.credential, authenticatorIdHash: hash(7) }),
  );
  record(
    "other factory",
    predictPasskeyInstance(
      "0x2000000000000000000000000000000000000002",
      w.implementation,
      w.input(w.accountA, key.credential),
    ),
  );
  record(
    "other implementation",
    predictPasskeyInstance(
      w.factory,
      "0x2000000000000000000000000000000000000003",
      w.input(w.accountA, key.credential),
    ),
  );
});

test("TypeScript derivation == the contract for salt, commitment and address", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const commitment = passkeyCredentialCommitment(key.credential);
  assert.equal(
    await w.view<Hex>("credentialCommitment", [passkeyInstallData(key.credential)]),
    commitment,
  );
  for (const purpose of [0, 1, 2, 3] as const) {
    const salt = pad(toHex(purpose * 7), { size: 32 });
    assert.equal(
      await w.view<Hex>("saltFor", [w.accountA, purpose, commitment, salt]),
      passkeyInstanceSalt(w.input(w.accountA, key.credential, purpose, salt)),
    );
  }
});

test("fuzz: 300 random inputs, contract address == TS address, and all addresses are distinct", async () => {
  const w = await FactoryWorld.create();
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const credential: PasskeyCredential = {
      x: BigInt(keccak256(toHex(`x${i}`))),
      y: BigInt(keccak256(toHex(`y${i}`))),
      authenticatorIdHash: keccak256(toHex(`id${i}`)),
    };
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const purpose = (i % 4) as PasskeyPurpose;
    const salt = keccak256(toHex(`salt${i}`));
    const fromChain = await w.view<Address>(
      "predictInstance",
      w.args(account, credential, purpose, salt),
    );
    const fromTs = w.predict(account, credential, purpose, salt);
    assert.equal(fromChain.toLowerCase(), fromTs.toLowerCase(), `mismatch at ${i}`);
    assert.ok(!seen.has(fromTs.toLowerCase()), `collision at ${i}`);
    seen.add(fromTs.toLowerCase());
  }
});

test("fuzz: changing exactly one field always changes the address", async () => {
  const w = await FactoryWorld.create();
  for (let i = 0; i < 60; i++) {
    const key = new SoftPasskey();
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const salt = keccak256(toHex(`s${i}`));
    const base = w.predict(account, key.credential, 0, salt).toLowerCase();
    const variants = [
      w.predict(account, key.credential, 1, salt),
      w.predict(account, key.credential, 0, keccak256(salt)),
      w.predict(privateKeyToAccount(generatePrivateKey()).address, key.credential, 0, salt),
      w.predict(account, new SoftPasskey().credential, 0, salt),
    ];
    for (const v of variants) assert.notEqual(v.toLowerCase(), base);
  }
});

test("malformed or zero inputs are rejected, including from deploy", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const commitment = passkeyCredentialCommitment(key.credential);
  const zeroAddress: Address = "0x0000000000000000000000000000000000000000";
  const reject = async (name: string, args: unknown[], expected: string) => {
    for (const fn of ["predictInstance", "deploy", "saltFor", "isDeployed"]) {
      const r = await w.chain.call(w.stranger, w.factory, factoryAbi, fn, args);
      assert.ok(!r.ok, `${fn} accepted ${name}`);
      if (!r.ok) assert.equal(r.error, expected, `${fn}: ${name}`);
    }
  };
  await reject("zero scope for RECOVERY", [zeroAddress, 1, commitment, ZERO_SALT], "ZeroAccount");
  await reject("zero scope for BACKUP", [zeroAddress, 2, commitment, ZERO_SALT], "ZeroAccount");
  await reject("zero scope for ROTATION", [zeroAddress, 3, commitment, ZERO_SALT], "ZeroAccount");
  await reject(
    "zero commitment",
    [w.accountA, 0, ZERO_SALT, ZERO_SALT],
    "ZeroCredentialCommitment",
  );
  await reject("purpose 4", [w.accountA, 4, commitment, ZERO_SALT], "InvalidPurpose");
  await reject("purpose 255", [w.accountA, 255, commitment, ZERO_SALT], "InvalidPurpose");
  assert.equal(await w.chain.getCode(w.predict(w.accountA, key.credential)), "0x");

  const data = passkeyInstallData(key.credential);
  for (const [name, bad] of [
    ["empty", "0x"],
    ["short", data.slice(0, data.length - 2)],
    ["long", `${data}00`],
    ["zero x", passkeyInstallData({ ...key.credential, x: 0n })],
    ["zero y", passkeyInstallData({ ...key.credential, y: 0n })],
  ] as const) {
    const r = await w.chain.call(w.stranger, w.factory, factoryAbi, "credentialCommitment", [bad]);
    assert.ok(!r.ok, name);
    if (!r.ok) assert.equal(r.error, "MalformedValidatorData", name);
  }
  assert.throws(() => passkeyInstanceSalt({ ...w.input(zeroAddress, key.credential, 1) }));
  // the preflight needs a real account
  const noAccount = await w.chain.call(w.stranger, w.factory, factoryAbi, "statusOf", [
    w.accountA,
    zeroAddress,
    0,
    commitment,
    ZERO_SALT,
  ]);
  assert.ok(!noAccount.ok && noAccount.error === "ZeroAccount");
  assert.throws(() => passkeyCredentialCommitment({ ...key.credential, x: 0n }));
});

test("the constructor refuses a missing implementation and a code-hash mismatch", async () => {
  const chain = await TestChain.create();
  const deployer: Address = "0x1000000000000000000000000000000000000001";
  await assert.rejects(() =>
    chain.deploy(deployer, factoryAbi, artifacts.KaadaPasskeyValidatorFactory.bytecode, [
      "0x2000000000000000000000000000000000000009",
      ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
    ]),
  );
  await chain.setCode(ZERODEV_PASSKEY_VALIDATOR_MAINNET, ZERODEV_PASSKEY_VALIDATOR_RUNTIME);
  await assert.rejects(() =>
    chain.deploy(deployer, factoryAbi, artifacts.KaadaPasskeyValidatorFactory.bytecode, [
      ZERODEV_PASSKEY_VALIDATOR_MAINNET,
      hash(1),
    ]),
  );
});

// ── factory has no powers ──────────────────────────────────────────────────────────────────────

test("the factory runtime has no CALL, DELEGATECALL, CALLCODE, SELFDESTRUCT or CREATE (only CREATE2 and STATICCALL)", () => {
  const full = Buffer.from(artifacts.KaadaPasskeyValidatorFactory.deployedBytecode.slice(2), "hex");
  // drop the CBOR metadata trailer (its length is in the last two bytes): it is data, not code
  const code = full.subarray(0, full.length - 2 - full.readUInt16BE(full.length - 2));
  const ops = new Set<number>();
  // Walk the opcodes, skipping PUSH data; stop at the metadata trailer (it follows the last INVALID/STOP).
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
    SELFDESTRUCT: 0xff,
  })) {
    assert.ok(!ops.has(op), `${name} present`);
  }
  assert.ok(ops.has(0xf5), "CREATE2 present");
  assert.ok(ops.has(0xfa), "STATICCALL present (isInitialized view)");
});

test("the factory accepts no ETH and exposes no admin, owner or upgrade function", async () => {
  const w = await FactoryWorld.create();
  const sent = await w.chain.raw({ from: w.stranger, to: w.factory, data: "0x", value: 1n });
  assert.equal(sent.ok, false, "receive/fallback must not exist");
  const names = (factoryAbi as readonly { type: string; name?: string; stateMutability?: string }[])
    .filter((e) => e.type === "function")
    .map((e) => e.name);
  assert.deepEqual(
    names.sort(),
    [
      "CREDENTIAL_DOMAIN",
      "FACTORY_VERSION",
      "IMPLEMENTATION",
      "IMPLEMENTATION_CODEHASH",
      "PURPOSE_BACKUP",
      "PURPOSE_PRIMARY",
      "PURPOSE_RECOVERY",
      "PURPOSE_ROTATION",
      "SALT_DOMAIN",
      "canUseForAccount",
      "credentialCommitment",
      "deploy",
      "isDeployed",
      "predictInstance",
      "saltFor",
      "statusOf",
    ].sort(),
  );
  const payable = (factoryAbi as readonly { type: string; stateMutability?: string }[]).filter(
    (e) => e.stateMutability === "payable",
  );
  assert.equal(payable.length, 0);
});

// ── initialization safety ──────────────────────────────────────────────────────────────────────

test("first initialization succeeds, second fails, status and canUseForAccount track it", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const args = w.args(w.accountA, key.credential);
  const instance = w.predict(w.accountA, key.credential);

  assert.equal(await w.view<number>("statusOf", [w.accountA, ...args]), STATUS.NOT_DEPLOYED);
  assert.equal(await w.view<boolean>("isDeployed", args), false);
  assert.equal(await w.view<boolean>("canUseForAccount", [w.accountA, ...args]), true);

  await w.deploy(w.accountA, key.credential);
  assert.equal(await w.view<boolean>("isDeployed", args), true);
  assert.equal(await w.view<number>("statusOf", [w.accountA, ...args]), STATUS.DEPLOYED_UNUSED);
  assert.equal(await w.view<boolean>("canUseForAccount", [w.accountA, ...args]), true);

  const first = await w.install(w.accountA, instance, key.credential);
  assert.ok(first.ok, describeOutcome(first));
  assert.equal(await w.isInitialized(instance, w.accountA), true);
  assert.equal(
    await w.view<number>("statusOf", [w.accountA, ...args]),
    STATUS.INITIALIZED_FOR_ACCOUNT,
  );
  assert.equal(
    await w.view<boolean>("canUseForAccount", [w.accountA, ...args]),
    false,
    "an initialized instance must be flagged",
  );

  const second = await w.install(w.accountA, instance, new SoftPasskey().credential);
  assert.equal(second.ok, false);
  assert.match(String(second.ok ? "" : second.error), /AlreadyInitialized|revert/);
  // and the original key is still the only one that signs
  assert.equal(await w.validate(w.accountA, instance, hash(1), key.sign(hash(1))), 0n);
});

test("another account uses its own deterministic instance, independently", async () => {
  const w = await FactoryWorld.create();
  const keyA = new SoftPasskey();
  const keyB = new SoftPasskey();
  await w.deploy(w.accountA, keyA.credential);
  await w.deploy(w.accountB, keyB.credential);
  const a = w.predict(w.accountA, keyA.credential);
  const b = w.predict(w.accountB, keyB.credential);
  assert.notEqual(a, b);
  assert.ok((await w.install(w.accountA, a, keyA.credential)).ok);
  assert.ok((await w.install(w.accountB, b, keyB.credential)).ok);
  assert.equal(await w.validate(w.accountA, a, hash(2), keyA.sign(hash(2))), 0n);
  assert.equal(await w.validate(w.accountB, b, hash(3), keyB.sign(hash(3))), 0n);
  // keys are not interchangeable across accounts
  assert.notEqual(await w.validate(w.accountA, a, hash(4), keyB.sign(hash(4))), 0n);
  assert.notEqual(await w.validate(w.accountB, b, hash(5), keyA.sign(hash(5))), 0n);
  // a signature for one hash is not valid for another
  assert.notEqual(await w.validate(w.accountA, a, hash(6), keyA.sign(hash(7))), 0n);
});

test("front-running: an attacker who deploys the instance, or calls onInstall on it, cannot affect the victim", async () => {
  const w = await FactoryWorld.create();
  const victimKey = new SoftPasskey();
  const attackerKey = new SoftPasskey();
  const instance = w.predict(w.accountA, victimKey.credential);

  // 1. the attacker pre-deploys the victim's instance (anyone may)
  const deployed = await w.deploy(w.accountA, victimKey.credential, 0, undefined, w.attacker);
  assert.ok(
    deployed.ok &&
      (deployed.value as [Address, boolean])[0].toLowerCase() === instance.toLowerCase(),
  );
  assert.equal(
    await w.isInitialized(instance, w.accountA),
    false,
    "pre-deployment initializes nothing",
  );

  // 2. the attacker calls onInstall directly with their own key: it is stored under the ATTACKER's address
  const direct = await w.chain.call(w.attacker, instance, validatorAbi, "onInstall", [
    passkeyInstallData(attackerKey.credential),
  ]);
  assert.ok(direct.ok, "an EOA initializing its own entry is allowed and irrelevant");
  assert.equal(
    await w.isInitialized(instance, w.accountA),
    false,
    "the victim's entry is untouched",
  );
  assert.equal(await w.isInitialized(instance, w.attacker), true);

  // 3. a second attacker-controlled "account" can do the same, still nothing for the victim
  assert.ok((await w.install(w.accountB, instance, attackerKey.credential)).ok);
  assert.equal(await w.isInitialized(instance, w.accountA), false);

  // 4. the victim then initializes normally and only the victim's key signs for the victim
  assert.ok((await w.install(w.accountA, instance, victimKey.credential)).ok);
  assert.equal(await w.validate(w.accountA, instance, hash(8), victimKey.sign(hash(8))), 0n);
  assert.notEqual(await w.validate(w.accountA, instance, hash(9), attackerKey.sign(hash(9))), 0n);
  // the attacker's key signs only for the entries the attacker created (their own accounts), never the victim's
  assert.equal(await w.validate(w.accountB, instance, hash(10), attackerKey.sign(hash(10))), 0n);
});

test("a recovered credential gets a fresh, usable instance; the old instance keeps existing but its key is only the old key", async () => {
  const w = await FactoryWorld.create();
  const oldKey = new SoftPasskey();
  const newKey = new SoftPasskey();
  await w.deploy(w.accountA, oldKey.credential, PASSKEY_PURPOSE.PRIMARY);
  const oldInstance = w.predict(w.accountA, oldKey.credential, PASSKEY_PURPOSE.PRIMARY);
  assert.ok((await w.install(w.accountA, oldInstance, oldKey.credential)).ok);

  // The reuse hazard: installing the NEW key on the OLD instance is refused by the validator
  const reuse = await w.install(w.accountA, oldInstance, newKey.credential);
  assert.equal(reuse.ok, false);

  // The factory makes the hazard detectable and offers a fresh address for the new credential
  assert.equal(
    await w.view<boolean>("canUseForAccount", [
      w.accountA,
      ...w.args(w.accountA, oldKey.credential, 0),
    ]),
    false,
  );
  const recoveredArgs = w.args(w.accountA, newKey.credential, PASSKEY_PURPOSE.RECOVERY);
  assert.equal(await w.view<boolean>("canUseForAccount", [w.accountA, ...recoveredArgs]), true);
  await w.deploy(w.accountA, newKey.credential, PASSKEY_PURPOSE.RECOVERY);
  const fresh = w.predict(w.accountA, newKey.credential, PASSKEY_PURPOSE.RECOVERY);
  assert.notEqual(fresh, oldInstance);
  assert.ok((await w.install(w.accountA, fresh, newKey.credential)).ok);

  assert.equal(await w.validate(w.accountA, fresh, hash(11), newKey.sign(hash(11))), 0n);
  assert.notEqual(
    await w.validate(w.accountA, fresh, hash(12), oldKey.sign(hash(12))),
    0n,
    "old key fails on the new instance",
  );
  assert.notEqual(
    await w.validate(w.accountA, oldInstance, hash(13), newKey.sign(hash(13))),
    0n,
    "new key fails on the old instance",
  );
  // The old instance still exists (code is permanent); whether its key may sign for the account is Kernel's job
  // (rotation voids it): see the Celo Sepolia proof.
  assert.notEqual(await w.chain.getCode(oldInstance), "0x");
});

test("purpose separation: the same credential gets distinct instances per role, each independently initializable", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const instances = new Set<string>();
  for (const purpose of [0, 1, 2, 3] as const) {
    await w.deploy(w.accountA, key.credential, purpose);
    const instance = w.predict(w.accountA, key.credential, purpose);
    instances.add(instance.toLowerCase());
    assert.ok((await w.install(w.accountA, instance, key.credential)).ok, `purpose ${purpose}`);
  }
  assert.equal(instances.size, 4);
});

test("deployment salt gives a fresh instance for the same credential and role", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const salt1 = pad("0x01", { size: 32 });
  await w.deploy(w.accountA, key.credential, 0);
  await w.deploy(w.accountA, key.credential, 0, salt1);
  const a = w.predict(w.accountA, key.credential, 0);
  const b = w.predict(w.accountA, key.credential, 0, salt1);
  assert.notEqual(a, b);
  assert.ok((await w.install(w.accountA, a, key.credential)).ok);
  assert.equal(
    await w.view<boolean>("canUseForAccount", [
      w.accountA,
      ...w.args(w.accountA, key.credential, 0),
    ]),
    false,
  );
  assert.equal(
    await w.view<boolean>("canUseForAccount", [
      w.accountA,
      ...w.args(w.accountA, key.credential, 0, salt1),
    ]),
    true,
  );
  assert.ok((await w.install(w.accountA, b, key.credential)).ok);
});

test("uninstall by the account frees its entry; nobody else can uninstall it", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  await w.deploy(w.accountA, key.credential);
  const instance = w.predict(w.accountA, key.credential);
  assert.ok((await w.install(w.accountA, instance, key.credential)).ok);
  const stranger = await w.chain.call(w.attacker, instance, validatorAbi, "onUninstall", ["0x"]);
  assert.equal(stranger.ok, false, "an address with no entry of its own cannot uninstall anything");
  assert.equal(await w.isInitialized(instance, w.accountA), true);
  const own = await w.asAccount(
    w.accountA,
    instance,
    encodeFunctionData({ abi: validatorAbi, functionName: "onUninstall", args: ["0x"] }),
  );
  assert.ok(own.ok);
  assert.equal(await w.isInitialized(instance, w.accountA), false);
  assert.notEqual(await w.validate(w.accountA, instance, hash(14), key.sign(hash(14))), 0n);
});

test("creation-time root: a zero-scope PRIMARY instance is valid, per-account state keeps accounts apart", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const zero: Address = "0x0000000000000000000000000000000000000000";
  const walletSalt = pad("0x77", { size: 32 });
  const predicted = w.predict(zero, key.credential, 0, walletSalt);
  const deployed = await w.deploy(zero, key.credential, 0, walletSalt);
  assert.ok(
    deployed.ok && (deployed.value as [Address])[0].toLowerCase() === predicted.toLowerCase(),
  );
  const status = (account: Address) =>
    w.view<number>("statusOf", [
      zero,
      account,
      0,
      passkeyCredentialCommitment(key.credential),
      walletSalt,
    ]);
  assert.equal(await status(w.accountA), STATUS.DEPLOYED_UNUSED);
  assert.ok((await w.install(w.accountA, predicted, key.credential)).ok);
  assert.equal(await status(w.accountA), STATUS.INITIALIZED_FOR_ACCOUNT);
  assert.equal(
    await status(w.accountB),
    STATUS.DEPLOYED_UNUSED,
    "another account's entry is its own",
  );
  // a different wallet salt gives a different instance
  assert.notEqual(predicted, w.predict(zero, key.credential, 0, pad("0x78", { size: 32 })));
  // scoped and creation-time instances for the same credential differ
  assert.notEqual(predicted, w.predict(w.accountA, key.credential, 0, walletSalt));
});

// ── recovery integration (in-process) ──────────────────────────────────────────────────────────

test("KaadaRecoveryValidator commits to a predicted clone; the exact batch accepts it; the new passkey signs and the old does not", async () => {
  const world = await World.create({ contract: "ShortDelayRecoveryValidator" });
  const f = await FactoryWorld.create(world.chain);
  const oldKey = new SoftPasskey();
  const newKey = new SoftPasskey();
  const account = world.account;

  // the account's current root: an instance for the OLD passkey
  await f.deploy(account, oldKey.credential, PASSKEY_PURPOSE.PRIMARY);
  const oldInstance = f.predict(account, oldKey.credential, PASSKEY_PURPOSE.PRIMARY);
  assert.ok((await f.install(account, oldInstance, oldKey.credential)).ok);
  assert.ok((await world.install({ delay: 10 })).ok);

  // The recovery commits to the PREDICTED clone for the new credential, before it exists
  const predicted = f.predict(account, newKey.credential, PASSKEY_PURPOSE.RECOVERY);
  const root = world.root({
    rootId: `0x01${predicted.slice(2).toLowerCase()}` as Hex,
    validatorData: passkeyInstallData(newKey.credential),
  });
  const early = await world.initiate(root);
  assert.equal(early.ok, false, "a committed root with no code is refused");
  assert.match(String(early.error), /InvalidRoot/);

  // the clone is deployed (by anyone) and the commitment is accepted
  await f.deploy(account, newKey.credential, PASSKEY_PURPOSE.RECOVERY, undefined, f.attacker);
  const initiated = await world.initiate(root);
  assert.ok(initiated.ok, describeOutcome(initiated));
  world.chain.warp(11);

  // exactly the committed batch validates; with a different credential's data it does not
  const nonce = await world.currentNonce();
  const calls = world.exactCalls(root, nonce);
  const wrong = world.exactCalls(
    { ...root, validatorData: passkeyInstallData(oldKey.credential) },
    nonce,
  );
  const bad = await world.validate(batch(wrong));
  assert.equal(bad.ok, false);
  const good = await world.validate(batch(calls));
  assert.ok(good.ok, describeOutcome(good));

  // What Kernel then does: install the committed data on the committed clone, as the account
  assert.ok((await f.install(account, predicted, newKey.credential)).ok);
  assert.equal(await f.validate(account, predicted, hash(21), newKey.sign(hash(21))), 0n);
  assert.notEqual(await f.validate(account, predicted, hash(22), oldKey.sign(hash(22))), 0n);
  // the old key still fails on the new instance and the committed install data can not be replayed on the old one
  assert.equal((await f.install(account, oldInstance, newKey.credential)).ok, false);
});

test("a clone is not a valid recovery root until it has code, and a code-less predicted address stays refused after replay", async () => {
  const world = await World.create({ contract: "ShortDelayRecoveryValidator" });
  const f = await FactoryWorld.create(world.chain);
  const key = new SoftPasskey();
  const predicted = f.predict(world.account, key.credential, PASSKEY_PURPOSE.RECOVERY);
  const root = world.root({
    rootId: `0x01${predicted.slice(2).toLowerCase()}` as Hex,
    validatorData: passkeyInstallData(key.credential),
  });
  assert.ok((await world.install({ delay: 10 })).ok);
  for (let i = 0; i < 2; i++) assert.equal((await world.initiate(root)).ok, false);
  await f.deploy(world.account, key.credential, PASSKEY_PURPOSE.RECOVERY);
  assert.ok((await world.initiate(root)).ok);
});

test("gas and size notes", async () => {
  const w = await FactoryWorld.create();
  const key = new SoftPasskey();
  const deployment = await w.deploy(w.accountA, key.credential);
  const again = await w.deploy(w.accountA, key.credential);
  const instance = w.predict(w.accountA, key.credential);
  const install = await w.install(w.accountA, instance, key.credential);
  assert.ok(deployment.ok && again.ok && install.ok);
  const size = (artifacts.KaadaPasskeyValidatorFactory.deployedBytecode.length - 2) / 2;
  console.log(
    `[gas] factory runtime ${size} B | deploy() new clone ${deployment.ok ? deployment.gasUsed : 0n} | repeat deploy() ${again.ok ? again.gasUsed : 0n}`,
  );
  assert.ok(size < 4096, `factory runtime is ${size} bytes`);
  if (deployment.ok) assert.ok(deployment.gasUsed < 150_000n);
});
