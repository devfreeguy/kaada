/*
 * Celo SEPOLIA ONLY. Runs the PRODUCTION KaadaRecoveryValidator source (the test-only short-delay build, which
 * differs only in the 10 s delay floor) inside a real Kernel v3.3 account, through the real EntryPoint:
 *
 *   KAADA_HARNESS_STATE=<state.json> npx tsx src/testnet/recovery-validator-sepolia.ts
 *
 * It checks what the in-process unit tests cannot: EntryPoint validAfter, Kernel's InvalidNonce voiding, the
 * selector grants, and re-arming a NEW recovery configuration after a recovery. Registry: the test mock
 * (the production registry is a later component).
 */
import { writeFileSync } from "node:fs";

import { artifacts } from "@kaada/contracts";
import {
  recoveryCommitment,
  recoveryDomain,
  recoveryInitiateMessage,
  recoveryInitiateTypes,
  recoveryInstallData,
} from "@kaada/contracts";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { encodeAbiParameters, encodeFunctionData, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
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

const GAS = { verification: 600_000n, call: 500_000n };
const DELAY = 25;
const MODE_BATCH: Hex = `0x01${"00".repeat(31)}`;

const validatorAbi = artifacts.ShortDelayRecoveryValidator.abi as unknown as Abi;
const registryAbi = artifacts.MockAttestorRegistry.abi as unknown as Abi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chainTime = async () => (await pub.getBlock()).timestamp;
async function waitUntil(timestamp: bigint): Promise<void> {
  while ((await chainTime()) <= timestamp + 4n) await sleep(2000);
}

const batch = (calls: Call[]): Hex =>
  encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "execute",
    args: [
      MODE_BATCH,
      encodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
          },
        ],
        [calls.map((c) => [c.to, c.value ?? 0n, c.data ?? "0x"] as const)],
      ),
    ],
  });

