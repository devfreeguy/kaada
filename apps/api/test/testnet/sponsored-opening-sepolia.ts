/*
 * Celo SEPOLIA ONLY. Proves the relayer-sponsored account opening with real transactions:
 *
 *   KAADA_KEYS_DIR=<dir outside the repo> npx tsx test/testnet/sponsored-opening-sepolia.ts
 *
 * The keys directory holds `sepolia-harness.json` ({ "deployerKey": "0x..." }, the faucet-funded throwaway deployer) and
 * `relayer-sepolia.key` (the Sepolia relayer). Nothing here is printed or stored but addresses, amounts and PASS/FAIL lines.
 *
 * What is real: the chain (Celo Sepolia), the relayer's transactions, the Kernel factory, the device-key validator clones, the
 * funding watcher reading ERC-20 balances, the ViemRecoveryChain adapter and the RecoveryConfigurationService with its sponsoring
 * rules, behind the real HTTP controller. What is substituted: the repositories and the ledger are in memory (their database twins are
 * proven by the database integration tests), and the signed arming operation is handed to the EntryPoint by the deployer
 * (`handleOps`), exactly as the other Sepolia harnesses do, because there is no ERC-4337 bundler on this network.
 */
import "reflect-metadata";

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  ChainBalanceReader,
  ViemRecoveryChain,
  ViemValidatorDeployer,
  createKernelAddressDeriver,
  createKernelFactoryCallReader,
  createViemChainReader,
} from "@kaada/blockchain";
import type { KernelFactoryCall } from "@kaada/blockchain";
import { RECOVERY_DEPLOYMENTS } from "@kaada/config";
import {
  buildPrimaryRoot,
  deviceKeyIdFromPoint,
  deviceKeyPayload,
  primaryRootDeploymentSalt,
} from "@kaada/contracts";
import { KaadaError, RECOVERY_AUDIT_EVENTS, depositValueUsdMicros } from "@kaada/domain";
import type { Asset, AssetRegistry, JsonObject, RootCredential } from "@kaada/domain";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  pad,
  parseEther,
  toFunctionSelector,
  toHex,
  bytesToHex,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { configureApp } from "../../src/app.setup.js";
import { totpAtStep, stepAt } from "../../src/core/recovery/totp.js";
import { RecoveryController } from "../../src/recovery/recovery.controller.js";
import type { RecoveryRuntime } from "../../src/recovery/recovery.runtime.js";
import { RECOVERY_RUNTIME } from "../../src/recovery/recovery.tokens.js";
import { WALLET_SETUP_SERVICE } from "../../src/wallet/wallet.tokens.js";
import { WalletFundingWatcher } from "../../src/core/wallets/funding-watcher.js";
import { MemoryFundingStore } from "../support/funding-memory.js";
import { createRecoveryWorld } from "../support/recovery-world.js";
import { MemorySponsorshipLedger } from "../support/sponsorship-memory.js";

// ───────────────────────────────── setup ─────────────────────────────────

const RPC = "https://forno.celo-sepolia.celo-testnet.org";
const CHAIN_ID = celoSepolia.id;
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const KERNEL_FACTORY = "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9" as const;
/** ZeroDev staker: the SDK wraps an account creation in its deployWithFactory(factory, createData, salt). */
const STAKER = "0xd703aaE79538628d27099B8c4f621bE4CCd142d5" as const;
const stakerAbi = parseAbi([
  "function deployWithFactory(address factory, bytes createData, bytes32 salt)",
]);
const MAINNET_GAS_GWEI = 202.5;

const keysDir = process.env["KAADA_KEYS_DIR"];
if (!keysDir)
  throw new Error(
    "set KAADA_KEYS_DIR to the directory (outside the repo) holding the Sepolia keys",
  );
const deployerKey = (
  JSON.parse(readFileSync(join(keysDir, "sepolia-harness.json"), "utf8")) as { deployerKey: Hex }
).deployerKey;
const relayerKey = readFileSync(join(keysDir, "relayer-sepolia.key"), "utf8").trim() as Hex;

const deployer = privateKeyToAccount(deployerKey);
const relayer = privateKeyToAccount(relayerKey);
const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
const deployerWallet = createWalletClient({
  account: deployer,
  chain: celoSepolia,
  transport: http(RPC),
});

const contracts = RECOVERY_DEPLOYMENTS["celo-sepolia"];
if (!contracts) throw new Error("no Celo Sepolia deployment recorded");
if (contracts.relayer.toLowerCase() !== relayer.address.toLowerCase()) {
  throw new Error("relayer-sepolia.key is not the relayer recorded for Celo Sepolia");
}
const validatorDeployments = {
  passkey: {
    factory: contracts.passkeyFactory as Address,
    implementation: contracts.passkeyImplementation as Address,
  },
  device: {
    factory: contracts.deviceFactory as Address,
    implementation: contracts.deviceImplementation as Address,
  },
};

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
}
const celo = (wei: bigint) => `${formatEther(wei)} CELO`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────────── software device key ─────────────────────────────

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A raw P-256 device key held in memory (a real client keeps it in the platform keystore). */
class SoftDevice {
  readonly x: Hex;
  readonly y: Hex;
  readonly keyId: Hex;
  private readonly pem: string;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.x = `0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`;
    this.y = `0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`;
    this.keyId = deviceKeyIdFromPoint({ x: BigInt(this.x), y: BigInt(this.y) });
  }

  /** Signs the exact payload the device key is asked to sign: keyId || r || s, low-s. */
  signPayload(payload: Hex): Hex {
    const raw = sign("sha256", Buffer.from(payload.slice(2), "hex"), {
      key: this.pem,
      dsaEncoding: "ieee-p1363",
    });
    const r = BigInt(bytesToHex(raw.subarray(0, 32)));
    let s = BigInt(bytesToHex(raw.subarray(32)));
    if (s > P256_N / 2n) s = P256_N - s;
    return concat([this.keyId, pad(toHex(r), { size: 32 }), pad(toHex(s), { size: 32 })]);
  }
}

