// KaadaRecoveryValidator: unit, access-control, state-transition, replay, malformed-calldata and property
// tests. The first block replicates, one for one, the guarantees first proven on Celo Sepolia with an earlier prototype of the
// validator. Kernel-level behaviour (EntryPoint validAfter, InvalidNonce voiding, selector grants) cannot run here and is covered
// by the Sepolia end-to-end run (recovery-validator-sepolia.ts).
import assert from "node:assert/strict";
import test from "node:test";

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  pad,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  DAY,
  MODE_BATCH,
  MODE_DELEGATE,
  MODE_SINGLE,
  World,
  batch,
  executeData,
  invalidateData,
  packExecutions,
  rootCallData,
  validatorAbi,
} from "./testing/recovery-world.js";
import type { Call } from "./testing/recovery-world.js";

/** A 32-byte mode word: `head` followed by `pad` zero bytes. */
const mode = (head: Hex, padBytes: number): Hex => concat([head, pad("0x", { size: padBytes })]);

const ATTACKER: Address = "0x00000000000000000000000000000000000a77ac";

/** A world with the validator installed (72h delay). */
async function installed(): Promise<World> {
  const world = await World.create();
  assert.equal((await world.install()).ok, true);
  return world;
}

/** ...and a recovery initiated and matured; returns the exact batch and the committed root. */
async function matured() {
  const world = await installed();
  const root = world.root();
  assert.equal((await world.initiate(root)).ok, true);
  world.chain.warp(72 * 3600 + 1);
  const nonce = await world.currentNonce();
  return { world, root, nonce, exact: world.exactCalls(root, nonce) };
}

// ── installation, delay floor, configuration ─────────────────────────────────────────────────────

test("install: delay below 24 hours is refused, exactly 24 hours is allowed, default 72 hours works", async () => {
  const world = await World.create();
  assert.equal((await world.install({ delay: DAY - 1 })).error, "BadConfig");
  assert.equal((await world.install({ delay: 0 })).error, "BadConfig");
  assert.equal((await world.install({ delay: DAY })).ok, true);
  const other = await World.create();
  assert.equal((await other.install({ delay: 72 * 3600 })).ok, true);
  assert.deepEqual(
    (await other.read<[Address, number, boolean]>("configs", [other.account])).slice(0, 3),
    [other.recoveryAddress, 72 * 3600, true],
  );
});

test("install: zero recovery key refused, double install refused", async () => {
  const world = await World.create();
  assert.equal((await world.install({ recoveryKey: zeroAddress })).error, "BadConfig");
  assert.equal((await world.install()).ok, true);
  assert.equal((await world.install()).error, "AlreadyInitialized");
});

test("install: configuration is per account (msg.sender), never settable for another account", async () => {
  const world = await World.create();
  const result = await world.chain.call(
    world.stranger,
    world.validator,
    validatorAbi,
    "onInstall",
    [
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint32" }],
        [world.recoveryAddress, 72 * 3600],
      ),
    ],
  );
  assert.equal(result.ok, true); // it installed for the CALLER (the stranger EOA), not for the account
  assert.equal(await world.read<boolean>("isInitialized", [world.account]), false);
  assert.equal(await world.read<boolean>("isInitialized", [world.stranger]), true);
});

test("the validator reads no external state: no registry, no attestor; its only constructor argument is the relayer", async () => {
  const names = validatorAbi.map((e) => ("name" in e ? e.name : e.type));
  assert.equal(
    names.some((n) => /registry|attestor/i.test(String(n))),
    false,
  );
  const constructor = validatorAbi.find((e) => e.type === "constructor") as
    { inputs: { name: string; type: string }[] } | undefined;
  assert.deepEqual(
    constructor?.inputs.map((i) => [i.name, i.type]),
    [["relayer", "address"]],
  );
  const world = await installed();
  assert.equal((await world.read<string>("RELAYER")).toLowerCase(), world.relayer.toLowerCase());
});

test("the relayer cannot be the zero address", async () => {
  const { TestChain } = await import("./testing/evm.js");
  const { artifacts } = await import("./generated/artifacts.js");
  const chain = await TestChain.create();
  await assert.rejects(
    chain.deploy(
      "0x1000000000000000000000000000000000000001",
      artifacts.KaadaRecoveryValidator.abi,
      artifacts.KaadaRecoveryValidator.bytecode,
      [zeroAddress],
    ),
  );
});

test("module surface: validator type only, never signs for the account", async () => {
  const world = await World.create();
  assert.equal(await world.read<boolean>("isModuleType", [1n]), true);
  for (const id of [0n, 2n, 3n, 4n, 99n])
    assert.equal(await world.read<boolean>("isModuleType", [id]), false);
  assert.equal(
    await world.read<string>("isValidSignatureWithSender", [
      world.stranger,
      pad("0x01", { size: 32 }),
      "0x",
    ]),
    "0xffffffff",
  );
});

