// TimelockedAttestorRegistry: role separation, timelocked rotation, two-step admin transfer, boundary and
// model-based property tests, and integration with KaadaRecoveryValidator (real registry, in-process EVM).
import assert from "node:assert/strict";
import test from "node:test";

import { decodeEventLog, getAddress, hexToBytes, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { artifacts } from "./generated/artifacts.js";
import { TestChain } from "./testing/evm.js";
import type { LogEntry } from "./testing/evm.js";
import { World, batch } from "./testing/recovery-world.js";

const abi = artifacts.TimelockedAttestorRegistry.abi as unknown as Abi;
const DAY = 86_400;
const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const ADMIN = addr(0xa0a);
const ATTESTOR = addr(0xa77e57);
const NEXT = addr(0xbeef01);
const NEXT2 = addr(0xbeef02);
const STRANGER = addr(0x5757);
const ADMIN2 = addr(0xa0b);

interface Result {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: LogEntry[];
}

class Registry {
  private constructor(
    readonly chain: TestChain,
    readonly address: Address,
  ) {}

  static async deploy(
    options: {
      delay?: number;
      contract?: "TimelockedAttestorRegistry" | "ShortDelayAttestorRegistry";
    } = {},
  ) {
    const chain = await TestChain.create();
    const contract = options.contract ?? "TimelockedAttestorRegistry";
    const address = await chain.deploy(
      STRANGER,
      artifacts[contract].abi,
      artifacts[contract].bytecode,
      [ADMIN, ATTESTOR, options.delay ?? 72 * 3600],
    );
    return new Registry(chain, address);
  }

  async call(from: Address, functionName: string, args: unknown[] = []): Promise<Result> {
    const result = await this.chain.call(from, this.address, abi, functionName, args);
    return result.ok
      ? { ok: true, value: result.value, logs: result.logs }
      : { ok: false, error: result.error, logs: [] };
  }

  async read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    const result = await this.call(STRANGER, functionName, args);
    if (!result.ok) throw new Error(`${functionName}: ${result.error}`);
    return result.value as T;
  }

  /** Decoded events of a result, in order. */
  events(result: Result): { name: string; args: Record<string, unknown> }[] {
    return result.logs.map((log) => {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return {
        name: String(decoded.eventName),
        args: (decoded.args ?? {}) as Record<string, unknown>,
      };
    });
  }

  async snapshot() {
    return {
      admin: await this.read<Address>("admin"),
      pendingAdmin: await this.read<Address>("pendingAdmin"),
      attestor: await this.read<Address>("currentAttestor"),
      pendingAttestor: await this.read<Address>("pendingAttestor"),
      executeAfter: BigInt(await this.read<number>("executeAfter")),
      delay: Number(await this.read<number>("rotationDelay")),
      count: BigInt(await this.read<bigint>("rotationCount")),
    };
  }

  now(): bigint {
    return this.chain.timestamp;
  }
}

// ── deployment ────────────────────────────────────────────────────────────────────────────────────

test("deploys with the expected initial state and rejects bad constructor input", async () => {
  const r = await Registry.deploy();
  assert.deepEqual(await r.snapshot(), {
    admin: ADMIN,
    pendingAdmin: zeroAddress,
    attestor: ATTESTOR,
    pendingAttestor: zeroAddress,
    executeAfter: 0n,
    delay: 72 * 3600,
    count: 0n,
  });
  const chain = await TestChain.create();
  const deploy = (args: unknown[]) =>
    chain.deploy(STRANGER, abi, artifacts.TimelockedAttestorRegistry.bytecode, args).then(
      () => "ok",
      () => "reverted",
    );
  assert.equal(await deploy([zeroAddress, ATTESTOR, 72 * 3600]), "reverted");
  assert.equal(await deploy([ADMIN, zeroAddress, 72 * 3600]), "reverted");
  assert.equal(await deploy([ADMIN, ATTESTOR, DAY - 1]), "reverted");
  assert.equal(await deploy([ADMIN, ATTESTOR, 30 * DAY + 1]), "reverted");
  assert.equal(await deploy([ADMIN, ATTESTOR, DAY]), "ok");
  assert.equal(await deploy([ADMIN, ATTESTOR, 30 * DAY]), "ok");
});