/** A software WebAuthn authenticator. Its assertion is already in the validator's own encoding. */
class SoftPasskey {
  readonly credentialId: string;
  readonly x: Hex;
  readonly y: Hex;
  private readonly pem: string;
  private counter = 0;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.x = `0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`;
    this.y = `0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`;
    this.credentialId = randomBytes(32).toString("base64url");
  }

  sign(challenge: Hex): Hex {
    this.counter += 1;
    const authData = Buffer.concat([
      createHash("sha256").update("kaada.test").digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, this.counter]),
    ]);
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
      origin: "https://kaada.test",
      crossOrigin: false,
    });
    const digestInput = Buffer.concat([
      authData,
      createHash("sha256").update(Buffer.from(clientData)).digest(),
    ]);
    const raw = sign("sha256", digestInput, { key: this.pem, dsaEncoding: "ieee-p1363" });
    const r = BigInt(bytesToHex(raw.subarray(0, 32)));
    let s = BigInt(bytesToHex(raw.subarray(32)));
    if (s > P256_N / 2n) s = P256_N - s;
    return encodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
      ],
      [bytesToHex(authData), clientData, 1n, r, s, true],
    );
  }
}

// ───────────────── a stand-in for the bundler's gas estimate (there is no bundler on this testnet) ─────────────────

interface EstimateRecord {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  signatureBytes: number;
}
const estimates: EstimateRecord[] = [];
const shim = { down: false, url: "http://127.0.0.1:9" };

/** What signs for each wallet's address, so the stand-in can estimate with a REAL signature (a stub would fail validation here). */
const signers = new Map<string, (userOpHash: Hex) => Hex>();

/**
 * eth_estimateUserOperationGas from the chain itself. EntryPoint v0.7 keeps its simulation in a separate contract that this
 * testnet does not have, so the stand-in measures instead: it dry-runs the whole `handleOps` with the account's balance overridden
 * (so an account that holds nothing yet is estimated like any other) and a real signature, takes the call's gas from an
 * `eth_estimateGas` from the EntryPoint to the account, and gives everything else to verification. The limits it returns carry no
 * margin of their own; the 25% is added by the code under test. This is NOT a real bundler: it lets the sizing logic be proved
 * against real gas numbers, and nothing more.
 */
async function estimateFromChain(op: Record<string, string>): Promise<Record<string, string>> {
  const sender = op["sender"] as Address;
  const stateOverride = [{ address: sender, balance: parseEther("1000") }];
  const base = {
    sender,
    nonce: BigInt(op["nonce"] as string),
    callData: op["callData"] as Hex,
    callGasLimit: BigInt(op["callGasLimit"] as string),
    verificationGasLimit: BigInt(op["verificationGasLimit"] as string),
    preVerificationGas: BigInt(op["preVerificationGas"] as string),
    maxFeePerGas: BigInt(op["maxFeePerGas"] as string),
    maxPriorityFeePerGas: BigInt(op["maxPriorityFeePerGas"] as string),
    signature: op["signature"] as Hex,
  };
  const sign = signers.get(sender.toLowerCase());
  if (!sign) throw new Error("no signer for this account");
  const handleOps = (operation: typeof base) =>
    encodeFunctionData({
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [
        [
          toPackedUserOperation({
            ...operation,
            signature: sign(
              getUserOperationHash({
                userOperation: operation,
                entryPointAddress: EP,
                entryPointVersion: "0.7",
                chainId: CHAIN_ID,
              }),
            ),
          }),
        ],
        deployer.address,
      ],
    });
  const detail = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? String(e);
  const runs = async (data: Hex, gas: bigint): Promise<boolean> => {
    try {
      await pub.call({ account: deployer, to: EP, data, gas, stateOverride });
      return true;
    } catch {
      return false;
    }
  };
  // Validation: the least gas the whole handleOps needs when the call is given no gas at all (it then fails cheaply inside, and
  // handleOps still succeeds), so what is left is verification and the EntryPoint's own bookkeeping.
  const verifyData = handleOps({ ...base, callGasLimit: 0n });
  const ceilingGas = 3_000_000n;
  if (!(await runs(verifyData, ceilingGas))) throw new Error("the operation does not validate");
  let lo = 21_000n;
  let hi = ceilingGas;
  while (hi - lo > 2_000n) {
    const mid = (lo + hi) / 2n;
    if (await runs(verifyData, mid)) hi = mid;
    else lo = mid;
  }
  const calldataCost = [...Buffer.from(verifyData.slice(2), "hex")].reduce(
    (sum, b) => sum + (b === 0 ? 4n : 16n),
    0n,
  );
  const verificationGasLimit = hi > 21_000n + calldataCost ? hi - 21_000n - calldataCost : hi;
  // The call: what the account's execute needs when the EntryPoint calls it.
  const call = await pub
    .estimateGas({ account: EP, to: sender, data: base.callData, stateOverride })
    .catch((e: unknown) => {
      throw new Error(`call estimate: ${detail(e)}`);
    });
  const record: EstimateRecord = {
    callGasLimit: call > 21_000n ? call - 21_000n : call,
    verificationGasLimit,
    preVerificationGas: 21_000n + calldataCost,
    signatureBytes: (op["signature"] as string).length / 2 - 1,
  };
  estimates.push(record);
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  return {
    callGasLimit: hex(record.callGasLimit),
    verificationGasLimit: hex(record.verificationGasLimit),
    preVerificationGas: hex(record.preVerificationGas),
  };
}

