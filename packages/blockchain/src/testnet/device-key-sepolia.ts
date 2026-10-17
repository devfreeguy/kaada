/*
 * Celo SEPOLIA ONLY. Proves KaadaDeviceKeyValidator inside real Kernel v3.3 accounts, through the real EntryPoint
 * and the real RIP-7212 precompile, with software P-256 keys:
 *
 *   KAADA_HARNESS_STATE=<state.json> npx tsx src/testnet/device-key-sepolia.ts
 *
 * Scenario DEVICE: a device-key root; add a second key; both sign; revoke one; the last key cannot be removed while
 * root; rotate to a passkey root; rotate back to a fresh device-key root; the wallet address never changes.
 * Scenario RECOVERY (one wallet, three recoveries): passkey -> device key, device key -> a different device key,
 * device key -> passkey, each through KaadaRecoveryValidator committing to the predicted clone.
 */
import { writeFileSync } from "node:fs";

import { artifacts } from "@kaada/contracts";
import {
  PASSKEY_PURPOSE,
  deviceKeyInstallData,
  passkeyCredentialCommitment,
  passkeyInstallData,
  predictPasskeyInstance,
  recoveryCommitment,
  recoveryDomain,
  recoveryInitiateMessage,
  recoveryInitiateTypes,
  recoveryInstallData,
} from "@kaada/contracts";
import type { PasskeyCredential } from "@kaada/contracts";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { encodeFunctionData, keccak256, pad, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { SoftDevice, SoftPasskey } from "./soft-keys.js";
import {
  deployer,
  describeError,
  encodeExecute,
  invalidateData,
  newAccountWithRoot,
  nonceNow,
  pub,
  record,
  results,
  rootOf,
  salt,
  sel,
  state,
  statePath,
  submit as submitRaw,
  vid,
  wallet,
} from "./kernel-probe-lib.js";
import type { Account, Call } from "./kernel-probe-lib.js";

const GAS = { verification: 700_000n, call: 600_000n };
const DELAY = 25;
const CHAIN_ID = celoSepolia.id;

const deviceAbi = artifacts.KaadaDeviceKeyValidator.abi as unknown as Abi;
const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const recoveryAbi = artifacts.ShortDelayRecoveryValidator.abi as unknown as Abi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chainTime = async () => (await pub.getBlock()).timestamp;
async function waitUntil(timestamp: bigint): Promise<void> {
  while ((await chainTime()) <= timestamp + 4n) await sleep(2000);
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
let opCounter = 0;
/** submit() that also prints the EntryPoint's actualGasUsed for every included operation. */
const submit: typeof submitRaw = async (...args) => {
  const outcome = await submitRaw(...args);
  if (outcome.accepted) {
    opCounter += 1;
    console.log(
      `  [op ${opCounter}] actualGasUsed ${outcome.actualGasUsed ?? "n/a"} executed ${outcome.executed}`,
    );
  }
  return outcome;
};
const throwaway: Call = { to: deployer.address, value: 1n };
const ZERO32: Hex = pad("0x", { size: 32 });

interface Saved {
  validator?: Address;
  passkeyFactory?: { address: Address };
  deviceKey?: { implementation: Address; factory: Address };
  recoveryProbe?: { validator?: Address };
}
const saved = state as unknown as Saved;
const persist = () => writeFileSync(statePath ?? "", JSON.stringify(state), { mode: 0o600 });

async function readWithRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await request();
    } catch (error) {
      if (i > 15) throw error;
      await sleep(1000);
    }
  }
}

async function ensureContract(
  label: string,
  existing: Address | undefined,
  deploy: () => Promise<{ address: Address; gas: bigint }>,
): Promise<{ address: Address; gas: bigint }> {
  if (existing) {
    const code = await pub.getCode({ address: existing });
    if (code && code !== "0x") return { address: existing, gas: 0n };
  }
  const created = await deploy();
  console.log(label, created.address, "deployment gas", created.gas);
  await sleep(4000);
  return created;
}