test("the constructor announces the initial admin, delay and attestor for audit", async () => {
  const chain = await TestChain.create();
  const created = await chain.raw({
    from: STRANGER,
    data: (await import("viem")).encodeDeployData({
      abi,
      bytecode: artifacts.TimelockedAttestorRegistry.bytecode,
      args: [ADMIN, ATTESTOR, 72 * 3600],
    }),
  });
  const names = created.logs.map(
    (l) => decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).eventName,
  );
  assert.deepEqual(names, [
    "AdminTransferAccepted",
    "RotationDelayChanged",
    "AttestorRotationFinalized",
  ]);
});

// ── rotation lifecycle ────────────────────────────────────────────────────────────────────────────

test("propose, wait, finalize: the attestor changes only at finalization, with events", async () => {
  const r = await Registry.deploy();
  const at = r.now();
  const proposed = await r.call(ADMIN, "proposeAttestor", [NEXT]);
  assert.equal(proposed.ok, true);
  assert.deepEqual(r.events(proposed), [
    {
      name: "AttestorRotationProposed",
      args: {
        currentAttestor: ATTESTOR,
        pendingAttestor: NEXT,
        executeAfter: Number(at) + 72 * 3600,
        delay: 72 * 3600,
        rotationId: 1n,
      },
    },
  ]);
  const during = await r.snapshot();
  assert.equal(during.attestor, ATTESTOR, "a pending proposal changes nothing");
  assert.equal(during.pendingAttestor, NEXT);
  assert.equal(during.executeAfter, at + BigInt(72 * 3600));

  r.chain.warp(72 * 3600);
  const finalized = await r.call(ADMIN, "finalizeAttestorRotation");
  assert.equal(finalized.ok, true);
  assert.deepEqual(r.events(finalized), [
    {
      name: "AttestorRotationFinalized",
      args: { previousAttestor: ATTESTOR, newAttestor: NEXT, by: ADMIN, rotationId: 1n },
    },
  ]);
  assert.deepEqual(await r.snapshot(), {
    admin: ADMIN,
    pendingAdmin: zeroAddress,
    attestor: NEXT,
    pendingAttestor: zeroAddress,
    executeAfter: 0n,
    delay: 72 * 3600,
    count: 1n,
  });
});

test("propose, cancel: nothing changes, event emitted, a fresh proposal is possible afterwards", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  const cancelled = await r.call(ADMIN, "cancelAttestorRotation");
  assert.equal(cancelled.ok, true);
  assert.deepEqual(r.events(cancelled), [
    {
      name: "AttestorRotationCancelled",
      args: { pendingAttestor: NEXT, by: ADMIN, rotationId: 1n },
    },
  ]);
  const after = await r.snapshot();
  assert.equal(after.attestor, ATTESTOR);
  assert.equal(after.pendingAttestor, zeroAddress);
  assert.equal(after.executeAfter, 0n);
  const again = await r.call(ADMIN, "proposeAttestor", [NEXT2]);
  assert.equal(again.ok, true);
  assert.equal((await r.snapshot()).count, 2n);
});

test("a cancelled rotation can never finalize, even after its maturity", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  await r.call(ADMIN, "cancelAttestorRotation");
  r.chain.warp(10 * DAY);
  assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).error, "NoPendingRotation");
  assert.equal((await r.snapshot()).attestor, ATTESTOR);
});

test("replay: a finalized rotation cannot be finalized or cancelled again", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  r.chain.warp(72 * 3600);
  assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).ok, true);
  assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).error, "NoPendingRotation");
  assert.equal((await r.call(ADMIN, "cancelAttestorRotation")).error, "NoPendingRotation");
  assert.equal((await r.snapshot()).attestor, NEXT);
});

test("early finalization is rejected up to the last second, accepted exactly at maturity", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  const maturity = (await r.snapshot()).executeAfter;
  r.chain.warp(72 * 3600 - 1);
  const early = await r.call(ADMIN, "finalizeAttestorRotation");
  assert.equal(early.error, "RotationNotMatured");
  assert.equal(r.now(), maturity - 1n);
  r.chain.warp(1);
  assert.equal(r.now(), maturity);
  assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).ok, true);
});

