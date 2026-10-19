/*
 * OPERATOR TOOL (not part of the application: nothing imports it). Deploys Kaada's recovery contracts to a Celo network and PROVES
 * what it deployed, then prints the six addresses `packages/config/src/deployments.ts` needs.
 *
 *   tsx deploy-recovery-contracts.ts <celo-sepolia|celo-mainnet> <keys-dir> [--dry-run]
 *
 * <keys-dir> is a directory OUTSIDE the repository holding `deployer.key` and `relayer-<network>.key` (one 0x-prefixed 32-byte
 * hex key each). It never prints a key. Re-running resumes: contracts already recorded in `deployment-<network>.json` (in the
 * keys dir) are verified again, not deployed again.
 *
 * What it checks BEFORE spending anything: the chain id, the P-256 precompile (accepts a valid signature, rejects a forged one),
 * the EntryPoint v0.7, and the ZeroDev passkey validator (canonical address, exact code hash; on a test network where the
 * canonical copy is absent it deploys an identical copy and checks the code hash).
 *
 * What it checks AFTER deploying: the deployed code equals the compiled code (immutables aside), the immutables read back as
 * intended (relayer, implementation, implementation code hash), the production delay floor is 24 hours (NOT the test build), and a
 * stranger cannot call `initiate`.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { artifacts } from "@kaada/contracts";
import {
  ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
  ZERODEV_PASSKEY_VALIDATOR_MAINNET,
  ZERODEV_PASSKEY_VALIDATOR_RUNTIME,
} from "@kaada/contracts";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo, celoSepolia } from "viem/chains";

const NETWORKS = {
  "celo-sepolia": { chain: celoSepolia, rpc: "https://forno.celo-sepolia.celo-testnet.org" },
  "celo-mainnet": { chain: celo, rpc: "https://forno.celo.org" },
} as const;
type Network = keyof typeof NETWORKS;

const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const P256_PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;

const [networkArg, keysDirArg, ...flags] = process.argv.slice(2);
if (!networkArg || !(networkArg in NETWORKS) || !keysDirArg) {
  throw new Error(
    "usage: deploy-recovery-contracts.ts <celo-sepolia|celo-mainnet> <keys-dir> [--dry-run]",
  );
}
const network = networkArg as Network;
const dryRun = flags.includes("--dry-run");
const keysDir = resolve(keysDirArg);
const { chain, rpc } = NETWORKS[network];

const readKey = (name: string): Hex => {
  const text = readFileSync(join(keysDir, name), "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error(`${name} must hold one 0x-prefixed 32-byte hex key`);
  return text as Hex;
};

const deployer = privateKeyToAccount(readKey("deployer.key"));
const relayer = privateKeyToAccount(readKey(`relayer-${network.replace("celo-", "")}.key`));
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });

const statePath = join(keysDir, `deployment-${network}.json`);
interface DeploymentRecord {
  network: Network;
  chainId: number;
  deployer: Address;
  relayer: Address;
  contracts: Partial<
    Record<
      | "validator"
      | "passkeyImplementation"
      | "passkeyFactory"
      | "deviceImplementation"
      | "deviceFactory",
      { address: Address; txHash?: Hex; blockNumber?: string }
    >
  >;
}
const record: DeploymentRecord = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as DeploymentRecord)
  : {
      network,
      chainId: chain.id,
      deployer: deployer.address,
      relayer: relayer.address,
      contracts: {},
    };
const save = () => writeFileSync(statePath, `${JSON.stringify(record, null, 2)}\n`);

const log = (line: string) => console.log(line);
const ok = (name: string, detail = "") => log(`PASS  ${name}${detail ? `  - ${detail}` : ""}`);
function fail(name: string, detail: string): never {
  log(`FAIL  ${name}  - ${detail}`);
  throw new Error(`${name}: ${detail}`);
}
const expect = (condition: boolean, name: string, detail: string) => {
  if (!condition) fail(name, detail);
  ok(name, detail);
};

// ───────────────────────── 1. preconditions ─────────────────────────

async function preconditions(): Promise<void> {
  log(`\n== ${network}: preconditions ==`);
  log(`deployer ${deployer.address}`);
  log(`relayer  ${relayer.address}`);
  expect(deployer.address !== relayer.address, "deployer and relayer are different keys", "");
  expect((await pub.getChainId()) === chain.id, "chain id", String(chain.id));

  const entryPoint = await pub.getCode({ address: ENTRY_POINT_V07 });
  expect(
    entryPoint !== undefined && entryPoint !== "0x",
    "EntryPoint v0.7 is deployed",
    ENTRY_POINT_V07,
  );

  // The P-256 precompile: a valid signature verifies (returns 1), a forged one does not (returns nothing).
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const x = BigInt(`0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`);
  const y = BigInt(`0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`);
  const message = randomBytes(32);
  const digest = createHash("sha256").update(message).digest();
  const raw = sign("sha256", message, { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
  const r = BigInt(`0x${raw.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const call = async (rr: bigint, ss: bigint) =>
    (
      await pub.call({
        to: P256_PRECOMPILE,
        data: `0x${digest.toString("hex")}${word(rr)}${word(ss)}${word(x)}${word(y)}`,
      })
    ).data;
  expect(
    (await call(r, s)) === `0x${word(1n)}`,
    "P-256 precompile accepts a valid signature",
    "0x100",
  );
  expect(
    ((await call(r + 1n, s)) ?? "0x") === "0x",
    "P-256 precompile rejects a forged signature",
    "0x100",
  );

  const balance = await pub.getBalance({ address: deployer.address });
  log(`      deployer balance ${(Number(balance) / 1e18).toFixed(4)} CELO`);
  const relayerBalance = await pub.getBalance({ address: relayer.address });
  log(`      relayer balance  ${(Number(relayerBalance) / 1e18).toFixed(4)} CELO`);
}

// ───────────────────────── 2. deployment helpers ─────────────────────────

/** A public RPC may answer from a node that has not seen the new block yet: wait until the code is visible before using it. */
async function waitForCode(address: Address): Promise<Hex> {
  for (let i = 0; i < 45; i += 1) {
    const code = await pub.getCode({ address });
    if (code && code !== "0x") return code;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`no code at ${address} after 90 seconds`);
}