async function main(): Promise<void> {
  const balance = Number(await pub.getBalance({ address: deployer.address })) / 1e18;
  console.log("deployer", deployer.address, "balance", balance, "CELO");
  if (balance < 0.55) throw new Error("deployer balance too low for the full run");

  const passkeyImpl = saved.validator;
  const passkeyFactory = saved.passkeyFactory?.address;
  if (!passkeyImpl || !passkeyFactory) throw new Error("run passkey-factory-sepolia.ts first");

  // ── implementation and factory ───────────────────────────────────────────────────────────────
  const impl = await ensureContract(
    "device validator",
    saved.deviceKey?.implementation,
    async () => {
      const hash = await wallet.deployContract({
        abi: deviceAbi,
        bytecode: artifacts.KaadaDeviceKeyValidator.bytecode,
        gas: 2_000_000n,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      return { address: receipt.contractAddress as Address, gas: receipt.gasUsed };
    },
  );
  const implCode = (await readWithRetry(() => pub.getCode({ address: impl.address }))) ?? "0x";
  const runtimeBytes = (implCode.length - 2) / 2;
  const deviceFactory = await ensureContract(
    "device factory",
    saved.deviceKey?.factory,
    async () => {
      const hash = await wallet.deployContract({
        abi: factoryAbi,
        bytecode: artifacts.KaadaPasskeyValidatorFactory.bytecode,
        args: [impl.address, keccak256(implCode)],
        gas: 1_500_000n,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      return { address: receipt.contractAddress as Address, gas: receipt.gasUsed };
    },
  );
  saved.deviceKey = { implementation: impl.address, factory: deviceFactory.address };
  persist();
  record(
    "device validator and its clone factory are deployed",
    runtimeBytes > 0,
    `runtime ${runtimeBytes} bytes`,
  );
  const expectedRuntime = `0x${artifacts.KaadaDeviceKeyValidator.deployedBytecode.slice(2)}`;
  record(
    "deployed runtime equals the compiled artifact",
    implCode.toLowerCase() === expectedRuntime.toLowerCase(),
    "",
  );

  const kinds = {
    device: { factory: deviceFactory.address, implementation: impl.address },
    passkey: { factory: passkeyFactory, implementation: passkeyImpl },
  } as const;
  type Kind = keyof typeof kinds;

  async function deployInstance(
    kind: Kind,
    scope: Address,
    purpose: (typeof PASSKEY_PURPOSE)[keyof typeof PASSKEY_PURPOSE],
    credential: PasskeyCredential,
    deploymentSalt: Hex = ZERO32,
  ): Promise<{ instance: Address; gas: bigint; matches: boolean }> {
    const target = kinds[kind];
    const predicted = predictPasskeyInstance(target.factory, target.implementation, {
      scope,
      purpose,
      credential,
      deploymentSalt,
    });
    const args = [scope, purpose, passkeyCredentialCommitment(credential), deploymentSalt];
    const { request, result } = await pub.simulateContract({
      account: deployer,
      address: target.factory,
      abi: factoryAbi,
      functionName: "deploy",
      args,
      gas: 400_000n,
    } as never);
    const [simulated] = result as unknown as [Address, boolean];
    const receipt = await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract(request),
    });
    await sleep(4000);
    return {
      instance: predicted,
      gas: receipt.gasUsed,
      matches: sameAddress(simulated, predicted),
    };
  }
  const deviceCredential = (key: SoftDevice): PasskeyCredential => ({
    x: key.point.x,
    y: key.point.y,
    authenticatorIdHash: key.keyId,
  });

  const deviceRead = <T>(instance: Address, name: string, args: unknown[]): Promise<T> =>
    readWithRetry(
      () =>
        pub.readContract({
          address: instance,
          abi: deviceAbi,
          functionName: name,
          args,
        }) as Promise<T>,
    );
  const signerOf = (key: SoftDevice, instance: Address, account: Account) =>
    key.signer(CHAIN_ID, instance, account.address);
  const add = (a: Account, instance: Address, key: SoftDevice): Call => ({
    to: instance,
    data: encodeFunctionData({
      abi: deviceAbi,
      functionName: "addKey",
      args: [key.keyId, key.point.x, key.point.y],
    }),
  });
  const remove = (instance: Address, keyId: Hex): Call => ({
    to: instance,
    data: encodeFunctionData({ abi: deviceAbi, functionName: "removeKey", args: [keyId] }),
  });
  const rotateBatch = async (a: Account, root: Address, validatorData: Hex): Promise<Hex> =>
    encodeExecute([
      {
        to: a.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "changeRootValidator",
          args: [vid(root), zeroAddress, validatorData, "0x"],
        }),
      },
      { to: a.address, data: invalidateData((await nonceNow(a)) + 1) },
    ]);

  // ═════════════════════════════ scenario DEVICE ═════════════════════════════
  const k1 = new SoftDevice();
  const k2 = new SoftDevice();
  const k3 = new SoftDevice();
  const walletSalt = salt();
  const d1 = await deployInstance(
    "device",
    zeroAddress,
    PASSKEY_PURPOSE.PRIMARY,
    deviceCredential(k1),
    walletSalt,
  );
  record(
    "device clone #1 deployed at the predicted address",
    d1.matches,
    `${d1.instance} (gas ${d1.gas})`,
  );
  const w1 = await newAccountWithRoot(
    d1.instance,
    deviceKeyInstallData(k1.point, k1.keyId),
    salt(),
  );
  console.log("wallet #1", w1.address);

  const created = await submit(
    w1,
    null,
    signerOf(k1, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "Kernel created with a DEVICE-KEY root; a real UserOperation signed by K1 executes",
    created.accepted && created.executed,
    created.detail,
  );
  if (!(created.accepted && created.executed)) throw new Error("setup failed");
  record(
    "the root is the device-key clone; one key enrolled",
    (await rootOf(w1)).includes(d1.instance.slice(2).toLowerCase()) &&
      (await deviceRead<bigint>(d1.instance, "keyCount", [w1.address])) === 1n,
    "",
  );

  // a signature for another account / chain / hash / validator is refused by the real EntryPoint
  const wrongChain = await submit(
    w1,
    null,
    k1.signer(1, d1.instance, w1.address),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "a signature for another chain id is refused (AA24)",
    !wrongChain.accepted,
    wrongChain.detail,
  );
  const wrongValidator = await submit(
    w1,
    null,
    k1.signer(CHAIN_ID, "0x2000000000000000000000000000000000000002", w1.address),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "a signature for another validator is refused",
    !wrongValidator.accepted,
    wrongValidator.detail,
  );
  const wrongAccount = await submit(
    w1,
    null,
    k1.signer(CHAIN_ID, d1.instance, "0x2000000000000000000000000000000000000003"),
    encodeExecute([throwaway]),
    GAS,
  );
  record("a signature for another account is refused", !wrongAccount.accepted, wrongAccount.detail);
  const stranger = await submit(
    w1,
    null,
    signerOf(new SoftDevice(), d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("an unenrolled device key is refused", !stranger.accepted, stranger.detail);

  const added = await submit(
    w1,
    null,
    signerOf(k1, d1.instance, w1),
    encodeExecute([add(w1, d1.instance, k2)]),
    GAS,
  );
  record("K1 adds a second device key K2", added.accepted && added.executed, added.detail);
  record(
    "two keys enrolled",
    (await deviceRead<bigint>(d1.instance, "keyCount", [w1.address])) === 2n,
    "",
  );
  const k2Op = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("the SECOND key signs a real UserOperation", k2Op.accepted && k2Op.executed, k2Op.detail);
  const k1Op = await submit(
    w1,
    null,
    signerOf(k1, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("the FIRST key still signs", k1Op.accepted && k1Op.executed, k1Op.detail);

  const revoke = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([remove(d1.instance, k1.keyId)]),
    GAS,
  );
  record("K2 revokes K1", revoke.accepted && revoke.executed, revoke.detail);
  const k1Dead = await submit(
    w1,
    null,
    signerOf(k1, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("the revoked key K1 is refused", !k1Dead.accepted, k1Dead.detail);

  const lastKey = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([remove(d1.instance, k2.keyId)]),
    GAS,
  );
  record(
    "the LAST key cannot be removed while this validator is the root (the operation reverts)",
    lastKey.accepted &&
      !lastKey.executed &&
      (await deviceRead<bigint>(d1.instance, "keyCount", [w1.address])) === 1n,
    lastKey.detail,
  );
  const stillOk = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "K2 still works after the refused removal",
    stillOk.accepted && stillOk.executed,
    stillOk.detail,
  );

  // rotate device root -> passkey root
  const p1 = new SoftPasskey();
  const pk1 = await deployInstance("passkey", w1.address, PASSKEY_PURPOSE.ROTATION, p1.credential);
  record(
    "passkey clone for the rotation deployed at the predicted address",
    pk1.matches,
    pk1.instance,
  );
  const rootBefore = await rootOf(w1);
  const toPasskey = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    await rotateBatch(w1, pk1.instance, passkeyInstallData(p1.credential)),
    GAS,
  );
  record(
    "the device key rotates the root to a PASSKEY atomically with invalidateNonce",
    toPasskey.accepted && toPasskey.executed,
    toPasskey.detail,
  );
  record(
    "root is the passkey clone; the wallet address is unchanged",
    rootBefore.includes(d1.instance.slice(2).toLowerCase()) &&
      (await rootOf(w1)).includes(pk1.instance.slice(2).toLowerCase()),
    w1.address,
  );
  const pkOp = await submit(w1, null, p1.sign, encodeExecute([throwaway]), GAS);
  record("the passkey signs", pkOp.accepted && pkOp.executed, pkOp.detail);
  const oldDeviceRoot = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "the old device key through the root is refused",
    !oldDeviceRoot.accepted,
    oldDeviceRoot.detail,
  );
  const oldDeviceLane = await submit(
    w1,
    d1.instance,
    signerOf(k2, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record(
    "the old device validator as a non-root lane is refused (voided)",
    !oldDeviceLane.accepted,
    oldDeviceLane.detail,
  );

  // rotate passkey root -> a FRESH device root
  const d2 = await deployInstance(
    "device",
    w1.address,
    PASSKEY_PURPOSE.ROTATION,
    deviceCredential(k3),
  );
  record("fresh device clone #2 deployed at the predicted address", d2.matches, d2.instance);
  const backToDevice = await submit(
    w1,
    null,
    p1.sign,
    await rotateBatch(w1, d2.instance, deviceKeyInstallData(k3.point, k3.keyId)),
    GAS,
  );
  record(
    "the passkey rotates the root back to a DEVICE KEY (a fresh instance)",
    backToDevice.accepted && backToDevice.executed,
    backToDevice.detail,
  );
  const k3Op = await submit(
    w1,
    null,
    signerOf(k3, d2.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("the new device key K3 signs", k3Op.accepted && k3Op.executed, k3Op.detail);
  const pkDead = await submit(w1, null, p1.sign, encodeExecute([throwaway]), GAS);
  record("the passkey is refused after the rotation back", !pkDead.accepted, pkDead.detail);
  const k2Dead = await submit(
    w1,
    null,
    signerOf(k2, d1.instance, w1),
    encodeExecute([throwaway]),
    GAS,
  );
  record("K2 (old device root) is still refused", !k2Dead.accepted, k2Dead.detail);
  record(
    "the wallet address stayed the same through every rotation",
    (await pub.getCode({ address: w1.address }))?.length !== 2 &&
      (await rootOf(w1)).includes(d2.instance.slice(2).toLowerCase()),
    w1.address,
  );

  // ═════════════════════════════ scenario RECOVERY ═════════════════════════════
  const probe = saved.recoveryProbe;
  if (!probe?.validator) throw new Error("no recovery probe fixtures in the state file");
  const MODULE: Address = probe.validator;
  const moduleKey = generatePrivateKey(); // the recovery module ignores the userOp signature

  const read = <T>(name: string, args: unknown[] = []): Promise<T> =>
    readWithRetry(
      () =>
        pub.readContract({
          address: MODULE,
          abi: recoveryAbi,
          functionName: name,
          args,
        }) as Promise<T>,
    );

  const p0 = new SoftPasskey();
  const w2salt = salt();
  const start = await deployInstance(
    "passkey",
    zeroAddress,
    PASSKEY_PURPOSE.PRIMARY,
    p0.credential,
    w2salt,
  );
  const w2 = await newAccountWithRoot(start.instance, passkeyInstallData(p0.credential), salt());
  console.log("wallet #2", w2.address);

  const armCalls = (a: Account, recoveryKey: Hex, nonce: number): Call[] => [
    {
      to: a.address,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "installValidations",
        args: [
          [vid(MODULE)],
          [{ nonce, hook: zeroAddress }],
          [recoveryInstallData(privateKeyToAccount(recoveryKey).address, DELAY)],
          ["0x"],
        ],
      }),
    },
    {
      to: a.address,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "grantAccess",
        args: [vid(MODULE), sel.execute, true],
      }),
    },
  ];

  const recoveryKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const setup = await submit(
    w2,
    null,
    p0.sign,
    encodeExecute(armCalls(w2, recoveryKeys[0]!, 1)),
    GAS,
  );
  record(
    "wallet #2 created with a passkey root and the recovery validator armed",
    setup.accepted && setup.executed,
    setup.detail,
  );
  if (!(setup.accepted && setup.executed)) throw new Error("setup failed");

  async function recover(input: {
    label: string;
    kind: Kind;
    credential: PasskeyCredential;
    installData: Hex;
    recoveryKey: Hex;
    deploymentSalt?: Hex;
  }): Promise<{ instance: Address }> {
    const clone = await deployInstance(
      input.kind,
      w2.address,
      PASSKEY_PURPOSE.RECOVERY,
      input.credential,
      input.deploymentSalt ?? ZERO32,
    );
    record(
      `${input.label}: recovery clone deployed at the predicted address`,
      clone.matches,
      clone.instance,
    );
    const root = {
      validator: clone.instance,
      hook: zeroAddress,
      validatorData: input.installData,
      hookData: "0x" as Hex,
    };
    const nonce = await read<bigint>("recoveryNonce", [w2.address]);
    const deadline = (await chainTime()) + 600n;
    const message = recoveryInitiateMessage({ account: w2.address, nonce, root, deadline });
    const signWith = (key: Hex) =>
      privateKeyToAccount(key).signTypedData({
        domain: recoveryDomain(CHAIN_ID, MODULE),
        types: recoveryInitiateTypes,
        primaryType: "Initiate",
        message,
      });
    let started = "ok";
    try {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: MODULE,
        abi: recoveryAbi,
        functionName: "initiate",
        args: [w2.address, recoveryCommitment(root), deadline, await signWith(input.recoveryKey)],
      } as never);
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      await sleep(4000);
    } catch (error) {
      started = describeError(error);
    }
    record(
      `${input.label}: recovery committed to the clone and its install data`,
      started === "ok",
      started,
    );
    const [, executeAfter] = await read<[Hex, number, boolean]>("pendings", [w2.address]);
    const batchFor = async (data: Hex) =>
      encodeExecute([
        {
          to: w2.address,
          data: encodeFunctionData({
            abi: KernelV3_3AccountAbi,
            functionName: "changeRootValidator",
            args: [vid(clone.instance), zeroAddress, data, "0x"],
          }),
        },
        { to: w2.address, data: invalidateData((await nonceNow(w2)) + 1) },
      ]);
    await waitUntil(BigInt(executeAfter));
    // the digest commits to the install data: another key's data under the same clone is NOT the committed batch
    const otherData =
      input.kind === "device"
        ? deviceKeyInstallData(new SoftDevice().point, keccak256("0x01"))
        : passkeyInstallData(new SoftPasskey().credential);
    const forged = await submit(w2, MODULE, moduleKey, await batchFor(otherData), GAS);
    record(
      `${input.label}: a batch with different install data is refused`,
      !forged.accepted,
      forged.detail,
    );
    const done = await submit(w2, MODULE, moduleKey, await batchFor(input.installData), GAS);
    record(
      `${input.label}: the exact committed batch executes`,
      done.accepted && done.executed,
      done.detail,
    );
    return { instance: clone.instance };
  }

  // 1. passkey -> device key
  const k4 = new SoftDevice();
  const r1 = await recover({
    label: "R1 passkey -> device key",
    kind: "device",
    credential: deviceCredential(k4),
    installData: deviceKeyInstallData(k4.point, k4.keyId),
    recoveryKey: recoveryKeys[0]!,
  });
  record(
    "R1: the wallet address is unchanged and the root is the device clone",
    (await rootOf(w2)).includes(r1.instance.slice(2).toLowerCase()),
    w2.address,
  );
  const k4Op = await submit(
    w2,
    null,
    signerOf(k4, r1.instance, w2),
    encodeExecute([throwaway]),
    GAS,
  );
  record("R1: the recovered device key signs", k4Op.accepted && k4Op.executed, k4Op.detail);
  const p0Dead = await submit(w2, null, p0.sign, encodeExecute([throwaway]), GAS);
  record("R1: the old passkey is refused", !p0Dead.accepted, p0Dead.detail);
  const rearm1 = await submit(
    w2,
    null,
    signerOf(k4, r1.instance, w2),
    encodeExecute(armCalls(w2, recoveryKeys[1]!, await nonceNow(w2))),
    GAS,
  );
  record(
    "R1: the new root re-arms recovery with a NEW recovery key",
    rearm1.accepted && rearm1.executed,
    rearm1.detail,
  );

  // 2. device key -> a different device key
  const k5 = new SoftDevice();
  const r2 = await recover({
    label: "R2 device key -> different device key",
    kind: "device",
    credential: deviceCredential(k5),
    installData: deviceKeyInstallData(k5.point, k5.keyId),
    recoveryKey: recoveryKeys[1]!,
  });
  const k5Op = await submit(
    w2,
    null,
    signerOf(k5, r2.instance, w2),
    encodeExecute([throwaway]),
    GAS,
  );
  record("R2: the different device key signs", k5Op.accepted && k5Op.executed, k5Op.detail);
  const k4Dead = await submit(
    w2,
    null,
    signerOf(k4, r1.instance, w2),
    encodeExecute([throwaway]),
    GAS,
  );
  record("R2: the previous device key is refused", !k4Dead.accepted, k4Dead.detail);
  const rearm2 = await submit(
    w2,
    null,
    signerOf(k5, r2.instance, w2),
    encodeExecute(armCalls(w2, recoveryKeys[2]!, await nonceNow(w2))),
    GAS,
  );
  record(
    "R2: the new root re-arms recovery again",
    rearm2.accepted && rearm2.executed,
    rearm2.detail,
  );

  // 3. device key -> passkey
  const p6 = new SoftPasskey();
  const r3 = await recover({
    label: "R3 device key -> passkey",
    kind: "passkey",
    credential: p6.credential,
    installData: passkeyInstallData(p6.credential),
    recoveryKey: recoveryKeys[2]!,
  });
  const p6Op = await submit(w2, null, p6.sign, encodeExecute([throwaway]), GAS);
  record("R3: the recovered passkey signs", p6Op.accepted && p6Op.executed, p6Op.detail);
  const k5Dead = await submit(
    w2,
    null,
    signerOf(k5, r2.instance, w2),
    encodeExecute([throwaway]),
    GAS,
  );
  record("R3: the device key is refused", !k5Dead.accepted, k5Dead.detail);
  record(
    "R3: the wallet address is unchanged after three recoveries",
    (await rootOf(w2)).includes(r3.instance.slice(2).toLowerCase()) &&
      (await pub.getCode({ address: w2.address }))?.length !== 2,
    w2.address,
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    `[gas] device validator deployment ${impl.gas} (runtime ${runtimeBytes} B) | device factory deployment ${deviceFactory.gas} | clone deployments ${[d1, d2, pk1, start].map((c) => c.gas).join(", ")}`,
  );
  if (failed.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