test("overlapping proposals: a second proposal is refused until the first is cancelled or finalized", async () => {
  const r = await Registry.deploy();
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT])).ok, true);
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT2])).error, "RotationPending");
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT])).error, "RotationPending");
  const during = await r.snapshot();
  assert.equal(during.pendingAttestor, NEXT);
  assert.equal(during.count, 1n);
  r.chain.warp(72 * 3600);
  assert.equal(
    (await r.call(ADMIN, "proposeAttestor", [NEXT2])).error,
    "RotationPending",
    "even once matured",
  );
  assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).ok, true);
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT2])).ok, true);
});

test("zero address and the current attestor are rejected; the previous attestor can be proposed again", async () => {
  const r = await Registry.deploy();
  assert.equal((await r.call(ADMIN, "proposeAttestor", [zeroAddress])).error, "ZeroAddress");
  assert.equal((await r.call(ADMIN, "proposeAttestor", [ATTESTOR])).error, "SameAsCurrentAttestor");
  assert.equal((await r.snapshot()).pendingAttestor, zeroAddress);
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  r.chain.warp(72 * 3600);
  await r.call(ADMIN, "finalizeAttestorRotation");
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT])).error, "SameAsCurrentAttestor");
  assert.equal(
    (await r.call(ADMIN, "proposeAttestor", [ATTESTOR])).ok,
    true,
    "rolling back is just another rotation",
  );
});

test("rotation delay: bounds, no change while pending, applies to future proposals only", async () => {
  const r = await Registry.deploy();
  assert.equal((await r.call(ADMIN, "setRotationDelay", [DAY - 1])).error, "DelayOutOfRange");
  assert.equal((await r.call(ADMIN, "setRotationDelay", [0])).error, "DelayOutOfRange");
  assert.equal((await r.call(ADMIN, "setRotationDelay", [30 * DAY + 1])).error, "DelayOutOfRange");
  const changed = await r.call(ADMIN, "setRotationDelay", [DAY]);
  assert.equal(changed.ok, true);
  assert.deepEqual(r.events(changed), [
    { name: "RotationDelayChanged", args: { previousDelay: 72 * 3600, newDelay: DAY, by: ADMIN } },
  ]);
  assert.equal((await r.call(ADMIN, "setRotationDelay", [30 * DAY])).ok, true);
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  assert.equal((await r.call(ADMIN, "setRotationDelay", [DAY])).error, "RotationPending");
  assert.equal(
    (await r.snapshot()).executeAfter,
    r.now() + BigInt(30 * DAY),
    "the pending proposal keeps its delay",
  );
});

// ── access control and role separation ────────────────────────────────────────────────────────────

test("only the admin can propose, cancel, finalize, set the delay or hand over the role", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  r.chain.warp(72 * 3600);
  const cases: [string, unknown[]][] = [
    ["proposeAttestor", [NEXT2]],
    ["cancelAttestorRotation", []],
    ["finalizeAttestorRotation", []],
    ["setRotationDelay", [DAY]],
    ["proposeAdmin", [STRANGER]],
    ["cancelAdminTransfer", []],
  ];
  for (const caller of [STRANGER, ATTESTOR, NEXT, ADMIN2]) {
    for (const [name, args] of cases) {
      assert.equal((await r.call(caller, name, args)).error, "NotAdmin", `${name} by ${caller}`);
    }
  }
  assert.equal((await r.call(STRANGER, "acceptAdmin")).error, "NotPendingAdmin");
  const snapshot = await r.snapshot();
  assert.equal(snapshot.attestor, ATTESTOR);
  assert.equal(snapshot.pendingAttestor, NEXT);
});

test("the attestor cannot rotate itself, instantly or at all: it has no function here", async () => {
  const r = await Registry.deploy();
  for (const [name, args] of [
    ["proposeAttestor", [ATTESTOR]],
    ["proposeAttestor", [NEXT]],
    ["finalizeAttestorRotation", []],
    ["cancelAttestorRotation", []],
    ["setRotationDelay", [DAY]],
    ["proposeAdmin", [ATTESTOR]],
  ] as [string, unknown[]][]) {
    assert.equal((await r.call(ATTESTOR, name, args)).error, "NotAdmin", name);
  }
  // even a proposal the ADMIN makes cannot be finalized by the (pending or current) attestor
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  r.chain.warp(72 * 3600);
  assert.equal((await r.call(NEXT, "finalizeAttestorRotation")).error, "NotAdmin");
  assert.equal((await r.call(ATTESTOR, "finalizeAttestorRotation")).error, "NotAdmin");
  assert.equal((await r.snapshot()).attestor, ATTESTOR);
});