const artifact = (name: keyof typeof artifacts) => {
  const a = artifacts[name] as unknown as { abi: Abi; bytecode: string; deployedBytecode: string };
  const hex = (value: string): Hex => (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  return { abi: a.abi, bytecode: hex(a.bytecode), deployedBytecode: hex(a.deployedBytecode) };
};

async function deploy(
  key: keyof DeploymentRecord["contracts"],
  name: keyof typeof artifacts,
  args: readonly unknown[],
): Promise<Address> {
  const known = record.contracts[key];
  if (known) {
    const code = await pub.getCode({ address: known.address });
    if (code && code !== "0x") {
      ok(`${name} already deployed (verified again below)`, known.address);
      return known.address;
    }
  }
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args, account: deployer, chain });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    fail(`deploy ${name}`, `transaction ${hash} failed`);
  await waitForCode(receipt.contractAddress);
  record.contracts[key] = {
    address: getAddress(receipt.contractAddress),
    txHash: hash,
    blockNumber: String(receipt.blockNumber),
  };
  save();
  ok(`${name} deployed`, `${receipt.contractAddress} (tx ${hash})`);
  return getAddress(receipt.contractAddress);
}

/** The deployed code equals the compiled code, except where an immutable was written (left-padded to 32 bytes). */
async function codeMatches(
  address: Address,
  compiled: Hex,
  immutables: readonly Address[],
): Promise<boolean> {
  const onChain = ((await pub.getCode({ address })) ?? "0x").toLowerCase();
  let normalised = onChain;
  for (const value of immutables) {
    const padded = value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    normalised = normalised.split(padded).join("0".repeat(64));
  }
  return normalised === compiled.toLowerCase();
}

// ───────────────────────── 3. the ZeroDev passkey validator ─────────────────────────

