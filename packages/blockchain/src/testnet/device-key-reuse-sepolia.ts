/*
 * Celo SEPOLIA ONLY. Demonstrates, live, why a root must always be a FRESH validator instance: rotating a Kernel back
 * to a device-key validator instance it already used does NOT call onInstall, so the old keys come back to life and
 * the key named in the new install data is ignored.
 *
 *   KAADA_HARNESS_STATE=<state.json> KAADA_VIA_ALTO=1 npx tsx src/testnet/device-key-reuse-sepolia.ts
 */
import { artifacts } from "@kaada/contracts";
import {
  PASSKEY_PURPOSE,
  deviceKeyInstallData,
  passkeyCredentialCommitment,
  passkeyInstallData,
  predictPasskeyInstance,
} from "@kaada/contracts";
import type { PasskeyCredential } from "@kaada/contracts";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { encodeFunctionData, pad, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import { celoSepolia } from "viem/chains";

import {
  deployer,
  encodeExecute,
  invalidateData,
  newAccountWithRoot,
  nonceNow,
  pub,
  record,
  results,
  rootOf,
  salt,
  state,
  submit,
  vid,
  wallet,
} from "./kernel-probe-lib.js";
import type { Account, Call } from "./kernel-probe-lib.js";
import { SoftDevice, SoftPasskey } from "./soft-keys.js";

const GAS = { verification: 700_000n, call: 600_000n };
const CHAIN_ID = celoSepolia.id;
const deviceAbi = artifacts.KaadaDeviceKeyValidator.abi as unknown as Abi;
const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const ZERO32: Hex = pad("0x", { size: 32 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const throwaway: Call = { to: deployer.address, value: 1n };

interface Saved {
  validator?: Address;
  passkeyFactory?: { address: Address };
  deviceKey?: { implementation: Address; factory: Address };
}
const saved = state as unknown as Saved;

async function main(): Promise<void> {
  const passkeyImpl = saved.validator;
  const passkeyFactory = saved.passkeyFactory?.address;
  const device = saved.deviceKey;
  if (!passkeyImpl || !passkeyFactory || !device)
    throw new Error("run the other Sepolia proofs first");

  async function deploy(
    factory: Address,
    implementation: Address,
    scope: Address,
    purpose: (typeof PASSKEY_PURPOSE)[keyof typeof PASSKEY_PURPOSE],
    credential: PasskeyCredential,
    deploymentSalt: Hex = ZERO32,
  ): Promise<Address> {
    const predicted = predictPasskeyInstance(factory, implementation, {
      scope,
      purpose,
      credential,
      deploymentSalt,
    });
    const { request } = await pub.simulateContract({
      account: deployer,
      address: factory,
      abi: factoryAbi,
      functionName: "deploy",
      args: [scope, purpose, passkeyCredentialCommitment(credential), deploymentSalt],
      gas: 400_000n,
    } as never);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    await sleep(4000);
    return predicted;
  }
  const cred = (key: SoftDevice): PasskeyCredential => ({
    x: key.point.x,
    y: key.point.y,
    authenticatorIdHash: key.keyId,
  });
  const signer = (key: SoftDevice, instance: Address, account: Account) =>
    key.signer(CHAIN_ID, instance, account.address);
  const rotate = async (a: Account, root: Address, data: Hex): Promise<Hex> =>
    encodeExecute([
      {
        to: a.address,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "changeRootValidator",
          args: [vid(root), zeroAddress, data, "0x"],
        }),
      },
      { to: a.address, data: invalidateData((await nonceNow(a)) + 1) },
    ]);

  const ka = new SoftDevice();
  const kb = new SoftDevice();
  const knew = new SoftDevice();
  const used = await deploy(
    device.factory,
    device.implementation,
    zeroAddress,
    PASSKEY_PURPOSE.PRIMARY,
    cred(ka),
    salt(),
  );
  const a = await newAccountWithRoot(used, deviceKeyInstallData(ka.point, ka.keyId), salt());
  console.log("wallet", a.address, "device instance", used);

  const created = await submit(a, null, signer(ka, used, a), encodeExecute([throwaway]), GAS);
  record(
    "wallet created with device instance U (key KA)",
    created.accepted && created.executed,
    created.detail,
  );
  const addB = await submit(
    a,
    null,
    signer(ka, used, a),
    encodeExecute([
      {
        to: used,
        data: encodeFunctionData({
          abi: deviceAbi,
          functionName: "addKey",
          args: [kb.keyId, kb.point.x, kb.point.y],
        }),
      },
    ]),
    GAS,
  );
  record("KA adds KB on U", addB.accepted && addB.executed, addB.detail);

  const p = new SoftPasskey();
  const pk = await deploy(
    passkeyFactory,
    passkeyImpl,
    a.address,
    PASSKEY_PURPOSE.ROTATION,
    p.credential,
  );
  const away = await submit(
    a,
    null,
    signer(ka, used, a),
    await rotate(a, pk, passkeyInstallData(p.credential)),
    GAS,
  );
  record("rotate away to a passkey root", away.accepted && away.executed, away.detail);
  const kbVoided = await submit(a, null, signer(kb, used, a), encodeExecute([throwaway]), GAS);
  record(
    "while the passkey is root, KB (on the old instance U) is refused",
    !kbVoided.accepted,
    kbVoided.detail,
  );

  // rotate BACK to the already-installed instance U, asking for a brand-new key KNEW
  const back = await submit(
    a,
    null,
    p.sign,
    await rotate(a, used, deviceKeyInstallData(knew.point, knew.keyId)),
    GAS,
  );
  record(
    "rotate back to the USED instance U with install data for KNEW",
    back.accepted && back.executed,
    back.detail,
  );
  record(
    "root is U again",
    (await rootOf(a)).includes(used.slice(2).toLowerCase()),
    await rootOf(a),
  );
  const knewOp = await submit(a, null, signer(knew, used, a), encodeExecute([throwaway]), GAS);
  record(
    "PREDICTED HAZARD: the key named in the new install data was NOT enrolled (onInstall never ran)",
    !knewOp.accepted,
    knewOp.detail,
  );
  const kbOp = await submit(a, null, signer(kb, used, a), encodeExecute([throwaway]), GAS);
  record(
    "PREDICTED HAZARD: the OLD key KB works again (revived by reusing the instance)",
    kbOp.accepted && kbOp.executed,
    kbOp.detail,
  );
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