test("the contract surface: no wallet reference, no calls out, no upgrade, no renounce, no payable path", async () => {
  const functions = abi.filter((e) => e.type === "function") as {
    name: string;
    stateMutability: string;
  }[];
  assert.deepEqual(functions.map((f) => f.name).sort(), [
    "DEFAULT_ROTATION_DELAY",
    "MAX_ROTATION_DELAY",
    "acceptAdmin",
    "admin",
    "cancelAdminTransfer",
    "cancelAttestorRotation",
    "currentAttestor",
    "executeAfter",
    "finalizeAttestorRotation",
    "minRotationDelay",
    "pendingAdmin",
    "pendingAttestor",
    "proposeAdmin",
    "proposeAttestor",
    "rotationCount",
    "rotationDelay",
    "setRotationDelay",
  ]);
  assert.equal(
    functions.some((f) => f.stateMutability === "payable"),
    false,
  );
  assert.equal(
    abi.some((e) => e.type === "receive" || e.type === "fallback"),
    false,
  );
  for (const banned of [
    "upgrade",
    "renounce",
    "delegatecall",
    "recover",
    "wallet",
    "validator",
    "withdraw",
    "sweep",
  ]) {
    assert.equal(
      functions.some((f) => f.name.toLowerCase().includes(banned)),
      false,
      banned,
    );
  }
  // No renounce: the admin can never become the zero address.
  const r = await Registry.deploy();
  assert.equal((await r.call(ADMIN, "proposeAdmin", [zeroAddress])).error, "ZeroAddress");
});

test("the runtime code contains no CALL, DELEGATECALL, CALLCODE, STATICCALL, CREATE or SELFDESTRUCT", () => {
  const runtime = hexToBytes(artifacts.TimelockedAttestorRegistry.deployedBytecode);
  // strip the CBOR metadata appended by solc (last two bytes give its length)
  const metadataLength = (runtime[runtime.length - 2]! << 8) | runtime[runtime.length - 1]!;
  const code = runtime.slice(0, runtime.length - metadataLength - 2);
  const banned = new Map([
    [0xf0, "CREATE"],
    [0xf1, "CALL"],
    [0xf2, "CALLCODE"],
    [0xf4, "DELEGATECALL"],
    [0xf5, "CREATE2"],
    [0xfa, "STATICCALL"],
    [0xff, "SELFDESTRUCT"],
  ]);
  const found: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const op = code[i]!;
    if (op >= 0x60 && op <= 0x7f)
      i += op - 0x5f; // skip PUSH data
    else if (banned.has(op)) found.push(`${banned.get(op)} at ${i}`);
  }
  assert.deepEqual(found, []);
});

// ── two-step admin transfer ───────────────────────────────────────────────────────────────────────

test("admin transfer: propose, accept; the old admin loses power, the new admin gains it, with events", async () => {
  const r = await Registry.deploy();
  const proposed = await r.call(ADMIN, "proposeAdmin", [ADMIN2]);
  assert.deepEqual(r.events(proposed), [
    { name: "AdminTransferProposed", args: { currentAdmin: ADMIN, proposedAdmin: ADMIN2 } },
  ]);
  assert.equal((await r.snapshot()).admin, ADMIN, "not effective until accepted");
  assert.equal(
    (await r.call(ADMIN2, "proposeAttestor", [NEXT])).error,
    "NotAdmin",
    "proposed admin has no power yet",
  );
  assert.equal((await r.call(STRANGER, "acceptAdmin")).error, "NotPendingAdmin");
  assert.equal((await r.call(ATTESTOR, "acceptAdmin")).error, "NotPendingAdmin");
  assert.equal(
    (await r.call(ADMIN, "acceptAdmin")).error,
    "NotPendingAdmin",
    "the current admin cannot accept for them",
  );
  const accepted = await r.call(ADMIN2, "acceptAdmin");
  assert.deepEqual(r.events(accepted), [
    { name: "AdminTransferAccepted", args: { previousAdmin: ADMIN, newAdmin: ADMIN2 } },
  ]);
  const after = await r.snapshot();
  assert.equal(after.admin, ADMIN2);
  assert.equal(after.pendingAdmin, zeroAddress);
  assert.equal((await r.call(ADMIN, "proposeAttestor", [NEXT])).error, "NotAdmin");
  assert.equal((await r.call(ADMIN2, "proposeAttestor", [NEXT])).ok, true);
  assert.equal(
    (await r.call(ADMIN2, "acceptAdmin")).error,
    "NotPendingAdmin",
    "acceptance cannot be replayed",
  );
});