test("setRecoveryKey / setDelay: account only, not while pending, delay floor, used keys refused", async () => {
  const world = await installed();
  const newKey = privateKeyToAccount(generatePrivateKey()).address;
  // a stranger acts only on its OWN (uninstalled) configuration
  assert.equal((await world.from(world.stranger, "setDelay", [DAY])).error, "NotInitialized");
  assert.equal((await world.asAccount(world.fn("setDelay", [DAY - 1]))).error, "BadConfig");
  assert.equal((await world.asAccount(world.fn("setDelay", [5 * DAY]))).ok, true);
  assert.equal(
    (await world.asAccount(world.fn("setRecoveryKey", [zeroAddress]))).error,
    "BadConfig",
  );
  assert.equal((await world.asAccount(world.fn("setRecoveryKey", [newKey]))).ok, true);
  assert.equal((await world.read<[Address]>("configs", [world.account]))[0], newKey);
  assert.equal((await world.initiate(world.root())).error, "BadSignature"); // signed with the OLD key
  // pending recoveries freeze configuration
  const fresh = await installed();
  assert.equal((await fresh.initiate(fresh.root())).ok, true);
  assert.equal((await fresh.asAccount(fresh.fn("setDelay", [5 * DAY]))).error, "RecoveryActive");
  assert.equal(
    (await fresh.asAccount(fresh.fn("setRecoveryKey", [newKey]))).error,
    "RecoveryActive",
  );
});

test("test-only short-delay variant lowers only the floor (10 s) and is a separate contract", async () => {
  const world = await World.create({ contract: "ShortDelayRecoveryValidator" });
  assert.equal((await world.install({ delay: 9 })).error, "BadConfig");
  assert.equal((await world.install({ delay: 10 })).ok, true);
  const production = await World.create();
  assert.equal((await production.install({ delay: 10 })).error, "BadConfig");
});

// ── initiate: who may start a recovery, and what the signatures bind ─────────────────────────────

test("initiate: the recovery key alone starts a recovery and the timelock is the configured delay", async () => {
  const world = await installed();
  const root = world.root();
  const at = world.chain.timestamp;
  assert.equal((await world.initiate(root)).ok, true);
  const pending = await world.pending();
  assert.equal(pending.active, true);
  assert.equal(pending.executeAfter, at + BigInt(72 * 3600));
});

test("initiate: a stranger's signature, or no signature, cannot start a recovery", async () => {
  const world = await installed();
  const root = world.root();
  const stranger = generatePrivateKey();
  assert.equal(
    (await world.initiate(root, { sigRecovery: await world.sign(stranger, root) })).error,
    "BadSignature",
  );
  assert.equal((await world.initiate(root, { sigRecovery: "0x" })).error, "BadSignature");
  assert.equal((await world.pending()).active, false);
});

test("initiate: only the relayer, and only with the Recovery Code signature: every other combination fails", async () => {
  const root = (await installed()).root();
  const valid = async (w: World) => w.sign(w.recoveryKey, root);

  // 1. The Recovery Code holder cannot call initiate directly, even with a perfect signature.
  const holder = await installed();
  const holderSig = await valid(holder);
  assert.equal(
    (
      await holder.initiate(holder.root(), {
        sender: holder.recoveryAddress,
        sigRecovery: holderSig,
      })
    ).error,
    "NotRelayer",
  );
  // 2. A random address cannot initiate, with a perfect signature or without one.
  for (const sender of [holder.stranger, ATTACKER, holder.account, holder.deployer]) {
    assert.equal(
      (
        await holder.initiate(holder.root(), {
          sender,
          sigRecovery: await holder.sign(holder.recoveryKey, holder.root()),
        })
      ).error,
      "NotRelayer",
      sender,
    );
    assert.equal(
      (await holder.initiate(holder.root(), { sender, sigRecovery: "0x" })).error,
      "NotRelayer",
      sender,
    );
  }
  assert.equal((await holder.pending()).active, false);

  // 3. The relayer with an INVALID Recovery Code signature fails.
  const invalid = await installed();
  assert.equal(
    (
      await invalid.initiate(invalid.root(), {
        sigRecovery: await invalid.sign(generatePrivateKey(), invalid.root()),
      })
    ).error,
    "BadSignature",
  );
  assert.equal(
    (await invalid.initiate(invalid.root(), { sigRecovery: "0x" })).error,
    "BadSignature",
  );
  assert.equal((await invalid.pending()).active, false);

  // 4. The relayer with a VALID Recovery Code signature succeeds.
  const ok = await installed();
  assert.equal((await ok.initiate(ok.root())).ok, true);
  assert.equal((await ok.pending()).active, true);
});

