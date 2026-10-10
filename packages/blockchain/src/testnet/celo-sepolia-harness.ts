/*
 * STANDALONE Celo Sepolia (chain 11142220) validation harness for the Kernel / ERC-4337 side ONLY.
 *
 * Testnet fixtures, faucet funds, throwaway keys. It is not part of the application: nothing imports it,
 * it is not exported from the package, and the mainnet configuration is untouched. State (throwaway keys,
 * the software passkey, hashes) lives in a JSON file OUTSIDE the repository, named by KAADA_HARNESS_STATE.
 *
 *   tsx src/testnet/celo-sepolia-harness.ts deploy-validator
 *   tsx src/testnet/celo-sepolia-harness.ts kernel
 *   tsx src/testnet/celo-sepolia-harness.ts restart-check
 *
 * It never prints a key, the bundler URL or an enable-data blob.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { deserializePermissionAccount } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseEventLogs,
  erc20Abi,
  http,
  parseEther,
} from "viem";
import type { Address, Hex } from "viem";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { celo, celoSepolia } from "viem/chains";

import { createMoney } from "@kaada/domain";
import type { PermissionScope } from "@kaada/domain";

import { createKernelAddressDeriver } from "../wallet/kernel-deriver.js";
import { createZeroDevKernelAdapter } from "../execution/zerodev-kernel-adapter.js";
import type { KernelNetwork } from "../execution/zerodev-kernel-adapter.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org";
const MAINNET_VALIDATOR = "0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69" as const;
/** CELO's ERC-20 face (the "duality" token). Verified to exist on Sepolia before use. */
const CELO_ERC20 = "0x471EcE3750Da237f93B8E339c536989b8978a438" as const;
const RP_ID = "harness.kaada.test";
const ORIGIN = "https://harness.kaada.test";

const statePath = process.env["KAADA_HARNESS_STATE"];
const bundlerUrl = process.env["BUNDLER_URL_TESTNET"];
if (!statePath) throw new Error("set KAADA_HARNESS_STATE to a JSON file outside the repository");

interface State {
  deployerKey: Hex;
  validator?: Address;
  passkey?: { privateKeyPem: string; x: string; y: string; credentialId: string; counter: number };
  wallet?: Address;
  fixtures?: { spender: Address; otherSpender: Address; recipient: Address; swapTarget: Address };
  /** The validity window that was INSTALLED: the permission id hashes it, so read-back must reuse it. */
  window?: { validFrom: string; expiresAt: string };
  session?: { key: string; approval: string; address: Address };
  ops: Record<string, { userOpHash: Hex; txHash?: Hex; success?: boolean }>;
}
const load = (): State =>
  ({ ops: {}, ...(JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>) }) as State;
const save = (state: State) => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const log = (...parts: unknown[]) => console.log(...parts);

const publicClient = createPublicClient({ chain: celoSepolia, transport: http(SEPOLIA_RPC) });
const mainnetClient = createPublicClient({
  chain: celo,
  transport: http("https://forno.celo.org"),
});

function network(state: State): KernelNetwork {
  if (!state.validator) throw new Error("deploy the validator fixture first");
  return { chain: celoSepolia, passkeyValidatorAddress: state.validator, p256Precompile: true };
}

const randomAddress = (): Address => `0x${randomBytes(20).toString("hex")}`;

// ── commands ───────────────────────────────────────────────────────────────────────────────────