test("admin transfer: zero address, same admin and cancel; re-proposing replaces the proposed admin", async () => {
  const r = await Registry.deploy();
  assert.equal((await r.call(ADMIN, "proposeAdmin", [zeroAddress])).error, "ZeroAddress");
  assert.equal((await r.call(ADMIN, "proposeAdmin", [ADMIN])).error, "SameAsCurrentAdmin");
  assert.equal((await r.call(ADMIN, "cancelAdminTransfer")).error, "NoPendingAdminTransfer");
  await r.call(ADMIN, "proposeAdmin", [ADMIN2]);
  const replaced = await r.call(ADMIN, "proposeAdmin", [STRANGER]);
  assert.equal(replaced.ok, true);
  assert.equal(
    (await r.call(ADMIN2, "acceptAdmin")).error,
    "NotPendingAdmin",
    "the replaced proposal is dead",
  );
  const cancelled = await r.call(ADMIN, "cancelAdminTransfer");
  assert.deepEqual(r.events(cancelled), [
    { name: "AdminTransferCancelled", args: { currentAdmin: ADMIN, proposedAdmin: STRANGER } },
  ]);
  assert.equal((await r.call(STRANGER, "acceptAdmin")).error, "NotPendingAdmin");
  assert.equal((await r.snapshot()).admin, ADMIN);
});

test("changing the admin never changes the attestor or a pending rotation, and vice versa", async () => {
  const r = await Registry.deploy();
  await r.call(ADMIN, "proposeAttestor", [NEXT]);
  const before = await r.snapshot();
  await r.call(ADMIN, "proposeAdmin", [ADMIN2]);
  await r.call(ADMIN2, "acceptAdmin");
  const after = await r.snapshot();
  assert.equal(after.attestor, before.attestor);
  assert.equal(after.pendingAttestor, before.pendingAttestor);
  assert.equal(after.executeAfter, before.executeAfter);
  // the NEW admin finishes the rotation the old admin started
  r.chain.warp(72 * 3600);
  assert.equal((await r.call(ADMIN2, "finalizeAttestorRotation")).ok, true);
  // a rotation does not touch a pending admin transfer
  await r.call(ADMIN2, "proposeAdmin", [ADMIN]);
  await r.call(ADMIN2, "proposeAttestor", [NEXT2]);
  r.chain.warp(72 * 3600);
  await r.call(ADMIN2, "finalizeAttestorRotation");
  assert.equal((await r.snapshot()).pendingAdmin, ADMIN);
  assert.equal((await r.snapshot()).attestor, NEXT2);
});

// ── property tests ────────────────────────────────────────────────────────────────────────────────

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("property: for any legal delay, finalization fails at maturity - 1 and succeeds at maturity", async () => {
  const random = prng(21);
  const delays = [DAY, DAY + 1, 72 * 3600, 30 * DAY - 1, 30 * DAY];
  for (let i = 0; i < 25; i++) delays.push(DAY + Math.floor(random() * (29 * DAY)));
  for (const delay of delays) {
    const r = await Registry.deploy({ delay });
    await r.call(ADMIN, "proposeAttestor", [NEXT]);
    r.chain.warp(delay - 1);
    assert.equal(
      (await r.call(ADMIN, "finalizeAttestorRotation")).error,
      "RotationNotMatured",
      `delay ${delay}`,
    );
    r.chain.warp(1);
    assert.equal((await r.call(ADMIN, "finalizeAttestorRotation")).ok, true, `delay ${delay}`);
  }
});