test("initiate: the relayer ALONE cannot forge a recovery: its own key, a replay for another account, or a changed root all fail", async () => {
  const { privateKeyToAccount: toAccount } = await import("viem/accounts");
  const world = await installed();
  const relayerKey = generatePrivateKey();
  // A world whose relayer is a key the test holds, to prove that even the relayer's own signature is not the Recovery Code's.
  const mine = await World.create({ relayer: toAccount(relayerKey).address });
  assert.equal((await mine.install()).ok, true);
  const root = mine.root();
  assert.equal(
    (await mine.initiate(root, { sigRecovery: await mine.sign(relayerKey, root) })).error,
    "BadSignature",
  );
  // The relayer cannot move a valid signature onto another root...
  const sig = await world.sign(world.recoveryKey, world.root());
  assert.equal(
    (await world.initiate(world.root({ validatorData: "0x99" }), { sigRecovery: sig })).error,
    "BadSignature",
  );
  // ...nor onto another account.
  assert.equal(
    (await world.initiate(world.root(), { account: ATTACKER, sigRecovery: sig })).error,
    "NotInitialized",
  );
  assert.equal((await world.pending()).active, false);
});

test("the relayer has no other power: it cannot cancel, uninstall or reconfigure anyone's recovery", async () => {
  const world = await installed();
  assert.equal((await world.initiate(world.root())).ok, true);
  // Everything else is keyed by msg.sender: as the relayer these act on the relayer's own empty state.
  assert.equal((await world.from(world.relayer, "cancel")).error, "NoPendingRecovery");
  assert.equal((await world.from(world.relayer, "setDelay", [DAY])).error, "NotInitialized");
  assert.equal(
    (await world.from(world.relayer, "setRecoveryKey", [ATTACKER])).error,
    "NotInitialized",
  );
  assert.equal((await world.pending()).active, true);
});

test("the existing root (the account) can still cancel directly, with no relayer involved", async () => {
  const world = await installed();
  assert.equal((await world.initiate(world.root())).ok, true);
  assert.equal((await world.asAccount(world.fn("cancel"))).ok, true);
  assert.equal((await world.pending()).active, false);
});

