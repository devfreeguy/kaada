/*
 * Celo SEPOLIA ONLY. Proves that a Kernel v3.3 validator which holds the `execute` selector can be limited,
 * by its own validateUserOp, to ONE exact atomic recovery batch (see contracts/RecoveryValidatorProbe.sol).
 *
 *   KAADA_HARNESS_STATE=<state.json> KAADA_RECOVERY_ARTIFACT=<compiled.json> \
 *     npx tsx src/testnet/recovery-atomic-probe.ts
 *
 * Nothing here is mainnet. The module is a PROTOTYPE of the production recovery validator.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseEther,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import {
  deployer,
  describeError,
  encodeExecute,
  ensureCopies,
  invalidateData,
  newAccount,
  nonceNow,
  pub,
  record,
  results,
  rootOf,
  salt,
  sel,
  state,
  statePath,
  submit,
  vid,
  wallet,
} from "./kernel-probe-lib.js";
import type { Account, Call } from "./kernel-probe-lib.js";

const artifactPath = process.env["KAADA_RECOVERY_ARTIFACT"];
if (!artifactPath) throw new Error("set KAADA_RECOVERY_ARTIFACT to the compiled prototype");
const artifact = (
  JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, { abi: never[]; bytecode: Hex }>
)["RecoveryValidatorProbe"]!;

const MIN_DELAY = 10;
const DELAY = 25;
const GAS = { verification: 600_000n, call: 500_000n };
const moduleAbi = parseAbi([
  "function commitmentOf(address account, bytes21 rootId, address hook, bytes validatorData, bytes hookData) pure returns (bytes32)",
  "function initiate(address account, bytes32 commitment, uint256 deadline, bytes sigRecovery, bytes sigAttestor)",
  "function cancel()",
  "function attestorCancel(address account)",
  "function onInstall(bytes data)",
  "function pendings(address) view returns (bytes32 commitment, uint48 executeAfter, bool active)",
  "function configs(address) view returns (address recoveryKey, address attestor, uint32 delay, uint64 nonce, bool installed)",
  "error BadConfig()",
  "error BadSignature()",
  "error NoPendingRecovery()",
  "error NotTheCommittedBatch()",
  "error RecoveryActive()",
]);

const MODE_BATCH: Hex = `0x01${"00".repeat(31)}`;
const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
const MODE_DELEGATE: Hex = `0xff${"00".repeat(31)}`;

const executionsType = [
  { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
] as const;
const packExecutions = (calls: Call[]): Hex =>
  encodeAbiParameters(executionsType, [
    calls.map((c) => [c.to, c.value ?? 0n, c.data ?? "0x"] as const),
  ]);
const executeData = (mode: Hex, execution: Hex): Hex =>
  encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "execute",
    args: [mode, execution],
  });
const batch = (calls: Call[]): Hex => executeData(MODE_BATCH, packExecutions(calls));

const rootCall = (
  account: Address,
  validator: Address,
  owner: Hex,
  hook: Address = zeroAddress,
): Call => ({
  to: account,
  data: encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "changeRootValidator",
    args: [vid(validator), hook, privateKeyToAccount(owner).address, "0x"],
  }),
});

async function chainTime(): Promise<bigint> {
  return (await pub.getBlock()).timestamp;
}
async function waitUntil(timestamp: bigint): Promise<void> {
  while ((await chainTime()) <= timestamp + 4n) await new Promise((r) => setTimeout(r, 2000));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const balance = Number(await pub.getBalance({ address: deployer.address })) / 1e18;
  console.log("deployer", deployer.address, "balance", balance, "CELO");
  if (balance < 0.4) throw new Error("deployer balance too low");

  // The module (prototype), a fresh deployment each run.
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [MIN_DELAY],
    gas: 3_000_000n,
  });
  const deployed = await pub.waitForTransactionReceipt({ hash: deployHash });
  const MODULE = deployed.contractAddress as Address;
  state.recoveryProbe ??= { copies: [] };
  (state.recoveryProbe as { module?: Address }).module = MODULE;
  writeFileSync(statePath ?? "", JSON.stringify(state), { mode: 0o600 });
  console.log("RecoveryValidatorProbe", MODULE);
  await sleep(4000);

  const [, Z, W, V] = await ensureCopies(4);
  const kA = generatePrivateKey(); // original root owner (validator X)
  const kC = generatePrivateKey(); // new root owner (fresh instance Z)
  const kOther = generatePrivateKey();
  const kD = generatePrivateKey(); // session-like validator W
  const recoveryKey = generatePrivateKey(); // what the Recovery Code derives
  const attestorKey = generatePrivateKey();
  const recoveryAddr = privateKeyToAccount(recoveryKey).address;
  const attestorAcc = privateKeyToAccount(attestorKey);
  const attacker = privateKeyToAccount(generatePrivateKey()).address;

  const domain = {
    name: "KaadaRecovery",
    version: "1",
    chainId: celoSepolia.id,
    verifyingContract: MODULE,
  } as const;
  const types = {
    Initiate: [
      { name: "account", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  } as const;
  const sign = (key: Hex, account: Address, nonce: bigint, commitment: Hex, deadline: bigint) =>
    privateKeyToAccount(key).signTypedData({
      domain,
      types,
      primaryType: "Initiate",
      message: { account, nonce, commitment, deadline },
    });

  // ── hard minimum delay (called as an arbitrary "account") ─────────────────────────────────────
  const installData = (delay: number): Hex =>
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint32" }],
      [recoveryAddr, attestorAcc.address, delay],
    );
  for (const [delay, shouldPass] of [
    [MIN_DELAY - 1, false],
    [MIN_DELAY, true],
  ] as const) {
    try {
      await pub.simulateContract({
        account: attacker,
        address: MODULE,
        abi: moduleAbi,
        functionName: "onInstall",
        args: [installData(delay)],
      });
      record(
        `hard minimum delay: install with delay ${delay}s (min ${MIN_DELAY}s)`,
        shouldPass,
        "accepted",
      );
    } catch (error) {
      record(
        `hard minimum delay: install with delay ${delay}s (min ${MIN_DELAY}s)`,
        !shouldPass,
        describeError(error),
      );
    }
  }

  async function setup(label: string): Promise<{ a: Account; commitment: Hex }> {
    const a = await newAccount(kA, salt());
    const install: Call[] = [
      {
        to: a.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "installValidations",
          args: [
            [vid(W!), vid(MODULE)],
            [
              { nonce: 1, hook: zeroAddress },
              { nonce: 1, hook: zeroAddress },
            ],
            [privateKeyToAccount(kD).address, installData(DELAY)],
            ["0x", "0x"],
          ],
        }),
      },
      ...[W!, MODULE].map((v) => ({
        to: a.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "grantAccess",
          args: [vid(v), sel.execute, true],
        }),
      })),
    ];
    const r = await submit(a, null, kA, encodeExecute(install), GAS);
    record(
      `[${label}] setup: account deployed; session-like W and the recovery module installed (execute granted)`,
      r.accepted && r.executed,
      r.detail,
    );
    if (!(r.accepted && r.executed)) throw new Error("setup failed");
    const commitment = await pub.readContract({
      address: MODULE,
      abi: moduleAbi,
      functionName: "commitmentOf",
      args: [a.address, vid(Z!), zeroAddress, privateKeyToAccount(kC).address, "0x"],
    });
    return { a, commitment };
  }

  async function initiate(
    a: Account,
    commitment: Hex,
    signers: [Hex, Hex],
    nonce: bigint,
  ): Promise<string> {
    const deadline = (await chainTime()) + 600n;
    const sigR = await sign(signers[0], a.address, nonce, commitment, deadline);
    const sigA = await sign(signers[1], a.address, nonce, commitment, deadline);
    try {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: MODULE,
        abi: moduleAbi,
        functionName: "initiate",
        args: [a.address, commitment, deadline, sigR, sigA],
      });
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      await sleep(4000);
      return "ok";
    } catch (error) {
      return describeError(error);
    }
  }

  const pending = async (a: Account) =>
    pub.readContract({
      address: MODULE,
      abi: moduleAbi,
      functionName: "pendings",
      args: [a.address],
    });
  const moduleNonce = async (a: Account) =>
    (
      await pub.readContract({
        address: MODULE,
        abi: moduleAbi,
        functionName: "configs",
        args: [a.address],
      })
    )[3];
  const throwaway: Call = { to: deployer.address, value: 1n };
  const expectedBatch = async (a: Account): Promise<Call[]> => [
    rootCall(a.address, Z!, kC),
    { to: a.address, data: invalidateData((await nonceNow(a)) + 1) },
  ];
  const viaModule = (a: Account, data: Hex) => submit(a, MODULE, kA, data, GAS);

  // ══ Account A: the full path ════════════════════════════════════════════════════════════════
  if (process.argv[2] !== "B") {
    const { a, commitment } = await setup("A");

    // who may start a recovery
    const nonce0 = await moduleNonce(a);
    const onlyRecovery = await initiate(a, commitment, [recoveryKey, recoveryKey], nonce0);
    record(
      "initiate: the recovery key alone (both slots) cannot start a recovery",
      onlyRecovery !== "ok",
      onlyRecovery,
    );
    const onlyAttestor = await initiate(a, commitment, [attestorKey, attestorKey], nonce0);
    record(
      "initiate: the attestor alone (both slots) cannot start a recovery",
      onlyAttestor !== "ok",
      onlyAttestor,
    );
    record("initiate: nothing pending after the failed attempts", !(await pending(a))[2], "");

    // a valid batch with no recovery pending
    const noPending = await viaModule(a, batch(await expectedBatch(a)));
    record(
      "no recovery pending: the exact batch is rejected",
      !noPending.accepted,
      noPending.detail,
    );

    const started = await initiate(a, commitment, [recoveryKey, attestorKey], nonce0);
    record("initiate: recovery key + attestor start a recovery", started === "ok", started);
    const [, executeAfter] = await pending(a);
    console.log("  executeAfter", executeAfter, "chain time", await chainTime());

    const exact = await expectedBatch(a);
    const tooEarly = await viaModule(a, batch(exact));
    record("execution before executeAfter fails", !tooEarly.accepted, tooEarly.detail);

    await waitUntil(BigInt(executeAfter));
    console.log("  matured; chain time", await chainTime());

    // negative variants, every one must be rejected and must leave the recovery pending
    const currentNonce = await nonceNow(a);
    const variants: [string, Hex][] = [
      ["changing the new root's owner key", batch([rootCall(a.address, Z!, kOther), exact[1]!])],
      [
        "changing the new root's validator instance",
        batch([rootCall(a.address, V!, kC), exact[1]!]),
      ],
      ["changing the new root's hook", batch([rootCall(a.address, Z!, kC, attacker), exact[1]!])],
      ["removing invalidateNonce (batch of one)", batch([exact[0]!])],
      [
        "removing invalidateNonce (single-call mode)",
        executeData(
          MODE_SINGLE,
          concat([a.address, ("0x" + "00".repeat(32)) as Hex, exact[0]!.data!]),
        ),
      ],
      ["only invalidateNonce", batch([exact[1]!])],
      ["adding a third harmless call", batch([...exact, throwaway])],
      [
        "adding a third call: native transfer to an attacker",
        batch([...exact, { to: attacker, value: 1n }]),
      ],
      [
        "adding a third call: token-style approve to an attacker",
        batch([...exact, { to: attacker, data: ("0x095ea7b3" + "00".repeat(64)) as Hex }]),
      ],
      [
        "replacing invalidateNonce with a transfer",
        batch([exact[0]!, { to: attacker, value: 1n }]),
      ],
      ["changing the target of call 1", batch([{ ...exact[0]!, to: attacker }, exact[1]!])],
      ["changing the target of call 2", batch([exact[0]!, { ...exact[1]!, to: attacker }])],
      ["adding native value to call 1", batch([{ ...exact[0]!, value: 1n }, exact[1]!])],
      ["adding native value to call 2", batch([exact[0]!, { ...exact[1]!, value: 1n }])],
      [
        "wrong invalidateNonce argument (+2)",
        batch([exact[0]!, { to: a.address, data: invalidateData(currentNonce + 2) }]),
      ],
      [
        "wrong invalidateNonce argument (+0)",
        batch([exact[0]!, { to: a.address, data: invalidateData(currentNonce) }]),
      ],
      ["calls in the wrong order", batch([exact[1]!, exact[0]!])],
      ["delegatecall mode", executeData(MODE_DELEGATE, packExecutions(exact))],
      [
        "non-canonical encoding (trailing bytes)",
        executeData(MODE_BATCH, concat([packExecutions(exact), ("0x" + "00".repeat(32)) as Hex])),
      ],
      ["different selector (changeRootValidator directly)", exact[0]!.data!],
    ];
    for (const [name, data] of variants) {
      const outcome = await viaModule(a, data);
      record(`variant rejected — ${name}`, !outcome.accepted, outcome.detail);
    }
    record(
      "after every variant the recovery is still pending and unconsumed",
      (await pending(a))[2] === true && (await moduleNonce(a)) === nonce0,
      "",
    );

    // the exact batch
    const before = {
      balance: await pub.getBalance({ address: a.address }),
      nonce: await nonceNow(a),
    };
    const success = await viaModule(a, batch(exact));
    record("the exact batch succeeds", success.accepted && success.executed, success.detail);
    const root = await rootOf(a);
    record(
      "root is now the committed validator instance Z",
      root.includes(Z!.slice(2).toLowerCase()),
      root,
    );
    const afterNonce = await nonceNow(a);
    record(
      "invalidateNonce(currentNonce + 1) took effect",
      afterNonce === before.nonce + 1,
      `${before.nonce} → ${afterNonce}`,
    );
    record(
      "no recovery pending afterwards; module nonce advanced",
      !(await pending(a))[2] && (await moduleNonce(a)) === nonce0 + 1n,
      "",
    );
    const newRootSigns = await submit(a, null, kC, encodeExecute([throwaway]));
    record(
      "the NEW root signs",
      newRootSigns.accepted && newRootSigns.executed,
      newRootSigns.detail,
    );
    const oldRoot = await submit(a, null, kA, encodeExecute([throwaway]));
    record("the OLD root key is rejected", !oldRoot.accepted, oldRoot.detail);
    const sessionAfter = await submit(a, W!, kD, encodeExecute([throwaway]));
    record(
      "the session-like validator installed before is rejected",
      !sessionAfter.accepted,
      sessionAfter.detail,
    );
    const recoveryAfter = await viaModule(a, batch(await expectedBatch(a)));
    record(
      "REPLAY: the recovery validator itself is voided; the same batch fails",
      !recoveryAfter.accepted,
      recoveryAfter.detail,
    );

    // the module's stored state still cannot be turned into a second recovery
    const staleSigs = await initiate(a, commitment, [recoveryKey, attestorKey], nonce0);
    const restart = await initiate(a, commitment, [recoveryKey, attestorKey], nonce0 + 1n);
    record(
      "old signatures (previous recovery nonce) cannot start another recovery",
      staleSigs !== "ok",
      staleSigs,
    );
    const stale = await viaModule(a, batch(await expectedBatch(a)));
    record(
      "even a fresh pending recovery on the voided module cannot execute",
      !stale.accepted,
      `initiate=${restart}; ${stale.detail}`,
    );
  }

  // ══ Account B: cancellation ═════════════════════════════════════════════════════════════════
  const { a: b, commitment: bCommit } = await setup("B");
  const fund = await wallet.sendTransaction({ to: attestorAcc.address, value: parseEther("0.02") });
  await pub.waitForTransactionReceipt({ hash: fund });
  const bNonce = await moduleNonce(b);
  record(
    "[B] initiate",
    (await initiate(b, bCommit, [recoveryKey, attestorKey], bNonce)) === "ok",
    "",
  );
  const cancelByRoot = await submit(
    b,
    null,
    kA,
    encodeExecute([
      { to: MODULE, data: encodeFunctionData({ abi: moduleAbi, functionName: "cancel" }) },
    ]),
    GAS,
  );
  record(
    "[B] the existing root cancels during the delay",
    cancelByRoot.accepted && cancelByRoot.executed,
    cancelByRoot.detail,
  );
  record(
    "[B] nothing pending after the cancel; module nonce advanced",
    !(await pending(b))[2] && (await moduleNonce(b)) === bNonce + 1n,
    "",
  );
  await sleep(DELAY * 1000);
  const afterCancel = await viaModule(b, batch(await expectedBatch(b)));
  record(
    "[B] after a cancel, the (matured) exact batch is rejected",
    !afterCancel.accepted,
    afterCancel.detail,
  );
  const reuse = await initiate(b, bCommit, [recoveryKey, attestorKey], bNonce);
  record("[B] the cancelled recovery's signatures cannot be reused", reuse !== "ok", reuse);

  record(
    "[B] initiate again with fresh signatures",
    (await initiate(b, bCommit, [recoveryKey, attestorKey], bNonce + 1n)) === "ok",
    "",
  );
  try {
    const { request } = await pub.simulateContract({
      account: attestorAcc,
      address: MODULE,
      abi: moduleAbi,
      functionName: "attestorCancel",
      args: [b.address],
    });
    const attestorWallet = (await import("viem")).createWalletClient({
      account: attestorAcc,
      chain: celoSepolia,
      transport: (await import("viem")).http("https://forno.celo-sepolia.celo-testnet.org"),
    });
    await pub.waitForTransactionReceipt({ hash: await attestorWallet.writeContract(request) });
    await sleep(4000);
    record("[B] the attestor can veto a pending recovery", !(await pending(b))[2], "");
  } catch (error) {
    record("[B] the attestor can veto a pending recovery", false, describeError(error));
  }
  try {
    await pub.simulateContract({
      account: attacker,
      address: MODULE,
      abi: moduleAbi,
      functionName: "attestorCancel",
      args: [b.address],
    });
    record("[B] a stranger cannot cancel as attestor", false, "accepted");
  } catch (error) {
    record("[B] a stranger cannot cancel as attestor", true, describeError(error));
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} expectations met`);
  for (const f of failed) console.log("UNEXPECTED:", f.name, f.detail);
}

await main();