async function deployValidator(): Promise<void> {
  const state = load();
  const deployer = privateKeyToAccount(state.deployerKey);
  const wallet = createWalletClient({
    account: deployer,
    chain: celoSepolia,
    transport: http(SEPOLIA_RPC),
  });
  const runtime = await mainnetClient.getCode({ address: MAINNET_VALIDATOR });
  if (!runtime || runtime === "0x") throw new Error("mainnet validator code not found");
  const bytes = (runtime.length - 2) / 2;
  // initcode: PUSH2 len, DUP1, PUSH1 0x0c, PUSH1 0, CODECOPY, PUSH1 0, RETURN  ++ runtime
  const initcode =
    `0x61${bytes.toString(16).padStart(4, "0")}80600c6000396000f3${runtime.slice(2)}` as Hex;
  const hash = await wallet.sendTransaction({ data: initcode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("deployment failed");
  const deployed = await publicClient.getCode({ address: receipt.contractAddress });
  log(
    "validator fixture:",
    receipt.contractAddress,
    "| runtime identical to mainnet:",
    deployed === runtime,
  );
  if (deployed !== runtime) throw new Error("deployed code differs");
  state.validator = receipt.contractAddress;
  save(state);
}

function softPasskey(state: State): NonNullable<State["passkey"]> {
  if (state.passkey) return state.passkey;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  state.passkey = {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    x: Buffer.from(jwk.x ?? "", "base64url").toString("hex"),
    y: Buffer.from(jwk.y ?? "", "base64url").toString("hex"),
    credentialId: randomBytes(32).toString("base64url"),
    counter: 0,
  };
  save(state);
  return state.passkey;
}

/** A real-shaped WebAuthn assertion from the software key over the server's challenge (a UserOp hash). */
function assertionFor(state: State, challengeHex: Hex): unknown {
  const passkey = softPasskey(state);
  passkey.counter += 1;
  const authData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, passkey.counter]),
  ]);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challengeHex.slice(2), "hex").toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    }),
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    passkey.privateKeyPem,
  );
  save(state);
  return {
    id: passkey.credentialId,
    response: {
      authenticatorData: authData.toString("base64url"),
      clientDataJSON: clientData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
  };
}