async function passkeyImplementation(): Promise<Address> {
  const canonical = ZERODEV_PASSKEY_VALIDATOR_MAINNET;
  const code = await pub.getCode({ address: canonical });
  if (code && code !== "0x") {
    expect(
      keccak256(code) === ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
      "ZeroDev passkey validator at its canonical address has the expected code hash",
      canonical,
    );
    return canonical;
  }
  if (network === "celo-mainnet")
    fail("ZeroDev passkey validator", `not found at ${canonical} on mainnet`);

  // A test network without the canonical copy: an identical copy, proven by its code hash.
  const known = record.contracts.passkeyImplementation;
  if (known) return known.address;
  const runtime = ZERODEV_PASSKEY_VALIDATOR_RUNTIME.replace(/^0x/, "");
  const length = runtime.length / 2;
  // PUSH2 length, DUP1, PUSH1 10, RETURNDATASIZE(0), CODECOPY, RETURNDATASIZE(0), RETURN, then the runtime: returns the runtime as the code.
  const init = `0x61${length.toString(16).padStart(4, "0")}80600a3d393df3${runtime}` as Hex;
  const hash = await wallet.sendTransaction({ data: init, account: deployer, chain });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    fail("deploy ZeroDev validator copy", hash);
  const copy = getAddress(receipt.contractAddress);
  expect(
    keccak256(await waitForCode(copy)) === ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
    "the ZeroDev validator copy has the exact expected code hash",
    copy,
  );
  record.contracts.passkeyImplementation = {
    address: copy,
    txHash: hash,
    blockNumber: String(receipt.blockNumber),
  };
  save();
  return copy;
}

// ───────────────────────── 4. run ─────────────────────────

async function read<T>(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return (await pub.readContract({ address, abi, functionName, args })) as T;
}