test("initiate: malformed or malleable signatures fail (length, v, high-s)", async () => {
  const world = await installed();
  const root = world.root();
  const good = await world.sign(world.recoveryKey, root);
  assert.equal((await world.initiate(root, { sigRecovery: "0x" })).error, "BadSignature");
  assert.equal(
    (await world.initiate(root, { sigRecovery: good.slice(0, -2) as Hex })).error,
    "BadSignature",
  );
  assert.equal(
    (await world.initiate(root, { sigRecovery: concat([good, "0x00"]) })).error,
    "BadSignature",
  );
  const badV = (good.slice(0, -2) + "1f") as Hex;
  assert.equal((await world.initiate(root, { sigRecovery: badV })).error, "BadSignature");
  // the malleable twin: s -> n - s, v flipped
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${good.slice(66, 130)}`);
  const twinS = pad(`0x${(n - s).toString(16)}`, { size: 32 });
  const v = Number.parseInt(good.slice(130, 132), 16);
  const twin = concat([good.slice(0, 66) as Hex, twinS, v === 27 ? "0x1c" : "0x1b"]);
  assert.equal((await world.initiate(root, { sigRecovery: twin })).error, "BadSignature");
});

test("initiate: signatures bind chain, contract, account, nonce, new validator, validator data, hook and hook data", async () => {
  const world = await installed();
  const root = world.root();
  const sign = (key: Hex, r = root, o: Parameters<World["sign"]>[2] = {}) => world.sign(key, r, o);
  const attempt = async (name: string, sigRecovery: Hex) =>
    assert.equal((await world.initiate(root, { sigRecovery })).error, "BadSignature", name);
  const alter = async (r: typeof root) => attempt("changed root", await sign(world.recoveryKey, r));
  await alter(world.root({ validatorData: "0x1235" }));
  await alter(world.root({ hookData: "0x00" }));
  await alter(world.root({ hook: ATTACKER }));
  await alter(world.root({ rootId: concat(["0x01", ATTACKER]) }));
  await attempt("other account", await sign(world.recoveryKey, root, { account: ATTACKER }));
  await attempt("other nonce", await sign(world.recoveryKey, root, { nonce: 1n }));
  const otherChain = { ...world.domain(), chainId: world.domain().chainId + 1 };
  await attempt("other chain", await sign(world.recoveryKey, root, { domain: otherChain }));
  const otherContract = { ...world.domain(), verifyingContract: ATTACKER };
  await attempt("other contract", await sign(world.recoveryKey, root, { domain: otherContract }));
  assert.equal((await world.pending()).active, false);
});

test("initiate: the on-chain digest equals the EIP-712 hash clients compute", async () => {
  const world = await installed();
  const root = world.root();
  const deadline = world.chain.timestamp + 100n;
  const onChain = await world.read<Hex>("initiateDigest", [
    world.account,
    0n,
    world.commitment(root),
    deadline,
  ]);
  const c = world.commitment(root);
  const offChain = hashTypedData({
    domain: world.domain(),
    types: {
      Initiate: [
        { name: "account", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "rootId", type: "bytes21" },
        { name: "hook", type: "address" },
        { name: "validatorDataHash", type: "bytes32" },
        { name: "hookDataHash", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Initiate",
    message: { account: world.account, nonce: 0n, ...c, deadline },
  });
  assert.equal(onChain, offChain);
});

test("initiate: an expired deadline is refused", async () => {
  const world = await installed();
  const deadline = world.chain.timestamp - 1n;
  assert.equal((await world.initiate(world.root(), { deadline })).error, "Expired");
});

test("initiate: not installed, and only one recovery at a time", async () => {
  const bare = await World.create();
  assert.equal((await bare.initiate(bare.root())).error, "NotInitialized");
  const world = await installed();
  assert.equal((await world.initiate(world.root())).ok, true);
  assert.equal(
    (await world.initiate(world.root({ validatorData: "0x99" }))).error,
    "RecoveryActive",
  );
});

test("initiate: the new root must be a validator-type id naming a real contract that is not the module", async () => {
  const world = await installed();
  const attempt = async (rootId: Hex) => (await world.initiate(world.root({ rootId }))).error;
  assert.equal(await attempt(concat(["0x00", world.newValidator])), "InvalidRoot"); // ROOT type
  assert.equal(await attempt(concat(["0x02", world.newValidator])), "InvalidRoot"); // PERMISSION type
  assert.equal(await attempt(concat(["0x01", zeroAddress])), "InvalidRoot");
  assert.equal(await attempt(concat(["0x01", ATTACKER])), "InvalidRoot"); // no code
  assert.equal(await attempt(concat(["0x01", world.validator])), "InvalidRoot"); // the module itself
  assert.equal((await world.pending()).active, false);
});

// ── the exact batch ───────────────────────────────────────────────────────────────────────────────

test("exact batch: validates, returns validAfter = executeAfter, and consumes the recovery", async () => {
  const { world, nonce, exact } = await matured();
  const pending = await world.pending();
  const result = await world.validate(batch(exact));
  assert.equal(result.ok, true, result.error);
  const validationData = BigInt(result.value as Hex);
  assert.equal(validationData >> 208n, pending.executeAfter, "validAfter");
  assert.equal((validationData >> 160n) & ((1n << 48n) - 1n), 0n, "validUntil (none)");
  assert.equal(validationData & ((1n << 160n) - 1n), 0n, "no aggregator / sig failure");
  assert.equal((await world.pending()).active, false);
  assert.equal(await world.read<bigint>("recoveryNonce", [world.account]), 1n);
  assert.equal(await world.read<boolean>("isInitialized", [world.account]), false);
  assert.equal(
    await world.read<boolean>("usedRecoveryKeys", [world.account, world.recoveryAddress]),
    true,
  );
  void nonce;
});

test("exact batch: validation gas stays well inside a normal verification budget", async () => {
  const { world, exact } = await matured();
  const forwarded = await world.chain.raw({
    from: world.stranger,
    to: world.account,
    data: encodeFunctionData({
      abi: (await import("./testing/recovery-world.js")).accountAbi,
      functionName: "forward",
      args: [
        world.validator,
        world.fn("validateUserOp", [world.userOp(batch(exact)), pad("0x01", { size: 32 })]),
      ],
    }),
  });
  assert.equal(forwarded.ok, true);
  assert.ok(forwarded.gasUsed < 200_000n, `validation used ${forwarded.gasUsed} gas`);
});

test("no recovery pending: the exact batch is refused", async () => {
  const world = await installed();
  const exact = world.exactCalls(world.root(), 1);
  assert.equal((await world.validate(batch(exact))).error, "NoPendingRecovery");
});

test("the validator refuses a userOp whose sender is not the calling account", async () => {
  const { world, exact } = await matured();
  assert.equal((await world.validate(batch(exact), { sender: ATTACKER })).error, "WrongSender");
});

test("a recovery pending for account A never validates a batch for account B", async () => {
  const { world, root, nonce } = await matured();
  const other = await World.create();
  void other;
  const second = await world.chain.deploy(
    world.deployer,
    (await import("./testing/recovery-world.js")).accountAbi,
    (await import("./generated/artifacts.js")).artifacts.MockAccount.bytecode,
  );
  assert.equal((await world.install({ account: second })).ok, true);
  assert.equal(
    (await world.validate(batch(world.exactCalls(root, nonce, second)), { account: second })).error,
    "NoPendingRecovery",
  );
  // A's own recovery is untouched
  assert.equal((await world.pending()).active, true);
});

/** Variants of the exact batch. Every one must be refused; none may consume the recovery. */
function variants(world: World, root: ReturnType<World["root"]>, nonce: number): [string, Hex][] {
  const exact = world.exactCalls(root, nonce);
  const [c1, c2] = exact as [Call, Call];
  const account = world.account;
  const other = (over: Partial<ReturnType<World["root"]>>) => world.root({ ...root, ...over });
  const asBatch = (calls: Call[]) => batch(calls);
  return [
    [
      "new root: different validator data",
      asBatch(world.exactCalls(other({ validatorData: "0x1235" }), nonce)),
    ],
    [
      "new root: different validator instance",
      asBatch(world.exactCalls(other({ rootId: concat(["0x01", world.account]) }), nonce)),
    ],
    ["new root: different hook", asBatch(world.exactCalls(other({ hook: ATTACKER }), nonce))],
    [
      "new root: different hook data",
      asBatch(world.exactCalls(other({ hookData: "0x01" }), nonce)),
    ],
    [
      "new root: permission-type id",
      asBatch(world.exactCalls(other({ rootId: concat(["0x02", world.newValidator]) }), nonce)),
    ],
    ["removing invalidateNonce (batch of one)", asBatch([c1])],
    [
      "removing invalidateNonce (single-call mode)",
      executeData(MODE_SINGLE, concat([account, pad("0x00", { size: 32 }), c1.data!])),
    ],
    ["only invalidateNonce", asBatch([c2])],
    ["empty batch", asBatch([])],
    ["adding a harmless third call", asBatch([c1, c2, { to: account, data: "0x" }])],
    ["adding a native transfer", asBatch([c1, c2, { to: ATTACKER, value: 1n }])],
    [
      "adding an approve to an attacker",
      asBatch([
        c1,
        c2,
        {
          to: ATTACKER,
          data: concat(["0x095ea7b3", pad(ATTACKER, { size: 32 }), pad("0xff", { size: 32 })]),
        },
      ]),
    ],
    [
      "adding a swap-shaped call",
      asBatch([c1, c2, { to: ATTACKER, data: concat(["0x38ed1739", pad("0x01", { size: 32 })]) }]),
    ],
    ["a third call BEFORE the exact pair", asBatch([{ to: ATTACKER, value: 1n }, c1, c2])],
    ["replacing invalidateNonce with a transfer", asBatch([c1, { to: ATTACKER, value: 1n }])],
    ["replacing the root change with a transfer", asBatch([{ to: ATTACKER, value: 1n }, c2])],
    ["changing the target of call 1", asBatch([{ ...c1, to: ATTACKER }, c2])],
    ["changing the target of call 2", asBatch([c1, { ...c2, to: ATTACKER }])],
    ["native value on call 1", asBatch([{ ...c1, value: 1n }, c2])],
    ["native value on call 2", asBatch([c1, { ...c2, value: 1n }])],
    ["invalidateNonce(current)", asBatch([c1, { to: account, data: invalidateData(nonce) }])],
    [
      "invalidateNonce(current + 2)",
      asBatch([c1, { to: account, data: invalidateData(nonce + 2) }]),
    ],
    ["invalidateNonce(max)", asBatch([c1, { to: account, data: invalidateData(0xffffffff) }])],
    ["calls in the wrong order", asBatch([c2, c1])],
    ["the same call twice", asBatch([c1, c1])],
    ["delegatecall mode", executeData(MODE_DELEGATE, packExecutions(exact))],
    ["single mode with the whole pack", executeData(MODE_SINGLE, packExecutions(exact))],
    [
      "batch mode with an exec-type bit set (try/catch)",
      executeData(mode("0x0101", 30), packExecutions(exact)),
    ],
    [
      "batch mode with a mode selector",
      executeData(mode("0x010000000000111111110000", 20), packExecutions(exact)),
    ],
    [
      "non-canonical encoding: trailing word",
      executeData(MODE_BATCH, concat([packExecutions(exact), pad("0x", { size: 32 })])),
    ],
    [
      "non-canonical encoding: trailing byte",
      executeData(MODE_BATCH, concat([packExecutions(exact), "0x00"])),
    ],
    ["different selector: changeRootValidator directly", c1.data!],
    ["different selector: invalidateNonce directly", c2.data!],
    ["different selector: executeUserOp", concat(["0x8dd7712f", batch(exact).slice(10) as Hex])],
    ["no calldata", "0x"],
    ["short calldata", "0x1234"],
    ["execute selector only", "0xe9ae5c53"],
    ["extra bytes after the exact calldata", concat([batch(exact), "0x00"])],
    ["extra word after the exact calldata", concat([batch(exact), pad("0x", { size: 32 })])],
  ];
}

test("exact batch: every variant is refused and leaves the recovery pending", async () => {
  const { world, root, nonce, exact } = await matured();
  const pendingBefore = await world.pending();
  const nonceBefore = await world.read<bigint>("recoveryNonce", [world.account]);
  for (const [name, data] of variants(world, root, nonce)) {
    const outcome = await world.validate(data);
    assert.equal(outcome.ok, false, `ACCEPTED: ${name}`);
  }
  assert.deepEqual(await world.pending(), pendingBefore);
  assert.equal(await world.read<bigint>("recoveryNonce", [world.account]), nonceBefore);
  assert.equal(await world.read<boolean>("isInitialized", [world.account]), true);
  // and the exact one still works afterwards
  assert.equal((await world.validate(batch(exact))).ok, true);
});

test("exact batch: variants fail with the batch error, not by accident", async () => {
  const { world, root, nonce } = await matured();
  let batchErrors = 0;
  for (const [, data] of variants(world, root, nonce)) {
    const outcome = await world.validate(data);
    if (outcome.error === "NotTheCommittedBatch") batchErrors++;
  }
  assert.ok(batchErrors >= 30, `only ${batchErrors} variants hit NotTheCommittedBatch`);
});

test("exact batch: currentNonce + 1 follows the account's CURRENT nonce", async () => {
  const world = await installed();
  const root = world.root();
  assert.equal((await world.initiate(root)).ok, true);
  await world.chain.call(
    world.stranger,
    world.account,
    (await import("./testing/recovery-world.js")).accountAbi,
    "setCurrentNonce",
    [7],
  );
  assert.equal(
    (await world.validate(batch(world.exactCalls(root, 1)))).error,
    "NotTheCommittedBatch",
  );
  assert.equal((await world.validate(batch(world.exactCalls(root, 7)))).ok, true);
});

test("exact batch: currentNonce = 2^32-1 cannot be overflowed into a valid batch", async () => {
  const world = await installed();
  const root = world.root();
  assert.equal((await world.initiate(root)).ok, true);
  await world.chain.call(
    world.stranger,
    world.account,
    (await import("./testing/recovery-world.js")).accountAbi,
    "setCurrentNonce",
    [0xffffffff],
  );
  const [change] = world.exactCalls(root, 0) as [Call, Call];
  for (const n of [0, 1, 0xffffffff]) {
    const outcome = await world.validate(
      batch([change, { to: world.account, data: invalidateData(n) }]),
    );
    assert.equal(outcome.ok, false, `invalidateNonce(${n}) accepted at currentNonce = 2^32-1`);
  }
});

// ── one shot, replay, voiding ─────────────────────────────────────────────────────────────────────

test("after success: replay fails, the recovery key is burnt, the module is void until a NEW key is installed", async () => {
  const { world, root, nonce, exact } = await matured();
  assert.equal((await world.validate(batch(exact))).ok, true);
  // replay of the very same batch
  assert.equal((await world.validate(batch(exact))).error, "NoPendingRecovery");
  // the module no longer accepts a recovery for this account
  assert.equal((await world.initiate(root)).error, "NotInitialized");
  // the OLD recovery key can never be installed again
  assert.equal((await world.install()).error, "RecoveryKeyAlreadyUsed");
  assert.equal(
    (await world.asAccount(world.fn("setRecoveryKey", [world.recoveryAddress]))).error,
    "NotInitialized",
  );
  // a NEW recovery key can (this is what the new root does after recovery)
  const newKey = generatePrivateKey();
  assert.equal(
    (await world.install({ recoveryKey: privateKeyToAccount(newKey).address })).ok,
    true,
  );
  // signatures from the first recovery (nonce 0) are dead: the nonce moved on
  const stale = await world.sign(world.recoveryKey, root, { nonce: 0n });
  assert.equal((await world.initiate(root, { sigRecovery: stale })).error, "BadSignature");
  void nonce;
});

test("the same recovery nonce succeeds only once, across the whole lifecycle", async () => {
  const { world, root, nonce, exact } = await matured();
  const seen = new Set<bigint>();
  seen.add(await world.read<bigint>("recoveryNonce", [world.account]));
  assert.equal((await world.validate(batch(exact))).ok, true);
  seen.add(await world.read<bigint>("recoveryNonce", [world.account]));
  const newKey = generatePrivateKey();
  assert.equal(
    (await world.install({ recoveryKey: privateKeyToAccount(newKey).address })).ok,
    true,
  );
  const second = await world.sign(newKey, root);
  assert.equal((await world.initiate(root, { sigRecovery: second })).ok, true);
  world.chain.warp(72 * 3600 + 1);
  assert.equal((await world.validate(batch(world.exactCalls(root, nonce)))).ok, true);
  seen.add(await world.read<bigint>("recoveryNonce", [world.account]));
  assert.equal(seen.size, 3, "recovery nonce must strictly increase");
});

// ── cancellation ─────────────────────────────────────────────────────────────────────────

test("cancel: the account (root-signed operation) cancels; the matured batch then fails; signatures cannot be reused", async () => {
  const world = await installed();
  const root = world.root();
  const sigRecovery = await world.sign(world.recoveryKey, root);
  assert.equal((await world.initiate(root, { sigRecovery })).ok, true);
  assert.equal((await world.asAccount(world.fn("cancel"))).ok, true);
  assert.equal((await world.pending()).active, false);
  assert.equal(await world.read<bigint>("recoveryNonce", [world.account]), 1n);
  world.chain.warp(72 * 3600 + 1);
  assert.equal((await world.validate(batch(world.exactCalls(root, 1)))).error, "NoPendingRecovery");
  assert.equal((await world.initiate(root, { sigRecovery })).error, "BadSignature");
  // a fresh recovery works again
  assert.equal((await world.initiate(root)).ok, true);
});

test("cancel: only the account can cancel its own recovery; nothing to cancel is an error", async () => {
  const world = await installed();
  assert.equal((await world.asAccount(world.fn("cancel"))).error, "NoPendingRecovery");
  assert.equal((await world.initiate(world.root())).ok, true);
  // a stranger's cancel() acts on the stranger's own (empty) state
  assert.equal((await world.from(world.stranger, "cancel")).error, "NoPendingRecovery");
  assert.equal((await world.pending()).active, true);
});

test("nobody but the account can stop a recovery: no veto, no third-party cancel", async () => {
  const world = await installed();
  assert.equal((await world.initiate(world.root())).ok, true);
  for (const sender of [world.stranger, world.recoveryAddress]) {
    assert.equal((await world.from(sender, "cancel")).error, "NoPendingRecovery"); // acts on its own empty state
  }
  assert.equal((await world.pending()).active, true);
  const names = validatorAbi
    .filter((e) => e.type === "function")
    .map((e) => (e as { name: string }).name);
  assert.deepEqual(
    names.filter((n) => /cancel|veto/i.test(n)),
    ["cancel"],
  );
});

test("uninstall removes configuration and any pending recovery", async () => {
  const world = await installed();
  assert.equal((await world.initiate(world.root())).ok, true);
  assert.equal((await world.asAccount(world.fn("onUninstall", ["0x"]))).ok, true);
  assert.equal((await world.pending()).active, false);
  assert.equal(await world.read<boolean>("isInitialized", [world.account]), false);
});

// ── property / fuzz tests ─────────────────────────────────────────────────────────────────────────

/** A small seeded PRNG so failures reproduce. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, max: number) => Math.floor(r() * max);
const bytes = (r: () => number, n: number): Hex =>
  `0x${Array.from({ length: n }, () => int(r, 256).toString(16).padStart(2, "0")).join("")}`;

test("property: ANY mutation of the exact calldata (flip, truncate, extend, swap) is refused", async () => {
  const { world, nonce, root } = await matured();
  const exact = batch(world.exactCalls(root, nonce));
  const raw = exact.slice(2);
  const r = prng(7);
  for (let i = 0; i < 300; i++) {
    let mutated = raw;
    const kind = int(r, 4);
    if (kind === 0) {
      const at = int(r, raw.length / 2) * 2;
      const flipped = (Number.parseInt(raw.slice(at, at + 2), 16) ^ (1 << int(r, 8)))
        .toString(16)
        .padStart(2, "0");
      mutated = raw.slice(0, at) + flipped + raw.slice(at + 2);
    } else if (kind === 1) {
      mutated = raw.slice(0, int(r, raw.length / 2) * 2);
    } else if (kind === 2) {
      mutated = raw + bytes(r, 1 + int(r, 40)).slice(2);
    } else {
      const a = int(r, raw.length / 64) * 64;
      const b = int(r, raw.length / 64) * 64;
      if (a === b) continue;
      const wa = raw.slice(a, a + 64);
      const wb = raw.slice(b, b + 64);
      if (wa === wb) continue;
      const chars = raw.split("");
      chars.splice(a, 64, ...wb);
      chars.splice(b, 64, ...wa);
      mutated = chars.join("");
    }
    if (mutated === raw) continue;
    assert.equal(
      (await world.validate(`0x${mutated}`)).ok,
      false,
      `mutation ${i} (kind ${kind}) accepted`,
    );
  }
  assert.equal((await world.pending()).active, true);
  assert.equal((await world.validate(exact)).ok, true);
});

test("property: for random committed roots the exact batch is accepted and nothing else is", async () => {
  const r = prng(11);
  for (let i = 0; i < 25; i++) {
    const world = await installed();
    const root = world.root({
      validatorData: bytes(r, int(r, 130)),
      hookData: bytes(r, int(r, 70)),
      hook: r() < 0.5 ? zeroAddress : `0x${bytes(r, 20).slice(2)}`,
    });
    assert.equal((await world.initiate(root)).ok, true, `initiate ${i}`);
    world.chain.warp(72 * 3600 + 1);
    const nonce = 1 + int(r, 1_000_000);
    await world.chain.call(
      world.stranger,
      world.account,
      (await import("./testing/recovery-world.js")).accountAbi,
      "setCurrentNonce",
      [nonce],
    );
    const exact = batch(world.exactCalls(root, nonce));
    const tweaked = world.root({ ...root, validatorData: concat([root.validatorData, "0x00"]) });
    assert.equal(
      (await world.validate(batch(world.exactCalls(tweaked, nonce)))).ok,
      false,
      `tweaked ${i}`,
    );
    assert.equal(
      (await world.validate(batch([...world.exactCalls(root, nonce), { to: ATTACKER, value: 1n }])))
        .ok,
      false,
    );
    assert.equal((await world.validate(exact)).ok, true, `exact ${i}`);
  }
});

test("property: random signature bytes never start a recovery", async () => {
  const world = await installed();
  const root = world.root();
  const r = prng(3);
  for (let i = 0; i < 100; i++) {
    const outcome = await world.initiate(root, {
      sigRecovery: bytes(r, 65),
    });
    assert.equal(outcome.ok, false);
  }
  assert.equal((await world.pending()).active, false);
});

test("the validator has no function that moves value or calls out", () => {
  const names = validatorAbi
    .filter((e) => e.type === "function")
    .map((e) => (e as { name: string }).name)
    .sort();
  assert.deepEqual(names, [
    "RELAYER",
    "cancel",
    "commitmentOf",
    "configs",
    "domainSeparator",
    "initiate",
    "initiateDigest",
    "isInitialized",
    "isModuleType",
    "isValidSignatureWithSender",
    "minDelay",
    "onInstall",
    "onUninstall",
    "pendings",
    "recoveryNonce",
    "setDelay",
    "setRecoveryKey",
    "usedRecoveryKeys",
    "validateUserOp",
  ]);
  // no receive/fallback, no owner, no upgrade hook
  assert.equal(
    validatorAbi.some((e) => e.type === "receive" || e.type === "fallback"),
    false,
  );
  for (const banned of [
    "owner",
    "upgrade",
    "transfer",
    "withdraw",
    "execute",
    "call",
    "delegatecall",
  ]) {
    assert.equal(
      names.some((n) => n.toLowerCase().includes(banned)),
      false,
      banned,
    );
  }
});

test("MODE constants used by the tests match Kernel's batch mode", () => {
  assert.equal(MODE_BATCH, `0x01${"00".repeat(31)}`);
  assert.equal(
    rootCallData(concat(["0x01", ATTACKER]), zeroAddress, "0x", "0x").slice(0, 10).length,
    10,
  );
});

test("the shared client/backend helpers produce exactly what the contract verifies", async () => {
  const {
    recoveryDomain,
    recoveryInitiateMessage,
    recoveryInitiateTypes,
    recoveryRootId,
    recoveryInstallData,
  } = await import("./recovery.js");
  const world = await World.create();
  const data = recoveryInstallData(world.recoveryAddress, 72 * 3600);
  assert.equal((await world.asAccount(world.fn("onInstall", [data]))).ok, true);
  const root = {
    validator: world.newValidator,
    hook: zeroAddress,
    validatorData: "0xabcd" as Hex,
    hookData: "0x" as Hex,
  };
  assert.equal(recoveryRootId(root.validator), concat(["0x01", world.newValidator]));
  const deadline = world.chain.timestamp + 600n;
  const message = recoveryInitiateMessage({ account: world.account, nonce: 0n, root, deadline });
  const domain = recoveryDomain(Number(world.chain.chainId), world.validator);
  const sign = (key: Hex) =>
    privateKeyToAccount(key).signTypedData({
      domain,
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message,
    });
  const outcome = await world.from(world.relayer, "initiate", [
    world.account,
    {
      rootId: message.rootId,
      hook: message.hook,
      validatorDataHash: message.validatorDataHash,
      hookDataHash: message.hookDataHash,
    },
    deadline,
    await sign(world.recoveryKey),
  ]);
  assert.equal(outcome.ok, true, outcome.error);
});