async function startEstimatorShim(): Promise<() => Promise<void>> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      response.setHeader("content-type", "application/json");
      const reply = (result: unknown) =>
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      const fail = (text: string) =>
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: text },
          }),
        );
      if (shim.down) return response.destroy();
      if (message.method === "eth_supportedEntryPoints") return reply([EP]);
      if (message.method === "eth_estimateUserOperationGas") {
        estimateFromChain(message.params?.[0] as Record<string, string>).then(
          reply,
          (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            console.log("  (estimator stand-in failed:", text.split("\n")[0], ")");
            fail(text);
          },
        );
        return;
      }
      fail(`not served here: ${message.method}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  shim.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return () => new Promise((resolve) => server.close(() => resolve()));
}

// ───────────────────── a chain adapter that submits through handleOps ─────────────────────

const BIGINT_PREFIX = "bigint:";
const fromJsonSafe = (value: unknown): unknown => {
  if (typeof value === "string" && value.startsWith(BIGINT_PREFIX))
    return BigInt(value.slice(BIGINT_PREFIX.length));
  if (Array.isArray(value)) return value.map(fromJsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJsonSafe(v)]));
  }
  return value;
};

/** The real adapter, except that a signed operation goes to the EntryPoint from the deployer (no bundler exists on this testnet). */
class HarnessChain extends ViemRecoveryChain {
  openAttempts = 0;
  opened = 0;
  override async openAccount(input: Parameters<ViemRecoveryChain["openAccount"]>[0]) {
    this.openAttempts += 1;
    const result = await super.openAccount(input);
    if (result.opened) this.opened += 1;
    return result;
  }
  /** The software passkey's assertion already is the validator's encoding; a device key's goes through the real encoder. */
  override encodeRootSignature(
    input: Parameters<ViemRecoveryChain["encodeRootSignature"]>[0],
  ): string {
    const ready = (input.material as { signature?: unknown } | null)?.signature;
    if (input.kind === "PASSKEY" && typeof ready === "string" && ready.startsWith("0x"))
      return ready;
    return super.encodeRootSignature(input);
  }
  override async submitOperation(input: { operation: JsonObject; signature?: string }) {
    const wire = fromJsonSafe(input.operation) as Record<string, unknown>;
    delete wire["userOpHash"];
    const signed = { ...wire, ...(input.signature && { signature: input.signature as Hex }) };
    const packed = toPackedUserOperation(signed as never);
    const { request } = await pub.simulateContract({
      account: deployer,
      address: EP,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], deployer.address],
      // The operation's own limits plus room for the EntryPoint's bookkeeping.
      gas:
        (wire["callGasLimit"] as bigint) +
        (wire["verificationGasLimit"] as bigint) +
        (wire["preVerificationGas"] as bigint) +
        300_000n,
    });
    const txHash = await deployerWallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== EP.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        if (event.eventName === "UserOperationEvent") {
          lastArming = {
            success: event.args.success,
            gasUsed: event.args.actualGasUsed,
            cost: event.args.actualGasCost,
          };
          return { userOpHash: event.args.userOpHash };
        }
      } catch {
        // not an EntryPoint event we know
      }
    }
    throw new Error("the EntryPoint did not report the operation");
  }
}
let lastArming: { success: boolean; gasUsed: bigint; cost: bigint } | undefined;

const makeChain = (factoryCall?: (root: RootCredential) => Promise<KernelFactoryCall>) =>
  new HarnessChain({
    chain: celoSepolia,
    rpcUrl: RPC,
    bundlerUrl: shim.url,
    recoveryValidator: contracts.validator as Address,
    deployments: validatorDeployments,
    relayerKey,
    p256Precompile: true,
    accountFactoryCall:
      factoryCall ??
      createKernelFactoryCallReader({ rpcUrl: RPC, network: { chain: celoSepolia } }),
  });

// ───────────────────────────── test tokens (two called "USDT") ─────────────────────────────

async function deployTestToken(symbol: string, label: string): Promise<Address> {
  const requireFromContracts = createRequire(
    new URL("../../../../packages/contracts/package.json", import.meta.url),
  );
  const solc = requireFromContracts("solc") as { compile: (input: string) => string };
  const source = readFileSync(
    new URL("../../../../packages/blockchain/src/testnet/contracts/Fixtures.sol", import.meta.url),
    "utf8",
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Fixtures.sol": { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "paris",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  ) as {
    contracts: {
      "Fixtures.sol": { TestToken: { abi: Abi; evm: { bytecode: { object: string } } } };
    };
  };
  const token = output.contracts["Fixtures.sol"].TestToken;
  const hash = await deployerWallet.deployContract({
    abi: token.abi,
    bytecode: `0x${token.evm.bytecode.object}`,
    args: [label, symbol, 6],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("token was not deployed");
  return receipt.contractAddress;
}

const tokenAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const;

async function mint(token: Address, to: Address, units: number): Promise<void> {
  const hash = await deployerWallet.writeContract({
    address: token,
    abi: tokenAbi,
    functionName: "mint",
    args: [to, BigInt(units) * 1_000_000n],
  });
  await pub.waitForTransactionReceipt({ hash });
}

// ─────────────────────────────────── the harness ───────────────────────────────────

async function relayerNonce(): Promise<number> {
  return pub.getTransactionCount({ address: relayer.address, blockTag: "pending" });
}
async function relayerBalance(): Promise<bigint> {
  return pub.getBalance({ address: relayer.address });
}
async function hasCode(address: Address): Promise<boolean> {
  const code = await pub.getCode({ address });
  return code !== undefined && code !== "0x";
}

/** The relayer's most recent transaction to `to` (looked up in the last blocks), with what it really cost. */
async function relayerTxTo(
  to: string,
): Promise<{ gasUsed: bigint; price: bigint; value: bigint } | undefined> {
  const head = await pub.getBlockNumber();
  for (let n = head; n > head - 40n; n -= 1n) {
    const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of [...block.transactions].reverse()) {
      if (
        tx.from.toLowerCase() === relayer.address.toLowerCase() &&
        tx.to?.toLowerCase() === to.toLowerCase()
      ) {
        const receipt = await pub.getTransactionReceipt({ hash: tx.hash });
        return { gasUsed: receipt.gasUsed, price: receipt.effectiveGasPrice, value: tx.value };
      }
    }
  }
  return undefined;
}

/** KAADA_SCENARIOS=new runs only the sections added for gas sizing (cheaper in faucet CELO); the default runs everything. */
const reduced = process.env["KAADA_SCENARIOS"] === "new";

async function main(): Promise<void> {
  console.log(`relayer ${relayer.address}  deployer ${deployer.address}`);
  const startRelayer = await relayerBalance();
  console.log(
    `relayer balance ${celo(startRelayer)}, deployer ${celo(await pub.getBalance({ address: deployer.address }))}`,
  );
  if (startRelayer < parseEther("0.07")) {
    const hash = await deployerWallet.sendTransaction({
      to: relayer.address,
      value: parseEther("0.12") - startRelayer,
    });
    await pub.waitForTransactionReceipt({ hash });
    await sleep(3_000);
    console.log(
      `topped the relayer up to ${celo(await relayerBalance())} (faucet CELO from the throwaway deployer)`,
    );
  }

  // Two tokens with the SAME symbol: the official one (registered by address) and a worthless imitation.
  // The two test tokens are deployed once and remembered in the keys directory: a deployment costs real testnet CELO.
  const tokensFile = join(keysDir ?? "", "sponsored-harness-tokens.json");
  const remembered = existsSync(tokensFile)
    ? (JSON.parse(readFileSync(tokensFile, "utf8")) as { official?: Address; imitation?: Address })
    : {};
  const reuse = async (a?: Address) => (a && (await hasCode(a)) ? a : undefined);
  const official =
    (await reuse(remembered.official)) ?? (await deployTestToken("USDT", "Test Dollar"));
  const imitation =
    (await reuse(remembered.imitation)) ?? (await deployTestToken("USDT", "Test Dollar"));
  writeFileSync(tokensFile, JSON.stringify({ official, imitation }));
  console.log(
    `official USDT ${official}\nimitation USDT ${imitation}  (same symbol, different address)`,
  );
  const officialAsset: Asset = {
    id: "asset-official-usdt",
    symbol: "USDT",
    name: "Test Dollar",
    kind: "USD_STABLECOIN",
    decimals: 6,
    chainId: CHAIN_ID,
    contractAddress: official,
    fiatCode: "USD",
    isActive: true,
  };
  const registry = {
    getById: (id: string) => Promise.resolve(id === officialAsset.id ? officialAsset : null),
    findBySymbol: (symbol: string) => Promise.resolve(symbol === "USDT" ? [officialAsset] : []),
  } as unknown as AssetRegistry;

  const world = createRecoveryWorld();
  const funding = new MemoryFundingStore();
  const ledger = new MemorySponsorshipLedger();
  const stopShim = await startEstimatorShim();
  const chain = makeChain();
  (world.context as { chain: unknown }).chain = chain;
  const watcher = new WalletFundingWatcher({
    store: funding,
    reader: new ChainBalanceReader({
      assets: registry,
      chain: createViemChainReader(),
      networks: { [CHAIN_ID]: createViemChainReader({ rpcUrl: RPC, network: "celo-sepolia" }) },
    }),
    tokens: () => Promise.resolve([officialAsset]),
    chainId: CHAIN_ID,
    dustDecimalsBelow: 2,
    newWalletMs: 3_600_000,
    now: world.now,
  });

  const sponsoring = (over: Partial<NonNullable<typeof world.context.sponsorship>> = {}) => {
    world.context.sponsorship = {
      perWalletWei: parseEther("0.3"),
      dailyBudgetWei: parseEther("1"),
      relayerReserveWei: parseEther("0.01"),
      minDepositUsdMicros: 5_000_000n,
      depositItems: (userId: string) => funding.depositItems(userId, CHAIN_ID),
      ledger,
      ...over,
    };
  };
  sponsoring();

  // The real HTTP controller in front of the real service.
  const sessions = new Map<string, string>();
  const runtime = {
    finalizer: {
      completedSessionUser: () => Promise.reject(new KaadaError("RECOVERY_SESSION_INVALID", "no")),
    },
    configuration: world.configuration,
  } as unknown as RecoveryRuntime;
  const moduleRef = await Test.createTestingModule({
    controllers: [RecoveryController],
    providers: [
      { provide: RECOVERY_RUNTIME, useValue: runtime },
      {
        provide: WALLET_SETUP_SERVICE,
        useValue: { userForView: (token: string) => Promise.resolve(sessions.get(token) ?? "") },
      },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureApp(app, { corsOrigins: [] } as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const http = (url: string, token: string, body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/v1/recovery${url}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });

  // A fresh device-key wallet: its validator clone deployed by the relayer (the real registration cost), its account NOT opened.
  const validators = new ViemValidatorDeployer({
    chain: celoSepolia,
    rpcUrl: RPC,
    deployments: validatorDeployments,
    relayerKey,
  });
  const deriver = createKernelAddressDeriver({ rpcUrl: RPC, network: { chain: celoSepolia } });
  let walletCounter = 0;
  async function freshWallet(kind: "DEVICE_KEY" | "PASSKEY" = "DEVICE_KEY") {
    walletCounter += 1;
    const userId = crypto.randomUUID();
    const device = kind === "DEVICE_KEY" ? new SoftDevice() : undefined;
    const passkey = kind === "PASSKEY" ? new SoftPasskey() : undefined;
    const strip = (hex: Hex) => hex.slice(2).padStart(64, "0");
    const x = strip((device?.x ?? passkey?.x) as Hex);
    const y = strip((device?.y ?? passkey?.y) as Hex);
    const credentialRef = (device?.keyId ?? passkey?.credentialId) as string;
    const salt = primaryRootDeploymentSalt(userId);
    const primary = buildPrimaryRoot({
      deployments: validatorDeployments,
      credential: device
        ? { kind: "DEVICE_KEY", keyId: device.keyId, publicKeyX: x, publicKeyY: y }
        : { kind: "PASSKEY", credentialId: credentialRef, publicKeyX: x, publicKeyY: y },
      deploymentSalt: salt,
    });
    await validators.ensureDeployed({
      type: kind,
      account: null,
      purpose: 0,
      deploymentSalt: salt,
      validatorAddress: primary.instance,
      publicKeyX: x,
      publicKeyY: y,
      credentialRef,
    });
    const root: RootCredential = device
      ? {
          type: "DEVICE_KEY",
          keyId: device.keyId,
          publicKeyX: x,
          publicKeyY: y,
          validatorAddress: primary.instance,
          purpose: 0,
          deploymentSalt: salt,
        }
      : {
          type: "PASSKEY",
          credentialId: credentialRef,
          publicKeyX: x,
          publicKeyY: y,
          rpId: "kaada.test",
          validatorAddress: primary.instance,
        };
    const address = (await deriver.deriveAddress(root)) as Address;
    const r = world.repositories;
    await r.identities.add({
      id: crypto.randomUUID(),
      userId,
      type: "EMAIL",
      externalId: `h${walletCounter}@example.test`,
    });
    const created = await r.wallets.create({
      id: crypto.randomUUID(),
      userId,
      chainId: 42220,
      isPrimary: true,
      type: "EMBEDDED",
      status: "PROVISIONING",
      deployment: "NOT_APPLICABLE",
    });
    const wallet = await r.wallets.activate(created.id, {
      address: address.toLowerCase(),
      deployment: "COUNTERFACTUAL",
      provider: "test",
      at: world.now(),
    });
    if (!wallet) throw new Error("wallet was not activated");
    await r.walletCredentials.create({
      id: crypto.randomUUID(),
      userId,
      walletId: wallet.id,
      kind,
      role: "PRIMARY",
      status: "ACTIVE",
      isRoot: true,
      validatorAddress: primary.instance.toLowerCase(),
      validatorPurpose: 0,
      deploymentSalt: salt,
      credentialRef,
      publicKeyX: x,
      publicKeyY: y,
      ...(passkey && { rpId: "kaada.test" }),
      securityTier: "UNKNOWN",
    } as never);
    const enrolment = await world.totp.begin({
      userId,
      walletId: wallet.id,
      accountName: `h${walletCounter}@example.test`,
    });
    await world.totp.confirm({
      userId,
      walletId: wallet.id,
      code: totpAtStep(enrolment.secret, stepAt(world.now().getTime())),
    });
    world.advance(31_000);
    funding.watch({ userId, address: address.toLowerCase(), activatedAt: world.now() });
    const token = `session-${walletCounter}`;
    sessions.set(token, userId);
    signers.set(address.toLowerCase(), (userOpHash) =>
      device
        ? device.signPayload(
            deviceKeyPayload({
              chainId: CHAIN_ID,
              validator: primary.instance,
              account: address,
              keyId: device.keyId,
              userOpHash,
            }),
          )
        : (passkey as SoftPasskey).sign(userOpHash),
    );
    /** What the root hands back for a signing request: a device key's keyId || r || s, or a passkey's assertion. */
    const signRequest = (signing: {
      challenge: string;
      device?: { payload: Hex };
    }): { signature: Hex } => ({
      signature: device
        ? device.signPayload(signing.device?.payload as Hex)
        : (passkey as SoftPasskey).sign(signing.challenge as Hex),
    });
    return {
      userId,
      kind,
      signRequest,
      address,
      walletId: wallet.id,
      token,
      root,
      validator: primary.instance,
    };
  }
  type Wallet = Awaited<ReturnType<typeof freshWallet>>;

  /** Gives the wallet `units` of `token` and lets the REAL watcher record what the registry recognises. */
  async function deposit(w: Wallet, token: Address, units: number): Promise<void> {
    await mint(token, w.address, units);
    await sleep(3_000);
    await watcher.poll();
  }

  const arm = (w: Wallet) =>
    http("/configuration/prepare", w.token, {
      recoveryAddress: "0x00000000000000000000000000000000000000f9",
    });

  if (!reduced) {
    // ───────────── 6 first: recognition is by contract address, never by name ─────────────
    console.log("\n== 6. stablecoins are recognised by contract address ==");
    const w6 = await freshWallet();
    await deposit(w6, imitation, 1000);
    const imitationBalance = await pub.readContract({
      address: imitation,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [w6.address],
    });
    const events6 = await funding.depositItems(w6.userId, CHAIN_ID);
    check(
      "the worthless 'USDT' really sits in the wallet",
      imitationBalance === 1_000_000_000n,
      `${imitationBalance} units of the imitation`,
    );
    check(
      "the watcher records nothing for it (not in the registry by address)",
      events6.length === 0,
    );
    check("its value for sponsoring is zero", depositValueUsdMicros(events6) === 0n);
    const before6 = await relayerNonce();
    const refused6 = await arm(w6);
    check(
      "a wallet holding only the imitation is refused: 409 SPONSORSHIP_UNAVAILABLE",
      refused6.statusCode === 409 &&
        refused6.json<{ code: string }>().code === "SPONSORSHIP_UNAVAILABLE",
      `status ${refused6.statusCode}`,
    );
    check(
      "nothing was sent on chain and the account was not opened",
      (await relayerNonce()) === before6 && !(await hasCode(w6.address)),
    );
    await deposit(w6, official, 20);
    const events6b = await funding.depositItems(w6.userId, CHAIN_ID);
    check(
      "the SAME symbol at the registered address is recognised and valued at face value",
      depositValueUsdMicros(events6b) === 20_000_000n,
      `${depositValueUsdMicros(events6b)} micro-USD`,
    );

    // ───────────── 3. refusals, each with nothing sent ─────────────
    console.log("\n== 3. refusals send nothing on chain ==");
    async function expectRefused(name: string, w: Wallet, reason: string): Promise<void> {
      const nonce = await relayerNonce();
      const balance = await relayerBalance();
      const response = await arm(w);
      const body = response.json<{ code?: string; message?: string }>();
      const logged = world.logs.find(
        (l) => l.event === "recovery.sponsor_refused" && l.fields["walletId"] === w.walletId,
      );
      check(
        `${name}: 409 SPONSORSHIP_UNAVAILABLE, reason ${reason}`,
        response.statusCode === 409 &&
          body.code === "SPONSORSHIP_UNAVAILABLE" &&
          logged?.fields["reason"] === reason,
        `status ${response.statusCode}, logged ${String(logged?.fields["reason"])}`,
      );
      check(
        `${name}: no transaction sent, account not opened, relayer balance unchanged`,
        (await relayerNonce()) === nonce &&
          (await relayerBalance()) === balance &&
          !(await hasCode(w.address)),
      );
    }
    const below = await freshWallet();
    await deposit(below, official, 3);
    await expectRefused("below the minimum deposit ($3 < $5)", below, "BELOW_MINIMUM_DEPOSIT");

    const capped = await freshWallet();
    await deposit(capped, official, 20);
    const take = await ledger.reserve({
      userId: capped.userId,
      walletId: capped.walletId,
      wantWei: parseEther("0.3"),
      walletCapWei: parseEther("0.3"),
      dailyCapWei: parseEther("1"),
      windowMs: 86_400_000,
      now: world.now(),
    });
    check("(setup) this wallet has already used its whole lifetime budget", take.granted);
    await expectRefused("wallet cap reached", capped, "WALLET_CAP");

    const dry = await freshWallet();
    await deposit(dry, official, 20);
    const day = await ledger.usedInWindow(world.now(), 86_400_000);
    sponsoring({ dailyBudgetWei: day + parseEther("0.01") });
    await expectRefused("daily budget exhausted", dry, "DAILY_BUDGET");
    sponsoring();

    const poor = await freshWallet();
    await deposit(poor, official, 20);
    sponsoring({ relayerReserveWei: (await relayerBalance()) + 1n });
    await expectRefused("relayer under its reserve", poor, "RELAYER_RESERVE");
    sponsoring();

    // ───────────── 1 + 2. the real thing ─────────────
  }

  console.log("\n== 1. open + arm for a funded wallet with no CELO, sized from a gas estimate ==");
  const margin = (v: bigint) => (v * 125n + 99n) / 100n;
  interface Measured {
    kind: "DEVICE_KEY" | "PASSKEY";
    w: Wallet;
    relayerBefore: bigint;
    relayerAfter: bigint;
    openCost: bigint;
    topUpValue: bigint;
    limits: { call: bigint; verification: bigint; pre: bigint };
    maxFee: bigint;
    estimate: EstimateRecord;
    armingGas: bigint;
    armingCost: bigint;
  }
  const sponsoredSpent = async (w: Wallet, purpose: string) =>
    (await world.repositories.audit.listByType(w.userId, RECOVERY_AUDIT_EVENTS.relayerSponsored))
      .filter((d) => (d.data as { purpose: string }).purpose === purpose)
      .reduce((sum, d) => sum + BigInt((d.data as { wei: string }).wei), 0n);

  async function sponsoredArming(kind: "DEVICE_KEY" | "PASSKEY"): Promise<Measured> {
    const tag = `[${kind}]`;
    const w = await freshWallet(kind);
    await deposit(w, official, 20);
    check(
      `${tag} (setup) the wallet holds no CELO and no account yet`,
      (await pub.getBalance({ address: w.address })) === 0n && !(await hasCode(w.address)),
    );
    const relayerBefore = await relayerBalance();
    const estimatesBefore = estimates.length;
    const prepared = await arm(w);
    if (prepared.statusCode !== 200) {
      console.log("  response:", prepared.body);
      for (const l of world.logs.slice(-8))
        console.log("  log:", l.level, l.event, JSON.stringify(l.fields).slice(0, 300));
    }
    const body = prepared.json<{
      configurationId?: string;
      signing?: { challenge: string; device?: { payload: Hex } };
    }>();
    check(
      `${tag} preparing the arming succeeds (200)`,
      prepared.statusCode === 200 && !!body.configurationId,
      `status ${prepared.statusCode}`,
    );
    check(`${tag} the relayer opened the account on chain`, await hasCode(w.address));
    const relayerAfter = await relayerBalance();
    const openCost = await sponsoredSpent(w, "open_account");
    const topUpValue = await sponsoredSpent(w, "gas_topup");

    // What the operation was sized to: read back from the stored operation, and compared with what the estimator said.
    const row = await world.repositories.recoveryConfigurations.findById(
      body.configurationId as string,
    );
    const op = fromJsonSafe(row?.preparedOperation) as Record<string, bigint>;
    const limits = {
      call: op["callGasLimit"] as bigint,
      verification: op["verificationGasLimit"] as bigint,
      pre: op["preVerificationGas"] as bigint,
    };
    const maxFee = op["maxFeePerGas"] as bigint;
    const estimate = estimates[estimates.length - 1] as EstimateRecord;
    check(
      `${tag} the estimator was asked (with a stub signature of the ${kind} shape)`,
      estimates.length > estimatesBefore && estimate.signatureBytes > 0,
      `${estimate.signatureBytes}-byte stub`,
    );
    check(
      `${tag} each gas limit is the estimate plus 25%`,
      limits.call === margin(estimate.callGasLimit) &&
        limits.verification === margin(estimate.verificationGasLimit) &&
        limits.pre === margin(estimate.preVerificationGas),
      `estimate ${estimate.callGasLimit}/${estimate.verificationGasLimit}/${estimate.preVerificationGas} -> limits ${limits.call}/${limits.verification}/${limits.pre}`,
    );
    const ceiling = limits.call + limits.verification + limits.pre;
    const required = ceiling * maxFee;
    const fixedRequired = 1_360_000n * maxFee;
    check(
      `${tag} the top-up is the sized prefund plus 5%, not the fixed 1.36M-gas prefund`,
      topUpValue === (required * 105n) / 100n && topUpValue < (fixedRequired * 105n) / 100n,
      `${celo(topUpValue)} instead of ${celo((fixedRequired * 105n) / 100n)}`,
    );
    const walletCelo = await pub.getBalance({ address: w.address });
    check(
      `${tag} the wallet received the top-up from the relayer`,
      topUpValue > 0n && walletCelo >= topUpValue,
      `wallet holds ${celo(walletCelo)}`,
    );

    // The attempt is abandoned before it is signed and tried again: the wallet still holds what it was topped up with, so the
    // retry must send nothing and spend nothing.
    const nonceRetry = await relayerNonce();
    const rowsRetry = ledger.rows.length;
    const usedRetry = await ledger.usedInWindow(world.now(), 86_400_000);
    const retried = await arm(w);
    check(
      `${tag} a retry of the abandoned arming succeeds`,
      retried.statusCode === 200,
      `status ${retried.statusCode}`,
    );
    check(
      `${tag} and sends nothing: no relayer transaction, no new reservation, no ledger spend`,
      (await relayerNonce()) === nonceRetry &&
        ledger.rows.length === rowsRetry &&
        (await ledger.usedInWindow(world.now(), 86_400_000)) === usedRetry,
    );
    // The retry superseded the first preparation: it is the one to sign.
    const retriedBody = retried.json<{
      configurationId?: string;
      signing?: { challenge: string; device?: { payload: Hex } };
    }>();

    let armed = await world.configuration.submit({
      userId: w.userId,
      configurationId: retriedBody.configurationId as string,
      material: w.signRequest(
        retriedBody.signing as { challenge: string; device?: { payload: Hex } },
      ),
    });
    // The chain node may lag a moment behind the receipt: the reconciler path (confirm) reads the validator again until it is ACTIVE.
    for (let i = 0; i < 15 && armed.status !== "ACTIVE"; i += 1) {
      await sleep(2_000);
      armed = (await world.configuration.confirm(armed.id)) ?? armed;
    }
    check(
      `${tag} the root signs with the sized limits and the recovery arming succeeds on chain`,
      armed.status === "ACTIVE" && lastArming?.success === true,
      `status ${armed.status}`,
    );
    const armingGas = lastArming?.gasUsed ?? 0n;
    check(
      `${tag} the limits were enough: the arming used ${armingGas} of ${ceiling} gas`,
      armingGas > 0n && armingGas <= ceiling,
      `${(Number(armingGas) * 100) / Number(ceiling)}% of the ceiling`,
    );
    check(
      `${tag} the recovery validator now holds a configuration for the account`,
      (await chain.validatorState(w.address)).initialized === true,
    );
    return {
      kind,
      w,
      relayerBefore,
      relayerAfter,
      openCost,
      topUpValue,
      limits,
      maxFee,
      estimate,
      armingGas,
      armingCost: lastArming?.cost ?? 0n,
    };
  }

  // KAADA_KINDS=PASSKEY (or DEVICE_KEY) runs one root type only: a run of both needs about 0.2 faucet CELO.
  const kinds = (process.env["KAADA_KINDS"] ?? "DEVICE_KEY,PASSKEY").split(",") as Array<
    "DEVICE_KEY" | "PASSKEY"
  >;
  const m1 = await sponsoredArming(kinds[0] ?? "DEVICE_KEY");
  const mp = kinds[1] ? await sponsoredArming(kinds[1]) : undefined;
  const w1 = m1.w;
  const { relayerBefore, relayerAfter, openCost, topUpValue } = m1;
  const openTx = await relayerTxTo(KERNEL_FACTORY);
  const topUpTx = await relayerTxTo((mp ?? m1).w.address);

  console.log("\n== 2. the spend is recorded and counted ==");
  const used = await ledger.usedInWindow(world.now(), 86_400_000);
  const reservedRows = ledger.rows.filter((r) => r.walletId === w1.walletId);
  check(
    "the audit trail has an open_account and a gas_topup record for this wallet",
    openCost > 0n && topUpValue > 0n,
    `open ${celo(openCost)}, top-up ${celo(topUpValue)}`,
  );
  check(
    "the ledger settled the reservation at the real cost",
    reservedRows.some((r) => r.ref !== undefined && r.wei === openCost + topUpValue),
    `settled ${celo(openCost + topUpValue)}`,
  );
  check(
    "the rolling 24-hour total counts it (with the earlier test reservation)",
    used >= openCost + topUpValue,
    `24h total ${celo(used)}`,
  );
  check(
    "the relayer balance fell by what was recorded plus the top-up's own fee",
    relayerBefore - relayerAfter >= openCost + topUpValue,
  );

  // ───────────── the EntryPoint deposit is counted ─────────────
  console.log("\n== 2b. the EntryPoint deposit is counted; a retry sends nothing ==");
  const deposits = (a: Address) =>
    pub.readContract({ address: EP, abi: entryPoint07Abi, functionName: "balanceOf", args: [a] });
  // After an arming ran, what it left sits in the EntryPoint deposit. A re-arm tops up only what is still missing.
  const nativeLeft = await pub.getBalance({ address: w1.address });
  const depositLeft = await deposits(w1.address);
  const topUpBefore = await sponsoredSpent(w1, "gas_topup");
  const rearm = await arm(w1);
  const topUpAfter = await sponsoredSpent(w1, "gas_topup");
  const rearmRow =
    rearm.statusCode === 200
      ? await world.repositories.recoveryConfigurations.findById(
          rearm.json<{ configurationId: string }>().configurationId,
        )
      : null;
  const rop = rearmRow
    ? (fromJsonSafe(rearmRow.preparedOperation) as Record<string, bigint>)
    : undefined;
  if (rop) {
    const reqRearm =
      ((rop["callGasLimit"] as bigint) +
        (rop["verificationGasLimit"] as bigint) +
        (rop["preVerificationGas"] as bigint)) *
      (rop["maxFeePerGas"] as bigint);
    const have = nativeLeft + depositLeft;
    const expectedShortfall = have >= reqRearm ? 0n : (reqRearm * 105n) / 100n - have;
    check(
      "a re-arm on a wallet whose first arming left a deposit tops up only the shortfall",
      topUpAfter - topUpBefore === expectedShortfall,
      `held ${celo(nativeLeft)} native + ${celo(depositLeft)} deposit; topped up ${celo(topUpAfter - topUpBefore)} (the old rule, native balance only, would have sent ${celo((reqRearm * 105n) / 100n - nativeLeft)})`,
    );
  } else {
    check(
      "a re-arm on a wallet whose first arming left a deposit tops up only the shortfall",
      false,
      `status ${rearm.statusCode}`,
    );
  }

  if (!reduced) {
    // ───────────── 4. an open wallet costs nothing, and nothing opens twice ─────────────
    console.log("\n== 4. an open wallet costs nothing; no double opening ==");
    const opensBefore = chain.opened;
    const nonce4 = await relayerNonce();
    const again = await chain.openAccount({ account: w1.address, root: w1.root });
    check(
      "opening an account that is already open returns opened:false at zero cost",
      again.opened === false && again.costWei === "0",
    );
    check("and sends nothing", (await relayerNonce()) === nonce4 && chain.opened === opensBefore);
    const w4 = await freshWallet();
    await deposit(w4, official, 20);
    const call = await createKernelFactoryCallReader({
      rpcUrl: RPC,
      network: { chain: celoSepolia },
    })(w4.root);
    const userOpens = await deployerWallet.sendTransaction({
      to: call.factory,
      data: call.factoryData,
    });
    await pub.waitForTransactionReceipt({ hash: userOpens });
    const fund = await deployerWallet.sendTransaction({ to: w4.address, value: parseEther("0.1") });
    await pub.waitForTransactionReceipt({ hash: fund });
    await sleep(3_000);
    const nonceOpen = await relayerNonce();
    const ledgerBefore = await ledger.usedInWindow(world.now(), 86_400_000);
    const opensBefore4 = chain.opened;
    const prepared4 = await arm(w4);
    check(
      "a wallet that is already open and holds its own CELO is prepared with no sponsoring",
      prepared4.statusCode === 200 &&
        chain.opened === opensBefore4 &&
        (await relayerNonce()) === nonceOpen,
      `status ${prepared4.statusCode}`,
    );
    check(
      "and the ledger did not move",
      (await ledger.usedInWindow(world.now(), 86_400_000)) === ledgerBefore,
    );

    // ───────────── 5. the relayer can only send the creation call to the official factory ─────────────
    console.log("\n== 5. nothing but the account-creation call can be sent ==");
    const w5 = await freshWallet();
    const real = await createKernelFactoryCallReader({
      rpcUrl: RPC,
      network: { chain: celoSepolia },
    })(w5.root);
    const [, createData, accountSalt] = decodeFunctionData({
      abi: stakerAbi,
      data: real.factoryData,
    }).args;
    const rewrap = (inner: Address, data: Hex): Hex =>
      encodeFunctionData({
        abi: stakerAbi,
        functionName: "deployWithFactory",
        args: [inner, data, accountSalt],
      });
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [deployer.address, 1n],
    });
    const attempts: [string, KernelFactoryCall][] = [
      [
        "a call to some other contract (a token) instead of the staker",
        { ...real, factory: official },
      ],
      [
        "a call to an ordinary address (a plain CELO transfer) instead of the staker",
        { ...real, factory: deployer.address },
      ],
      [
        "the staker pointed at some other factory",
        { ...real, factoryData: rewrap(official, createData) },
      ],
      [
        "the staker asked for another function (an ERC-20 transfer)",
        { ...real, factoryData: rewrap(KERNEL_FACTORY, transfer) },
      ],
      ["the creation call for a DIFFERENT account", { ...real, address: deployer.address }],
    ];
    for (const [what, call] of attempts) {
      const hostile = makeChain(() => Promise.resolve(call));
      const nonce = await relayerNonce();
      let refused = "";
      try {
        await hostile.openAccount({ account: w5.address, root: w5.root });
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      check(
        `${what}: refused before sending`,
        refused.length > 0 && (await relayerNonce()) === nonce && !(await hasCode(w5.address)),
        refused,
      );
    }
    check(
      "control: the genuine call is the staker wrapping the official factory's creation (initialize data) for this wallet",
      real.factory.toLowerCase() === STAKER.toLowerCase() &&
        createData.startsWith(
          toFunctionSelector("initialize(bytes21,address,bytes,bytes,bytes[])"),
        ) &&
        decodeFunctionData({ abi: stakerAbi, data: real.factoryData }).args[0].toLowerCase() ===
          KERNEL_FACTORY.toLowerCase() &&
        real.address.toLowerCase() === w5.address.toLowerCase(),
    );

    // ───────────── cost report ─────────────
  }

  // ───────────── 7. no estimate, no sponsoring ─────────────
  console.log("\n== 7. with no gas estimate there is no sponsoring ==");
  const w8 = await freshWallet();
  await deposit(w8, official, 20);
  shim.down = true;
  const nonce8 = await relayerNonce();
  const balance8 = await relayerBalance();
  const r8 = await arm(w8);
  shim.down = false;
  const logged8 = world.logs.find(
    (l) => l.event === "recovery.sponsor_refused" && l.fields["walletId"] === w8.walletId,
  );
  check(
    "the bundler is unreachable: refused with 409 SPONSORSHIP_UNAVAILABLE, logged as ESTIMATE_UNAVAILABLE",
    r8.statusCode === 409 &&
      r8.json<{ code?: string }>().code === "SPONSORSHIP_UNAVAILABLE" &&
      logged8?.fields["reason"] === "ESTIMATE_UNAVAILABLE" &&
      logged8.fields["message"] === "estimate unavailable",
    `status ${r8.statusCode}, logged ${String(logged8?.fields["reason"])}`,
  );
  check(
    "nothing was sent: the account was not opened (so nothing was spent on it) and the relayer balance is unchanged",
    (await relayerNonce()) === nonce8 &&
      (await relayerBalance()) === balance8 &&
      !(await hasCode(w8.address)),
  );

  // ───────────── cost report ─────────────
  console.log("\n== real costs on Celo Sepolia ==");
  const gwei = (n: number) => BigInt(Math.round(n * 1e9));
  const price = openTx?.price ?? 0n;
  if (openTx) {
    console.log(
      `opening an account: ${openTx.gasUsed} gas = ${celo(openTx.gasUsed * openTx.price)} at ${Number(price) / 1e9} gwei (${celo(openTx.gasUsed * gwei(MAINNET_GAS_GWEI))} at ${MAINNET_GAS_GWEI} gwei)`,
    );
  }
  const topUpFeeGas = topUpTx?.gasUsed ?? 27_139n;
  for (const m of mp ? [m1, mp] : [m1]) {
    const ceiling = m.limits.call + m.limits.verification + m.limits.pre;
    const atMainnet = (gas: bigint) => gas * gwei(MAINNET_GAS_GWEI);
    console.log(`\n[${m.kind}]`);
    console.log(
      `  estimate (call/verification/pre): ${m.estimate.callGasLimit}/${m.estimate.verificationGasLimit}/${m.estimate.preVerificationGas}; with +25%: ${m.limits.call}/${m.limits.verification}/${m.limits.pre} = ${ceiling} gas (the fixed ceiling is 1,360,000)`,
    );
    console.log(
      `  the arming really used ${m.armingGas} gas = ${celo(m.armingCost)}; that is ${(Number(m.armingGas) * 100) / Number(ceiling)}% of the sized ceiling`,
    );
    console.log(
      `  top-up sent: ${celo(m.topUpValue)} (fixed limits would have sent ${celo((1_360_000n * m.maxFee * 105n) / 100n)}); total out of the relayer for this wallet ${celo(m.relayerBefore - m.relayerAfter)}`,
    );
    console.log(
      `  at ${MAINNET_GAS_GWEI} gwei: prefund sized ${celo(atMainnet(ceiling))} -> top-up ${celo((atMainnet(ceiling) * 105n) / 100n)}; fixed ${celo(atMainnet(1_360_000n))} -> ${celo((atMainnet(1_360_000n) * 105n) / 100n)}; arming really costs ${celo(atMainnet(m.armingGas))}`,
    );
    console.log(
      `  per signup out of the relayer at ${MAINNET_GAS_GWEI} gwei: open ${celo(atMainnet(openTx?.gasUsed ?? 0n))} + top-up fee ${celo(atMainnet(topUpFeeGas))} + top-up ${celo((atMainnet(ceiling) * 105n) / 100n)} = ${celo(atMainnet(openTx?.gasUsed ?? 0n) + atMainnet(topUpFeeGas) + (atMainnet(ceiling) * 105n) / 100n)}`,
    );
  }

  await app.close();
  await stopShim();
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed; relayer ends with ${celo(await relayerBalance())}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(
    "harness error:",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exit(2);
});
