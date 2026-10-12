/*
 * Celo SEPOLIA ONLY. Proves KaadaPasskeyValidatorFactory inside real Kernel v3.3 accounts, through the real
 * EntryPoint, with the real ZeroDev passkey validator (the Sepolia copy of the mainnet runtime) behind EIP-1167
 * clones and a software WebAuthn authenticator:
 *
 *   KAADA_HARNESS_STATE=<state.json> npx tsx src/testnet/passkey-factory-sepolia.ts
 *
 * Scenario ROTATION: clone #1 is the creation-time root (passkey P1); rotate to clone #2 (passkey P2); the wallet
 * address does not change; P2 signs; P1 does not.
 * Scenario RECOVERY: KaadaRecoveryValidator (short-delay build) commits to the PREDICTED clone for a recovered
 * passkey P4, the exact atomic batch switches the root to it, P4 signs, P3 does not.
 */
import { writeFileSync } from "node:fs";

import { artifacts } from "@kaada/contracts";
import {
  PASSKEY_PURPOSE,
  ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
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
import { encodeFunctionData, keccak256, pad, parseAbi, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { SoftPasskey } from "./soft-keys.js";
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
  submit,
  vid,
  wallet,
} from "./kernel-probe-lib.js";
import type { Account, Call } from "./kernel-probe-lib.js";

const GAS = { verification: 700_000n, call: 600_000n };
const DELAY = 25;

const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const recoveryAbi = artifacts.ShortDelayRecoveryValidator.abi as unknown as Abi;
const registryAbi = artifacts.MockAttestorRegistry.abi as unknown as Abi;
const passkeyAbi = parseAbi([
  "function isInitialized(address account) view returns (bool)",
  "function onInstall(bytes data)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chainTime = async () => (await pub.getBlock()).timestamp;
async function waitUntil(timestamp: bigint): Promise<void> {
  while ((await chainTime()) <= timestamp + 4n) await sleep(2000);
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const throwaway: Call = { to: deployer.address, value: 1n };

async function main(): Promise<void> {
  const balance = Number(await pub.getBalance({ address: deployer.address })) / 1e18;
  console.log("deployer", deployer.address, "balance", balance, "CELO");
  if (balance < 0.7) throw new Error("deployer balance too low");

  const fixtures = state as unknown as {
    validator?: Address;
    passkeyFactory?: { address: Address };
  };
  const implementation = fixtures.validator;
  if (!implementation) throw new Error("no Sepolia passkey validator fixture in the state file");
  const onChain = await pub.getCode({ address: implementation });
  record(
    "the Sepolia passkey validator fixture is byte-identical to the verified ZeroDev runtime",
    onChain !== undefined && keccak256(onChain) === ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
    implementation,
  );

  // ── factory ──────────────────────────────────────────────────────────────────────────────────
  let factory = fixtures.passkeyFactory?.address;
  if (factory) {
    const code = await pub.getCode({ address: factory });
    if (!code || code === "0x") factory = undefined;
  }
  let factoryGas = 0n;
  if (!factory) {
    const hash = await wallet.deployContract({
      abi: factoryAbi,
      bytecode: artifacts.KaadaPasskeyValidatorFactory.bytecode,
      args: [implementation, ZERODEV_PASSKEY_VALIDATOR_CODEHASH],
      gas: 1_500_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    factory = receipt.contractAddress as Address;
    factoryGas = receipt.gasUsed;
    fixtures.passkeyFactory = { address: factory };
    writeFileSync(statePath ?? "", JSON.stringify(state), { mode: 0o600 });
    await sleep(4000);
  }
  console.log("factory", factory, "deployment gas", factoryGas);
  const factoryAddress = factory;
  const runtime = await pub.getCode({ address: factoryAddress });
  record(
    "factory deployed with the pinned implementation code hash",
    (runtime?.length ?? 0) > 2,
    `runtime ${((runtime?.length ?? 2) - 2) / 2} bytes`,
  );

  const factoryRead = async <T>(name: string, args: unknown[]): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return (await pub.readContract({
          address: factoryAddress,
          abi: factoryAbi,
          functionName: name,
          args,
        })) as T;
      } catch (error) {
        if (i > 15) throw error;
        await sleep(1000);
      }
    }
  };
  const initialized = async (instance: Address, account: Address): Promise<boolean> => {
    for (let i = 0; ; i++) {
      try {
        return await pub.readContract({
          address: instance,
          abi: passkeyAbi,
          functionName: "isInitialized",
          args: [account],
        });
      } catch (error) {
        if (i > 15) throw error;
        await sleep(1000);
      }
    }
  };
  async function deployInstance(
    input: Parameters<typeof predictPasskeyInstance>[2],
  ): Promise<{ instance: Address; gas: bigint; matches: boolean }> {
    const predicted = predictPasskeyInstance(factoryAddress, implementation as Address, input);
    const args = [
      input.scope,
      input.purpose,
      passkeyCredentialCommitment(input.credential),
      input.deploymentSalt ?? pad("0x", { size: 32 }),
    ];
    const { request, result } = await pub.simulateContract({
      account: deployer,
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "deploy",
      args,
      gas: 400_000n,
    } as never);
    const [simulated] = result as unknown as [Address, boolean];
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    await sleep(4000);
    return {
      instance: predicted,
      gas: receipt.gasUsed,
      matches: sameAddress(simulated, predicted),
    };
  }

  // ═════════════════════════════ scenario ROTATION ═════════════════════════════
  const p1 = new SoftPasskey();
  const p2 = new SoftPasskey();
  const walletSalt = salt();
  const primaryInput = {
    scope: zeroAddress,
    purpose: PASSKEY_PURPOSE.PRIMARY,
    credential: p1.credential,
    deploymentSalt: walletSalt,
  } as const;
  const clone1 = await deployInstance(primaryInput);
  const code1 = await pub.getCode({ address: clone1.instance });
  record(
    "creation-time root: predicted clone #1 == deployed address; EIP-1167 runtime",
    clone1.matches &&
      code1?.toLowerCase() ===
        `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`,
    `${clone1.instance} (deploy gas ${clone1.gas})`,
  );
  const repeat = await pub.simulateContract({
    account: deployer,
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "deploy",
    args: [zeroAddress, 0, passkeyCredentialCommitment(p1.credential), walletSalt],
  } as never);
  record(
    "repeat deployment is idempotent (same address, created = false)",
    sameAddress((repeat.result as unknown as [Address, boolean])[0], clone1.instance) &&
      (repeat.result as unknown as [Address, boolean])[1] === false,
    "",
  );

  const a = await newAccountWithRoot(clone1.instance, passkeyInstallData(p1.credential), salt());
  console.log("wallet #1", a.address);
  const rotationInput = {
    scope: a.address,
    purpose: PASSKEY_PURPOSE.ROTATION,
    credential: p2.credential,
  } as const;
  const clone2 = await deployInstance(rotationInput);
  record(
    "rotation clone #2 deployed at the predicted address, scoped to the wallet",
    clone2.matches,
    `${clone2.instance} (deploy gas ${clone2.gas})`,
  );

  // FRONT-RUNNING: the deployer EOA (acting as an attacker) calls onInstall on the victim's predicted instance
  const attackerKey = new SoftPasskey();
  const hijack = await wallet.writeContract({
    address: clone2.instance,
    abi: passkeyAbi,
    functionName: "onInstall",
    args: [passkeyInstallData(attackerKey.credential)],
    gas: 200_000n,
  });
  await pub.waitForTransactionReceipt({ hash: hijack });
  await sleep(4000);
  record(
    "front-run attempt: an outsider initializing the instance only touches its OWN entry, not the wallet's",
    (await initialized(clone2.instance, deployer.address)) &&
      !(await initialized(clone2.instance, a.address)),
    "",
  );
  record(
    "preflight: the factory says the wallet may still use clone #2",
    (await factoryRead<boolean>("canUseForAccount", [
      a.address,
      a.address,
      PASSKEY_PURPOSE.ROTATION,
      passkeyCredentialCommitment(p2.credential),
      pad("0x", { size: 32 }),
    ])) === true,
    "",
  );

  // first op creates the wallet with clone #1 as root, signed by P1
  const created = await submit(a, null, p1.sign, encodeExecute([throwaway]), GAS);
  record(
    "wallet created with the passkey clone #1 as root; P1 signs the first operation",
    created.accepted && created.executed,
    created.detail,
  );
  if (!(created.accepted && created.executed)) throw new Error("setup failed");
  record(
    "clone #1 is initialized for the wallet",
    await initialized(clone1.instance, a.address),
    "",
  );
  const reuse = await factoryRead<boolean>("canUseForAccount", [
    zeroAddress,
    a.address,
    PASSKEY_PURPOSE.PRIMARY,
    passkeyCredentialCommitment(p1.credential),
    walletSalt,
  ]);
  record("preflight flags clone #1 as used (never silently reused)", reuse === false, "");
  const rootBefore = await rootOf(a);

  const rotate = async (clone: Address, credential: PasskeyCredential, signer: (h: Hex) => Hex) => {
    const nonce = await nonceNow(a);
    return submit(
      a,
      null,
      signer,
      encodeExecute([
        {
          to: a.address,
          data: encodeFunctionData({
            abi: KernelV3_3AccountAbi,
            functionName: "changeRootValidator",
            args: [vid(clone), zeroAddress, passkeyInstallData(credential), "0x"],
          }),
        },
        { to: a.address, data: invalidateData(nonce + 1) },
      ]),
      GAS,
    );
  };
  const rotated = await rotate(clone2.instance, p2.credential, p1.sign);
  record(
    "P1 rotates the root to clone #2 atomically with invalidateNonce",
    rotated.accepted && rotated.executed,
    rotated.detail,
  );
  const rootAfter = await rootOf(a);
  record(
    "root changed to clone #2; the wallet address is unchanged",
    rootBefore.includes(clone1.instance.slice(2).toLowerCase()) &&
      rootAfter.includes(clone2.instance.slice(2).toLowerCase()) &&
      (await pub.getCode({ address: a.address }))?.length !== 2,
    a.address,
  );
  const p2Op = await submit(a, null, p2.sign, encodeExecute([throwaway]), GAS);
  record("P2 signs through the new root", p2Op.accepted && p2Op.executed, p2Op.detail);
  const p1Root = await submit(a, null, p1.sign, encodeExecute([throwaway]), GAS);
  record("P1 can NOT sign through the root any more", !p1Root.accepted, p1Root.detail);
  const p1Old = await submit(a, clone1.instance, p1.sign, encodeExecute([throwaway]), GAS);
  record(
    "P1 through its OWN old validator instance is rejected (voided)",
    !p1Old.accepted,
    p1Old.detail,
  );
  record(
    "the old instance still exists and is still initialized (nothing was removed), yet cannot act",
    ((await pub.getCode({ address: clone1.instance }))?.length ?? 0) > 2 &&
      (await initialized(clone1.instance, a.address)),
    "",
  );
  record(
    "clone #2 is initialized for the wallet",
    await initialized(clone2.instance, a.address),
    "",
  );

  // ═════════════════════════════ scenario RECOVERY ═════════════════════════════
  const registryHash = await wallet.deployContract({
    abi: registryAbi,
    bytecode: artifacts.MockAttestorRegistry.bytecode,
    gas: 600_000n,
  });
  const registry = (await pub.waitForTransactionReceipt({ hash: registryHash }))
    .contractAddress as Address;
  const attestorKey = generatePrivateKey();
  const setHash = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: "setAttestor",
    args: [privateKeyToAccount(attestorKey).address],
    gas: 100_000n,
  });
  await pub.waitForTransactionReceipt({ hash: setHash });
  const moduleHash = await wallet.deployContract({
    abi: recoveryAbi,
    bytecode: artifacts.ShortDelayRecoveryValidator.bytecode,
    args: [registry],
    gas: 4_000_000n,
  });
  const MODULE = (await pub.waitForTransactionReceipt({ hash: moduleHash }))
    .contractAddress as Address;
  await sleep(4000);
  console.log("registry (mock)", registry, "recovery validator", MODULE);

  const p3 = new SoftPasskey(); // the wallet's passkey at creation
  const p4 = new SoftPasskey(); // the recovered passkey (new device)
  const recoveryKey = generatePrivateKey();
  const moduleKey = generatePrivateKey(); // the module ignores the userOp signature
  const walletSalt2 = salt();
  const clone3 = await deployInstance({
    scope: zeroAddress,
    purpose: PASSKEY_PURPOSE.PRIMARY,
    credential: p3.credential,
    deploymentSalt: walletSalt2,
  });
  const b: Account = await newAccountWithRoot(
    clone3.instance,
    passkeyInstallData(p3.credential),
    salt(),
  );
  console.log("wallet #2", b.address);

  const setup = await submit(
    b,
    null,
    p3.sign,
    encodeExecute([
      {
        to: b.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "installValidations",
          args: [
            [vid(MODULE)],
            [{ nonce: 1, hook: zeroAddress }],
            [recoveryInstallData(privateKeyToAccount(recoveryKey).address, DELAY)],
            ["0x"],
          ],
        }),
      },
      {
        to: b.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "grantAccess",
          args: [vid(MODULE), sel.execute, true],
        }),
      },
    ]),
    GAS,
  );
  record(
    "wallet #2 created with passkey root P3; recovery validator installed",
    setup.accepted && setup.executed,
    setup.detail,
  );
  if (!(setup.accepted && setup.executed)) throw new Error("setup failed");

  // The recovery commits to the PREDICTED clone for the recovered passkey, scoped to the wallet.
  const recoveredInput = {
    scope: b.address,
    purpose: PASSKEY_PURPOSE.RECOVERY,
    credential: p4.credential,
  } as const;
  const predicted = predictPasskeyInstance(factoryAddress, implementation, recoveredInput);
  const root = {
    validator: predicted,
    hook: zeroAddress,
    validatorData: passkeyInstallData(p4.credential),
    hookData: "0x" as Hex,
  };
  const read = async <T>(name: string, args: unknown[] = []): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return (await pub.readContract({
          address: MODULE,
          abi: recoveryAbi,
          functionName: name,
          args,
        })) as T;
      } catch (error) {
        if (i > 15) throw error;
        await sleep(1000);
      }
    }
  };
  const initiate = async (): Promise<string> => {
    const nonce = await read<bigint>("recoveryNonce", [b.address]);
    const deadline = (await chainTime()) + 600n;
    const message = recoveryInitiateMessage({ account: b.address, nonce, root, deadline });
    const signWith = (key: Hex) =>
      privateKeyToAccount(key).signTypedData({
        domain: recoveryDomain(celoSepolia.id, MODULE),
        types: recoveryInitiateTypes,
        primaryType: "Initiate",
        message,
      });
    try {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: MODULE,
        abi: recoveryAbi,
        functionName: "initiate",
        args: [
          b.address,
          recoveryCommitment(root),
          deadline,
          await signWith(recoveryKey),
          await signWith(attestorKey),
        ],
      } as never);
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      await sleep(4000);
      return "ok";
    } catch (error) {
      return describeError(error);
    }
  };

  const early = await initiate();
  record(
    "a recovery committing to a clone that is not deployed yet is refused (InvalidRoot)",
    early !== "ok",
    early,
  );
  const recovered = await deployInstance(recoveredInput);
  record(
    "the predicted recovery clone is deployed at the predicted address",
    recovered.matches,
    recovered.instance,
  );
  const started = await initiate();
  record("recovery committed to the clone address starts", started === "ok", started);
  const [, executeAfter] = await read<[Hex, number, boolean]>("pendings", [b.address]);
  const exact = encodeExecute([
    {
      to: b.address,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "changeRootValidator",
        args: [vid(predicted), zeroAddress, root.validatorData, "0x"],
      }),
    },
    { to: b.address, data: invalidateData((await nonceNow(b)) + 1) },
  ]);
  const tooSoon = await submit(b, MODULE, moduleKey, exact, GAS);
  record("before executeAfter: refused", !tooSoon.accepted, tooSoon.detail);
  await waitUntil(BigInt(executeAfter));
  const done = await submit(b, MODULE, moduleKey, exact, GAS);
  record(
    "the exact atomic batch switches the root to the committed clone",
    done.accepted && done.executed,
    done.detail,
  );
  record(
    "root is the recovered clone; the wallet address is unchanged",
    (await rootOf(b)).includes(predicted.slice(2).toLowerCase()),
    await rootOf(b),
  );
  record(
    "the recovered clone is initialized for the wallet",
    await initialized(predicted, b.address),
    "",
  );
  const p4Op = await submit(b, null, p4.sign, encodeExecute([throwaway]), GAS);
  record("the recovered passkey P4 signs", p4Op.accepted && p4Op.executed, p4Op.detail);
  const p3Root = await submit(b, null, p3.sign, encodeExecute([throwaway]), GAS);
  record("the OLD passkey P3 is rejected through the root", !p3Root.accepted, p3Root.detail);
  const p3Old = await submit(b, clone3.instance, p3.sign, encodeExecute([throwaway]), GAS);
  record(
    "P3 through its own old instance is rejected (voided by nonce invalidation)",
    !p3Old.accepted,
    p3Old.detail,
  );
  const replay = await submit(b, MODULE, moduleKey, exact, GAS);
  record("REPLAY of the recovery batch fails", !replay.accepted, replay.detail);
  record(
    "nonce invalidation took effect (currentNonce advanced)",
    (await nonceNow(b)) >= 2,
    String(await nonceNow(b)),
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    `[gas] factory deployment ${factoryGas} | clone deployments ${clone1.gas}, ${clone2.gas}, ${clone3.gas}, ${recovered.gas}`,
  );
  if (failed.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