async function main(): Promise<void> {
  const balance = Number(await pub.getBalance({ address: deployer.address })) / 1e18;
  console.log("deployer", deployer.address, "balance", balance, "CELO");
  if (balance < 0.8) throw new Error("deployer balance too low");

  const registryHash = await wallet.deployContract({
    abi: registryAbi,
    bytecode: artifacts.MockAttestorRegistry.bytecode,
    gas: 600_000n,
  });
  const registry = (await pub.waitForTransactionReceipt({ hash: registryHash }))
    .contractAddress as Address;
  const attestorKey = generatePrivateKey();
  const attestorAddress = privateKeyToAccount(attestorKey).address;
  const set = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: "setAttestor",
    args: [attestorAddress],
    gas: 100_000n,
  });
  await pub.waitForTransactionReceipt({ hash: set });
  const moduleHash = await wallet.deployContract({
    abi: validatorAbi,
    bytecode: artifacts.ShortDelayRecoveryValidator.bytecode,
    args: [registry],
    gas: 4_000_000n,
  });
  const MODULE = (await pub.waitForTransactionReceipt({ hash: moduleHash }))
    .contractAddress as Address;
  (state as { recoveryProbe?: object }).recoveryProbe = {
    ...(state.recoveryProbe ?? { copies: [] }),
    registry,
    validator: MODULE,
  };
  writeFileSync(statePath ?? "", JSON.stringify(state), { mode: 0o600 });
  console.log("registry (mock)", registry, "validator", MODULE);
  await sleep(4000);

  const [, Z, W, V] = await ensureCopies(4);
  const kA = generatePrivateKey(); // original root owner (validator X)
  const kC = generatePrivateKey(); // new root owner (fresh instance Z)
  const kV = generatePrivateKey(); // second new root (fresh instance V)
  const kD = generatePrivateKey(); // session-like validator W
  const recoveryKey1 = generatePrivateKey(); // Recovery Code #1
  const recoveryKey2 = generatePrivateKey(); // Recovery Code #2 (after the first recovery)
  const throwaway: Call = { to: deployer.address, value: 1n };
  const attacker = privateKeyToAccount(generatePrivateKey()).address;
  const ownerData = (key: Hex): Hex => privateKeyToAccount(key).address;

  const read = async <T>(name: string, args: unknown[] = []): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return (await pub.readContract({
          address: MODULE,
          abi: validatorAbi,
          functionName: name,
          args,
        })) as T;
      } catch (error) {
        if (i > 15) throw error;
        await sleep(1000);
      }
    }
  };
  const viaModule = (a: Account, data: Hex) => submit(a, MODULE, kA, data, GAS);

  async function sign(
    key: Hex,
    a: Account,
    nonce: bigint,
    root: ReturnType<typeof rootFor>,
    deadline: bigint,
  ) {
    return privateKeyToAccount(key).signTypedData({
      domain: recoveryDomain(celoSepolia.id, MODULE),
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message: recoveryInitiateMessage({ account: a.address, nonce, root, deadline }),
    });
  }
  const rootFor = (validator: Address, owner: Hex) => ({
    validator,
    hook: zeroAddress,
    validatorData: ownerData(owner),
    hookData: "0x" as Hex,
  });
  async function initiate(
    a: Account,
    root: ReturnType<typeof rootFor>,
    recoveryKey: Hex,
    sigAttestorKey: Hex = attestorKey,
  ): Promise<string> {
    const nonce = await read<bigint>("recoveryNonce", [a.address]);
    const deadline = (await chainTime()) + 600n;
    const c = recoveryCommitment(root);
    try {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: MODULE,
        abi: validatorAbi,
        functionName: "initiate",
        args: [
          a.address,
          c,
          deadline,
          await sign(recoveryKey, a, nonce, root, deadline),
          await sign(sigAttestorKey, a, nonce, root, deadline),
        ],
      } as never);
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      await sleep(4000);
      return "ok";
    } catch (error) {
      return describeError(error);
    }
  }
  const exactBatch = async (a: Account, root: ReturnType<typeof rootFor>): Promise<Hex> =>
    batch([
      {
        to: a.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "changeRootValidator",
          args: [vid(root.validator), root.hook, root.validatorData, root.hookData],
        }),
      },
      { to: a.address, data: invalidateData((await nonceNow(a)) + 1) },
    ]);

  // ── account: root X; session-like W; the recovery validator (execute granted) ───────────────────
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
          [ownerData(kD), recoveryInstallData(privateKeyToAccount(recoveryKey1).address, DELAY)],
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
    "setup: account, session-like W and the PRODUCTION validator installed via Kernel",
    r.accepted && r.executed,
    r.detail,
  );
  if (!(r.accepted && r.executed)) throw new Error("setup failed");

  const rootZ = rootFor(Z!, kC);
  const tooSoon = await initiate(a, rootZ, recoveryKey1, recoveryKey1);
  record(
    "attestor key missing: recovery key signing both slots cannot start",
    tooSoon !== "ok",
    tooSoon,
  );
  const started = await initiate(a, rootZ, recoveryKey1);
  record("recovery key + attestor start a recovery", started === "ok", started);
  const [, executeAfter] = await read<[Hex, number, boolean]>("pendings", [a.address]);
  const exact = await exactBatch(a, rootZ);

  const early = await viaModule(a, exact);
  record("before executeAfter: refused by the EntryPoint", !early.accepted, early.detail);
  const wBefore = await submit(a, W!, kD, encodeExecute([throwaway]), GAS);
  record(
    "meanwhile the session-like validator still works (recovery is only pending)",
    wBefore.accepted && wBefore.executed,
    wBefore.detail,
  );

  await waitUntil(BigInt(executeAfter));
  const extra = await viaModule(a, batch([{ to: attacker, value: 1n }, ...[]]));
  record("a different batch is refused", !extra.accepted, extra.detail);
  const success = await viaModule(a, exact);
  record("the exact batch succeeds", success.accepted && success.executed, success.detail);
  record(
    "root is the committed instance Z",
    (await rootOf(a)).includes(Z!.slice(2).toLowerCase()),
    await rootOf(a),
  );
  const newRoot = await submit(a, null, kC, encodeExecute([throwaway]), GAS);
  record("the NEW root signs", newRoot.accepted && newRoot.executed, newRoot.detail);
  const oldRoot = await submit(a, null, kA, encodeExecute([throwaway]), GAS);
  record("the OLD root key is rejected", !oldRoot.accepted, oldRoot.detail);
  const wAfter = await submit(a, W!, kD, encodeExecute([throwaway]), GAS);
  record("the session-like validator is rejected (voided)", !wAfter.accepted, wAfter.detail);
  const replay = await viaModule(a, exact);
  record("REPLAY of the same batch fails", !replay.accepted, replay.detail);
  record(
    "the validator's own state is void for the account",
    (await read<boolean>("isInitialized", [a.address])) === false &&
      (await read<bigint>("recoveryNonce", [a.address])) === 1n,
    "",
  );

  // ── re-arm: the NEW root installs a NEW recovery configuration ──────────────────────────────────
  const oldKeyInstall = await submit(
    a,
    null,
    kC,
    encodeExecute(rearm(a, recoveryKey1, false)),
    GAS,
  );
  record(
    "re-arm with the OLD recovery key is refused",
    !(oldKeyInstall.accepted && oldKeyInstall.executed),
    `${oldKeyInstall.detail}`,
  );

  const plain = await submit(a, null, kC, encodeExecute(rearm(a, recoveryKey2, false)), GAS);
  console.log(
    `  plain re-install of the same validator address: accepted=${plain.accepted} executed=${plain.executed} ${plain.detail}`,
  );
  let rearmed = plain.accepted && plain.executed;
  if (!rearmed) {
    const viaUninstall = await submit(
      a,
      null,
      kC,
      encodeExecute(rearm(a, recoveryKey2, true)),
      GAS,
    );
    console.log(
      `  uninstall + install in one batch: accepted=${viaUninstall.accepted} executed=${viaUninstall.executed} ${viaUninstall.detail}`,
    );
    rearmed = viaUninstall.accepted && viaUninstall.executed;
  }
  record("the new root re-arms the validator with a NEW recovery key", rearmed, "");

  // ── second recovery with the new key, new root = V ──────────────────────────────────────────────
  const rootV = rootFor(V!, kV);
  const second = await initiate(a, rootV, recoveryKey2);
  record("second recovery starts with the NEW recovery key", second === "ok", second);
  const staleKey = await initiate(a, rootV, recoveryKey1);
  record("the OLD recovery key cannot start a recovery any more", staleKey !== "ok", staleKey);
  const [, executeAfter2] = await read<[Hex, number, boolean]>("pendings", [a.address]);
  await waitUntil(BigInt(executeAfter2));
  const second2 = await submit(a, MODULE, kC, await exactBatch(a, rootV), GAS);
  record(
    "second exact batch succeeds (recovery chain works repeatedly)",
    second2.accepted && second2.executed,
    second2.detail,
  );
  const vRoot = await submit(a, null, kV, encodeExecute([throwaway]), GAS);
  record("root after the second recovery is V", vRoot.accepted && vRoot.executed, vRoot.detail);
  const cOld = await submit(a, null, kC, encodeExecute([throwaway]), GAS);
  record(
    "the first recovered root (Z) is rejected after the second recovery",
    !cOld.accepted,
    cOld.detail,
  );

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} expectations met`);
  for (const f of failed) console.log("UNEXPECTED:", f.name, f.detail);

  /** Calls the new root signs to (re)install the validator with a new recovery key. */
  function rearm(account: Account, key: Hex, uninstallFirst: boolean): Call[] {
    const data = recoveryInstallData(privateKeyToAccount(key).address, DELAY);
    const nonce = 2;
    return [
      ...(uninstallFirst
        ? [
            {
              to: account.address,
              data: encodeFunctionData({
                abi: KernelV3_3AccountAbi,
                functionName: "uninstallValidation",
                args: [vid(MODULE), "0x", "0x"],
              }),
            },
          ]
        : []),
      {
        to: account.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "installValidations",
          args: [[vid(MODULE)], [{ nonce, hook: zeroAddress }], [data], ["0x"]],
        }),
      },
      {
        to: account.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "grantAccess",
          args: [vid(MODULE), sel.execute, true],
        }),
      },
    ];
  }
}

await main();