async function main(): Promise<void> {
  await preconditions();
  if (dryRun) {
    log("\n== dry run: simulating the constructors, nothing is sent ==");
    for (const [name, args] of [
      ["KaadaRecoveryValidator", [relayer.address]],
      ["KaadaDeviceKeyValidator", []],
    ] as const) {
      const { abi, bytecode } = artifact(name);
      const initcode = (bytecode +
        encodeAbiParameters(
          (
            abi.find((e) => e.type === "constructor") as { inputs: { type: string }[] } | undefined
          )?.inputs.map((i) => ({ type: i.type })) ?? [],
          args as unknown as readonly unknown[],
        ).slice(2)) as Hex;
      const gas = await pub.estimateGas({ account: deployer.address, data: initcode });
      ok(`${name} constructor simulates`, `${gas} gas`);
    }
    log("\nDry run finished. Fund the deployer, then run again without --dry-run.");
    return;
  }

  log(`\n== ${network}: deploying ==`);
  const passkeyImpl = await passkeyImplementation();
  const validator = await deploy("validator", "KaadaRecoveryValidator", [relayer.address]);
  const deviceImpl = await deploy("deviceImplementation", "KaadaDeviceKeyValidator", []);
  const deviceCodehash = keccak256(await waitForCode(deviceImpl));
  const passkeyFactory = await deploy("passkeyFactory", "KaadaPasskeyValidatorFactory", [
    passkeyImpl,
    ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
  ]);
  const deviceFactory = await deploy("deviceFactory", "KaadaPasskeyValidatorFactory", [
    deviceImpl,
    deviceCodehash,
  ]);
  if (!record.contracts.passkeyImplementation)
    record.contracts.passkeyImplementation = { address: passkeyImpl };
  save();

  log(`\n== ${network}: verifying what is on chain ==`);
  const recoveryAbi = artifact("KaadaRecoveryValidator").abi;
  const factoryAbi = artifact("KaadaPasskeyValidatorFactory").abi;
  const deviceAbi = artifact("KaadaDeviceKeyValidator").abi;

  // Bytecode: the exact compiled production code (not the short-delay test build).
  expect(
    await codeMatches(validator, artifact("KaadaRecoveryValidator").deployedBytecode, [
      relayer.address,
    ]),
    "KaadaRecoveryValidator code equals the compiled production code",
    validator,
  );
  expect(
    keccak256((await pub.getCode({ address: validator })) ?? "0x") !==
      keccak256(artifact("ShortDelayRecoveryValidator").deployedBytecode),
    "it is NOT the short-delay test build",
    "",
  );
  expect(
    (await pub.getCode({ address: deviceImpl })) ===
      artifact("KaadaDeviceKeyValidator").deployedBytecode.toLowerCase() ||
      (await codeMatches(deviceImpl, artifact("KaadaDeviceKeyValidator").deployedBytecode, [])),
    "KaadaDeviceKeyValidator code equals the compiled code",
    deviceImpl,
  );
  expect(
    await codeMatches(passkeyFactory, artifact("KaadaPasskeyValidatorFactory").deployedBytecode, [
      passkeyImpl,
      ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
    ]),
    "passkey factory code equals the compiled code",
    passkeyFactory,
  );
  expect(
    await codeMatches(deviceFactory, artifact("KaadaPasskeyValidatorFactory").deployedBytecode, [
      deviceImpl,
      deviceCodehash,
    ]),
    "device-key factory code equals the compiled code",
    deviceFactory,
  );

  // Immutables and constants, read back from the chain.
  expect(
    getAddress(await read<Address>(validator, recoveryAbi, "RELAYER")) === relayer.address,
    "recovery validator RELAYER is the relayer address",
    relayer.address,
  );
  expect(
    (await read<number>(validator, recoveryAbi, "minDelay")) === 86_400,
    "recovery validator delay floor is 24 hours",
    "86400 s",
  );
  expect(
    getAddress(await read<Address>(passkeyFactory, factoryAbi, "IMPLEMENTATION")) === passkeyImpl &&
      (await read<Hex>(passkeyFactory, factoryAbi, "IMPLEMENTATION_CODEHASH")) ===
        ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
    "passkey factory points at the ZeroDev validator, with its code hash",
    passkeyImpl,
  );
  expect(
    getAddress(await read<Address>(deviceFactory, factoryAbi, "IMPLEMENTATION")) === deviceImpl &&
      (await read<Hex>(deviceFactory, factoryAbi, "IMPLEMENTATION_CODEHASH")) === deviceCodehash,
    "device-key factory points at the device-key validator, with its code hash",
    deviceImpl,
  );
  expect(
    (await read<bigint>(deviceImpl, deviceAbi, "MAX_KEYS")) === 16n &&
      (await read<bigint>(deviceImpl, deviceAbi, "VERSION")) === 1n,
    "device-key validator reads back its constants",
    "MAX_KEYS 16, VERSION 1",
  );
  expect(
    (await read<boolean>(validator, recoveryAbi, "isModuleType", [1n])) &&
      (await read<boolean>(deviceImpl, deviceAbi, "isModuleType", [1n])),
    "both validators declare themselves validator modules",
    "type 1",
  );

  // Behaviour: nobody but the relayer can start a recovery.
  const stranger = privateKeyToAccount(toHex(randomBytes(32)));
  let refusal = "";
  try {
    await pub.call({
      account: stranger.address,
      to: validator,
      data: encodeFunctionData({
        abi: recoveryAbi,
        functionName: "initiate",
        args: [
          zeroAddress,
          {
            rootId: `0x01${"00".repeat(20)}`,
            hook: zeroAddress,
            validatorDataHash: `0x${"00".repeat(32)}`,
            hookDataHash: `0x${"00".repeat(32)}`,
          },
          0n,
          "0x",
        ],
      }),
    });
    refusal = "the call did not revert";
  } catch (error) {
    // The revert data sits somewhere in viem's error chain: walk to it rather than guessing from the message text.
    const found = (
      error as { walk?: (fn: (x: unknown) => boolean) => { data?: Hex } | null }
    ).walk?.((x) => typeof (x as { data?: unknown })?.data === "string");
    try {
      refusal = found?.data
        ? decodeErrorResult({ abi: recoveryAbi, data: found.data }).errorName
        : "";
    } catch {
      refusal = "";
    }
  }
  expect(
    refusal === "NotRelayer",
    "a stranger calling initiate is refused with NotRelayer",
    refusal || "no refusal",
  );

  const deploymentsSnippet = `  "${network}": {
    validator: "${validator}",
    relayer: "${relayer.address}",
    passkeyFactory: "${passkeyFactory}",
    passkeyImplementation: "${passkeyImpl}",
    deviceFactory: "${deviceFactory}",
    deviceImplementation: "${deviceImpl}",
  },`;
  writeFileSync(join(keysDir, `deployments-snippet-${network}.txt`), `${deploymentsSnippet}\n`);
  log(
    `\nALL CHECKS PASSED on ${network}.\n\nPaste into packages/config/src/deployments.ts (RECOVERY_DEPLOYMENTS):\n${deploymentsSnippet}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
      : String(error);
  log(`
STOPPED: ${message.slice(0, 600)}`);
  process.exitCode = 1;
}