test("property: random operation sequences always agree with a model and keep the invariants", async () => {
  const random = prng(5);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  for (let run = 0; run < 12; run++) {
    const r = await Registry.deploy();
    const m = {
      admin: ADMIN,
      pendingAdmin: zeroAddress as Address,
      attestor: ATTESTOR,
      pending: zeroAddress as Address,
      after: 0n,
      delay: 72 * 3600,
    };
    const people = [ADMIN, ADMIN2, ATTESTOR, NEXT, NEXT2, STRANGER, zeroAddress] as Address[];
    for (let step = 0; step < 60; step++) {
      const caller = pick([
        m.admin,
        m.admin,
        m.pendingAdmin === zeroAddress ? STRANGER : m.pendingAdmin,
        ATTESTOR,
        STRANGER,
      ]);
      const op = pick([
        "propose",
        "cancel",
        "finalize",
        "delay",
        "proposeAdmin",
        "acceptAdmin",
        "cancelAdmin",
        "warp",
        "warp",
      ]);
      let expected: boolean;
      let result: Result | undefined;
      if (op === "warp") {
        r.chain.warp(Math.floor(random() * 2 * 72 * 3600));
        continue;
      }
      if (op === "propose") {
        const target = pick(people);
        result = await r.call(caller, "proposeAttestor", [target]);
        expected =
          caller === m.admin &&
          target !== zeroAddress &&
          target !== m.attestor &&
          m.pending === zeroAddress;
        if (expected) {
          m.pending = target;
          m.after = r.now() + BigInt(m.delay);
        }
      } else if (op === "cancel") {
        result = await r.call(caller, "cancelAttestorRotation");
        expected = caller === m.admin && m.pending !== zeroAddress;
        if (expected) {
          m.pending = zeroAddress;
          m.after = 0n;
        }
      } else if (op === "finalize") {
        result = await r.call(caller, "finalizeAttestorRotation");
        expected = caller === m.admin && m.pending !== zeroAddress && r.now() >= m.after;
        if (expected) {
          m.attestor = m.pending;
          m.pending = zeroAddress;
          m.after = 0n;
        }
      } else if (op === "delay") {
        const next = pick([0, DAY - 1, DAY, 3 * DAY, 30 * DAY, 30 * DAY + 1]);
        result = await r.call(caller, "setRotationDelay", [next]);
        expected =
          caller === m.admin && m.pending === zeroAddress && next >= DAY && next <= 30 * DAY;
        if (expected) m.delay = next;
      } else if (op === "proposeAdmin") {
        const target = pick(people);
        result = await r.call(caller, "proposeAdmin", [target]);
        expected = caller === m.admin && target !== zeroAddress && target !== m.admin;
        if (expected) m.pendingAdmin = target;
      } else if (op === "acceptAdmin") {
        result = await r.call(caller, "acceptAdmin");
        expected = m.pendingAdmin !== zeroAddress && caller === m.pendingAdmin;
        if (expected) {
          m.admin = caller;
          m.pendingAdmin = zeroAddress;
        }
      } else {
        result = await r.call(caller, "cancelAdminTransfer");
        expected = caller === m.admin && m.pendingAdmin !== zeroAddress;
        if (expected) m.pendingAdmin = zeroAddress;
      }
      assert.equal(
        result.ok,
        expected,
        `run ${run} step ${step}: ${op} by ${caller} -> ${result.error ?? "ok"}`,
      );
      const snapshot = await r.snapshot();
      assert.equal(snapshot.admin, m.admin);
      assert.equal(snapshot.pendingAdmin, m.pendingAdmin);
      assert.equal(snapshot.attestor, m.attestor);
      assert.equal(snapshot.pendingAttestor, m.pending);
      assert.equal(snapshot.executeAfter, m.after);
      assert.equal(snapshot.delay, m.delay);
      assert.notEqual(snapshot.admin, zeroAddress);
      assert.notEqual(snapshot.attestor, zeroAddress);
    }
  }
});

test("the test-only short-delay build lowers only the floor and is a separate contract", async () => {
  const short = await Registry.deploy({ delay: 10, contract: "ShortDelayAttestorRegistry" });
  assert.equal((await short.call(ADMIN, "setRotationDelay", [9])).error, "DelayOutOfRange");
  assert.equal((await short.call(ADMIN, "setRotationDelay", [10])).ok, true);
  const chain = await TestChain.create();
  await assert.rejects(
    chain.deploy(STRANGER, abi, artifacts.TimelockedAttestorRegistry.bytecode, [
      ADMIN,
      ATTESTOR,
      10,
    ]),
  );
});