async function waitReceipt(
  adapter: ReturnType<typeof createZeroDevKernelAdapter>,
  userOpHash: Hex,
): Promise<{ txHash: Hex; success: boolean; blockNumber: string }> {
  for (let i = 0; i < 40; i += 1) {
    const receipt = await adapter.getUserOperationReceipt(userOpHash);
    if (receipt.status === "INCLUDED") {
      return {
        txHash: receipt.txHash as Hex,
        success: receipt.success,
        blockNumber: receipt.blockNumber,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("no receipt within 2 minutes");
}

async function kernel(): Promise<void> {
  if (!bundlerUrl) throw new Error("BUNDLER_URL_TESTNET is not set");
  const state = load();
  const net = network(state);
  const adapter = createZeroDevKernelAdapter({ bundlerUrl, rpcUrl: SEPOLIA_RPC, network: net });
  const passkey = softPasskey(state);
  const credential = {
    credentialId: passkey.credentialId,
    publicKeyX: passkey.x,
    publicKeyY: passkey.y,
    rpId: RP_ID,
  };

  // 4. counterfactual account
  const deriver = createKernelAddressDeriver({
    rpcUrl: SEPOLIA_RPC,
    network: { chain: celoSepolia, passkeyValidatorAddress: state.validator as Address },
  });
  const wallet = (await deriver.deriveAddress(credential)) as Address;
  state.wallet = wallet;
  save(state);
  log("counterfactual account:", wallet, "| deployed before:", await adapter.isDeployed(wallet));
  if ((await publicClient.getCode({ address: CELO_ERC20 })) === undefined) {
    throw new Error("CELO ERC-20 face not found on Sepolia");
  }

  // fund the account for gas (no paymaster) and for the transfer test
  const deployer = privateKeyToAccount(state.deployerKey);
  const funder = createWalletClient({
    account: deployer,
    chain: celoSepolia,
    transport: http(SEPOLIA_RPC),
  });
  if ((await adapter.nativeBalance(wallet)) < parseEther("0.2")) {
    const hash = await funder.sendTransaction({ to: wallet, value: parseEther("0.3") });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  log("account native balance (wei):", (await adapter.nativeBalance(wallet)).toString());

  // fixtures: only addresses; the swap target is an EOA so any call to it "succeeds"
  state.fixtures ??= {
    spender: randomAddress(),
    otherSpender: randomAddress(),
    recipient: randomAddress(),
    swapTarget: randomAddress(),
  };
  save(state);
  const f = state.fixtures;
  state.window ??= {
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  };
  save(state);
  const scope: PermissionScope = {
    chainId: celoSepolia.id,
    allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
    allowedContracts: [CELO_ERC20, f.swapTarget],
    allowedAssetIds: ["asset-a", "asset-b"],
    perTransactionLimit: createMoney("1000", "asset-a"),
    approval: {
      tokenAddress: CELO_ERC20,
      spender: f.spender,
      limit: createMoney("1000", "asset-a"),
    },
    payout: {
      assetId: "asset-b",
      tokenAddress: CELO_ERC20,
      recipient: f.recipient,
      limit: createMoney("500", "asset-b"),
    },
    swapTarget: f.swapTarget,
    swapSelector: "0x12345678",
    validFrom: new Date(state.window.validFrom),
    expiresAt: new Date(state.window.expiresAt),
  };

  // Debugging aid: HARNESS_VARIANT=swaponly|approval|payout|full trims the scope to find what the chain rejects.
  const variant = process.env["HARNESS_VARIANT"] ?? "full";
  if (variant === "swaponly" || variant === "payout") delete scope.approval;
  if (variant === "swaponly" || variant === "approval") delete scope.payout;
  log("scope variant:", variant);

  // 5/6. ONE root operation: deploy the account (initCode) AND install the permission
  const submitMode = process.env["HARNESS_SUBMIT"] ?? "bundler";
  let currentOp = "root";
  const selfBundle = async (signed: Record<string, unknown>): Promise<Hex> => {
    const op: Record<string, unknown> = { ...signed };
    for (const key of [
      "nonce",
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (typeof op[key] === "string" && !String(op[key]).startsWith("0x"))
        op[key] = BigInt(op[key]);
    }
    const entryPoint = getEntryPoint("0.7").address;
    const hash = getUserOperationHash({
      userOperation: op as never,
      entryPointAddress: entryPoint,
      entryPointVersion: "0.7",
      chainId: celoSepolia.id,
    });
    const tx = await funder.writeContract({
      address: entryPoint,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[toPackedUserOperation(op as never)], deployer.address],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    // handleOps succeeding does not mean the operation did: read the EntryPoint's own event.
    const event = parseEventLogs({
      abi: entryPoint07Abi,
      logs: receipt.logs,
      eventName: "UserOperationEvent",
    })[0];
    const innerOk = receipt.status === "success" && event?.args.success === true;
    state.ops[currentOp] = { userOpHash: hash, txHash: tx, success: innerOk };
    save(state);
    log(
      `${currentOp} self-bundled via EntryPoint.handleOps | tx`,
      tx,
      "| operation success:",
      innerOk,
    );
    return hash;
  };
  const rootAdapter =
    submitMode === "self"
      ? createZeroDevKernelAdapter({
          bundlerUrl: bundlerUrl,
          rpcUrl: SEPOLIA_RPC,
          network: net,
          submitUserOperation: selfBundle,
        })
      : adapter;
  const delegateAdapter = rootAdapter;
  let sessionAddress: Address;
  if (state.ops["root"]?.success && state.session?.approval) {
    sessionAddress = state.session.address;
    log("root operation already done; resuming");
  } else {
    const prepared = await rootAdapter.prepareRootOperation({
      walletAddress: wallet,
      credential,
      calls: [],
      permission: { scope },
    });
    log("root challenge prepared (userOp hash):", prepared.challenge);
    // Persist the session key BEFORE anything is sent: a key lost after a send is a permission nobody can use.
    state.session = {
      key: prepared.sessionKey?.privateKey.reveal() ?? "",
      approval: "",
      address: prepared.sessionKey?.address as Address,
    };
    save(state);
    const sent = await rootAdapter.sendRootOperation({
      prepared: prepared.prepared,
      assertion: assertionFor(state, prepared.challenge as Hex),
    });
    const userOpHash = sent.userOpHash as Hex;
    log("root userOpHash:", userOpHash);
    state.session.approval = sent.approval?.reveal() ?? "";
    save(state);
    sessionAddress = state.session.address;
    if (submitMode !== "self") {
      const waited = await waitReceipt(adapter, userOpHash);
      state.ops["root"] = { userOpHash, ...waited };
      save(state);
    }
  }
  const rootOp = state.ops["root"] as { txHash?: Hex; success?: boolean };
  const rootBlock = rootOp.txHash
    ? (await publicClient.getTransactionReceipt({ hash: rootOp.txHash })).blockNumber.toString()
    : "?";
  log("root receipt: success =", rootOp.success, "| txHash", rootOp.txHash, "| block", rootBlock);
  log("deployed after:", await adapter.isDeployed(wallet));
  log(
    "account code size:",
    ((await publicClient.getCode({ address: wallet }))?.length ?? 2) / 2 - 1,
    "bytes",
  );

  await new Promise((resolve) => setTimeout(resolve, 8_000)); // let the RPC node catch up
  // 7. read-back
  log(
    "permission read-back (exact scope rebuilt):",
    await adapter.isPermissionInstalled({
      walletAddress: wallet,
      sessionKeyAddress: sessionAddress,
      scope,
    }),
  );
  log(
    "read-back with a DIFFERENT scope (spender changed):",
    await adapter.isPermissionInstalled({
      walletAddress: wallet,
      sessionKeyAddress: sessionAddress,
      scope: { ...scope, approval: { ...scope.approval!, spender: f.otherSpender } },
    }),
  );

  // 9. restricted signing with a bounded approval, then a batch: any-selector call + payout transfer
  const approve = (
    spender: Address,
    amount: bigint,
  ): { to: string; data: string; value: string } => ({
    to: CELO_ERC20,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    value: "0",
  });
  const transfer = (to: Address, amount: bigint) => ({
    to: CELO_ERC20,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    value: "0",
  });
  const delegate = async (name: string, calls: { to: string; data: string; value: string }[]) => {
    currentOp = name;
    const sender = submitMode === "self" ? delegateAdapter : adapter;
    const op = await sender.sendDelegatedCalls({
      walletAddress: wallet,
      sessionKey: { reveal: () => state.session?.key ?? "" } as never,
      approval: { reveal: () => state.session?.approval ?? "" } as never,
      calls,
    });
    if (submitMode !== "self") {
      const receipt = await waitReceipt(adapter, op.userOpHash as Hex);
      state.ops[name] = { userOpHash: op.userOpHash as Hex, ...receipt };
      save(state);
    }
    // Public RPC nodes behind one URL lag by a block; the next operation would read a stale nonce.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const done = state.ops[name];
    log(
      `${name}: success =`,
      done?.success,
      "| userOpHash",
      op.userOpHash,
      "| txHash",
      done?.txHash,
    );
  };
  await delegate("approve", [approve(f.spender, 1000n)]);
  await new Promise((resolve) => setTimeout(resolve, 6_000)); // RPC nodes lag a block behind
  log(
    "allowance on chain:",
    (
      await publicClient.readContract({
        address: CELO_ERC20,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, f.spender],
      })
    ).toString(),
  );
  const before = await publicClient.getBalance({ address: f.recipient });
  try {
    await delegate("swap-and-payout", [
      { to: f.swapTarget, data: "0x12345678", value: "0" }, // an arbitrary selector on the swap target
      transfer(f.recipient, 100n),
    ]);
    log("PINNED SELECTOR: the pinned selector on the swap target was ACCEPTED");
  } catch (error) {
    log(
      "PINNED SELECTOR: the pinned selector on the swap target was REFUSED ->",
      JSON.stringify((error as { details?: unknown }).details),
    );
  }
  // the payout alone is within the permission and must work
  await delegate("payout", [transfer(f.recipient, 100n)]);
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  log(
    "recipient received (wei):",
    ((await publicClient.getBalance({ address: f.recipient })) - before).toString(),
  );

  // 8. safe simulation of what the permission must REFUSE (prepareUserOperation estimates only; nothing is sent)
  const signer = await toECDSASigner({ signer: privateKeyToAccount(state.session.key as Hex) });
  const account = await deserializePermissionAccount(
    publicClient,
    getEntryPoint("0.7"),
    KERNEL_V3_3,
    state.session.approval,
    signer,
  );
  const accountClient = createKernelAccountClient({
    account,
    chain: celoSepolia,
    bundlerTransport: http(bundlerUrl),
    client: publicClient,
    userOperation: {
      estimateFeesPerGas: async () => {
        const f = await publicClient.estimateFeesPerGas();
        return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      },
    },
  });
  const refusals: [string, { to: string; data: string; value: string }[]][] = [
    ["approve to another spender", [approve(f.otherSpender, 1000n)]],
    ["approve above the limit (1001)", [approve(f.spender, 1001n)]],
    ["transfer to another recipient", [transfer(f.otherSpender, 1n)]],
    ["transfer above the payout limit (501)", [transfer(f.recipient, 501n)]],
    [
      "a different selector on the swap target",
      [{ to: f.swapTarget, data: "0x87654321", value: "0" }],
    ],
    ["native value on the swap target", [{ to: f.swapTarget, data: "0x12345678", value: "1" }]],
    ["call to an unlisted address", [{ to: randomAddress(), data: "0x12345678", value: "0" }]],
    [
      "unlisted selector on the token (transferFrom)",
      [
        {
          to: CELO_ERC20,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transferFrom",
            args: [wallet, f.recipient, 1n],
          }),
          value: "0",
        },
      ],
    ],
  ];
  for (const [label, calls] of refusals) {
    try {
      await accountClient.prepareUserOperation({
        callData: await account.encodeCalls(
          calls.map((c) => ({ to: c.to as Address, data: c.data as Hex, value: BigInt(c.value) })),
        ),
      });
      log(`SIMULATION ACCEPTED (unsafe?): ${label}`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
      log(`refused: ${label} -> ${message.slice(0, 140)}`);
    }
  }
  save(state);
}

function harnessScope(
  f: NonNullable<State["fixtures"]>,
  window: { validFrom: string; expiresAt: string },
): PermissionScope {
  return {
    chainId: celoSepolia.id,
    allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"],
    allowedContracts: [CELO_ERC20, f.swapTarget],
    allowedAssetIds: ["asset-a", "asset-b"],
    perTransactionLimit: createMoney("1000", "asset-a"),
    approval: {
      tokenAddress: CELO_ERC20,
      spender: f.spender,
      limit: createMoney("1000", "asset-a"),
    },
    payout: {
      assetId: "asset-b",
      tokenAddress: CELO_ERC20,
      recipient: f.recipient,
      limit: createMoney("500", "asset-b"),
    },
    swapTarget: f.swapTarget,
    swapSelector: "0x12345678",
    validFrom: new Date(window.validFrom),
    expiresAt: new Date(window.expiresAt),
  };
}

async function restartCheck(): Promise<void> {
  if (!bundlerUrl) throw new Error("BUNDLER_URL_TESTNET is not set");
  const state = load();
  // A brand-new adapter (a "restarted" process) recovers everything from the persisted hashes and the chain.
  const adapter = createZeroDevKernelAdapter({
    bundlerUrl,
    rpcUrl: SEPOLIA_RPC,
    network: network(state),
  });
  for (const [name, op] of Object.entries(state.ops)) {
    const viaChain = op.txHash
      ? await adapter.getTransactionReceipt(op.txHash)
      : { status: "NOT_FOUND" };
    const viaBundler = await adapter.getUserOperationReceipt(op.userOpHash);
    log(
      `${name}: chain receipt = ${viaChain.status} | bundler receipt = ${viaBundler.status} | recorded success = ${op.success}`,
    );
  }
  const f = state.fixtures;
  if (state.wallet && state.session && f && state.window) {
    log("account still deployed:", await adapter.isDeployed(state.wallet));
    log(
      "allowance still on chain:",
      (
        await publicClient.readContract({
          address: CELO_ERC20,
          abi: erc20Abi,
          functionName: "allowance",
          args: [state.wallet, f.spender],
        })
      ).toString(),
    );
    log(
      "permission read-back from the persisted window:",
      await adapter.isPermissionInstalled({
        walletAddress: state.wallet,
        sessionKeyAddress: state.session.address,
        scope: harnessScope(f, state.window),
      }),
    );
  }
  log(
    "unknown hash:",
    JSON.stringify(await adapter.getUserOperationReceipt(`0x${"ab".repeat(32)}`)),
  );
}

async function bundlerProbe(): Promise<void> {
  if (!bundlerUrl) throw new Error("BUNDLER_URL_TESTNET is not set");
  const state = load();
  const adapter = createZeroDevKernelAdapter({
    bundlerUrl,
    rpcUrl: SEPOLIA_RPC,
    network: network(state),
  });
  const f = state.fixtures;
  if (!f || !state.wallet || !state.session) throw new Error("run `kernel` first");
  const started = Date.now();
  const sent = await adapter.sendDelegatedCalls({
    walletAddress: state.wallet,
    sessionKey: { reveal: () => state.session?.key ?? "" } as never,
    approval: { reveal: () => state.session?.approval ?? "" } as never,
    calls: [
      {
        to: CELO_ERC20,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [f.recipient, 1n],
        }),
        value: "0",
      },
    ],
  });
  log("bundler accepted the operation:", sent.userOpHash);
  state.ops["bundler-probe"] = { userOpHash: sent.userOpHash as Hex };
  save(state);
  for (let i = 0; i < 60; i += 1) {
    const receipt = await adapter.getUserOperationReceipt(sent.userOpHash);
    if (receipt.status === "INCLUDED") {
      log(
        `bundled after ${Math.round((Date.now() - started) / 1000)}s | success`,
        receipt.success,
        "| tx",
        receipt.txHash,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  log("NOT bundled within 5 minutes");
}

const command = process.argv[2];
if (!existsSync(statePath)) throw new Error("state file missing");
if (command === "deploy-validator") await deployValidator();
else if (command === "kernel") await kernel();
else if (command === "restart-check") await restartCheck();
else if (command === "bundler-probe") await bundlerProbe();
else throw new Error("usage: deploy-validator | kernel | restart-check");