test("size and gas notes (informational; bounds guard against regressions)", async () => {
  const size = (artifacts.TimelockedAttestorRegistry.deployedBytecode.length - 2) / 2;
  const r = await Registry.deploy();
  const gas: Record<string, bigint> = {};
  const measure = async (name: string, from: Address, fn: string, args: unknown[] = []) => {
    const res = await r.chain.call(from, r.address, abi, fn, args);
    assert.equal(res.ok, true, name);
    if (res.ok) gas[name] = res.gasUsed;
  };
  await measure("proposeAttestor", ADMIN, "proposeAttestor", [NEXT]);
  r.chain.warp(72 * 3600);
  await measure("finalizeAttestorRotation", ADMIN, "finalizeAttestorRotation");
  await measure("proposeAttestor (2nd)", ADMIN, "proposeAttestor", [NEXT2]);
  await measure("cancelAttestorRotation", ADMIN, "cancelAttestorRotation");
  await measure("proposeAdmin", ADMIN, "proposeAdmin", [ADMIN2]);
  await measure("acceptAdmin", ADMIN2, "acceptAdmin");
  console.log(
    `# TimelockedAttestorRegistry runtime ${size} bytes; gas`,
    JSON.stringify(gas, (_key: string, v: unknown): unknown =>
      typeof v === "bigint" ? Number(v) : v,
    ),
  );
  assert.ok(size < 4000, `runtime grew to ${size} bytes`);
  for (const [name, used] of Object.entries(gas))
    assert.ok(used < 120_000n, `${name} used ${used}`);
});

// ── integration with KaadaRecoveryValidator (real registry) ───────────────────────────────────────

async function recoveryWorld() {
  const world = await World.create({ registry: "real" });
  assert.equal((await world.install()).ok, true);
  const call = async (from: Address, fn: string, args: unknown[] = []) => {
    const result = await world.chain.call(from, world.registry, abi, fn, args);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  };
  return { world, call };
}
const ADMIN_ADDR = ADMIN;

test("integration: the validator reads the real registry's current attestor", async () => {
  const { world } = await recoveryWorld();
  const reading = await world.chain.call(world.stranger, world.registry, abi, "currentAttestor");
  assert.equal((reading as { value: unknown }).value, world.attestorAddress);
  assert.equal(
    (await world.initiate(world.root())).ok,
    true,
    "signatures from the current attestor are accepted",
  );
});

test("integration: a pending rotation does not affect the active attestor", async () => {
  const { world, call } = await recoveryWorld();
  const next = generatePrivateKey();
  assert.equal(
    (await call(ADMIN_ADDR, "proposeAttestor", [privateKeyToAccount(next).address])).ok,
    true,
  );
  const root = world.root();
  // the proposed attestor is NOT yet an attestor
  assert.equal(
    (await world.initiate(root, { sigAttestor: await world.sign(next, root) })).error,
    "BadSignature",
  );
  // the current one still is
  assert.equal((await world.initiate(root)).ok, true);
  assert.equal(
    (await world.from(privateKeyToAccount(next).address, "attestorCancel", [world.account])).error,
    "NotAttestor",
  );
  assert.equal(
    (await world.from(world.attestorAddress, "attestorCancel", [world.account])).ok,
    true,
  );
});

test("integration: a cancelled rotation does not affect the active attestor", async () => {
  const { world, call } = await recoveryWorld();
  const next = generatePrivateKey();
  await call(ADMIN_ADDR, "proposeAttestor", [privateKeyToAccount(next).address]);
  await call(ADMIN_ADDR, "cancelAttestorRotation");
  world.chain.warp(10 * DAY);
  assert.equal((await call(ADMIN_ADDR, "finalizeAttestorRotation")).ok, false);
  const root = world.root();
  assert.equal(
    (await world.initiate(root, { sigAttestor: await world.sign(next, root) })).error,
    "BadSignature",
  );
  assert.equal((await world.initiate(root)).ok, true);
});

test("integration: after a finalized rotation the old attestor stops working and the new one works", async () => {
  const { world, call } = await recoveryWorld();
  const nextKey = generatePrivateKey();
  const next = privateKeyToAccount(nextKey).address;
  await call(ADMIN_ADDR, "proposeAttestor", [next]);
  world.chain.warp(72 * 3600);
  assert.equal((await call(ADMIN_ADDR, "finalizeAttestorRotation")).ok, true);
  const root = world.root();
  assert.equal(
    (await world.initiate(root)).error,
    "BadSignature",
    "the old attestor's signature is dead",
  );
  assert.equal(
    (await world.initiate(root, { sigAttestor: await world.sign(nextKey, root) })).ok,
    true,
    "the new one works",
  );
  assert.equal(
    (await world.from(world.attestorAddress, "attestorCancel", [world.account])).error,
    "NotAttestor",
  );
  assert.equal((await world.from(next, "attestorCancel", [world.account])).ok, true);
});

test("integration: rotating the attestor never changes wallet state; a pending recovery still completes", async () => {
  const { world, call } = await recoveryWorld();
  const root = world.root();
  assert.equal((await world.initiate(root)).ok, true);
  const pendingBefore = await world.pending();
  const nonceBefore = await world.read<bigint>("recoveryNonce", [world.account]);
  const nextKey = generatePrivateKey();
  await call(ADMIN_ADDR, "proposeAttestor", [privateKeyToAccount(nextKey).address]);
  world.chain.warp(72 * 3600);
  await call(ADMIN_ADDR, "finalizeAttestorRotation");
  assert.deepEqual(
    await world.pending(),
    pendingBefore,
    "the wallet's recovery state is untouched",
  );
  assert.equal(await world.read<bigint>("recoveryNonce", [world.account]), nonceBefore);
  assert.equal(await world.read<boolean>("isInitialized", [world.account]), true);
  // the matured batch does not consult the attestor at all
  const nonce = await world.currentNonce();
  assert.equal((await world.validate(batch(world.exactCalls(root, nonce)))).ok, true);
});

test("integration: the registry admin cannot start, advance, veto or complete a wallet recovery", async () => {
  const { world, call } = await recoveryWorld();
  const root = world.root();
  const adminKey = generatePrivateKey();
  const adminAddress = privateKeyToAccount(adminKey).address;
  // an admin that is its own key still cannot sign for the attestor or the recovery key
  const sigs = await Promise.all([world.sign(adminKey, root), world.sign(adminKey, root)]);
  assert.equal(
    (await world.initiate(root, { sigRecovery: sigs[0], sigAttestor: sigs[1] })).error,
    "BadSignature",
  );
  assert.equal(
    (await world.initiate(root, { sender: ADMIN_ADDR })).ok,
    true,
    "submitting is open to anyone, authority is the signatures",
  );
  // veto is the attestor's alone, not the admin's
  assert.equal(
    (await world.from(ADMIN_ADDR, "attestorCancel", [world.account])).error,
    "NotAttestor",
  );
  assert.equal(
    (await world.from(adminAddress, "attestorCancel", [world.account])).error,
    "NotAttestor",
  );
  // the admin has no way to cancel a wallet's recovery either (cancel() acts on the caller's own state)
  assert.equal((await world.from(ADMIN_ADDR, "cancel")).error, "NoPendingRecovery");
  assert.equal((await world.pending()).active, true);
  // nor to complete it
  world.chain.warp(72 * 3600 + 1);
  const exact = batch(world.exactCalls(root, await world.currentNonce()));
  assert.equal(
    (await world.from(ADMIN_ADDR, "validateUserOp", [world.userOp(exact), `0x${"11".repeat(32)}`]))
      .error,
    "WrongSender",
  );
  // admin actions on the registry do not touch the validator
  await call(ADMIN_ADDR, "proposeAdmin", [ADMIN2]);
  assert.equal((await world.pending()).active, true);
});

test("integration: the attestor cannot rotate itself, so a compromised attestor cannot make itself permanent", async () => {
  const { world, call } = await recoveryWorld();
  assert.equal(
    (await call(world.attestorAddress, "proposeAttestor", [world.attestorAddress])).ok,
    false,
  );
  assert.equal((await call(world.attestorAddress, "proposeAttestor", [NEXT])).ok, false);
  assert.equal((await call(world.attestorAddress, "finalizeAttestorRotation")).ok, false);
});
